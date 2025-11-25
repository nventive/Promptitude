import * as vscode from 'vscode';
import { PromptTreeDataProvider } from './promptTreeProvider';
import { Logger } from '../utils/logger';
import { ConfigManager } from '../configManager';

export class PromptCardsWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'promptitude.cards';

    private _view?: vscode.WebviewView;
    private readonly logger: Logger;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly configManager: ConfigManager,
        private readonly promptTreeProvider: PromptTreeDataProvider
    ) {
        this.logger = Logger.get('PromptCardsWebview');

        // Listen to tree provider changes and update webview
        this.promptTreeProvider.onDidChangeTreeData(() => {
            this.logger.debug('Tree data changed, updating webview');
            this.updateWebview();
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(
            message => {
                this.logger.debug(`[WebView] Received message: ${JSON.stringify(message)}`);
                switch (message.command) {
                    case 'refresh':
                        this.logger.debug('[WebView] Manual refresh requested from webview');
                        this.refresh();
                        break;
                    case 'togglePrompt':
                        this.logger.info(`[WebView] togglePrompt message received for: ${message.promptPath}`);
                        this.togglePrompt(message.promptPath);
                        break;
                    case 'viewPrompt':
                        this.logger.debug(`[WebView] viewPrompt message received for: ${message.promptPath}`);
                        this.viewPrompt(message.promptPath);
                        break;
                    case 'openRepository':
                        this.logger.debug(`[WebView] openRepository message received for: ${message.repositoryUrl}`);
                        this.openRepository(message.repositoryUrl);
                        break;
                    default:
                        this.logger.warn(`[WebView] Unknown message command: ${message.command}`);
                }
            },
            undefined,
            []
        );

        // Load initial data - this will get prompts from tree provider
        this.logger.debug('Webview resolved, updating with initial data');
        this.updateWebview();
    }

    private updateWebview() {
        if (this._view) {
            const allPrompts = this.promptTreeProvider.getAllPrompts();
            this.logger.debug(`Updating webview with ${allPrompts.length} prompts`);
            this._view.webview.postMessage({
                command: 'updatePrompts',
                prompts: allPrompts
            });
        } else {
            this.logger.debug('Webview not initialized yet, skipping update');
        }
    }

    public refresh() {
        this.promptTreeProvider.refresh();
        this.updateWebview();
    }

    private async togglePrompt(promptPath: string) {
        try {
            this.logger.info(`[WebView] togglePrompt called with path: ${promptPath}`);

            // Normalize paths for cross-platform comparison (Windows uses backslashes)
            const normalizedPromptPath = promptPath.replace(/\\/g, '/');
            this.logger.debug(`[WebView] Normalized path: ${normalizedPromptPath}`);

            const allPrompts = this.promptTreeProvider.getAllPrompts();
            this.logger.debug(`[WebView] Total prompts available: ${allPrompts.length}`);

            const promptInfo = allPrompts.find(p => {
                const normalizedPath = p.path.replace(/\\/g, '/');
                return normalizedPath === normalizedPromptPath;
            });

            if (promptInfo) {
                this.logger.info(`[WebView] Found prompt: ${promptInfo.name}, active: ${promptInfo.active}`);
                this.logger.debug(`[WebView] Executing command: prompts.toggleSelection`);

                // Use the command that handles symlink creation/removal
                await vscode.commands.executeCommand('prompts.toggleSelection', promptInfo);

                this.logger.debug(`[WebView] Command executed successfully, updating webview`);
                // Update webview after successful toggle (command handles its own refresh)
                this.updateWebview();
            } else {
                this.logger.warn(`[WebView] Prompt not found for path: ${promptPath}`);
                this.logger.debug(`[WebView] Available paths: ${allPrompts.map(p => p.path).join(', ')}`);
                vscode.window.showErrorMessage('Prompt not found');
            }
        } catch (error) {
            this.logger.error('[WebView] Failed to toggle prompt:', error as Error);
            vscode.window.showErrorMessage(`Failed to toggle prompt: ${error}`);
            // Refresh to ensure UI shows correct state
            this.updateWebview();
        }
    }

    private async viewPrompt(promptPath: string) {
        try {
            const promptInfo = this.promptTreeProvider.getAllPrompts().find(p => p.path === promptPath);
            if (promptInfo) {
                // Use the command that handles PromptInfo directly
                vscode.commands.executeCommand('prompts.viewPrompt', promptInfo);
            }
        } catch (error) {
            this.logger.error('Failed to view prompt:', error as Error);
        }
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
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Prompts</title>
    <style>
        /* CSS Variables for theming */
        :root {
            --vscode-foreground: var(--vscode-foreground);
            --vscode-background: var(--vscode-sideBar-background, var(--vscode-editor-background));
            --vscode-button-background: var(--vscode-button-background);
            --vscode-button-hoverBackground: var(--vscode-button-hoverBackground);
            --vscode-input-background: var(--vscode-input-background);
            --vscode-input-border: var(--vscode-input-border);
            --vscode-focusBorder: var(--vscode-focusBorder);
            --vscode-textLink-foreground: var(--vscode-textLink-foreground);
            --vscode-badge-background: var(--vscode-badge-background);
            --vscode-badge-foreground: var(--vscode-badge-foreground);
            --vscode-list-hoverBackground: var(--vscode-list-hoverBackground);
            --vscode-descriptionForeground: var(--vscode-descriptionForeground);
            
            /* Category colors */
            --chatmode-color: #4CAF50;
            --instructions-color: #2196F3;
            --prompts-color: #FF9800;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            line-height: 1.5;
            color: var(--vscode-foreground);
            background-color: var(--vscode-background);
            padding: 12px;
            overflow-x: hidden;
        }

        .search-container {
            margin-bottom: 12px;
        }

        .search-input {
            width: 100%;
            padding: 8px 12px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            color: var(--vscode-foreground);
            font-family: inherit;
            font-size: inherit;
        }

        .search-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }

        .filters-container {
            display: flex;
            gap: 8px;
            margin-bottom: 16px;
            flex-wrap: wrap;
        }

        .filter-btn {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-foreground);
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 6px;
            flex: 1;
            min-width: fit-content;
            justify-content: center;
        }

        .filter-btn:hover {
            background-color: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }

        .filter-btn.active {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-button-background);
        }

        .filter-count {
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 6px;
            border-radius: 10px;
            font-size: 10px;
            font-weight: 600;
        }

        .filter-btn.active .filter-count {
            background-color: rgba(255, 255, 255, 0.2);
        }

        .source-filter-container {
            position: relative;
            flex: 1;
            min-width: fit-content;
        }

        .source-dropdown-btn {
            width: 100%;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-foreground);
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            transition: all 0.2s ease;
        }

        .source-dropdown-btn:hover {
            background-color: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }

        .source-dropdown-btn .dropdown-arrow {
            transition: transform 0.2s ease;
        }

        .source-dropdown-btn.open .dropdown-arrow {
            transform: rotate(180deg);
        }

        .source-dropdown-menu {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            margin-top: 4px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            max-height: 300px;
            overflow-y: auto;
            z-index: 1000;
            display: none;
        }

        .source-dropdown-menu.open {
            display: block;
        }

        .source-dropdown-item {
            padding: 8px 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: background-color 0.2s ease;
            font-size: 12px;
        }

        .source-dropdown-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .source-dropdown-item input[type="checkbox"] {
            cursor: pointer;
            margin: 0;
        }

        .source-dropdown-item label {
            cursor: pointer;
            flex: 1;
            display: flex;
            align-items: center;
            gap: 6px;
            user-select: none;
        }

        .source-dropdown-item .source-count {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 6px;
            border-radius: 10px;
            margin-left: auto;
        }

        .source-dropdown-divider {
            height: 1px;
            background-color: var(--vscode-input-border);
            margin: 4px 0;
        }

        .category-section {
            margin-bottom: 20px;
        }

        .category-header {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 8px;
            padding-bottom: 6px;
            border-bottom: 2px solid var(--vscode-input-border);
        }

        .category-icon {
            font-size: 16px;
        }

        .category-title {
            font-size: 13px;
            font-weight: 600;
            color: var(--vscode-foreground);
            flex: 1;
        }

        .category-count {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-input-background);
            padding: 2px 6px;
            border-radius: 10px;
        }

        .category-section.agents .category-header {
            border-bottom-color: var(--agents-color);
        }

        .category-section.instructions .category-header {
            border-bottom-color: var(--instructions-color);
        }

        .category-section.prompts .category-header {
            border-bottom-color: var(--prompts-color);
        }

        .cards-container {
            display: grid;
            grid-template-columns: 1fr;
            gap: 8px;
            padding: 0;
        }

        .prompt-card {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 8px 10px;
            transition: all 0.2s ease;
            cursor: pointer;
            position: relative;
            overflow: hidden;
        }

        .prompt-card:hover {
            background-color: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-focusBorder);
            transform: translateY(-1px);
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
        }

        .prompt-card:hover .card-title {
            text-decoration: underline;
            text-decoration-style: dotted;
        }

        .prompt-card.active {
            border-color: var(--vscode-input-border);
            background-color: var(--vscode-input-background);
        }

        .prompt-card.active::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 3px;
            height: 100%;
            background-color: var(--vscode-textLink-foreground);
            opacity: 0.6;
        }

        .prompt-card.agents.active::before {
            background-color: var(--agents-color);
        }

        .prompt-card.instructions.active::before {
            background-color: var(--instructions-color);
        }

        .prompt-card.prompts.active::before {
            background-color: var(--prompts-color);
        }

        .type-icon {
            font-size: 14px;
            margin-right: 3px;
        }

        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 4px;
            gap: 8px;
        }

        .card-title {
            font-weight: 600;
            font-size: 13px;
            color: var(--vscode-foreground);
            margin: 0;
            flex: 1;
            word-break: break-word;
            line-height: 1.3;
            display: flex;
            align-items: center;
        }

        .card-description {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            line-height: 1.3;
            margin-bottom: 4px;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        .card-repository {
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
            margin-bottom: 0;
            opacity: 0.8;
            font-style: italic;
        }

        .card-repository a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            transition: all 0.2s ease;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 3px;
        }

        .card-repository a:hover {
            text-decoration: underline;
            opacity: 1;
        }

        .card-actions {
            display: flex;
            gap: 6px;
            flex-shrink: 0;
        }

        .action-btn {
            border: none;
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 10px;
            font-weight: 600;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            min-width: 70px;
            white-space: nowrap;
        }

        .action-btn.inactive-btn {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: 1px solid var(--vscode-button-background);
        }

        .action-btn.inactive-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
            border-color: var(--vscode-button-hoverBackground);
            transform: translateY(-1px);
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        .action-btn.active-btn {
            background-color: rgba(var(--vscode-charts-green), 0.15);
            color: var(--chatmode-color);
            border: 1px solid var(--chatmode-color);
        }

        .action-btn.active-btn:hover {
            background-color: rgba(255, 0, 0, 0.1);
            color: #f44336;
            border-color: #f44336;
            transform: translateY(-1px);
        }

        .action-btn:active {
            transform: translateY(0);
        }

        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }

        .empty-state h3 {
            margin-bottom: 8px;
            color: var(--vscode-foreground);
        }

        .empty-state p {
            font-size: 13px;
            line-height: 1.5;
        }

        .loading {
            text-align: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground);
        }

        /* Dark theme optimizations */
        @media (prefers-color-scheme: dark) {
            .prompt-card {
                box-shadow: 0 1px 3px rgba(255, 255, 255, 0.05);
            }
            
            .prompt-card:hover {
                box-shadow: 0 4px 8px rgba(255, 255, 255, 0.1);
            }
        }

        /* Responsive adjustments */
        @media (max-width: 300px) {
            body {
                padding: 8px;
            }
            
            .prompt-card {
                padding: 12px;
            }
            
            .card-actions {
                opacity: 1; /* Always show actions on small screens */
            }
        }
    </style>
