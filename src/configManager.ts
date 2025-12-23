import * as vscode from 'vscode';
import { GitProviderFactory } from './utils/gitProviderFactory';
import { GitProvider } from './utils/gitProvider';
import { Logger } from './utils/logger';
import * as os from 'os';
import * as path from 'path';

export interface SyncFrequency {
    startup: number;
    hourly: number;
    daily: number;
    weekly: number;
    manual: number;
}

export class ConfigManager {
    private static readonly SYNC_FREQUENCIES: SyncFrequency = {
        startup: 0, // Only on startup
        hourly: 60 * 60 * 1000, // 1 hour
        daily: 24 * 60 * 60 * 1000, // 24 hours
        weekly: 7 * 24 * 60 * 60 * 1000, // 7 days
        manual: -1 // Never automatic
    };

    private context?: vscode.ExtensionContext;
    private logger = Logger.get('ConfigManager');

    constructor(context?: vscode.ExtensionContext) {
        this.context = context;
    }

    get enabled(): boolean {
        return vscode.workspace.getConfiguration('promptitude').get('enabled', true);
    }

    get frequency(): keyof SyncFrequency {
        return vscode.workspace.getConfiguration('promptitude').get('frequency', 'daily');
    }

    get customPath(): string {
        return vscode.workspace.getConfiguration('promptitude').get('customPath', '');
    }

    get repositories(): string[] {
        const repository = vscode.workspace.getConfiguration('promptitude').get<string[]>('repositories', []);
        const sanitized = repository
            .map(r => (r ?? '').trim())
            .filter(r => r.length > 0);
        const uniqueArray = Array.from(new Set(sanitized));
        
        // If duplicates were found, update the configuration to remove them.
        if (uniqueArray.length !== repository.length) {
            this.logger.info(`Removing ${repository.length - uniqueArray.length} duplicate repository URL(s) from configuration`);
            
            // Update the configuration to persist the deduplicated list.
            vscode.workspace.getConfiguration('promptitude')
                .update('repositories', uniqueArray, vscode.ConfigurationTarget.Global)
                .then(() => {
                    vscode.window.showInformationMessage(
                        `Removed ${repository.length - uniqueArray.length} duplicate repository URL(s) from configuration.`
                    );
                }, (error) => {
                    this.logger.error('Failed to update repositories configuration', error instanceof Error ? error : undefined);
                    vscode.window.showWarningMessage(
                        `Found ${repository.length - uniqueArray.length} duplicate repository URL(s) but failed to update configuration. Please remove duplicates manually.`
                    );
                });
        }
        
        return uniqueArray;
    }

    /**
     * Returns repositories with their associated branch. The repositories setting accepts
     * entries in the form "https://github.com/owner/repo", "https://dev.azure.com/org/project/_git/repo", or with branch "repo_url|branch".
     * If no branch is specified, defaults to "main".
     */
    get repositoryConfigs(): { url: string; branch: string }[] {
        return this.repositories.map(entry => {
            const [url, branch] = entry.split('|');
            return { url, branch: (branch && branch.trim()) ? branch.trim() : 'main' };
        });
    }

    get syncOnStartup(): boolean {
        return vscode.workspace.getConfiguration('promptitude').get('syncOnStartup', true);
    }

    get showNotifications(): boolean {
        return vscode.workspace.getConfiguration('promptitude').get('showNotifications', true);
    }

    get debug(): boolean {
        return vscode.workspace.getConfiguration('promptitude').get('debug', false);
    }

    get syncChatmode(): boolean {
        return vscode.workspace.getConfiguration('promptitude').get('syncChatmode', true);
    }

    get syncInstructions(): boolean {
        return vscode.workspace.getConfiguration('promptitude').get('syncInstructions', false);
    }

    get syncPrompt(): boolean {
        return vscode.workspace.getConfiguration('promptitude').get('syncPrompt', true);
    }

    getSyncInterval(): number {
        return ConfigManager.SYNC_FREQUENCIES[this.frequency];
    }

