import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { ConfigManager } from './configManager';
import { StatusBarManager, SyncStatus } from './statusBarManager';
import { Logger } from './utils/logger';
import { NotificationManager } from './utils/notifications';
import { GitApiManager, GitTreeItem } from './utils/gitProvider';
import { encodeRepositorySlug } from './storage/repositoryStorage';
import { GitProviderFactory } from './utils/gitProviderFactory';
import { FileSystemManager } from './utils/fileSystem';
import { AzureDevOpsApiManager } from './utils/azureDevOps';
import { PromptTreeDataProvider } from './ui/promptTreeProvider';
import { REPO_SYNC_CHAT_MODE_PATH, REPO_SYNC_CHAT_MODE_LEGACY_PATH, REPO_SYNC_CHAT_MODE_LEGACY_SINGULAR_PATH, REPO_SYNC_INSTRUCTIONS_PATH, REPO_SYNC_PROMPT_PATH, } from './constant';
export interface SyncResult {
    success: boolean;
    itemsUpdated: number;
    error?: string;
}

export interface RepositorySyncResult {
    repository: string;
    success: boolean;
    itemsUpdated: number;
    error?: string;
}

export interface MultiRepositorySyncResult {
    overallSuccess: boolean;
    totalItemsUpdated: number;
    repositories: RepositorySyncResult[];
    errors: string[];
}

export class SyncManager {
    private timer: NodeJS.Timeout | null = null;
    private context: vscode.ExtensionContext | null = null;
    private notifications: NotificationManager;
    private fileSystem: FileSystemManager;
    private gitProviders: Map<string, GitApiManager> = new Map();
    private repoStorageDir: string;

    constructor(
        private config: ConfigManager,
        private statusBar: StatusBarManager,
        private treeProvider?: PromptTreeDataProvider,
        private logger: Logger = Logger.get('SyncManager')
    ) {
        this.notifications = new NotificationManager(this.config, undefined, this.logger);
        this.fileSystem = new FileSystemManager();
        this.repoStorageDir = this.getRepositoryStorageDirectory();
    }

    async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.context = context;

        // Update notification manager with extension context
        this.notifications = new NotificationManager(this.config, this.context, this.logger);

        this.logger.info('Initializing SyncManager...');

        // Migrate repository storage from old location to new location
        await this.migrateRepositoryStorage();

        // Listen for configuration changes
        const configDisposable = this.config.onConfigurationChanged(() => {
            this.logger.debug('Configuration changed, reinitializing sync schedule');
            this.scheduleNextSync();
        });

        context.subscriptions.push(configDisposable);

        // Perform initial sync if enabled
        if (this.config.enabled && this.config.syncOnStartup) {
            this.logger.info('Performing initial sync on startup');
            setTimeout(() => this.syncNow(), 2000); // Delay to let VS Code finish loading
        }

        // Schedule periodic syncs
        this.scheduleNextSync();

