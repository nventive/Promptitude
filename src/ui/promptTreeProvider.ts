import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ConfigManager } from '../configManager';
import { FileSystemManager } from '../utils/fileSystem';
import { Logger } from '../utils/logger';
import { decodeRepositorySlug, encodeRepositorySlug } from '../storage/repositoryStorage';

export interface PromptInfo {
    name: string; // Original filename from repository
    path: string;
    type: 'agents' | 'instructions' | 'prompts';
    size: number;
    lastModified: Date;
    lineCount: number;
    active: boolean;
    repositoryUrl?: string; // The repository URL this prompt came from
    description?: string; // Extracted description from prompt content
    workspaceName?: string; // Unique name used in workspace (may differ from name if there are conflicts)
}

export class PromptTreeItem extends vscode.TreeItem {
    constructor(
        public readonly promptInfo: PromptInfo,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(promptInfo.name, collapsibleState);
        this.tooltip = this.getTooltip();
        this.description = this.getDescription();
        this.contextValue = 'prompt';
        this.command = {
            command: 'prompts.viewPrompt',
            title: 'View Prompt',
            arguments: [this.promptInfo]
        };
        this.iconPath = this.getIcon();
    }

    private getTooltip(): string {
        const sizeKb = (this.promptInfo.size / 1024).toFixed(1);
        return `${this.promptInfo.name}\nType: ${this.promptInfo.type}\nSize: ${sizeKb} KB\nLines: ${this.promptInfo.lineCount}\nModified: ${this.promptInfo.lastModified.toLocaleDateString()}`;
    }

    private getDescription(): string {
        const sizeKb = (this.promptInfo.size / 1024).toFixed(1);
        return `${sizeKb}KB • ${this.promptInfo.lineCount} lines`;
    }

    private getIcon(): vscode.ThemeIcon {
        const baseIcon = this.getTypeIcon();
        if (this.promptInfo.active) {
            return new vscode.ThemeIcon(baseIcon.id, new vscode.ThemeColor('charts.green'));
        }
        return baseIcon;
    }

    private getTypeIcon(): vscode.ThemeIcon {
        switch (this.promptInfo.type) {
            case 'agents':
                return new vscode.ThemeIcon('comment-discussion');
            case 'instructions':
                return new vscode.ThemeIcon('book');
            case 'prompts':
                return new vscode.ThemeIcon('code');
            default:
                return new vscode.ThemeIcon('file');
        }
    }
}

export class CategoryTreeItem extends vscode.TreeItem {
    constructor(
        public readonly category: string,
        public readonly count: number,
        public readonly activeCount: number,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(category, collapsibleState);
        this.tooltip = this.getTooltip();
        this.description = this.getDescription();
        this.contextValue = 'category';
        this.iconPath = this.getIcon();
    }

    private getTooltip(): string {
        return `${this.category}\n${this.count} prompts (${this.activeCount} active)`;
    }

    private getDescription(): string {
        return `${this.count} (${this.activeCount} active)`;
    }

    private getIcon(): vscode.ThemeIcon {
        switch (this.category.toLowerCase()) {
            case 'agents':
                return new vscode.ThemeIcon('comment-discussion');
            case 'instructions':
                return new vscode.ThemeIcon('book');
            case 'prompts':
                return new vscode.ThemeIcon('code');
            default:
                return new vscode.ThemeIcon('folder');
        }
    }
}