</head>
<body>
    <div class="search-container">
        <input type="text" class="search-input" placeholder="Search prompts..." id="searchInput">
    </div>
    
    <div class="filters-container" id="filtersContainer"></div>
    
    <div id="cardsContainer" class="cards-container">
        <div class="loading">Loading prompts...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let allPrompts = [];
        let currentFilter = 'all';
        let enabledSources = new Set(); // Empty set means all sources enabled
        let searchTerm = '';
        let dropdownOpen = false;

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updatePrompts':
                    allPrompts = message.prompts || [];
                    renderFilters();
                    applyFiltersAndRender();
                    break;
            }
        });

        // Search functionality
        document.getElementById('searchInput').addEventListener('input', (e) => {
            searchTerm = e.target.value.toLowerCase();
            applyFiltersAndRender();
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            const dropdownBtn = document.querySelector('.source-dropdown-btn');
            const dropdownMenu = document.querySelector('.source-dropdown-menu');
            if (dropdownBtn && dropdownMenu && !dropdownBtn.contains(e.target) && !dropdownMenu.contains(e.target)) {
                closeDropdown();
            }
        });

        function applyFiltersAndRender() {
            let filteredPrompts = allPrompts;

            // Apply search filter (include repository source in search)
            if (searchTerm) {
                filteredPrompts = filteredPrompts.filter(prompt => {
                    const nameMatch = prompt.name.toLowerCase().includes(searchTerm);
                    const descMatch = prompt.description && prompt.description.toLowerCase().includes(searchTerm);
                    const sourceMatch = prompt.repositoryUrl && getRepositoryName(prompt.repositoryUrl).toLowerCase().includes(searchTerm);
                    return nameMatch || descMatch || sourceMatch;
                });
            }

            // Apply category filter
            if (currentFilter !== 'all') {
                filteredPrompts = filteredPrompts.filter(prompt => prompt.type === currentFilter);
            }

            // Apply source filter (only if specific sources are enabled)
            if (enabledSources.size > 0) {
                filteredPrompts = filteredPrompts.filter(prompt => {
                    const sourceKey = prompt.repositoryUrl || 'local';
                    return enabledSources.has(sourceKey);
                });
            }

            renderPrompts(filteredPrompts);
        }

        function renderFilters() {
            const container = document.getElementById('filtersContainer');
            
            const counts = {
                all: allPrompts.length,
                agents: allPrompts.filter(p => p.type === 'agents').length,
                prompts: allPrompts.filter(p => p.type === 'prompts').length,
                instructions: allPrompts.filter(p => p.type === 'instructions').length
            };

            const activeCounts = {
                all: allPrompts.filter(p => p.active).length,
                agents: allPrompts.filter(p => p.type === 'agents' && p.active).length,
                prompts: allPrompts.filter(p => p.type === 'prompts' && p.active).length,
                instructions: allPrompts.filter(p => p.type === 'instructions' && p.active).length
            };

            // Get unique repository sources
            const sources = new Map();
            let localCount = 0;
            allPrompts.forEach(p => {
                if (p.repositoryUrl) {
                    const repoName = getRepositoryName(p.repositoryUrl);
                    if (!sources.has(p.repositoryUrl)) {
                        sources.set(p.repositoryUrl, { name: repoName, count: 0, active: 0 });
                    }
                    sources.get(p.repositoryUrl).count++;
                    if (p.active) sources.get(p.repositoryUrl).active++;
                } else {
                    localCount++;
                }
            });

            // Build source dropdown items
            const sourceItems = [];
            
            // Add "All Sources" option
            sourceItems.push(\`
                <div class="source-dropdown-item" onclick="toggleAllSources(event)">
                    <input type="checkbox" id="source-all" \${enabledSources.size === 0 ? 'checked' : ''} onchange="toggleAllSources(event)">
                    <label for="source-all">
                        🌐 All Sources
                        <span class="source-count">\${allPrompts.length}</span>
                    </label>
                </div>
            \`);

            if (sources.size > 0 || localCount > 0) {
                sourceItems.push('<div class="source-dropdown-divider"></div>');
            }

            // Add repository sources
            Array.from(sources.entries()).forEach(([url, data], index) => {
                const isChecked = enabledSources.size === 0 || enabledSources.has(url);
                const safeId = 'source-repo-' + index;
                sourceItems.push(\`
                    <div class="source-dropdown-item" onclick="toggleSource('\${escapeHtml(url)}', event)">
                        <input type="checkbox" id="\${safeId}" \${isChecked ? 'checked' : ''} onchange="toggleSource('\${escapeHtml(url)}', event)">
                        <label for="\${safeId}" title="\${escapeHtml(url)}">
                            📦 \${escapeHtml(data.name)}
                            <span class="source-count">\${data.active}/\${data.count}</span>
                        </label>
                    </div>
                \`);
            });

            // Add local prompts
            if (localCount > 0) {
                const isChecked = enabledSources.size === 0 || enabledSources.has('local');
                sourceItems.push(\`
                    <div class="source-dropdown-item" onclick="toggleSource('local', event)">
                        <input type="checkbox" id="source-local" \${isChecked ? 'checked' : ''} onchange="toggleSource('local', event)">
                        <label for="source-local">
                            💻 Local
                            <span class="source-count">\${allPrompts.filter(p => !p.repositoryUrl && p.active).length}/\${localCount}</span>
                        </label>
                    </div>
                \`);
            }

            const enabledCount = enabledSources.size === 0 ? sources.size + (localCount > 0 ? 1 : 0) : enabledSources.size;
            const totalSources = sources.size + (localCount > 0 ? 1 : 0);
            const sourceFilterLabel = enabledSources.size === 0 ? 'All Sources' : \`\${enabledCount}/\${totalSources}\`;

            container.innerHTML = \`
                <button class="filter-btn \${currentFilter === 'all' ? 'active' : ''}" onclick="setFilter('all')">
                    📋 All
                    <span class="filter-count">\${activeCounts.all}/\${counts.all}</span>
                </button>
                <button class="filter-btn \${currentFilter === 'agents' ? 'active' : ''}" onclick="setFilter('agents')">
                    🤖 Agents
                    <span class="filter-count">\${activeCounts.agents}/\${counts.agents}</span>
                </button>
                <button class="filter-btn \${currentFilter === 'prompts' ? 'active' : ''}" onclick="setFilter('prompts')">
                    ⚡ Prompts
                    <span class="filter-count">\${activeCounts.prompts}/\${counts.prompts}</span>
                </button>
                <button class="filter-btn \${currentFilter === 'instructions' ? 'active' : ''}" onclick="setFilter('instructions')">
                    📖 Instructions
                    <span class="filter-count">\${activeCounts.instructions}/\${counts.instructions}</span>
                </button>
                \${totalSources > 0 ? \`
                <div class="source-filter-container">
                    <button class="source-dropdown-btn \${dropdownOpen ? 'open' : ''}" onclick="toggleDropdown(event)">
                        <span>📦 \${sourceFilterLabel}</span>
                        <span class="dropdown-arrow">▼</span>
                    </button>
                    <div class="source-dropdown-menu \${dropdownOpen ? 'open' : ''}">
                        \${sourceItems.join('')}
                    </div>
                </div>
                \` : ''}
            \`;
        }

        function setFilter(filter) {
            currentFilter = filter;
            renderFilters();
            applyFiltersAndRender();
        }

        function toggleDropdown(event) {
            if (event) event.stopPropagation();
            dropdownOpen = !dropdownOpen;
            renderFilters();
        }

        function closeDropdown() {
            if (dropdownOpen) {
                dropdownOpen = false;
                renderFilters();
            }
        }

        function toggleAllSources(event) {
            if (event) event.stopPropagation();
            if (enabledSources.size === 0) {
                // Currently all enabled, do nothing (keep all enabled)
                return;
            } else {
                // Some sources disabled, enable all
                enabledSources.clear();
            }
            renderFilters();
            applyFiltersAndRender();
        }

        // Make functions globally accessible for inline onclick handlers
        window.toggleDropdown = toggleDropdown;
        window.toggleAllSources = toggleAllSources;
        window.toggleSource = toggleSource;
        window.setFilter = setFilter;

        function toggleSource(sourceKey, event) {
            if (event) event.stopPropagation();
            
            if (enabledSources.size === 0) {
                // All sources are currently enabled
                // Create a set with all sources except the one being toggled off
                const allSources = new Set();
                allPrompts.forEach(p => {
                    const key = p.repositoryUrl || 'local';
                    allSources.add(key);
                });
                allSources.forEach(key => {
                    if (key !== sourceKey) {
                        enabledSources.add(key);
                    }
                });
            } else {
                // Some sources are filtered
                if (enabledSources.has(sourceKey)) {
                    enabledSources.delete(sourceKey);
                } else {
                    enabledSources.add(sourceKey);
                    
                    // Check if all sources are now enabled
                    const allSources = new Set();
                    allPrompts.forEach(p => {
                        const key = p.repositoryUrl || 'local';
                        allSources.add(key);
                    });
                    
                    if (enabledSources.size === allSources.size) {
                        // All sources are now enabled, clear the set
                        enabledSources.clear();
                    }
                }
            }
            renderFilters();
            applyFiltersAndRender();
        }

        function renderPrompts(prompts) {
            const container = document.getElementById('cardsContainer');
            
            if (!prompts || prompts.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state">
                        <h3>No prompts found</h3>
                        <p>No prompts are available. Try syncing your repositories or check your configuration.</p>
                        <p style="margin-top: 12px; font-size: 12px;">Click the Sync button in the toolbar to fetch prompts from your configured repositories.</p>
                    </div>
                \`;
                return;
            }

            // Group by category if showing all
            if (currentFilter === 'all') {
                const grouped = {
                    agents: prompts.filter(p => p.type === 'agents'),
                    prompts: prompts.filter(p => p.type === 'prompts'),
                    instructions: prompts.filter(p => p.type === 'instructions')
                };

                const categories = [
                    { key: 'agents', title: 'Agents', icon: '🤖', prompts: grouped.agents },
                    { key: 'prompts', title: 'Prompts', icon: '⚡', prompts: grouped.prompts },
                    { key: 'instructions', title: 'Instructions', icon: '📖', prompts: grouped.instructions }
                ];

                container.innerHTML = categories
                    .filter(cat => cat.prompts.length > 0)
                    .map(cat => \`
                        <div class="category-section \${cat.key}">
                            <div class="category-header">
                                <span class="category-icon">\${cat.icon}</span>
                                <span class="category-title">\${cat.title}</span>
                                <span class="category-count">\${cat.prompts.filter(p => p.active).length}/\${cat.prompts.length} active</span>
                            </div>
                            <div class="cards-container">
                                \${cat.prompts.map(prompt => renderPromptCard(prompt)).join('')}
                            </div>
                        </div>
                    \`).join('');
            } else {
                // Show flat list for specific category
                container.innerHTML = '<div class="cards-container">' + 
                    prompts.map(prompt => renderPromptCard(prompt)).join('') + 
                    '</div>';
            }
        }

        function renderPromptCard(prompt) {
            const typeIcon = getTypeIcon(prompt.type);
            // Escape backslashes in paths for JavaScript strings (Windows compatibility)
            const escapedPath = prompt.path.replace(/\\\\/g, '\\\\\\\\');
            return \`
                <div class="prompt-card \${prompt.type} \${prompt.active ? 'active' : ''}" onclick="viewPrompt('\${escapedPath}')">
                    <div class="card-header">
                        <h3 class="card-title">
                            <span class="type-icon">\${typeIcon}</span>
                            \${escapeHtml(cleanPromptName(prompt.name))}
                        </h3>
                        <div class="card-actions" onclick="event.stopPropagation()">
                            <button class="action-btn \${prompt.active ? 'active-btn' : 'inactive-btn'}" onclick="event.stopPropagation(); togglePrompt('\${escapedPath}'); return false;" title="\${prompt.active ? 'Click to deactivate' : 'Click to activate'}">
                                \${prompt.active ? '✓ Activated' : '+ Activate'}
                            </button>
                        </div>
                    </div>
                    <div class="card-description">
                        \${escapeHtml(prompt.description || 'No description available')}
                    </div>
                    <div class="card-repository" onclick="event.stopPropagation()">
                        \${prompt.repositoryUrl ? 
                            \`📦 <a href="#" onclick="openRepository('\${escapeHtml(prompt.repositoryUrl)}'); return false;" title="Open repository in browser">\${escapeHtml(getRepositoryName(prompt.repositoryUrl))} 🔗</a>\` :
                            \`📦 Local\`
                        }
                    </div>
                </div>
            \`;
        }

        function getTypeIcon(type) {
            switch(type) {
                case 'chatmode': return '💬';
                case 'instructions': return '📖';
                case 'prompts': return '⚡';
                default: return '📄';
            }
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function cleanPromptName(filename) {
            // Remove common extensions: .prompt.md, .chatmode.md, .instructions.md, .md, .txt
            return filename
                .replace(/\\\\.prompt\\\\.md$/, '')
                .replace(/\\\\.chatmode\\\\.md$/, '')
                .replace(/\\\\.instructions\\\\.md$/, '')
                .replace(/\\\\.(md|txt)$/, '');
        }

        function getRepositoryName(repositoryUrl) {
            if (!repositoryUrl) {
                return 'Local';
            }
            
            // Extract repository name from URL
            // Examples:
            // https://github.com/owner/repo -> owner/repo
            // https://dev.azure.com/org/project/_git/repo -> org/project/repo
            
            try {
                // GitHub pattern
                const githubMatch = repositoryUrl.match(/github\\.com\\/([^\\/]+\\/[^\\/]+)/);
                if (githubMatch) {
                    return githubMatch[1].replace(/\\.git$/, '');
                }
                
                // Azure DevOps pattern
                const azureMatch = repositoryUrl.match(/dev\\.azure\\.com\\/([^\\/]+)\\/([^\\/]+)\\/_git\\/([^\\/]+)/);
                if (azureMatch) {
                    return \`\${azureMatch[1]}/\${azureMatch[3]}\`;
                }
                
                // Fallback: try to get last two parts of the path
                const parts = repositoryUrl.replace(/https?:\\/\\//, '').split('/').filter(p => p);
                if (parts.length >= 2) {
                    return parts.slice(-2).join('/').replace(/\\.git$/, '');
                }
                
                return 'Repository';
            } catch (error) {
                return 'Repository';
            }
        }

        function togglePrompt(promptPath) {
            console.log('[Promptitude WebView] togglePrompt called with:', promptPath);
            vscode.postMessage({
                command: 'togglePrompt',
                promptPath: promptPath
            });
            console.log('[Promptitude WebView] Message posted to extension');
        }

        function viewPrompt(promptPath) {
            vscode.postMessage({
                command: 'viewPrompt',
                promptPath: promptPath
            });
        }

        function openRepository(repositoryUrl) {
            vscode.postMessage({
                command: 'openRepository',
                repositoryUrl: repositoryUrl
            });
        }

        // Request initial data
        vscode.postMessage({ command: 'refresh' });
    </script>
</body>
</html>`;
    }
}