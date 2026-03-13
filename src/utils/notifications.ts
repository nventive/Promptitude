import * as vscode from 'vscode';
import { ConfigManager } from '../configManager';
import { AzureDevOpsApiManager } from './azureDevOps';
import { Logger } from './logger';

export class NotificationManager {
    private config: vscode.WorkspaceConfiguration;
    private configManager?: ConfigManager;
    private extensionContext?: vscode.ExtensionContext;
    private logger?: Logger;

    constructor(configManager?: ConfigManager, extensionContext?: vscode.ExtensionContext, logger?: Logger) {
        this.config = vscode.workspace.getConfiguration('promptitude');
        this.configManager = configManager;
        this.extensionContext = extensionContext;
        this.logger = logger;
    }

    private get showNotifications(): boolean {
        return this.config.get('showNotifications', true);
    }

    showInfo(message: string, ...actions: string[]): Thenable<string | undefined> {
        if (!this.showNotifications) {
            return Promise.resolve(undefined);
        }
        return vscode.window.showInformationMessage(message, ...actions);
    }

    showWarning(message: string, ...actions: string[]): Thenable<string | undefined> {
        if (!this.showNotifications) {
            return Promise.resolve(undefined);
        }
        return vscode.window.showWarningMessage(message, ...actions);
    }

    showError(message: string, ...actions: string[]): Thenable<string | undefined> {
        // Always show error messages regardless of settings
        return vscode.window.showErrorMessage(message, ...actions);
    }

    async showSyncSuccess(itemsCount: number): Promise<void> {
        // Only show notification if items were actually updated
        if (itemsCount > 0) {
            await this.showInfo(`✅ Prompts synced successfully! ${itemsCount} items updated.`);
        }
    }

    async showPartialSyncSuccess(itemsCount: number, successCount: number, totalCount: number, errors: string[]): Promise<void> {
        // Categorise failures so the summary toast is immediately actionable
        let badUrlCount = 0;
        let badStructureCount = 0;
        let otherCount = 0;
        for (const err of errors) {
            if (err.includes('Invalid URL')) {
                badUrlCount++;
            } else if (err.includes('Incompatible repository') || err.includes('No sync types enabled')) {
                badStructureCount++;
            } else {
                otherCount++;
            }
        }

        const failParts: string[] = [];
        if (badUrlCount > 0) { failParts.push(`${badUrlCount} bad URL${badUrlCount > 1 ? 's' : ''}`); }
        if (badStructureCount > 0) { failParts.push(`${badStructureCount} incompatible structure${badStructureCount > 1 ? 's' : ''}`); }
        if (otherCount > 0) { failParts.push(`${otherCount} other error${otherCount > 1 ? 's' : ''}`); }

        const failSummary = failParts.length > 0 ? ` Failures: ${failParts.join(', ')}.` : '';
        const message = `⚠️ Partial sync: ${itemsCount} items updated from ${successCount}/${totalCount} repos.${failSummary}`;
        const result = await this.showWarning(
            message,
            'Show Details',
            'Retry Failed'
        );

        if (result === 'Show Details') {
            const details = errors.length > 0 ? 
                `Failed repositories:\n${errors.join('\n')}` : 
                'No error details available';
            await this.showInfo(details);
        } else if (result === 'Retry Failed') {
            vscode.commands.executeCommand('promptitude.syncNow');
        }
    }

    async showSyncError(error: string): Promise<void> {
        // Enhanced error handling for Azure DevOps specific errors
        let message = `❌ Failed to sync prompts: ${error}`;
        let actions = ['Retry', 'Show Logs'];
        
        // Check for specific Azure DevOps authentication errors in the error message
        if (error.includes('Azure DevOps') || error.includes('dev.azure.com') || error.includes('visualstudio.com')) {
            actions = ['Add Azure DevOps PAT', 'Retry', 'Show Logs'];
        }
        
        const result = await this.showError(message, ...actions);

        if (result === 'Retry') {
            vscode.commands.executeCommand('promptitude.syncNow');
        } else if (result === 'Show Logs') {
            this.logger?.show();
        } else if (result === 'Add Azure DevOps PAT') {
            vscode.commands.executeCommand('promptitude.addAzureDevOpsPAT');
        }
    }

