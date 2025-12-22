import * as vscode from 'vscode';
import { PromptTreeDataProvider, PromptInfo, PromptTreeItem } from './promptTreeProvider';
import { PromptDetailsWebviewProvider } from './promptDetailsWebview';
import { ConfigManager } from '../configManager';
import { FileSystemManager } from '../utils/fileSystem';
import { Logger } from '../utils/logger';
import { SyncManager } from '../syncManager';

export class PromptCommandManager {
    private logger: Logger;
    private fileSystem: FileSystemManager;

    constructor(
        private treeProvider: PromptTreeDataProvider,
        private webviewProvider: PromptDetailsWebviewProvider,
        private config: ConfigManager,
        private syncManager?: SyncManager
    ) {
        this.logger = Logger.get('PromptCommandManager');
        this.fileSystem = new FileSystemManager();
    }

    registerCommands(context: vscode.ExtensionContext): void {
        // Tree view commands
        const refreshCommand = vscode.commands.registerCommand('prompts.refresh', () => {
            this.refreshPrompts();
        });

        const toggleSelectionCommand = vscode.commands.registerCommand('prompts.toggleSelection', async (item: PromptTreeItem | PromptInfo) => {
            await this.toggleSelection(item);
        });

        const selectAllCommand = vscode.commands.registerCommand('prompts.selectAll', () => {
            this.selectAll();
        });

        const deselectAllCommand = vscode.commands.registerCommand('prompts.deselectAll', () => {
            return this.deselectAll();
        });

        // Prompt action commands
        const editPromptCommand = vscode.commands.registerCommand('prompts.editPrompt', async (item: PromptTreeItem | PromptInfo) => {
            await this.editPrompt(item);
        });

        const viewPromptCommand = vscode.commands.registerCommand('prompts.viewPrompt', async (item: PromptTreeItem | PromptInfo) => {
            await this.viewPrompt(item);
        });

        const deletePromptCommand = vscode.commands.registerCommand('prompts.deletePrompt', async (item: PromptTreeItem | PromptInfo) => {
            await this.deletePrompt(item);
        });

        const duplicatePromptCommand = vscode.commands.registerCommand('prompts.duplicatePrompt', async (item: PromptTreeItem | PromptInfo) => {
            await this.duplicatePrompt(item);
        });

        // Settings command
        const openSettingsCommand = vscode.commands.registerCommand('prompts.openSettings', () => {
            this.openSettings();
        });

        // Add all commands to subscriptions
        context.subscriptions.push(
            refreshCommand,
            toggleSelectionCommand,
            selectAllCommand,
            deselectAllCommand,
            editPromptCommand,
            viewPromptCommand,
            deletePromptCommand,
            duplicatePromptCommand,
            openSettingsCommand
        );

        this.logger.info('Prompt commands registered successfully');
    }

    private refreshPrompts(): void {
        this.logger.debug('Refreshing prompts tree view');
        this.treeProvider.refresh();
        vscode.window.showInformationMessage('Prompts refreshed');
    }

