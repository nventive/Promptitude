import * as vscode from 'vscode';
import { SyncManager } from './syncManager';
import { StatusBarManager } from './statusBarManager';
import { ConfigManager } from './configManager';
import { Logger } from './utils/logger';
import { AzureDevOpsApiManager } from './utils/azureDevOps';
import { PromptTreeDataProvider } from './ui/promptTreeProvider';
import { PromptDetailsWebviewProvider } from './ui/promptDetailsWebview';
import { PromptCardsWebviewProvider } from './ui/promptCardsWebview';
import { PromptCommandManager } from './ui/promptCommands';


let syncManager: SyncManager;
let statusBarManager: StatusBarManager;
let logger: Logger;
let promptTreeProvider: PromptTreeDataProvider;
let promptDetailsProvider: PromptDetailsWebviewProvider;
let promptCardsProvider: PromptCardsWebviewProvider;
let promptCommandManager: PromptCommandManager;

export function activate(context: vscode.ExtensionContext) {
    logger = Logger.get('Extension');
    logger.info('Promptitude Extension is activating...');

    // If debugging and a debugger is attached, auto-select the Output channel without stealing focus
    try {
        // Dynamically import inspector to avoid bundling issues; optional behavior
        const inspector = require('inspector');
        const debuggerAttached = !!inspector.url();
        if (debuggerAttached) {
            // Show output channel but preserve focus (don't steal keyboard focus)
            logger.show(true);
        }
    } catch {
        // Ignore if inspector isn't available
    }

    const configManager = new ConfigManager(context);
    statusBarManager = new StatusBarManager();
    
    // Initialize UI components first
    promptTreeProvider = new PromptTreeDataProvider(configManager);
    promptDetailsProvider = new PromptDetailsWebviewProvider(context.extensionUri, configManager, context);
    promptCardsProvider = new PromptCardsWebviewProvider(context.extensionUri, configManager, promptTreeProvider);

    // Initialize sync manager with tree provider access
    syncManager = new SyncManager(configManager, statusBarManager, promptTreeProvider);
    
    // Initialize command manager with sync manager for symlink operations
    promptCommandManager = new PromptCommandManager(promptTreeProvider, promptDetailsProvider, configManager, syncManager);

    // Register cards webview provider
    vscode.window.registerWebviewViewProvider(
        PromptCardsWebviewProvider.viewType,
        promptCardsProvider
    );

    // Register details webview provider
    vscode.window.registerWebviewViewProvider(
        PromptDetailsWebviewProvider.viewType,
        promptDetailsProvider
    );

    // Register prompt commands
    promptCommandManager.registerCommands(context);

    // Register original commands
    const syncNowCommand = vscode.commands.registerCommand('promptitude.syncNow', async () => {
        await syncManager.syncNow();
        // Refresh prompts after sync
        promptTreeProvider.refresh();
        promptCardsProvider.refresh();
    });

    const showStatusCommand = vscode.commands.registerCommand('promptitude.showStatus', async () => {
        await syncManager.showStatus();
    });

    const openPromptsFolderCommand = vscode.commands.registerCommand('promptitude.openPromptsFolder', async () => {
        await syncManager.openPromptsFolder();
    });

    const cleanupOrphanedPromptsCommand = vscode.commands.registerCommand('promptitude.cleanupOrphanedPrompts', async () => {
        try {
            const result = await vscode.window.showWarningMessage(
                'This will remove regular files from your prompts directory that have copies in repository storage. Only symlinked prompts (active prompts) will remain. Continue?',
                { modal: true },
                'Yes, Clean Up'
            );

            if (result === 'Yes, Clean Up') {
                const cleanup = await syncManager.cleanupOrphanedPrompts();
                
                if (cleanup.removed > 0) {
                    vscode.window.showInformationMessage(
                        `✅ Cleaned up ${cleanup.removed} orphaned prompt file(s). Only active (symlinked) prompts remain.`
                    );
                } else {
                    vscode.window.showInformationMessage('No orphaned prompts found. Your prompts directory is clean!');
                }

                // Refresh UI
                promptTreeProvider.refresh();
                promptCardsProvider.refresh();

                if (cleanup.errors.length > 0) {
                    logger.warn(`Cleanup completed with ${cleanup.errors.length} errors`);
                }
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to cleanup orphaned prompts: ${errorMessage}`);
        }
    });

    // Azure DevOps PAT management commands
    const addAzureDevOpsPATCommand = vscode.commands.registerCommand('promptitude.addAzureDevOpsPAT', async () => {
        try {
            const azureManager = new AzureDevOpsApiManager(context);
            const success = await azureManager.requestAuthentication();

            if (success) {
                const patCount = await azureManager.getPATCount();
                vscode.window.showInformationMessage(`✅ Azure DevOps PAT added successfully! (Total: ${patCount})`);
            } else {
                vscode.window.showWarningMessage('Adding Azure DevOps PAT was cancelled.');
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to add Azure DevOps PAT: ${errorMessage}`);
        }
    });

    const clearAzureDevOpsPATCommand = vscode.commands.registerCommand('promptitude.clearAzureDevOpsPAT', async () => {
        try {
            const azureManager = new AzureDevOpsApiManager(context);
            const patCount = await azureManager.getPATCount();

            if (patCount === 0) {
                vscode.window.showInformationMessage('No Azure DevOps PATs configured to clear.');
                return;
            }

            // Show options to remove specific PAT or all
            const items = [];
            for (let i = 0; i < patCount; i++) {
                items.push({
                    label: `$(key) PAT ${i + 1}`,
                    description: `Remove PAT at position ${i + 1}`,
                    index: i
                });
            }
            items.push({
                label: '$(trash) Remove All PATs',
                description: `Remove all ${patCount} PAT(s)`,
                index: -1
            });

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: `You have ${patCount} PAT(s) configured. Select which to remove:`
            });

            if (!selected) {
                return;
            }

            if (selected.index === -1) {
                // Remove all
                const confirm = await vscode.window.showWarningMessage(
                    `Are you sure you want to remove all ${patCount} Azure DevOps PAT(s)? You will need to re-enter them to sync from Azure DevOps repositories.`,
                    'Yes, Remove All',
                    'Cancel'
                );

                if (confirm === 'Yes, Remove All') {
                    await azureManager.clearAllPATs();
                    vscode.window.showInformationMessage('✅ All Azure DevOps PATs removed successfully.');
                }
            } else {
                // Remove specific PAT
                const confirm = await vscode.window.showWarningMessage(
                    `Are you sure you want to remove PAT ${selected.index + 1}?`,
                    'Yes, Remove',
                    'Cancel'
                );

                if (confirm === 'Yes, Remove') {
                    await azureManager.removePAT(selected.index);
                    vscode.window.showInformationMessage(`✅ PAT ${selected.index + 1} removed successfully.`);
                }
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to clear Azure DevOps PATs: ${errorMessage}`);
        }
    });

    const clearAzureDevOpsCacheCommand = vscode.commands.registerCommand('promptitude.clearAzureDevOpsCache', async () => {
        try {
            const azureManager = new AzureDevOpsApiManager(context);
            const cachedOrgs = await azureManager.getCachedOrganizations();

            if (cachedOrgs.length === 0) {
                vscode.window.showInformationMessage('No Azure DevOps cache to clear.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Clear Azure DevOps authentication cache for ${cachedOrgs.length} organization(s)? This will force re-authentication on the next sync.`,
                'Yes, Clear Cache',
                'Cancel'
            );

            if (confirm === 'Yes, Clear Cache') {
                await azureManager.clearCache();
                vscode.window.showInformationMessage(`✅ Azure DevOps cache cleared for ${cachedOrgs.length} organization(s).`);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to clear Azure DevOps cache: ${errorMessage}`);
        }
    });

    // Add to subscriptions
    context.subscriptions.push(
        syncNowCommand,
        showStatusCommand,
        openPromptsFolderCommand,
        cleanupOrphanedPromptsCommand,
        addAzureDevOpsPATCommand,
        clearAzureDevOpsPATCommand,
        clearAzureDevOpsCacheCommand,
        statusBarManager
    );

    // Initialize sync manager
    syncManager.initialize(context);

    // Set up listener for configuration changes to refresh prompts
    const configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('promptitude')) {
            promptTreeProvider.refresh();
            promptCardsProvider.refresh();
        }
    });
    context.subscriptions.push(configDisposable);

    logger.info('Promptitude Extension activated successfully');
}

export function deactivate() {
    logger?.info('Promptitude Extension is deactivating...');
    syncManager?.dispose();
    statusBarManager?.dispose();
    Logger.disposeSharedChannel();
}