    async showSyncStart(): Promise<void> {
        await this.showInfo('🔄 Starting Promptitude...');
    }

    async showAuthenticationRequired(): Promise<void> {
        // If we don't have access to the config manager, fall back to generic message
        if (!this.configManager) {
            await this.showWarning(
                'Git authentication required to sync prompts. Please check the extension output for authentication prompts.',
            );
            return;
        }

        const usedProviders = this.configManager.getUsedProviders();
        const hasGitHub = usedProviders.has('github');
        const hasAzure = usedProviders.has('azure');

        // Build appropriate message and actions based on the providers in use
        let message = 'Git authentication required to sync prompts.';
        const actions: string[] = [];

        if (hasGitHub && hasAzure) {
            message = 'GitHub and Azure DevOps authentication required to sync prompts.';
            actions.push('Sign in to GitHub', 'Setup Azure DevOps');
        } else if (hasGitHub) {
            message = 'GitHub authentication required to sync prompts.';
            actions.push('Sign in to GitHub');
        } else if (hasAzure) {
            message = 'Azure DevOps authentication required to sync prompts.';
            actions.push('Setup Azure DevOps');
        }

        // Always provide the "Show Logs" option for troubleshooting
        actions.push('Show Logs');

        const result = await this.showWarning(message, ...actions);

        // Handle the user's choice
        if (result === 'Sign in to GitHub') {
            await this.handleGitHubSignIn();
        } else if (result === 'Setup Azure DevOps') {
            await this.handleAzureDevOpsSetup();
        } else if (result === 'Show Logs') {
            this.logger?.show();
        }
    }

    private async handleGitHubSignIn(): Promise<void> {
        try {
            // Use VS Code's built-in GitHub authentication
            await vscode.commands.executeCommand('github.signin');
        } catch (error) {
            await this.showError('Failed to initiate GitHub sign-in. Please try signing in manually through VS Code settings.');
        }
    }

    private async handleAzureDevOpsSetup(): Promise<void> {
        if (!this.extensionContext) {
            await this.showError('Extension context not available for Azure DevOps setup.');
            return;
        }

        try {
            // Create an Azure DevOps manager and trigger authentication
            const azureManager = new AzureDevOpsApiManager(this.extensionContext);
            const success = await azureManager.requestAuthentication();
            
            if (success) {
                await this.showInfo('✅ Azure DevOps Personal Access Token configured successfully!');
            } else {
                await this.showWarning('Azure DevOps setup was cancelled. You can retry later.');
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await this.showError(`Failed to setup Azure DevOps authentication: ${errorMessage}`);
        }
    }

    /**
     * Show a warning when the total instructions size or count exceeds safe thresholds.
     * Instructions are auto-loaded into Copilot's context, unlike prompts which are on-demand.
     */
    async showPromptSizeWarning(details: { totalSizeKB: number; activeCount: number; reasons: string[] }): Promise<void> {
        const reasonText = details.reasons.join('; ');
        const message = `⚠️ Promptitude: Your active instructions may be too large for GitHub Copilot's context window (${details.totalSizeKB.toFixed(0)} KB across ${details.activeCount} instructions). ${reasonText}. Consider disabling unused instructions.`;

        // Always show this warning regardless of notification settings — it's a safeguard
        const result = await vscode.window.showWarningMessage(
            message,
            'Manage Prompts',
            'Open Settings',
            'Dismiss'
        );

        if (result === 'Manage Prompts') {
            vscode.commands.executeCommand('promptitude.cards.focus');
        } else if (result === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'promptitude');
        }
    }
}