    private async toggleSelection(item: PromptTreeItem | PromptInfo): Promise<void> {
        try {
            const promptInfo = this.getPromptInfo(item);
            if (!promptInfo) {
                this.logger.warn('Invalid prompt item for toggle selection');
                vscode.window.showErrorMessage('Invalid prompt item');
                return;
            }

            this.logger.info(`Toggling selection for: ${promptInfo.name}, current active: ${promptInfo.active}, repositoryUrl: ${promptInfo.repositoryUrl || 'none'}`);
            this.logger.debug(`Prompt info details - path: ${promptInfo.path}, workspaceName: ${promptInfo.workspaceName || 'none'}`);

            // Store the current state before toggling
            const wasActive = promptInfo.active;
            this.logger.debug(`State before toggle: wasActive = ${wasActive}`);

            // Toggle the selection in the tree provider first (optimistic update)
            this.treeProvider.toggleSelection(promptInfo);
            this.logger.debug(`State after toggle: promptInfo.active = ${promptInfo.active}`);

            // Handle symlink creation/removal if SyncManager is available
            if (this.syncManager) {
                this.logger.debug(`SyncManager is available, proceeding with file operations`);
                if (promptInfo.active) {
                    // Prompt was activated - create symlink
                    const repositoryUrl = promptInfo.repositoryUrl;
                    if (repositoryUrl) {
                        this.logger.info(`Activating prompt: ${promptInfo.name} with URL: ${repositoryUrl}`);

                        // Show immediate feedback
                        const activatingMsg = vscode.window.setStatusBarMessage(`$(sync~spin) Activating prompt: ${promptInfo.name}...`);

                        try {
                            const actualWorkspaceName = await this.syncManager.activatePrompt(promptInfo.name, repositoryUrl);
                            // Update the workspace name in the prompt info
                            if (actualWorkspaceName !== promptInfo.name) {
                                promptInfo.workspaceName = actualWorkspaceName;
                                // Update the path to reflect the actual workspace filename
                                const promptsDir = this.config.getPromptsDirectory();
                                promptInfo.path = this.fileSystem.joinPath(promptsDir, actualWorkspaceName);
                            }
                            this.logger.info(`Successfully created symlink/copy for activated prompt: ${promptInfo.name} as ${actualWorkspaceName}`);
                            activatingMsg.dispose();

                            // File operation succeeded - refresh tree and update webview
                            this.treeProvider.refresh();
                            this.webviewProvider.updateSelectionStatus(promptInfo);
                            vscode.window.showInformationMessage(`✅ Activated prompt: ${promptInfo.name}`);
                        } catch (activationError) {
                            activatingMsg.dispose();
                            // Revert the toggle since activation failed
                            this.treeProvider.toggleSelection(promptInfo);
                            this.webviewProvider.updateSelectionStatus(promptInfo);
                            throw activationError;
                        }
                    } else {
                        const errorMsg = `No repository URL found for prompt: ${promptInfo.name}. Cannot create symlink.`;
                        this.logger.error(errorMsg);
                        vscode.window.showErrorMessage(errorMsg);
                        // Revert the toggle since we couldn't create the symlink
                        this.treeProvider.toggleSelection(promptInfo);
                        this.webviewProvider.updateSelectionStatus(promptInfo);
                    }
                } else {
                    // Prompt was deactivated - remove symlink
                    // Use workspaceName if available, otherwise fall back to name
                    const nameToDeactivate = promptInfo.workspaceName || promptInfo.name;
                    this.logger.info(`Deactivating prompt: ${nameToDeactivate}`);

                    try {
                        await this.syncManager.deactivatePrompt(nameToDeactivate);
                        this.logger.info(`Successfully removed symlink/copy for deactivated prompt: ${nameToDeactivate}`);

                        // File operation succeeded - refresh tree and update webview
                        this.treeProvider.refresh();
                        this.webviewProvider.updateSelectionStatus(promptInfo);
                        vscode.window.showInformationMessage(`✅ Deactivated prompt: ${promptInfo.name}`);
                    } catch (deactivationError) {
                        // Revert the toggle since deactivation failed
                        this.treeProvider.toggleSelection(promptInfo);
                        this.webviewProvider.updateSelectionStatus(promptInfo);
                        throw deactivationError;
                    }
                }
            } else {
                this.logger.error('SyncManager not available - cannot create/remove symlinks');
                vscode.window.showErrorMessage('SyncManager not available');
                // Revert the toggle
                this.treeProvider.toggleSelection(promptInfo);
                this.webviewProvider.updateSelectionStatus(promptInfo);
            }

            const status = promptInfo.active ? 'activated' : 'deactivated';
            this.logger.info(`Prompt ${promptInfo.name} ${status}`);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to toggle selection: ${errorMsg}`, error instanceof Error ? error : undefined);
            vscode.window.showErrorMessage(`Failed to toggle selection: ${errorMsg}`);
            // Try to revert the toggle
            try {
                const promptInfo = this.getPromptInfo(item);
                if (promptInfo) {
                    this.treeProvider.toggleSelection(promptInfo);
                }
            } catch {
                // Ignore revert errors
            }
        }
    }

    private async selectAll(): Promise<void> {
        try {
            if (!this.syncManager) {
                vscode.window.showErrorMessage('SyncManager not available');
                return;
            }

            // Get all prompts that are currently inactive
            const allPrompts = this.treeProvider.getAllPrompts();
            const inactivePrompts = allPrompts.filter(p => !p.active);

            if (inactivePrompts.length === 0) {
                vscode.window.showInformationMessage('All prompts are already activated');
                return;
            }

            // Use withProgress for proper loading indicator
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Activating ${inactivePrompts.length} prompts`,
                cancellable: false
            }, async (progress) => {
                if (!this.syncManager) {
                    throw new Error('SyncManager not available');
                }

                // Activate all inactive prompts by creating symlinks
                let successCount = 0;
                const errors: string[] = [];

                for (let i = 0; i < inactivePrompts.length; i++) {
                    const prompt = inactivePrompts[i];
                    progress.report({ 
                        increment: (100 / inactivePrompts.length),
                        message: `${i + 1}/${inactivePrompts.length}: ${prompt.name}`
                    });

                    try {
                        if (!prompt.repositoryUrl) {
                            errors.push(`${prompt.name}: No repository URL`);
                            continue;
                        }

                        const workspaceName = await this.syncManager.activatePrompt(prompt.name, prompt.repositoryUrl);
                        prompt.workspaceName = workspaceName;
                        prompt.active = true;
                        successCount++;

                        // Update details view if this prompt is currently being viewed
                        this.webviewProvider.updateSelectionStatus(prompt);
                    } catch (error) {
                        const errorMsg = error instanceof Error ? error.message : String(error);
                        errors.push(`${prompt.name}: ${errorMsg}`);
                        this.logger.warn(`Failed to activate ${prompt.name}: ${errorMsg}`);
                    }
                }

                this.treeProvider.refresh();

                if (successCount === inactivePrompts.length) {
                    vscode.window.showInformationMessage(`✅ Activated all ${successCount} prompts`);
                } else if (successCount > 0) {
                    vscode.window.showWarningMessage(`⚠️ Activated ${successCount}/${inactivePrompts.length} prompts. ${errors.length} failed.`);
                } else {
                    vscode.window.showErrorMessage(`❌ Failed to activate prompts: ${errors.join(', ')}`);
                }

                this.logger.debug(`Activated ${successCount}/${inactivePrompts.length} prompts`);
            });
        } catch (error) {
            this.logger.error(`Failed to activate all prompts: ${error}`);
            vscode.window.showErrorMessage(`Failed to activate all prompts: ${error}`);
        }
    }

    private async deselectAll(): Promise<void> {
        try {
            if (!this.syncManager) {
                vscode.window.showErrorMessage('SyncManager not available');
                return;
            }

            // Get all currently selected prompts
            const activePrompts = this.treeProvider.getSelectedPrompts();

            if (activePrompts.length === 0) {
                vscode.window.showInformationMessage('No prompts are currently activated');
                return;
            }

            // Use withProgress for proper loading indicator
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Deactivating ${activePrompts.length} prompts`,
                cancellable: false
            }, async (progress) => {
                if (!this.syncManager) {
                    throw new Error('SyncManager not available');
                }

                // Deactivate all prompts efficiently by removing symlinks directly
                let successCount = 0;
                const errors: string[] = [];

                for (let i = 0; i < activePrompts.length; i++) {
                    const prompt = activePrompts[i];
                    progress.report({ 
                        increment: (100 / activePrompts.length),
                        message: `${i + 1}/${activePrompts.length}: ${prompt.name}`
                    });

                    try {
                        const nameToDeactivate = prompt.workspaceName || prompt.name;
                        await this.syncManager.deactivatePrompt(nameToDeactivate);
                        prompt.active = false;
                        successCount++;

                        // Update details view if this prompt is currently being viewed
                        this.webviewProvider.updateSelectionStatus(prompt);
                    } catch (error) {
                        const errorMsg = error instanceof Error ? error.message : String(error);
                        errors.push(`${prompt.name}: ${errorMsg}`);
                        this.logger.warn(`Failed to deactivate ${prompt.name}: ${errorMsg}`);
                    }
                }

                this.treeProvider.refresh();

                if (successCount === activePrompts.length) {
                    vscode.window.showInformationMessage(`✅ Deactivated all ${successCount} prompts`);
                } else if (successCount > 0) {
                    vscode.window.showWarningMessage(`⚠️ Deactivated ${successCount}/${activePrompts.length} prompts. ${errors.length} failed.`);
                } else {
                    vscode.window.showErrorMessage(`❌ Failed to deactivate prompts: ${errors.join(', ')}`);
                }

                this.logger.debug(`Deactivated ${successCount}/${activePrompts.length} prompts`);
            });
        } catch (error) {
            this.logger.error(`Failed to deactivate all prompts: ${error}`);
            vscode.window.showErrorMessage(`Failed to deactivate all prompts: ${error}`);
        }
    }

    private async editPrompt(item: PromptTreeItem | PromptInfo): Promise<void> {
        try {
            const promptInfo = this.getPromptInfo(item);
            if (!promptInfo) {
                this.logger.warn('Invalid prompt item for edit');
                return;
            }

            const document = await vscode.workspace.openTextDocument(promptInfo.path);
            await vscode.window.showTextDocument(document);
            this.logger.debug(`Opened prompt for editing: ${promptInfo.name}`);
        } catch (error) {
            this.logger.error(`Failed to edit prompt: ${error}`);
            vscode.window.showErrorMessage(`Failed to open prompt for editing: ${error}`);
        }
    }

    private async viewPrompt(item: PromptTreeItem | PromptInfo): Promise<void> {
        try {
            const promptInfo = this.getPromptInfo(item);
            if (!promptInfo) {
                this.logger.warn('Invalid prompt item for view');
                return;
            }

            await this.webviewProvider.showPrompt(promptInfo);
            this.logger.debug(`Viewing prompt in details panel: ${promptInfo.name}`);
        } catch (error) {
            this.logger.error(`Failed to view prompt: ${error}`);
            vscode.window.showErrorMessage(`Failed to view prompt: ${error}`);
        }
    }

    private async deletePrompt(item: PromptTreeItem | PromptInfo): Promise<void> {
        try {
            const promptInfo = this.getPromptInfo(item);
            if (!promptInfo) {
                this.logger.warn('Invalid prompt item for delete');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to delete "${promptInfo.name}"?`,
                { modal: true },
                'Delete'
            );

            if (confirm === 'Delete') {
                await vscode.workspace.fs.delete(vscode.Uri.file(promptInfo.path));
                this.treeProvider.refresh();
                this.webviewProvider.clearPrompt();

                vscode.window.showInformationMessage(`Prompt "${promptInfo.name}" deleted successfully`);
                this.logger.debug(`Deleted prompt: ${promptInfo.name}`);
            }
        } catch (error) {
            this.logger.error(`Failed to delete prompt: ${error}`);
            vscode.window.showErrorMessage(`Failed to delete prompt: ${error}`);
        }
    }

    private async duplicatePrompt(item: PromptTreeItem | PromptInfo): Promise<void> {
        try {
            const promptInfo = this.getPromptInfo(item);
            if (!promptInfo) {
                this.logger.warn('Invalid prompt item for duplicate');
                return;
            }

            // Generate new filename
            const baseName = promptInfo.name.replace(/\.[^/.]+$/, '');
            const extension = promptInfo.name.substring(baseName.length);
            let newName = `${baseName}_copy${extension}`;

            // Ensure unique filename
            const promptsDir = this.config.getPromptsDirectory();
            let counter = 1;
            while (await this.fileSystem.fileExists(this.fileSystem.joinPath(promptsDir, newName))) {
                newName = `${baseName}_copy${counter}${extension}`;
                counter++;
            }

            const newPath = this.fileSystem.joinPath(promptsDir, newName);

            // Copy content
            const content = await this.fileSystem.readFileContent(promptInfo.path);
            await this.fileSystem.writeFileContent(newPath, content);

            // Refresh tree view
            this.treeProvider.refresh();

            vscode.window.showInformationMessage(`Prompt duplicated as "${newName}"`);
            this.logger.debug(`Duplicated prompt ${promptInfo.name} as ${newName}`);
        } catch (error) {
            this.logger.error(`Failed to duplicate prompt: ${error}`);
            vscode.window.showErrorMessage(`Failed to duplicate prompt: ${error}`);
        }
    }

    private openSettings(): void {
        try {
            vscode.commands.executeCommand('workbench.action.openSettings', 'promptitude');
            this.logger.debug('Opened Promptitude settings');
        } catch (error) {
            this.logger.error(`Failed to open settings: ${error}`);
            vscode.window.showErrorMessage(`Failed to open settings: ${error}`);
        }
    }

    private getPromptInfo(item: PromptTreeItem | PromptInfo): PromptInfo | undefined {
        if ('promptInfo' in item) {
            return item.promptInfo;
        }

        if ('name' in item && 'path' in item && 'type' in item) {
            return item as PromptInfo;
        }

        return undefined;
    }

    // Bulk operations
    async deleteSelectedPrompts(): Promise<void> {
        try {
            const selectedPrompts = this.treeProvider.getSelectedPrompts();

            if (selectedPrompts.length === 0) {
                vscode.window.showInformationMessage('No active prompts to delete');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to delete ${selectedPrompts.length} active prompt(s)?`,
                { modal: true },
                'Delete All'
            );

            if (confirm === 'Delete All') {
                let deletedCount = 0;
                const errors: string[] = [];

                for (const prompt of selectedPrompts) {
                    try {
                        await vscode.workspace.fs.delete(vscode.Uri.file(prompt.path));
                        deletedCount++;
                    } catch (error) {
                        errors.push(`${prompt.name}: ${error}`);
                    }
                }

                this.treeProvider.refresh();
                this.webviewProvider.clearPrompt();

                if (errors.length === 0) {
                    vscode.window.showInformationMessage(`Successfully deleted ${deletedCount} prompts`);
                } else {
                    vscode.window.showWarningMessage(
                        `Deleted ${deletedCount} prompts, but ${errors.length} failed. Check output for details.`
                    );
                    this.logger.warn(`Bulk delete errors: ${errors.join('; ')}`);
                }

                this.logger.debug(`Bulk deleted ${deletedCount} prompts with ${errors.length} errors`);
            }
        } catch (error) {
            this.logger.error(`Failed to delete selected prompts: ${error}`);
            vscode.window.showErrorMessage(`Failed to delete selected prompts: ${error}`);
        }
    }

    async exportSelectedPrompts(): Promise<void> {
        try {
            const selectedPrompts = this.treeProvider.getSelectedPrompts();

            if (selectedPrompts.length === 0) {
                vscode.window.showInformationMessage('No active prompts to export');
                return;
            }

            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(`prompts_export_${new Date().toISOString().split('T')[0]}.zip`),
                filters: {
                    'Archive files': ['zip'],
                    'All files': ['*']
                }
            });

            if (saveUri) {
                // For now, just copy files to a directory
                // In a full implementation, you'd create a ZIP file
                vscode.window.showInformationMessage(`Export functionality would save ${selectedPrompts.length} prompts to ${saveUri.fsPath}`);
                this.logger.debug(`Export request for ${selectedPrompts.length} prompts to ${saveUri.fsPath}`);
            }
        } catch (error) {
            this.logger.error(`Failed to export selected prompts: ${error}`);
            vscode.window.showErrorMessage(`Failed to export selected prompts: ${error}`);
        }
    }

    getSelectedCount(): number {
        return this.treeProvider.getSelectedPrompts().length;
    }

    getTotalCount(): number {
        return this.treeProvider.getAllPrompts().length;
    }
}