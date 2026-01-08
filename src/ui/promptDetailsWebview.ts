import * as vscode from 'vscode';
import * as path from 'path';
import { PromptInfo } from './promptTreeProvider';
import { FileSystemManager } from '../utils/fileSystem';
import { Logger } from '../utils/logger';
import { ConfigManager } from '../configManager';
import { encodeRepositorySlug, getRepositoryStorageDirectory } from '../storage/repositoryStorage';

export class PromptDetailsWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'promptitude.details';

    private _view?: vscode.WebviewView;
    private _currentPrompt?: PromptInfo;
    private fileSystem: FileSystemManager;
    private logger: Logger;
    private context?: vscode.ExtensionContext;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly config: ConfigManager,
        context?: vscode.ExtensionContext
    ) {
        this.fileSystem = new FileSystemManager();
        this.logger = Logger.get('PromptDetailsWebviewProvider');
        this.context = context;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            message => {
                switch (message.type) {
                    case 'saveContent':
                        this.savePromptContent(message.content);
                        break;
                    case 'editPrompt':
                        this.editPromptInEditor();
                        break;
                    case 'duplicatePrompt':
                        this.duplicatePrompt();
                        break;
                    case 'deletePrompt':
                        this.deletePrompt();
                        break;
                    case 'toggleSelection':
                        this.toggleSelection();
                        break;
                    case 'openSettings':
                        vscode.commands.executeCommand('workbench.action.openSettings', 'promptitude');
                        break;
                    case 'openRepository':
                        this.openRepository(message.repositoryUrl);
                        break;
                }
            },
            undefined,
        );
    }

    public async showPrompt(prompt: PromptInfo) {
        this._currentPrompt = prompt;
        
        if (!this._view) {
            this.logger.warn('Webview not initialized');
            return;
        }

        try {
            this.logger.debug(`showPrompt called for: ${prompt.name}, active: ${prompt.active}, repositoryUrl: ${prompt.repositoryUrl}`);
            
            // Compute the actual file path
            const actualPath = this.getActualFilePath(prompt);
            this.logger.debug(`Actual path resolved to: ${actualPath}`);
            
            const content = await this.fileSystem.readFileContent(actualPath);
            const metadata = await this.getPromptMetadata(prompt);
            
            await this._view.webview.postMessage({
                type: 'showPrompt',
                prompt: {
                    ...prompt,
                    content,
                    metadata
                }
            });

            this._view.show?.(true);
        } catch (error) {
            this.logger.error(`Failed to show prompt: ${error}`);
            vscode.window.showErrorMessage(`Failed to load prompt: ${error}`);
        }
    }

    /**
     * Get the actual file path for a prompt (handles inactive prompts stored in repository)
     */
    private getActualFilePath(prompt: PromptInfo): string {
        const fs = require('fs');
        
        this.logger.debug(`Getting actual path - active: ${prompt.active}, repositoryUrl: ${prompt.repositoryUrl}, path: ${prompt.path}, name: ${prompt.name}`);
        
        // For inactive prompts with a repository URL, go directly to repository storage
        if (!prompt.active && prompt.repositoryUrl) {
            // Get repository storage directory using the helper function
            const repoStorageDir = getRepositoryStorageDirectory(this.context);
            
            // Encode repository URL using the same logic as SyncManager
            const encodedUrl = encodeRepositorySlug(prompt.repositoryUrl);
            
            // Build path to repository storage using the original filename
            const repoStoragePath = path.join(repoStorageDir, encodedUrl, prompt.name);
            
            this.logger.debug(`Repo storage dir: ${repoStorageDir}`);
            this.logger.debug(`Encoded URL: ${encodedUrl}`);
            this.logger.debug(`Looking for inactive prompt at repository storage: ${repoStoragePath}`);
            
            if (fs.existsSync(repoStoragePath)) {
                this.logger.debug(`File found at repository storage: ${repoStoragePath}`);
                return repoStoragePath;
            } else {
                this.logger.warn(`File not found at repository storage: ${repoStoragePath}`);
                // Try to list files in the encoded directory to help debug
                const encodedDir = path.join(repoStorageDir, encodedUrl);
                if (fs.existsSync(encodedDir)) {
                    try {
                        const files = fs.readdirSync(encodedDir);
                        this.logger.debug(`Files in repository directory: ${files.join(', ')}`);
                    } catch (err) {
                        this.logger.debug(`Could not list files in repository directory: ${err}`);
                    }
                } else {
                    this.logger.warn(`Repository directory does not exist: ${encodedDir}`);
                }
            }
        }
        
        // For active prompts or when repository lookup failed, check workspace path
        if (fs.existsSync(prompt.path)) {
            this.logger.debug(`File exists at workspace path: ${prompt.path}`);
            return prompt.path;
        }
        
        // Fallback to the original path (will likely fail, but at least we tried)
        this.logger.warn(`File not found anywhere, returning original path: ${prompt.path}`);
        return prompt.path;
    }

    public clearPrompt() {
        this._currentPrompt = undefined;
        this._view?.webview.postMessage({
            type: 'clearPrompt'
        });
    }

    public updateSelectionStatus(prompt: PromptInfo) {
        if (this._currentPrompt && this._currentPrompt.path === prompt.path) {
            this._currentPrompt.active = prompt.active;
            this._view?.webview.postMessage({
                type: 'updateSelection',
                active: prompt.active
            });
        }
    }

    private async getPromptMetadata(prompt: PromptInfo) {
        return {
            name: prompt.name,
            type: prompt.type,
            active: prompt.active,
            description: prompt.description,
            repositoryUrl: prompt.repositoryUrl
        };
    }

    private async savePromptContent(content: string) {
        if (!this._currentPrompt) {
            return;
        }

        try {
            const actualPath = this.getActualFilePath(this._currentPrompt);
            await this.fileSystem.writeFileContent(actualPath, content);

            // Notify webview of successful save
            this._view?.webview.postMessage({
                type: 'saveSuccess'
            });

            vscode.window.showInformationMessage('Prompt saved successfully');
            
            // Fire event to refresh tree view
            vscode.commands.executeCommand('prompts.refresh');
        } catch (error) {
            this.logger.error(`Failed to save prompt: ${error}`);
            vscode.window.showErrorMessage(`Failed to save prompt: ${error}`);
            
            this._view?.webview.postMessage({
                type: 'saveError',
                error: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    }

    private async editPromptInEditor() {
        if (!this._currentPrompt) {
            return;
        }

        try {
            const actualPath = this.getActualFilePath(this._currentPrompt);
            const document = await vscode.workspace.openTextDocument(actualPath);
            await vscode.window.showTextDocument(document);
        } catch (error) {
            this.logger.error(`Failed to open prompt in editor: ${error}`);
            vscode.window.showErrorMessage(`Failed to open prompt: ${error}`);
        }
    }

    private async duplicatePrompt() {
        if (!this._currentPrompt) {
            return;
        }

        try {
            const baseName = this._currentPrompt.name.replace(/\.[^/.]+$/, '');
            const extension = this._currentPrompt.name.substring(baseName.length);
            const newName = `${baseName}_copy${extension}`;
            
            // Always write to workspace directory for duplicates
            const promptsDir = this.config.getPromptsDirectory();
            const newPath = path.join(promptsDir, newName);
            
            // Read from actual path (repository storage for inactive prompts)
            const actualPath = this.getActualFilePath(this._currentPrompt);
            const content = await this.fileSystem.readFileContent(actualPath);
            await this.fileSystem.writeFileContent(newPath, content);
            
            vscode.window.showInformationMessage(`Prompt duplicated as ${newName}`);
            vscode.commands.executeCommand('prompts.refresh');
        } catch (error) {
            this.logger.error(`Failed to duplicate prompt: ${error}`);
            vscode.window.showErrorMessage(`Failed to duplicate prompt: ${error}`);
        }
    }

    private async deletePrompt() {
        if (!this._currentPrompt) {
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete "${this._currentPrompt.name}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm === 'Delete') {
            try {
                const actualPath = this.getActualFilePath(this._currentPrompt);
                await vscode.workspace.fs.delete(vscode.Uri.file(actualPath));
                vscode.window.showInformationMessage(`Prompt "${this._currentPrompt.name}" deleted successfully`);
                this.clearPrompt();
                vscode.commands.executeCommand('prompts.refresh');
            } catch (error) {
                this.logger.error(`Failed to delete prompt: ${error}`);
                vscode.window.showErrorMessage(`Failed to delete prompt: ${error}`);
            }
        }
    }

    private toggleSelection() {
        if (!this._currentPrompt) {
            return;
        }

        vscode.commands.executeCommand('prompts.toggleSelection', this._currentPrompt);
    }

    private async openRepository(repositoryUrl: string) {
        try {
            if (!repositoryUrl) {
                return;
            }
            
            this.logger.info(`Opening repository in browser: ${repositoryUrl}`);
            
            // Open the URL in the default browser
            await vscode.env.openExternal(vscode.Uri.parse(repositoryUrl));
        } catch (error) {
            this.logger.error('Failed to open repository:', error as Error);
            vscode.window.showErrorMessage(`Failed to open repository: ${error}`);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
        const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
        const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));

        const nonce = getNonce();

        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${styleResetUri}" rel="stylesheet">
				<link href="${styleVSCodeUri}" rel="stylesheet">
				<link href="${styleMainUri}" rel="stylesheet">
				<title>Prompt Details</title>
			</head>
			<body>
				<div id="container">
					<div id="empty-state" class="empty-state" style="display: block;">
						<div class="empty-icon">📝</div>
						<h2>No Prompt Selected</h2>
						<p>Select a prompt from the tree view to view its details and content.</p>
					</div>
					
					<div id="prompt-details" class="prompt-details" style="display: none;">
						<div class="header">
							<div class="title-section">
								<h1 id="prompt-title"></h1>
								<div class="metadata">
									<span id="prompt-type" class="type-badge"></span>
								</div>
							</div>
							<div class="actions">
								<button id="toggle-selection" class="action-button" title="Toggle Active">
									<span class="icon">✓</span>
								</button>
							</div>
						</div>
						
							<div class="description-section" id="description-section" style="display: none;">
								<div class="description-content" id="prompt-description"></div>
							</div>

							<div class="content-section">
								<div class="section-header">
									<h3>Content</h3>
							</div>
							<textarea id="prompt-content" class="content-editor" placeholder="Prompt content will appear here..." readonly></textarea>
						</div>

						<div class="info-section" id="source-section">
								<div class="info-item">
									<label>Source:</label>
									<span id="prompt-source"></span>
								</div>
							</div>
					</div>
				</div>

				<script nonce="${nonce}">
					const vscode = acquireVsCodeApi();
					let currentPrompt = null;

					// DOM elements
					const emptyState = document.getElementById('empty-state');
					const promptDetails = document.getElementById('prompt-details');
					const promptTitle = document.getElementById('prompt-title');
					const promptType = document.getElementById('prompt-type');
					const promptContent = document.getElementById('prompt-content');
					const promptDescription = document.getElementById('prompt-description');
					const descriptionSection = document.getElementById('description-section');
					const promptSource = document.getElementById('prompt-source');
					const sourceSection = document.getElementById('source-section');
					
					const toggleSelectionBtn = document.getElementById('toggle-selection');

					// Event listeners
					toggleSelectionBtn.addEventListener('click', () => {
						vscode.postMessage({ type: 'toggleSelection' });
					});

					function updateSelectionButton(active) {
						const icon = toggleSelectionBtn.querySelector('.icon');
						if (active) {
							icon.textContent = '✓';
							toggleSelectionBtn.classList.add('selected');
							toggleSelectionBtn.classList.remove('activate');
							toggleSelectionBtn.title = 'Deactivate';
						} else {
							icon.textContent = '+';
							toggleSelectionBtn.classList.remove('selected');
							toggleSelectionBtn.classList.add('activate');
							toggleSelectionBtn.title = 'Activate';
						}
					}

					function showPrompt(data) {
						currentPrompt = data.prompt;
                        emptyState.style.display = 'none';
						promptDetails.style.display = 'block';
						
						// Update header
						promptTitle.textContent = data.prompt.name;
						promptType.textContent = data.prompt.type;
						promptType.className = \`type-badge type-\${data.prompt.type}\`;
						
						// Update description if available
						if (data.prompt.description && data.prompt.description !== 'No description available') {
							promptDescription.textContent = data.prompt.description;
							descriptionSection.style.display = 'block';
						} else {
							descriptionSection.style.display = 'none';
						}
						
						// Update content
						promptContent.value = data.prompt.content;
						
						// Update source if from repository
						if (data.prompt.repositoryUrl) {
							const repoName = extractRepositoryName(data.prompt.repositoryUrl);
							promptSource.innerHTML = \`<a href="#" class="repo-link" data-url="\${data.prompt.repositoryUrl}" title="Open repository in browser">\${repoName}</a>\`;
							
							// Add click handler for the link
							const repoLink = promptSource.querySelector('.repo-link');
							if (repoLink) {
								repoLink.addEventListener('click', (e) => {
									e.preventDefault();
									const url = repoLink.getAttribute('data-url');
									if (url) {
										vscode.postMessage({ type: 'openRepository', repositoryUrl: url });
									}
								});
							}
							
							sourceSection.style.display = 'block';
						} else {
							promptSource.textContent = 'Local';
							sourceSection.style.display = 'block';
						}
						
						// Update selection button
						updateSelectionButton(data.prompt.active);
					}

					function extractRepositoryName(url) {
						// GitHub: https://github.com/owner/repo
						const githubMatch = url.match(/github\\.com\\/([^/]+\\/[^/]+)/);
						if (githubMatch) return githubMatch[1];
						
						// Azure DevOps: https://dev.azure.com/org/project/_git/repo
						const azureMatch = url.match(/dev\\.azure\\.com\\/[^/]+\\/[^/]+\\/_git\\/([^/]+)/);
						if (azureMatch) return azureMatch[1];
						
						return url;
					}

					function clearPrompt() {
						currentPrompt = null;
						originalContent = '';
						emptyState.style.display = 'block';
						promptDetails.style.display = 'none';
						hasUnsavedChanges = false;
						updateSaveButtons();
					}

					// Handle messages from extension
					window.addEventListener('message', event => {
						const message = event.data;
						
						switch (message.type) {
							case 'showPrompt':
								showPrompt(message);
								break;
							case 'clearPrompt':
								clearPrompt();
								break;
							case 'updateSelection':
								updateSelectionButton(message.active);
								break;
							case 'saveSuccess':
								// Just acknowledge the save, no need to update metadata display
								break;
							case 'saveError':
								// Handle save error
								break;
						}
					});

					// Initialize with empty state on load
					clearPrompt();
				</script>
			</body>
			</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}