export class PromptTreeDataProvider implements vscode.TreeDataProvider<PromptTreeItem | CategoryTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<PromptTreeItem | CategoryTreeItem | undefined | null | void> = new vscode.EventEmitter<PromptTreeItem | CategoryTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<PromptTreeItem | CategoryTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private prompts: Map<string, PromptInfo[]> = new Map();
    private activePrompts: Set<string> = new Set();
    private logger: Logger;
    private fileSystem: FileSystemManager;
    private isLoading = false;

    constructor(private config: ConfigManager) {
        this.logger = Logger.get('PromptTreeDataProvider');
        this.fileSystem = new FileSystemManager();
        // Trigger initial load asynchronously
        this.initialLoad();
    }

    private async initialLoad(): Promise<void> {
        try {
            this.logger.debug('Starting initial prompt load');
            await this.loadPrompts();
            this._onDidChangeTreeData.fire();
            this.logger.debug('Initial prompt load completed');
        } catch (error) {
            this.logger.error('Failed to perform initial prompt load', error instanceof Error ? error : undefined);
        }
    }

    refresh(): void {
        if (this.isLoading) {
            this.logger.debug('Refresh already in progress, skipping concurrent refresh');
            return;
        }

        this.logger.debug('Starting tree refresh');
        this.refreshAsync();
    }

    private async refreshAsync(): Promise<void> {
        try {
            await this.loadPrompts();
            this._onDidChangeTreeData.fire();
        } catch (error) {
            this.logger.error('Failed to refresh prompts', error instanceof Error ? error : undefined);
        }
    }

    getTreeItem(element: PromptTreeItem | CategoryTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: PromptTreeItem | CategoryTreeItem): Thenable<(PromptTreeItem | CategoryTreeItem)[]> {
        if (!element) {
            // Root level - return categories
            // Ensure prompts are loaded before returning categories
            return this.ensurePromptsLoaded().then(() => this.getCategories());
        }

        if (element instanceof CategoryTreeItem) {
            // Return prompts for this category
            return Promise.resolve(this.getPromptsForCategory(element.category));
        }

        return Promise.resolve([]);
    }

    private async ensurePromptsLoaded(): Promise<void> {
        // If prompts map is empty and we're not currently loading, trigger a load
        if (this.prompts.size === 0 && !this.isLoading) {
            this.logger.debug('No prompts loaded, triggering load in getChildren');
            await this.loadPrompts();
        }
    }

    private getCategories(): CategoryTreeItem[] {
        const categories: CategoryTreeItem[] = [];

        for (const [category, prompts] of this.prompts.entries()) {
            const activeCount = prompts.filter(p => p.active).length;
            categories.push(new CategoryTreeItem(
                this.getCategoryDisplayName(category),
                prompts.length,
                activeCount,
                vscode.TreeItemCollapsibleState.Expanded
            ));
        }

        return categories.sort((a, b) => this.getCategorySortOrder(a.category) - this.getCategorySortOrder(b.category));
    }

    private getPromptsForCategory(categoryDisplay: string): PromptTreeItem[] {
        const category = this.getCategoryKey(categoryDisplay);
        const prompts = this.prompts.get(category) || [];

        return prompts
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(prompt => new PromptTreeItem(prompt, vscode.TreeItemCollapsibleState.None));
    }

    private getCategoryDisplayName(category: string): string {
        switch (category) {
            case 'agents': return 'Agents';
            case 'instructions': return 'Instructions';
            case 'prompts': return 'Prompts';
            default: return category;
        }
    }

    private getCategoryKey(displayName: string): string {
        switch (displayName.toLowerCase()) {
            case 'agents': return 'agents';
            case 'instructions': return 'instructions';
            case 'prompts': return 'prompts';
            default: return displayName.toLowerCase();
        }
    }

    private getCategorySortOrder(category: string): number {
        switch (category.toLowerCase()) {
            case 'agents': return 1;
            case 'prompts': return 2;
            case 'instructions': return 3;
            default: return 99;
        }
    }

    private async loadPrompts(): Promise<void> {
        if (this.isLoading) {
            this.logger.debug('loadPrompts already in progress, skipping');
            return;
        }

        this.isLoading = true;
        this.prompts.clear();
        this.logger.debug('Starting to load prompts - cleared existing prompts');

        try {
            const promptsDir = this.config.getPromptsDirectory();

            if (!await this.fileSystem.directoryExists(promptsDir)) {
                this.logger.debug(`Prompts directory does not exist: ${promptsDir}`);
                // Create the base directory
                await this.fileSystem.ensureDirectoryExists(promptsDir);
            }

            // Load active prompts directly from User/prompts/ (no subdirectories)
            let workspaceCount = 0;
            const files = await this.fileSystem.readDirectory(promptsDir);

            for (const file of files) {
                // Skip hidden files
                if (file.startsWith('.')) {
                    continue;
                }

                if (this.isPromptFile(file)) {
                    const promptInfo = await this.createPromptInfo(promptsDir, file);
                    if (promptInfo) {
                        const category = promptInfo.type;
                        if (!this.prompts.has(category)) {
                            this.prompts.set(category, []);
                        }
                        this.prompts.get(category)!.push(promptInfo);
                        this.logger.debug(`Loaded workspace prompt into category '${category}': ${file} (active: ${promptInfo.active})`);
                        workspaceCount++;
                    }
                }
            }

            this.logger.debug(`Loaded ${workspaceCount} active prompts from workspace`);            // Load prompts from repository storage (these are all available prompts)
            await this.loadPromptsFromRepositoryStorage();

            this.logger.debug(`Total loaded: ${this.getTotalPromptCount()} prompts across ${this.prompts.size} categories`);
        } catch (error) {
            this.logger.error('Failed to load prompts', error instanceof Error ? error : undefined);
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Load prompts from repository storage directories (in globalStorage)
     */
    private async loadPromptsFromRepositoryStorage(): Promise<void> {
        try {
            // Get repository storage directory from globalStorage
            const repoStorageDir = this.getRepositoryStorageDirectory();

            if (!await this.fileSystem.directoryExists(repoStorageDir)) {
                this.logger.debug(`Repository storage directory does not exist: ${repoStorageDir}`);
                return;
            }

            const repoDirs = await this.fileSystem.readDirectory(repoStorageDir);
            let repoCount = 0;
            let addedCount = 0;
            let skippedCount = 0;

            for (const repoDir of repoDirs) {
                const fullRepoPath = path.join(repoStorageDir, repoDir);

                if (await this.fileSystem.directoryExists(fullRepoPath)) {
                    repoCount++;
                    const repoFiles = await this.fileSystem.readDirectory(fullRepoPath);
                    const repositoryUrl = this.decodeRepositoryUrl(repoDir);

                    for (const file of repoFiles) {
                        if (this.isPromptFile(file)) {
                            // Check if this prompt is already loaded from the same repository
                            const existingPrompt = this.findPromptByNameAndRepository(file, repositoryUrl);

                            if (!existingPrompt) {
                                // Create prompt info for repository storage file
                                const promptInfo = await this.createRepositoryPromptInfo(fullRepoPath, file, repositoryUrl);
                                if (promptInfo) {
                                    const category = promptInfo.type;
                                    if (!this.prompts.has(category)) {
                                        this.prompts.set(category, []);
                                    }
                                    this.prompts.get(category)!.push(promptInfo);
                                    this.logger.debug(`Added prompt to category '${category}': ${file} (active: ${promptInfo.active})`);
                                    addedCount++;
                                }
                            } else {
                                // Prompt already exists from the same repository
                                this.logger.debug(`Skipping duplicate prompt from same repository: ${file} (${repositoryUrl})`);
                                skippedCount++;
                            }
                        }
                    }
                }
            }

            this.logger.debug(`Repository storage scan: ${repoCount} repos, ${addedCount} prompts added, ${skippedCount} duplicates skipped`);
        } catch (error) {
            this.logger.warn(`Failed to load prompts from repository storage: ${error}`);
        }
    }

    /**
     * Find a prompt by its filename across all categories (legacy method)
     * @deprecated Use findPromptByNameAndRepository for repository-aware lookup
     */
    private findPromptByName(fileName: string): PromptInfo | undefined {
        for (const prompts of this.prompts.values()) {
            const found = prompts.find(p => p.name === fileName);
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    /**
     * Find a prompt by its filename and repository URL (composite key)
     * This prevents conflating prompts with the same name from different repositories
     */
    private findPromptByNameAndRepository(fileName: string, repositoryUrl?: string): PromptInfo | undefined {
        for (const prompts of this.prompts.values()) {
            const found = prompts.find(p =>
                p.name === fileName && p.repositoryUrl === repositoryUrl
            );
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    /**
     * Create prompt info for a file in repository storage
     */
    private async createRepositoryPromptInfo(repoPath: string, fileName: string, repositoryUrl: string): Promise<PromptInfo | null> {
        try {
            const filePath = path.join(repoPath, fileName);
            const stats = await fs.promises.stat(filePath);
            const content = await this.fileSystem.readFileContent(filePath);

            // Determine type based on filename patterns
            const type = this.determinePromptType(fileName);

            // Extract description from content
            const description = this.extractDescription(content);

            // Generate the workspace name that would be used for this prompt
            const workspaceName = await this.calculateWorkspaceName(fileName, repositoryUrl);

            // Create workspace path using the unique workspace name
            const workspacePath = path.join(this.config.getPromptsDirectory(), workspaceName);

            // Check if this prompt is active by checking if the workspace file exists
            // On Windows, this could be either a symlink or a file copy
            let isActive = false;
            if (await this.fileSystem.fileExists(workspacePath)) {
                // File exists in workspace - check if it's a symlink or a regular file
                try {
                    const stats = await fs.promises.lstat(workspacePath);
                    if (stats.isSymbolicLink()) {
                        // It's a symlink - check if it points to this repository file
                        const targetPath = await fs.promises.readlink(workspacePath);
                        const normalizedTarget = targetPath.replace(/\\/g, '/');
                        const normalizedRepoPath = filePath.replace(/\\/g, '/');
                        isActive = normalizedTarget === normalizedRepoPath;
                    } else if (process.platform === 'win32') {
                        // On Windows, it might be a file copy (fallback when symlinks aren't available)
                        // Consider it active if the file exists in workspace and matches this repository
                        isActive = true;
                    }
                } catch (error) {
                    this.logger.debug(`Failed to check if prompt is active: ${workspaceName}`);
                }
            }

            const promptInfo: PromptInfo = {
                name: fileName,
                path: workspacePath,
                type,
                size: stats.size,
                lastModified: stats.mtime,
                lineCount: content.split('\n').length,
                active: isActive,
                repositoryUrl,
                description,
                workspaceName
            };

            return promptInfo;
        } catch (error) {
            this.logger.warn(`Failed to create repository prompt info for ${fileName}: ${error}`);
            return null;
        }
    }

    /**
     * Calculate what the workspace name would be for a given filename and repository
     * This mirrors the logic in SyncManager.getUniqueWorkspaceName
     */
    private async calculateWorkspaceName(fileName: string, repositoryUrl: string): Promise<string> {
        // Check if this filename exists in multiple repositories
        const allPrompts = Array.from(this.prompts.values()).flat();
        const promptsWithSameName = allPrompts.filter(p => p.name === fileName);

        // If this filename only appears once across all repos, use original name
        if (promptsWithSameName.length <= 1) {
            // Check repository storage to see if file exists in other repos
            const promptsDir = this.config.getPromptsDirectory();
            const parentDir = path.dirname(promptsDir);
            const repoStorageDir = path.join(parentDir, 'repos');

            if (await this.fileSystem.directoryExists(repoStorageDir)) {
                const repoDirs = await this.fileSystem.readDirectory(repoStorageDir);
                let repoCount = 0;

                for (const repoDir of repoDirs) {
                    const fullRepoPath = path.join(repoStorageDir, repoDir);
                    if (await this.fileSystem.directoryExists(fullRepoPath)) {
                        const filePath = path.join(fullRepoPath, fileName);
                        if (await this.fileSystem.fileExists(filePath)) {
                            repoCount++;
                            if (repoCount > 1) {
                                break;
                            }
                        }
                    }
                }

                if (repoCount <= 1) {
                    return fileName;
                }
            } else {
                return fileName;
            }
        }

        // File exists in multiple repos - need to make it unique
        const repoIdentifier = this.getRepositoryIdentifier(repositoryUrl);

        // Insert identifier before the file extension
        const lastDotIndex = fileName.lastIndexOf('.');
        if (lastDotIndex > 0) {
            const baseName = fileName.substring(0, lastDotIndex);
            const extension = fileName.substring(lastDotIndex);
            return `${baseName}@${repoIdentifier}${extension}`;
        } else {
            return `${fileName}@${repoIdentifier}`;
        }
    }

    /**
     * Extract a short, readable identifier from a repository URL
     * This mirrors the logic in SyncManager.getRepositoryIdentifier
     */
    private getRepositoryIdentifier(repositoryUrl: string): string {
        try {
            // Remove protocol and common prefixes
            let identifier = repositoryUrl
                .replace(/^https?:\/\//, '')
                .replace(/^www\./, '')
                .replace(/\.git$/, '');

            // For GitHub URLs: github.com/org/repo -> org-repo
            if (identifier.includes('github.com/')) {
                const parts = identifier.split('github.com/')[1].split('/');
                if (parts.length >= 2) {
                    return `${parts[0]}-${parts[1]}`;
                }
            }

            // For Azure DevOps: dev.azure.com/org/project/_git/repo -> org-project-repo
            if (identifier.includes('dev.azure.com/')) {
                const parts = identifier.split('/').filter(p => p && p !== '_git');
                if (parts.length >= 4) {
                    return `${parts[1]}-${parts[2]}-${parts[3]}`;
                }
            }

            // Fallback: use last 2 path segments separated by dash
            const pathParts = identifier.split('/').filter(p => p);
            if (pathParts.length >= 2) {
                return `${pathParts[pathParts.length - 2]}-${pathParts[pathParts.length - 1]}`;
            }

            // Last resort: use the last path segment
            return pathParts[pathParts.length - 1] || 'repo';
        } catch (error) {
            this.logger.warn(`Failed to extract repository identifier from ${repositoryUrl}, using fallback`);
            return 'repo';
        }
    }

    private isPromptFile(fileName: string): boolean {
        // Filter out directories, hidden files, and non-prompt files
        return !fileName.startsWith('.') &&
            !fileName.startsWith('_') &&
            (fileName.endsWith('.md') || fileName.endsWith('.txt'));
    }

    private async createPromptInfo(promptsDir: string, fileName: string): Promise<PromptInfo | null> {
        try {
            const filePath = path.join(promptsDir, fileName);
            const stats = await fs.promises.stat(filePath);
            const content = await this.fileSystem.readFileContent(filePath);

            // Determine type based on filename patterns
            const type = this.determinePromptType(fileName);

            // Extract description from content
            const description = this.extractDescription(content);

            // Check if this is a symlink and extract repository URL
            let repositoryUrl: string | undefined;
            let isSymlink = false;
            let isActiveFileCopy = false;

            try {
                const linkStats = await fs.promises.lstat(filePath);
                if (linkStats.isSymbolicLink()) {
                    isSymlink = true;
                    const targetPath = await fs.promises.readlink(filePath);
                    // Normalize path separators for cross-platform compatibility
                    const normalizedTargetPath = targetPath.replace(/\\/g, '/');
                    repositoryUrl = this.extractRepositoryUrlFromPath(normalizedTargetPath);
                } else if (process.platform === 'win32') {
                    // On Windows, files might be copies instead of symlinks
                    // Check if file exists in any repository storage
                    for (const repoConfig of this.config.repositoryConfigs) {
                        const repoPath = this.getRepositoryPath(repoConfig.url);
                        const repoFilePath = path.join(repoPath, fileName);

                        if (await this.fileSystem.fileExists(repoFilePath)) {
                            isActiveFileCopy = true;
                            repositoryUrl = repoConfig.url;
                            this.logger.debug(`Found Windows file copy in repository: ${fileName} -> ${repoConfig.url}`);
                            break;
                        }
                    }

                    // Additional check: if no repository match found but file exists in workspace prompts directory
                    // it might be a copied file that was just activated
                    if (!isActiveFileCopy) {
                        const promptsDir = this.config.getPromptsDirectory();
                        const normalizedPromptsDir = promptsDir.replace(/\\/g, '/');
                        const normalizedFilePath = filePath.replace(/\\/g, '/');

                        // If the file is in the prompts directory, check all repo storage for a matching file
                        if (normalizedFilePath.startsWith(normalizedPromptsDir)) {
                            this.logger.debug(`Windows: Checking if ${fileName} is an active copy in prompts directory`);
                            // Note: This prompt is in the workspace directory
                            // It will be marked as active if we can find it in any repository storage
                            // The repository URL will remain undefined if not found
                        }
                    }
                }
            } catch (error) {
                // If lstat fails, it's likely not a symlink
                this.logger.debug(`Not a symlink or failed to check: ${fileName}`);
            }

            // Active if it's a symlink OR a file copy on Windows that exists in repo storage
            const isActive = isSymlink || isActiveFileCopy;

            const promptInfo: PromptInfo = {
                name: fileName,
                path: filePath,
                type,
                size: stats.size,
                lastModified: stats.mtime,
                lineCount: content.split('\n').length,
                active: isActive,
                repositoryUrl,
                description,
                workspaceName: fileName // For active prompts in workspace, workspace name is same as filename
            };

            // Keep the activePrompts Set in sync
            if (isActive) {
                this.activePrompts.add(filePath);
            }

            return promptInfo;
        } catch (error) {
            this.logger.warn(`Failed to create prompt info for ${fileName}: ${error}`);
            return null;
        }
    }

    private determinePromptType(fileName: string): 'agents' | 'instructions' | 'prompts' {
        const lowerName = fileName.toLowerCase();

        // Support both 'agents' and legacy 'chatmode' naming
        if (lowerName.includes('agent') || lowerName.includes('chatmode') || lowerName.includes('chat-mode')) {
            return 'agents';
        }

        if (lowerName.includes('instruction') || lowerName.includes('guide')) {
            return 'instructions';
        }

        return 'prompts';
    }

    /**
     * Extract description from YAML frontmatter or content
     */
    private extractDescription(content: string): string {
        // Try to parse YAML frontmatter
        const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);

        if (frontmatterMatch) {
            const frontmatter = frontmatterMatch[1];

            // Look for description field in frontmatter (handles both quoted and unquoted values)
            const descriptionMatch = frontmatter.match(/description:\s*['"]([^'"]+)['"]|description:\s*([^\n]+)/);
            if (descriptionMatch) {
                // Use captured group 1 if quoted, otherwise group 2 if unquoted
                const description = (descriptionMatch[1] || descriptionMatch[2] || '').trim();
                if (description) {
                    return description;
                }
            }
        }

        // Fallback: Try to get first meaningful line from content
        const lines = content
            .replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '') // Remove frontmatter
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#') && !line.startsWith('//') && !line.startsWith('/*'));

        if (lines.length > 0) {
            const firstLine = lines[0];
            return firstLine.length > 100 ? firstLine.substring(0, 100) + '...' : firstLine;
        }

        return 'No description available';
    }

    private getTotalPromptCount(): number {
        let count = 0;
        for (const prompts of this.prompts.values()) {
            count += prompts.length;
        }
        return count;
    }

    // Selection management methods
    toggleSelection(promptInfo: PromptInfo): void {
        if (promptInfo.active) {
            this.activePrompts.delete(promptInfo.path);
            promptInfo.active = false;
        } else {
            this.activePrompts.add(promptInfo.path);
            promptInfo.active = true;
        }
        this._onDidChangeTreeData.fire();
    }

    selectAll(): void {
        for (const prompts of this.prompts.values()) {
            for (const prompt of prompts) {
                this.activePrompts.add(prompt.path);
                prompt.active = true;
            }
        }
        this._onDidChangeTreeData.fire();
    }

    deselectAll(): void {
        this.activePrompts.clear();
        for (const prompts of this.prompts.values()) {
            for (const prompt of prompts) {
                prompt.active = false;
            }
        }
        this._onDidChangeTreeData.fire();
    }

    getSelectedPrompts(): PromptInfo[] {
        const active: PromptInfo[] = [];
        for (const prompts of this.prompts.values()) {
            active.push(...prompts.filter(p => p.active));
        }
        return active;
    }

    getPromptByPath(filePath: string): PromptInfo | undefined {
        for (const prompts of this.prompts.values()) {
            const found = prompts.find(p => p.path === filePath);
            if (found) {
                return found;
            }
        }
        return undefined;
    }

    getAllPrompts(): PromptInfo[] {
        const allPrompts: PromptInfo[] = [];
        for (const prompts of this.prompts.values()) {
            allPrompts.push(...prompts);
        }
        return allPrompts;
    }

    /**
     * Get the repository storage path for a given repository URL
     */
    /**
     * Get the repository storage directory (in globalStorage)
     */
    private getRepositoryStorageDirectory(): string {
        // Try to get from context's globalStorageUri first
        if (this.config['context'] && this.config['context'].globalStorageUri) {
            return path.join(this.config['context'].globalStorageUri.fsPath, 'repos');
        }

        // Fallback: use platform-specific globalStorage path
        const extensionId = 'logientnventive.promptitude-extension';
        let globalStoragePath: string;

        switch (process.platform) {
            case 'win32':
                globalStoragePath = path.join(
                    os.homedir(),
                    'AppData',
                    'Roaming',
                    'Code',
                    'User',
                    'globalStorage',
                    extensionId
                );
                break;
            case 'darwin':
                globalStoragePath = path.join(
                    os.homedir(),
                    'Library',
                    'Application Support',
                    'Code',
                    'User',
                    'globalStorage',
                    extensionId
                );
                break;
            case 'linux':
                globalStoragePath = path.join(
                    os.homedir(),
                    '.config',
                    'Code',
                    'User',
                    'globalStorage',
                    extensionId
                );
                break;
            default:
                globalStoragePath = path.join(os.homedir(), '.vscode', 'globalStorage', extensionId);
                break;
        }

        return path.join(globalStoragePath, 'repos');
    }

    private getRepositoryPath(repositoryUrl: string): string {
        const repoStorageDir = this.getRepositoryStorageDirectory();
        const slug = encodeRepositorySlug(repositoryUrl);
        return path.join(repoStorageDir, slug);
    }

    /**
     * Extract repository URL from a symlink target path
     * Expected format: .../prompts/.promptitude/repos/{repo_url_encoded}/filename
     * Handles both Unix and Windows path separators
     */
    private extractRepositoryUrlFromPath(targetPath: string): string | undefined {
        try {
            // Normalize path separators to forward slashes for consistent parsing
            const normalizedPath = targetPath.replace(/\\/g, '/');

            // Split the path and look for the repos directory structure
            const pathParts = normalizedPath.split('/');
            const reposIndex = pathParts.findIndex(part => part === 'repos');

            if (reposIndex !== -1 && reposIndex + 1 < pathParts.length) {
                const encodedRepoUrl = pathParts[reposIndex + 1];
                // Decode the repository URL
                return this.decodeRepositoryUrl(encodedRepoUrl);
            }

            return undefined;
        } catch (error) {
            this.logger.warn(`Failed to extract repository URL from path: ${targetPath}: ${error}`);
            return undefined;
        }
    }

    /**
     * Decode a repository URL from its encoded directory name
     */
    private decodeRepositoryUrl(encodedUrl: string): string {
        return decodeRepositorySlug(encodedUrl);
    }
}