    /**
     * Get the VS Code User prompts directory where GitHub Copilot reads prompts from.
     * This is where symlinks/copies should be created when activating prompts.
     * 
     * - Default profile: <User Data>/User/prompts
     * - Named profile: <User Data>/User/profiles/<profile-id>/prompts
     */
    getPromptsDirectory(): string {
        if (this.customPath) {
            this.logger.info(`Using custom prompts path: ${this.customPath}`);
            return this.customPath;
        }

        // Use VS Code's storage path to determine the correct User directory
        if (this.context && this.context.globalStorageUri) {
            // globalStorageUri path structure:
            // - Default: <User Data>/User/globalStorage/<extension-id>
            // - Profile: <User Data>/User/profiles/<profile-id>/globalStorage/<extension-id>
            const globalStoragePath = this.context.globalStorageUri.fsPath;

            let userPromptsPath: string;

            // Check if we're in a profile
            if (globalStoragePath.includes(`${path.sep}profiles${path.sep}`)) {
                // Extract profile path: .../User/profiles/<profile-id>/globalStorage/... -> .../User/profiles/<profile-id>
                const parts = globalStoragePath.split(path.sep);
                const profilesIndex = parts.indexOf('profiles');

                if (profilesIndex !== -1 && profilesIndex + 1 < parts.length) {
                    // Reconstruct path to profile's prompts directory
                    const profilePath = parts.slice(0, profilesIndex + 2).join(path.sep);
                    userPromptsPath = path.join(profilePath, 'prompts');
                } else {
                    // Fallback if parsing fails
                    this.logger.warn('Failed to parse profile path, using fallback');
                    return this.getFallbackPromptsDirectory();
                }
            } else {
                // Default profile: .../User/globalStorage/... -> .../User
                const parts = globalStoragePath.split(path.sep);
                const userIndex = parts.indexOf('User');

                if (userIndex !== -1) {
                    const userPath = parts.slice(0, userIndex + 1).join(path.sep);
                    userPromptsPath = path.join(userPath, 'prompts');
                } else {
                    // Fallback if parsing fails
                    this.logger.warn('Failed to parse User path, using fallback');
                    return this.getFallbackPromptsDirectory();
                }
            }

            if (this.debug) {
                this.logger.debug(`VS Code User prompts directory: ${userPromptsPath}`);
            }

            return userPromptsPath;
        }

        // Fallback to platform-specific user data directory
        return this.getFallbackPromptsDirectory();
    }

    /**
     * Fallback to platform-specific VS Code User/prompts paths
     */
    private getFallbackPromptsDirectory(): string {
        this.logger.warn('Using fallback prompts directory paths (extension context not available)');

        try {
            let promptsPath: string;
            switch (process.platform) {
                case 'win32':
                    // Windows: C:\Users\username\AppData\Roaming\Code\User\prompts
                    promptsPath = path.join(
                        os.homedir(),
                        'AppData',
                        'Roaming',
                        'Code',
                        'User',
                        'prompts'
                    );
                    break;
                case 'darwin':
                    // macOS: /Users/username/Library/Application Support/Code/User/prompts
                    promptsPath = path.join(
                        os.homedir(),
                        'Library',
                        'Application Support',
                        'Code',
                        'User',
                        'prompts'
                    );
                    break;
                case 'linux':
                    // Linux: /home/username/.config/Code/User/prompts
                    promptsPath = path.join(
                        os.homedir(),
                        '.config',
                        'Code',
                        'User',
                        'prompts'
                    );
                    break;
                default:
                    promptsPath = path.join(os.homedir(), '.vscode', 'prompts');
                    break;
            }

            if (this.debug) {
                this.logger.debug(`Fallback prompts directory: ${promptsPath}`);
            }
            return promptsPath;
        } catch (error) {
            throw new Error('Unable to determine prompts directory: Node.js environment not available');
        }
    }

    onConfigurationChanged(callback: () => void): vscode.Disposable {
        return vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('promptitude')) {
                callback();
            }
        });
    }

    /**
     * Get the set of unique Git providers used in the configured repositories
     */
    getUsedProviders(): Set<GitProvider> {
        const providers = new Set<GitProvider>();

        // In getUsedProviders():
        for (const repo of this.repositories) {
            const [url] = repo.split('|');
            try {
                const provider = GitProviderFactory.detectProvider(url);
                if (provider !== 'unknown') {
                    providers.add(provider);
                }
            } catch {
                // Ignore invalid URLs
            }
        }

        return providers;
    }

    /**
     * Check if any configured repositories use GitHub
     */
    hasGitHubRepositories(): boolean {
        return this.getUsedProviders().has('github');
    }

    /**
     * Check if any configured repositories use Azure DevOps
     */
    hasAzureDevOpsRepositories(): boolean {
        return this.getUsedProviders().has('azure');
    }

    /**
     * Get repositories grouped by provider
     */
    getRepositoriesByProvider(): Map<GitProvider, string[]> {
        const providerMap = new Map<GitProvider, string[]>();

        // Sanitize branch suffix before detection
        for (const repo of this.repositories) {
            const [url] = repo.split('|');
            try {
                const provider = GitProviderFactory.detectProvider(url);
                if (provider !== 'unknown') {
                    if (!providerMap.has(provider)) {
                        providerMap.set(provider, []);
                    }
                    providerMap.get(provider)!.push(repo);
                }
            } catch {
                // Ignore invalid URLs
            }
        }

        return providerMap;
    }
}