        this.logger.info('SyncManager initialized successfully');
    }

    async syncNow(): Promise<SyncResult> {
        if (!this.config.enabled) {
            this.logger.info('Sync is disabled in configuration');
            return { success: false, itemsUpdated: 0, error: 'Sync disabled' };
        }

        this.logger.info('Starting manual sync...');
        this.statusBar.setStatus(SyncStatus.Syncing, 'Syncing...');

        try {
            const repositories = this.config.repositories;
            this.logger.info(`Syncing from ${repositories.length} repositories`);

            const result = await this.syncMultipleRepositories(repositories);

            // Recreate symlinks for active prompts (in case they were manually deleted)
            await this.recreateActivePromptSymlinks();

            // Clean up orphaned regular files in prompts directory
            const cleanup = await this.cleanupOrphanedPrompts();
            if (cleanup.removed > 0) {
                this.logger.info(`Cleaned up ${cleanup.removed} orphaned prompt files`);
            }

            // Update status based on overall result
            if (result.overallSuccess) {
                this.statusBar.setStatus(SyncStatus.Success);
                const syncStats = this.getSyncStatistics();
                await this.notifications.showSyncSuccess(result.totalItemsUpdated);
                this.logger.info(`Sync completed successfully. ${result.totalItemsUpdated} active items updated across ${repositories.length} repositories. ${syncStats}`);
            } else {
                // Partial success or complete failure
                const successCount = result.repositories.filter(r => r.success).length;
                if (successCount > 0) {
                    this.statusBar.setStatus(SyncStatus.Success, `${successCount}/${repositories.length} repos synced`);
                    await this.notifications.showPartialSyncSuccess(result.totalItemsUpdated, successCount, repositories.length, result.errors);
                    this.logger.warn(`Partial sync completed. ${result.totalItemsUpdated} items updated from ${successCount}/${repositories.length} repositories.`);
                } else {
                    this.statusBar.setStatus(SyncStatus.Error, 'All repos failed');
                    await this.notifications.showSyncError(`All repositories failed: ${result.errors.join('; ')}`);
                    this.logger.error('All repositories failed to sync');
                }
            }

            // Refresh tree provider after recreating symlinks
            if (this.treeProvider) {
                this.logger.debug('Refreshing tree provider after sync and symlink recreation');
                this.treeProvider.refresh();
            }

            // Schedule next sync
            this.scheduleNextSync();

            return {
                success: result.overallSuccess,
                itemsUpdated: result.totalItemsUpdated,
                error: result.errors.length > 0 ? result.errors.join('; ') : undefined
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error('Sync failed', error instanceof Error ? error : undefined);
            this.statusBar.setStatus(SyncStatus.Error, 'Sync failed');
            await this.notifications.showSyncError(errorMessage);

            return { success: false, itemsUpdated: 0, error: errorMessage };
        }
    }

    private filterRelevantFiles(tree: GitTreeItem[]): GitTreeItem[] {
        const allowedPaths: string[] = [];

        // Build list of allowed paths based on settings
        if (this.config.syncChatmode) {
            allowedPaths.push(REPO_SYNC_CHAT_MODE_PATH);
            allowedPaths.push(REPO_SYNC_CHAT_MODE_LEGACY_PATH); // Support legacy chatmodes/ directory
            allowedPaths.push(REPO_SYNC_CHAT_MODE_LEGACY_SINGULAR_PATH); // Support legacy chatmode/ directory (singular)
            this.logger.debug(`Enabled sync for agents: ${REPO_SYNC_CHAT_MODE_PATH} and legacy: ${REPO_SYNC_CHAT_MODE_LEGACY_PATH}, ${REPO_SYNC_CHAT_MODE_LEGACY_SINGULAR_PATH}`);
        }
        if (this.config.syncInstructions) {
            allowedPaths.push(REPO_SYNC_INSTRUCTIONS_PATH);
            this.logger.debug(`Enabled sync for instructions: ${REPO_SYNC_INSTRUCTIONS_PATH}`);
        }
        if (this.config.syncPrompt) {
            allowedPaths.push(REPO_SYNC_PROMPT_PATH);
            this.logger.debug(`Enabled sync for prompts: ${REPO_SYNC_PROMPT_PATH}`);
        }

        // If no types are selected, return empty array
        if (allowedPaths.length === 0) {
            this.logger.warn('No sync types selected in configuration');
            return [];
        }

        this.logger.debug(`Filtering ${tree.length} items, allowed paths: ${allowedPaths.join(', ')}`);

        const filtered = tree.filter(item => {
            const isBlob = item.type === 'blob';

            // Normalize path separators and remove leading slash for comparison
            const normalizedPath = item.path.replace(/\\/g, '/').replace(/^\/+/, '');

            const matchesPath = allowedPaths.some(path => {
                const normalizedAllowedPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
                return normalizedPath.startsWith(normalizedAllowedPath);
            });

            // Support more file extensions including .prompt.md
            const isRelevantFile = item.path.endsWith('.md') ||
                item.path.endsWith('.txt');
            if (isRelevantFile) {
                this.logger.debug(`  ${item.path}: blob=${isBlob}, matchesPath=${matchesPath}, (normalized: ${normalizedPath})`);
            }

            return isBlob && matchesPath && isRelevantFile;
        });

        this.logger.debug(`Filtered result: ${filtered.length} files out of ${tree.length} total`);
        return filtered;
    }

    private async syncFiles(gitApi: GitApiManager, owner: string, repo: string, files: GitTreeItem[], branch: string): Promise<number> {
        // Construct repository URL based on provider
        const providerName = gitApi.getProviderName();
        let repositoryUrl: string;

        if (providerName === 'github') {
            repositoryUrl = `https://github.com/${owner}/${repo}`;
        } else if (providerName === 'azure') {
            repositoryUrl = `https://dev.azure.com/${owner}/${repo}`;
        } else {
            repositoryUrl = `${providerName}/${owner}/${repo}`;
        }

        const repoStoragePath = this.getRepositoryPath(repositoryUrl);
        await this.fileSystem.ensureDirectoryExists(repoStoragePath);

        let itemsUpdated = 0;

        for (const file of files) {
            this.logger.debug(`Syncing file: ${file.path} to repository storage`);
            let content = null;

            try {
                content = await gitApi.getFileContent(owner, repo, file.path, branch);
            } catch (error) {
                // An error occurred while retrieving file content, Return here
                this.logger.warn(`Failed to fetch content for ${file.path}: ${error}`);
                this.notifications.showSyncError(`Failed to fetch content for ${file.path} branch:${branch}: ${error}.`);
                return itemsUpdated;
            }

            try {
                // Save to repository storage directory
                const fileName = this.fileSystem.getBasename(file.path);
                const repoFilePath = this.fileSystem.joinPath(repoStoragePath, fileName);

                // Check if file needs updating
                if (!content) {
                    this.logger.warn(`No content retrieved for ${file.path}, skipping`);
                    continue;
                }

                const needsUpdate = await this.shouldUpdateFile(repoFilePath, content);

                if (needsUpdate) {
                    await this.fileSystem.writeFileContent(repoFilePath, content);
                    itemsUpdated++;
                    this.logger.debug(`Updated file in repository storage: ${repoFilePath}`);

                    // If this prompt is currently active, update the symlink in workspace
                    await this.updateActivePromptSymlink(fileName, repositoryUrl);
                } else {
                    this.logger.debug(`File unchanged in repository storage: ${repoFilePath}`);
                }

            } catch (error) {
                this.logger.warn(`Failed to sync file ${file.path}: ${error}`);
                // Continue with other files even if one fails
            }
        }

        return itemsUpdated;
    }

    private async cleanupInactivePrompts(): Promise<void> {
        if (!this.treeProvider) {
            return;
        }

        try {
            const promptsDir = this.config.getPromptsDirectory();

            // Ensure the prompts directory exists before trying to read it
            await this.fileSystem.ensureDirectoryExists(promptsDir);

            const existingFiles = await this.fileSystem.readDirectory(promptsDir);
            const allPrompts = this.treeProvider.getAllPrompts();

            for (const fileName of existingFiles) {
                if (!this.isPromptFile(fileName)) {
                    continue;
                }

                const filePath = this.fileSystem.joinPath(promptsDir, fileName);
                const matchingPrompt = allPrompts.find(prompt => prompt.name === fileName);

                // Remove file if prompt exists but is not active
                if (matchingPrompt && !matchingPrompt.active) {
                    try {
                        await vscode.workspace.fs.delete(vscode.Uri.file(filePath));
                        this.logger.debug(`Removed inactive prompt: ${fileName}`);
                    } catch (error) {
                        this.logger.warn(`Failed to remove inactive prompt ${fileName}: ${error}`);
                    }
                }
            }
        } catch (error) {
            this.logger.error(`Failed to cleanup inactive prompts: ${error}`);
        }
    }

    private isPromptFile(fileName: string): boolean {
        return fileName.endsWith('.md') || fileName.endsWith('.txt');
    }

    private getSyncStatistics(): string {
        if (!this.treeProvider) {
            return '';
        }

        try {
            const allPrompts = this.treeProvider.getAllPrompts();
            const activePrompts = allPrompts.filter(p => p.active);
            return `(${activePrompts.length}/${allPrompts.length} prompts active)`;
        } catch (error) {
            this.logger.warn(`Failed to get sync statistics: ${error}`);
            return '';
        }
    }

    private async syncMultipleRepositories(repositories: string[]): Promise<MultiRepositorySyncResult> {
        const results: RepositorySyncResult[] = [];
        let totalItemsUpdated = 0;
        const errors: string[] = [];

        const repoConfigs = this.config.repositoryConfigs;

        for (const entry of repoConfigs) {
            const repoUrl = entry.url;
            const branch = entry.branch;
            try {
                this.logger.debug(`Syncing repository: ${repoUrl}`);

                // Get or create Git API manager for this repository
                let gitApi = this.gitProviders.get(repoUrl);
                if (!gitApi) {
                    if (!this.context) {
                        throw new Error('Extension context not available for git provider initialization');
                    }
                    gitApi = GitProviderFactory.createFromUrl(repoUrl, this.context);
                    this.gitProviders.set(repoUrl, gitApi);
                }

                // Check authentication for this provider
                // First check if we’re already authenticated
                let isAuthenticated = await gitApi.checkAuthentication();
                if (!isAuthenticated) {
                    this.logger.warn(`${gitApi.getProviderName()} authentication required for ${repoUrl}`);
                    await this.notifications.showAuthenticationRequired();

                    // Re-check after the notification flow before prompting again
                    isAuthenticated = await gitApi.checkAuthentication();
                    if (!isAuthenticated) {
                        const authSuccess = await gitApi.requestAuthentication();
                        if (!authSuccess) {
                            throw new Error(`${gitApi.getProviderName()} authentication failed`);
                        }
                    }
                }

                // Parse repository URL
                const { owner, repo } = gitApi.parseRepositoryUrl(repoUrl);
                this.logger.debug(`Syncing from ${owner}/${repo} branch ${branch}`);

                // Get repository tree
                const tree = await gitApi.getRepositoryTree(owner, repo, branch);
                this.logger.debug(`Retrieved repository tree with ${tree.tree.length} items for ${repoUrl}`);


                // Filter relevant files
                const relevantFiles = this.filterRelevantFiles(tree.tree);

                if (relevantFiles.length === 0) {
                    this.logger.warn(`No relevant files found to sync in ${repoUrl} based on current settings`);
                    const promptLocation = `${REPO_SYNC_CHAT_MODE_PATH}, ${REPO_SYNC_CHAT_MODE_LEGACY_PATH}, ${REPO_SYNC_CHAT_MODE_LEGACY_SINGULAR_PATH}, ${REPO_SYNC_INSTRUCTIONS_PATH}, ${REPO_SYNC_PROMPT_PATH}`;
                    results.push({
                        repository: repoUrl,
                        success: false,
                        itemsUpdated: 0,
                        error: `No relevant files found, make sure prompts are in valid directories: ${promptLocation}`
                    });
                    errors.push(`${repoUrl}: No relevant files found`);
                    continue;
                }
                this.logger.debug(`Found ${relevantFiles.length} relevant files to sync for ${repoUrl}`);

                // Sync files
                const itemsUpdated = await this.syncFiles(gitApi, owner, repo, relevantFiles, branch);

                results.push({
                    repository: repoUrl,
                    success: true,
                    itemsUpdated,
                });

                totalItemsUpdated += itemsUpdated;
                this.logger.info(`Successfully synced ${itemsUpdated} items from ${repoUrl}`);

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                this.logger.warn(`Failed to sync repository ${repoUrl}: ${errorMessage}`);

                results.push({
                    repository: repoUrl,
                    success: false,
                    itemsUpdated: 0,
                    error: errorMessage
                });

                errors.push(`${repoUrl}: ${errorMessage}`);
            }
        }

        const overallSuccess = results.every(r => r.success);

        return {
            overallSuccess,
            totalItemsUpdated,
            repositories: results,
            errors
        };
    }

    private async shouldUpdateFile(localPath: string, newContent: string): Promise<boolean> {
        try {
            if (!(await this.fileSystem.fileExists(localPath))) {
                return true; // File doesn't exist, needs to be created
            }

            const existingContent = await this.fileSystem.readFileContent(localPath);
            return existingContent !== newContent;
        } catch {
            return true; // Error reading file, assume it needs updating
        }
    }

    private shouldSyncFile(localPath: string): boolean {
        // If no tree provider is available, sync all files (default behavior)
        if (!this.treeProvider) {
            this.logger.debug('No tree provider available, syncing all files');
            return true;
        }

        // Get the filename from the local path
        const fileName = this.fileSystem.getBasename(localPath);

        // Find the prompt in the tree provider by filename
        const allPrompts = this.treeProvider.getAllPrompts();
        const matchingPrompt = allPrompts.find(prompt => prompt.name === fileName);

        if (!matchingPrompt) {
            // If prompt is not found in tree (new file), sync it
            this.logger.debug(`Prompt ${fileName} not found in tree, syncing as new file`);
            return true;
        }

        // Only sync if the prompt is marked as active
        const shouldSync = matchingPrompt.active;
        this.logger.debug(`Prompt ${fileName} active status: ${shouldSync}`);
        return shouldSync;
    }

    private scheduleNextSync(): void {
        // Clear existing timer
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (!this.config.enabled) {
            this.logger.debug('Sync disabled, not scheduling next sync');
            return;
        }

        const interval = this.config.getSyncInterval();

        if (interval <= 0) {
            this.logger.debug('Manual sync mode, not scheduling automatic sync');
            return;
        }

        this.logger.debug(`Scheduling next sync in ${interval}ms (${this.config.frequency})`);

        this.timer = setTimeout(() => {
            this.logger.info(`Automatic sync triggered (${this.config.frequency})`);
            this.syncNow();
        }, interval);
    }

    async showStatus(): Promise<void> {
        const syncTypes = [];
        if (this.config.syncChatmode) {
            syncTypes.push('Agents');
        }
        if (this.config.syncInstructions) {
            syncTypes.push('Instructions');
        }
        if (this.config.syncPrompt) {
            syncTypes.push('Prompt');
        }

        const repositories = this.config.repositories;
        const repoConfigs = this.config.repositoryConfigs;

        // Check authentication status for different providers
        const usedProviders = this.config.getUsedProviders();
        const authStatus: string[] = [];

        if (usedProviders.has('github')) {
            try {
                const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
                authStatus.push(`GitHub: ${session ? '✅ Authenticated' : '❌ Not authenticated'}`);
            } catch {
                authStatus.push('GitHub: ❌ Not authenticated');
            }
        }

        if (usedProviders.has('azure') && this.context) {
            try {
                const azureManager = new AzureDevOpsApiManager(this.context);
                const patCount = await azureManager.getPATCount();
                const cachedOrgs = await azureManager.getCachedOrganizations();
                authStatus.push(`Azure DevOps: ${patCount > 0 ? `✅ ${patCount} PAT(s) configured` : '❌ No PATs configured'}${cachedOrgs.length > 0 ? ` (${cachedOrgs.length} org(s) cached)` : ''}`);
            } catch {
                authStatus.push('Azure DevOps: ❌ No PATs configured');
            }
        }

        const items = [
            'Sync Status',
            '──────────',
            `Enabled: ${this.config.enabled ? '✅' : '❌'}`,
            `Frequency: ${this.config.frequency}`,
            `Branches: ${repoConfigs.length > 0 ? repoConfigs.map(rc => rc.branch).join(', ') : 'main'}`,
            `Prompts Directory: ${this.config.getPromptsDirectory()}`,
            `Sync on Startup: ${this.config.syncOnStartup ? '✅' : '❌'}`,
            `Show Notifications: ${this.config.showNotifications ? '✅' : '❌'}`,
            `Debug Mode: ${this.config.debug ? '✅' : '❌'}`,
            `Active Prompts Only: ✅ ${this.getSyncStatistics()}`,
        ];

        // Add authentication section if there are providers to show
        if (authStatus.length > 0) {
            items.push(
                '',
                'Authentication',
                '──────────────'
            );
            authStatus.forEach(status => items.push(status));
        }

        items.push(
            '',
            'Repositories',
            '────────────',
            `Count: ${repositories.length}`,
        );

        // Add each repository
        repoConfigs.forEach((rc, index) => {
            items.push(`${index + 1}. ${rc.url} (branch: ${rc.branch})`);
        });

        items.push(
            '',
            'Sync Types',
            '──────────',
            `Agents: ${this.config.syncChatmode ? '✅' : '❌'}`,
            `Instructions: ${this.config.syncInstructions ? '✅' : '❌'}`,
            `Prompt: ${this.config.syncPrompt ? '✅' : '❌'}`,
            `Active Types: ${syncTypes.length > 0 ? syncTypes.join(', ') : 'None'}`,
            '',
            'Commands',
            '────────',
            '• Sync Now: Ctrl+Shift+P → "Promptitude: Sync Now"',
            '• Show Status: Ctrl+Shift+P → "Promptitude: Show Status"',
            '• Open Prompts Folder: Ctrl+Shift+P → "Promptitude: Open Prompts Folder"',
            '',
            'Authentication Management',
            '───────────────────────',
            '• Add Azure DevOps PAT: Ctrl+Shift+P → "Promptitude: Add Azure DevOps Personal Access Token"',
            '• Remove Azure DevOps PAT: Ctrl+Shift+P → "Promptitude: Remove Azure DevOps Personal Access Token(s)"',
            '• Clear Azure DevOps Cache: Ctrl+Shift+P → "Promptitude: Clear Azure DevOps Authentication Cache"',
            '',
            'Configuration',
            '─────────────',
            '• Settings: File → Preferences → Settings → Search "Promptitude"'
        );

        const quickPick = vscode.window.createQuickPick();
        quickPick.items = items.map(item => ({ label: item }));
        quickPick.title = 'Promptitude Extension Status';
        quickPick.placeholder = 'Extension status and configuration';
        quickPick.canSelectMany = false;

        quickPick.onDidAccept(() => {
            quickPick.hide();
        });

        quickPick.show();
    }

    async openPromptsFolder(): Promise<void> {
        try {
            const promptsDir = this.config.getPromptsDirectory();

            // Ensure directory exists
            await this.fileSystem.ensureDirectoryExists(promptsDir);

            // Open folder in system file explorer
            const folderUri = vscode.Uri.file(promptsDir);
            await vscode.commands.executeCommand('revealFileInOS', folderUri);

            this.logger.info(`Opened prompts folder: ${promptsDir}`);

            // Show info message

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error('Failed to open prompts folder', error instanceof Error ? error : undefined);
            await this.notifications.showError(`Failed to open prompts folder: ${errorMessage}`);
        }
    }

    /**
     * Get the directory where repositories are stored locally (separate from active prompts)
     */
    private getRepositoryStorageDirectory(): string {
        // Repository storage should be in globalStorage, not in User/prompts
        // This keeps downloaded repository files separate from active prompts
        if (this.context && this.context.globalStorageUri) {
            return this.fileSystem.joinPath(this.context.globalStorageUri.fsPath, 'repos');
        }

        // Fallback: use platform-specific globalStorage path
        let globalStoragePath: string;
        const extensionId = 'logientnventive.promptitude-extension';

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

        return this.fileSystem.joinPath(globalStoragePath, 'repos');
    }

    /**
     * Migrate repository storage from old location (inside prompts dir) to new location (outside)
     */
    private async migrateRepositoryStorage(): Promise<void> {
        try {
            const fs = require('fs').promises;
            const promptsDir = this.config.getPromptsDirectory();

            // Old location: inside prompts directory
            const oldRepoStorage = path.join(promptsDir, '.promptitude', 'repos');

            // New location: outside prompts directory
            const newRepoStorage = this.repoStorageDir;

            // Check if old location exists and new location doesn't
            if (await this.fileSystem.directoryExists(oldRepoStorage)) {
                this.logger.info('Migrating repository storage to new location...');

                // Ensure parent directory exists for new location
                const newParentDir = path.dirname(newRepoStorage);
                await this.fileSystem.ensureDirectoryExists(newParentDir);

                // Move the entire repos directory
                try {
                    await fs.rename(oldRepoStorage, newRepoStorage);
                    this.logger.info(`Successfully migrated repository storage from ${oldRepoStorage} to ${newRepoStorage}`);

                    // Clean up old .promptitude directory if it's empty
                    const oldPromptitudeDir = path.join(promptsDir, '.promptitude');
                    try {
                        const entries = await fs.readdir(oldPromptitudeDir);
                        if (entries.length === 0) {
                            await fs.rmdir(oldPromptitudeDir);
                            this.logger.info('Removed empty .promptitude directory from prompts folder');
                        }
                    } catch (error) {
                        // Ignore errors during cleanup
                        this.logger.debug('Could not clean up old .promptitude directory');
                    }
                } catch (error) {
                    // If rename fails, try copy and delete
                    this.logger.warn('Could not move repository storage, attempting copy...');
                    const ncp = require('child_process').spawnSync('cp', ['-R', oldRepoStorage, newRepoStorage]);

                    if (ncp.status === 0) {
                        // Delete old directory after successful copy
                        await fs.rm(oldRepoStorage, { recursive: true, force: true });
                        this.logger.info('Successfully copied and removed old repository storage');
                    } else {
                        this.logger.error('Failed to migrate repository storage');
                    }
                }
            } else if (await this.fileSystem.directoryExists(newRepoStorage)) {
                this.logger.debug('Repository storage already at new location');
            } else {
                this.logger.debug('No repository storage to migrate');
            }
        } catch (error) {
            this.logger.error('Error during repository storage migration', error instanceof Error ? error : undefined);
            // Don't throw - allow extension to continue even if migration fails
        }
    }

    /**
     * Get the storage path for a specific repository
     */
    private getRepositoryPath(repositoryUrl: string): string {
        // Use reversible Base64 URL encoding for repository slug
        const slug = encodeRepositorySlug(repositoryUrl);
        return this.fileSystem.joinPath(this.repoStorageDir, slug);
    }

    /**
     * Generate a unique workspace filename for a prompt when there are conflicts across repositories
     * @param fileName The original filename
     * @param repositoryUrl The repository URL
     * @returns Unique filename with repository identifier if needed
     */
    private async getUniqueWorkspaceName(fileName: string, repositoryUrl: string): Promise<string> {
        // Check if this filename exists in multiple repositories
        const repositories = this.config.repositoryConfigs;
        const reposWithFile: string[] = [];

        for (const repoConfig of repositories) {
            const repoPath = this.getRepositoryPath(repoConfig.url);
            const filePath = this.fileSystem.joinPath(repoPath, fileName);

            if (await this.fileSystem.fileExists(filePath)) {
                reposWithFile.push(repoConfig.url);
            }
        }

        // If file exists in only one repository, use original name
        if (reposWithFile.length <= 1) {
            return fileName;
        }

        // File exists in multiple repos - need to make it unique
        this.logger.debug(`File ${fileName} exists in ${reposWithFile.length} repositories, generating unique name`);

        // Extract a short identifier from the repository URL
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
     * @param repositoryUrl The full repository URL
     * @returns Short identifier (e.g., "org-repo" from "https://github.com/org/repo")
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

    /**
     * Create a symlink from repository storage to active prompts directory
     * On Windows, falls back to file copy if symlink creation fails (requires admin/developer mode)
     */
    private async createPromptSymlink(sourcePath: string, targetPath: string): Promise<void> {
        this.logger.debug(`Creating symlink/copy: ${sourcePath} -> ${targetPath}`);
        this.logger.debug(`Platform: ${process.platform}`);

        // Ensure target directory exists
        const targetDir = require('path').dirname(targetPath);
        await this.fileSystem.ensureDirectoryExists(targetDir);

        // Remove existing file/symlink if it exists
        if (await this.fileSystem.fileExists(targetPath)) {
            this.logger.debug(`Target already exists, removing: ${targetPath}`);
            await vscode.workspace.fs.delete(vscode.Uri.file(targetPath));
        }

        // Try to create symlink
        const fs = require('fs').promises;
        try {
            this.logger.debug(`Attempting to create symlink...`);
            // On Windows, use 'file' type; on Unix, type parameter is optional but 'file' works
            await fs.symlink(sourcePath, targetPath, 'file');
            this.logger.info(`✅ Created symlink: ${sourcePath} -> ${targetPath}`);
        } catch (symlinkError: any) {
            this.logger.debug(`Symlink creation failed with code: ${symlinkError?.code}`);
            // Symlink creation failed (likely Windows without admin/dev mode)
            // Fall back to copying the file
            if (process.platform === 'win32' && symlinkError?.code === 'EPERM') {
                this.logger.info(`Symlink not permitted on Windows, copying file instead: ${path.basename(targetPath)}`);
                try {
                    const content = await fs.readFile(sourcePath, 'utf8');
                    await fs.writeFile(targetPath, content, 'utf8');
                    this.logger.info(`✅ Copied file as fallback: ${sourcePath} -> ${targetPath}`);
                } catch (copyError) {
                    this.logger.error(`Failed to copy file as fallback: ${sourcePath} -> ${targetPath}`, copyError instanceof Error ? copyError : undefined);
                    throw copyError;
                }
            } else {
                // On Unix systems or other Windows errors, symlink failure is more serious
                this.logger.error(`Failed to create symlink: ${sourcePath} -> ${targetPath}`, symlinkError instanceof Error ? symlinkError : undefined);
                throw symlinkError;
            }
        }

        // Verify the file was created
        const targetExists = await this.fileSystem.fileExists(targetPath);
        this.logger.debug(`Target file exists after operation: ${targetExists}`);
        if (!targetExists) {
            throw new Error(`Failed to create file at: ${targetPath}`);
        }
    }

    /**
     * Remove a symlink from the active prompts directory
     * On Windows, also removes regular file copies (fallback when symlinks aren't available)
     */
    private async removePromptSymlink(targetPath: string): Promise<void> {
        this.logger.debug(`Removing symlink/copy: ${targetPath}`);
        try {
            if (await this.fileSystem.fileExists(targetPath)) {
                // Check if it's actually a symlink before removing
                const fs = require('fs').promises;
                const stats = await fs.lstat(targetPath);

                if (stats.isSymbolicLink()) {
                    await vscode.workspace.fs.delete(vscode.Uri.file(targetPath));
                    this.logger.info(`✅ Removed symlink: ${targetPath}`);
                } else if (process.platform === 'win32') {
                    // On Windows, we may have copied files instead of symlinks
                    await vscode.workspace.fs.delete(vscode.Uri.file(targetPath));
                    this.logger.info(`✅ Removed file copy (Windows fallback): ${targetPath}`);
                } else {
                    this.logger.warn(`File exists but is not a symlink: ${targetPath}`);
                }
            }
        } catch (error) {
            this.logger.error(`Failed to remove symlink: ${targetPath}`, error instanceof Error ? error : undefined);
            throw error;
        }
    }

    /**
     * Recreate symlinks for all active prompts (e.g., after manual deletion)
     */
    async recreateActivePromptSymlinks(): Promise<void> {
        if (!this.treeProvider) {
            this.logger.debug('No tree provider available for symlink recreation');
            return;
        }

        try {
            // First, fix any broken symlinks
            await this.fixBrokenSymlinks();

            // Get all active prompts from tree provider
            const activePrompts = this.treeProvider.getSelectedPrompts();
            let recreatedCount = 0;

            this.logger.debug(`Checking ${activePrompts.length} active prompts for missing symlinks`);

            for (const prompt of activePrompts) {
                try {
                    const workspacePath = prompt.path;
                    const exists = await this.fileSystem.fileExists(workspacePath);

                    if (!exists && prompt.repositoryUrl) {
                        // Symlink is missing, recreate it
                        const fileName = this.fileSystem.getBasename(workspacePath);
                        const actualWorkspaceName = await this.activatePrompt(prompt.name, prompt.repositoryUrl);
                        // Update the prompt's workspaceName if it changed
                        if (!prompt.workspaceName || actualWorkspaceName !== fileName) {
                            prompt.workspaceName = actualWorkspaceName;
                        }
                        recreatedCount++;
                        this.logger.debug(`Recreated missing symlink for: ${prompt.name} as ${actualWorkspaceName}`);
                    }
                } catch (error) {
                    this.logger.warn(`Failed to recreate symlink for ${prompt.name}: ${error}`);
                }
            }

            if (recreatedCount > 0) {
                this.logger.info(`Recreated ${recreatedCount} missing symlinks for active prompts`);
            } else {
                this.logger.debug('All active prompt symlinks are present');
            }
        } catch (error) {
            this.logger.error(`Failed to recreate active prompt symlinks: ${error}`);
        }
    }

    /**
     * Fix broken symlinks by checking if they point to valid targets, and recreating them if not
     * On Windows, also checks file copies that may be outdated
     */
    private async fixBrokenSymlinks(): Promise<void> {
        const fs = require('fs').promises;
        const promptsDir = this.config.getPromptsDirectory();
        let fixedCount = 0;

        try {
            // Ensure the prompts directory exists before trying to scan it
            await this.fileSystem.ensureDirectoryExists(promptsDir);

            const entries = await fs.readdir(promptsDir, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.name.startsWith('.')) {
                    continue;
                }

                const fullPath = path.join(promptsDir, entry.name);

                try {
                    const stats = await fs.lstat(fullPath);

                    // Check if it's a symlink
                    if (stats.isSymbolicLink()) {
                        const targetPath = await fs.readlink(fullPath);

                        // Normalize path separators for cross-platform comparison
                        const normalizedTargetPath = targetPath.replace(/\\/g, '/');

                        // Check if target exists
                        try {
                            await fs.stat(fullPath); // This follows the symlink
                        } catch (error) {
                            // Target doesn't exist - broken symlink
                            this.logger.warn(`Found broken symlink: ${entry.name} -> ${normalizedTargetPath}`);

                            // Try to extract repository URL from the target path
                            const repositoryUrl = this.extractRepositoryUrlFromTargetPath(normalizedTargetPath);

                            if (repositoryUrl) {
                                // Check if file exists in new repository storage location
                                const repoPath = this.getRepositoryPath(repositoryUrl);
                                const newSourcePath = path.join(repoPath, entry.name);

                                if (await this.fileSystem.fileExists(newSourcePath)) {
                                    // Remove broken symlink and recreate it
                                    await fs.unlink(fullPath);
                                    await this.createPromptSymlink(newSourcePath, fullPath);
                                    fixedCount++;
                                    this.logger.info(`Fixed broken symlink: ${entry.name}`);
                                } else {
                                    this.logger.warn(`Cannot fix broken symlink ${entry.name}: source file not found at ${newSourcePath}`);
                                }
                            } else {
                                this.logger.warn(`Cannot fix broken symlink ${entry.name}: could not determine repository URL`);
                            }
                        }
                    }
                } catch (error) {
                    this.logger.warn(`Error checking symlink ${entry.name}: ${error}`);
                }
            }

            if (fixedCount > 0) {
                this.logger.info(`Fixed ${fixedCount} broken symlinks`);
            }
        } catch (error) {
            this.logger.error(`Failed to fix broken symlinks: ${error}`);
        }
    }

    /**
     * Extract repository URL from a symlink target path (including old location paths)
     * Handles both Unix and Windows path separators
     */
    private extractRepositoryUrlFromTargetPath(targetPath: string): string | undefined {
        try {
            // Normalize path separators to forward slashes for consistent parsing
            const normalizedPath = targetPath.replace(/\\/g, '/');

            // Split the path and look for the repos directory
            const pathParts = normalizedPath.split('/');
            const reposIndex = pathParts.findIndex(part => part === 'repos');

            if (reposIndex !== -1 && reposIndex + 1 < pathParts.length) {
                const encodedRepoUrl = pathParts[reposIndex + 1];
                // Decode the repository URL
                const decodedUrl = encodedRepoUrl
                    .replace(/_/g, '/')
                    .replace(/^/, 'https://');
                return decodedUrl;
            }

            return undefined;
        } catch (error) {
            this.logger.warn(`Failed to extract repository URL from target path: ${targetPath}`);
            return undefined;
        }
    }

    /**
     * Update symlink for an active prompt if it exists in workspace
     */
    private async updateActivePromptSymlink(fileName: string, repositoryUrl: string): Promise<void> {
        try {
            // Generate the unique workspace name for this prompt
            const workspaceName = await this.getUniqueWorkspaceName(fileName, repositoryUrl);
            const workspacePath = this.fileSystem.joinPath(this.config.getPromptsDirectory(), workspaceName);

            // Check if there's a symlink for this prompt in the workspace
            if (await this.fileSystem.fileExists(workspacePath)) {
                const fs = require('fs').promises;
                const stats = await fs.lstat(workspacePath);

                if (stats.isSymbolicLink()) {
                    // It's a symlink, update it to point to the new version
                    const repoPath = this.getRepositoryPath(repositoryUrl);
                    const newSourcePath = this.fileSystem.joinPath(repoPath, fileName);

                    // Remove old symlink and create new one
                    await this.removePromptSymlink(workspacePath);
                    await this.createPromptSymlink(newSourcePath, workspacePath);

                    this.logger.debug(`Updated symlink for active prompt: ${fileName} -> ${workspaceName}`);
                }
            }
        } catch (error) {
            this.logger.error(`Failed to update symlink for ${fileName}`, error instanceof Error ? error : undefined);
        }
    }

    /**
     * Activate a prompt by creating a symlink to it in the appropriate subdirectory
     */
    async activatePrompt(promptPath: string, repositoryUrl?: string): Promise<string> {
        if (!repositoryUrl) {
            const errorMsg = `Repository URL is required to activate prompt: ${promptPath}`;
            this.logger.warn(errorMsg);
            throw new Error(errorMsg);
        }

        this.logger.info(`Activating prompt: ${promptPath} from repository: ${repositoryUrl}`);

        try {
            const repoPath = this.getRepositoryPath(repositoryUrl);
            this.logger.debug(`Repository storage path: ${repoPath}`);

            const sourcePath = this.fileSystem.joinPath(repoPath, promptPath);
            this.logger.debug(`Source file path: ${sourcePath}`);

            const sourceExists = await this.fileSystem.fileExists(sourcePath);
            this.logger.debug(`Source file exists: ${sourceExists}`);

            if (!sourceExists) {
                const errorMsg = `Source file does not exist: ${sourcePath}`;
                this.logger.error(errorMsg);
                throw new Error(errorMsg);
            }

            // Generate unique workspace name if there are conflicts
            const workspaceName = await this.getUniqueWorkspaceName(promptPath, repositoryUrl);
            this.logger.debug(`Workspace name: ${workspaceName}`);

            // Create target path directly in User/prompts/ (no subdirectories)
            const promptsDir = this.config.getPromptsDirectory();
            const targetPath = this.fileSystem.joinPath(promptsDir, workspaceName);
            this.logger.debug(`Target path: ${targetPath}`);

            await this.createPromptSymlink(sourcePath, targetPath);
            this.logger.info(`✅ Successfully activated prompt: ${promptPath} as ${workspaceName}`);

            // Verify the file was created
            const targetExists = await this.fileSystem.fileExists(targetPath);
            if (!targetExists) {
                throw new Error(`Target file was not created: ${targetPath}`);
            }

            return workspaceName; // Return the actual workspace filename used
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger.error(`❌ Failed to activate prompt: ${promptPath} - ${errorMsg}`, error instanceof Error ? error : undefined);
            throw error;
        }
    }

    /**
     * Determine prompt type from filename
     */
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
     * Deactivate a prompt by removing its symlink
     * @param promptPath The workspace filename (may include repository identifier)
     */
    async deactivatePrompt(promptPath: string): Promise<void> {
        try {
            const promptsDir = this.config.getPromptsDirectory();
            const targetPath = this.fileSystem.joinPath(promptsDir, promptPath);

            this.logger.debug(`Deactivating prompt from: ${targetPath}`);
            await this.removePromptSymlink(targetPath);
            this.logger.info(`✅ Deactivated prompt: ${promptPath}`);
        } catch (error) {
            this.logger.error(`Failed to deactivate prompt: ${promptPath}`, error instanceof Error ? error : undefined);
            throw error;
        }
    }    /**
     * Clean up orphaned regular files in prompts directory that should be symlinks
     * Regular files that exist in repository storage should be removed from workspace
     */
    async cleanupOrphanedPrompts(): Promise<{ removed: number; errors: string[] }> {
        const fs = require('fs').promises;
        const promptsDir = this.config.getPromptsDirectory();
        let removed = 0;
        const errors: string[] = [];

        try {
            this.logger.info('Starting cleanup of orphaned prompts...');

            // Ensure the prompts directory exists before trying to scan it
            await this.fileSystem.ensureDirectoryExists(promptsDir);

            const entries = await fs.readdir(promptsDir, { withFileTypes: true });

            for (const entry of entries) {
                // Skip directories and hidden files
                if (entry.isDirectory() || entry.name.startsWith('.')) {
                    continue;
                }

                const fullPath = path.join(promptsDir, entry.name);

                try {
                    const stats = await fs.lstat(fullPath);

                    // Skip if it's already a symlink (these are the active prompts we want to keep)
                    // On Windows with file copy fallback, we check differently
                    const isSymlink = stats.isSymbolicLink();

                    if (isSymlink) {
                        continue;
                    }

                    // Check if this file exists in any repository storage
                    let existsInRepo = false;
                    for (const repoConfig of this.config.repositoryConfigs) {
                        // Use the base URL (without branch) for repository path computation
                        const repoPath = this.getRepositoryPath(repoConfig.url);
                        const repoFilePath = path.join(repoPath, entry.name);

                        if (await this.fileSystem.fileExists(repoFilePath)) {
                            existsInRepo = true;
                            break;
                        }
                    }

                    // If the file exists in repository storage, it's an orphaned copy
                    // However, on Windows it might be an active file copy (not a symlink)
                    // So we need to be more careful
                    if (existsInRepo) {
                        // On Windows, check if this is actually an active prompt (even if not a symlink)
                        if (process.platform === 'win32' && this.treeProvider) {
                            const allPrompts = this.treeProvider.getAllPrompts();
                            const isActive = allPrompts.some(p => p.name === entry.name && p.active);
                            if (isActive) {
                                this.logger.debug(`Keeping active Windows file copy: ${entry.name}`);
                                continue;
                            }
                        }

                        await fs.unlink(fullPath);
                        removed++;
                        this.logger.info(`Removed orphaned file: ${entry.name}`);
                    } else {
                        // Keep files that don't exist in repositories (user-created files)
                        this.logger.debug(`Keeping user-created file: ${entry.name}`);
                    }
                } catch (error) {
                    const errorMsg = `Failed to process ${entry.name}: ${error}`;
                    this.logger.warn(errorMsg);
                    errors.push(errorMsg);
                }
            }

            this.logger.info(`Cleanup complete. Removed ${removed} orphaned files`);
            return { removed, errors };
        } catch (error) {
            this.logger.error('Failed to cleanup orphaned prompts', error instanceof Error ? error : undefined);
            throw error;
        }
    }

    dispose(): void {
        this.logger.info('Disposing SyncManager...');

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        this.logger.info('SyncManager disposed');
    }
}
