````instructions
```language: .vscode-copilot-instructions

You are a software engineer working on a VS Code extension named "Promptitude" that syncs GitHub Copilot prompts from Git repositories to the local VS Code prompts folder.
**Always** ask for clarification and present your plan and reasoning before modifying code.
Update the instructions below as the codebase evolves.
Update the CHANGELOG.md with each significant change.
Warn me about backward-incompatible changes.

Architecture & key files
- Entry/activation: src/extension.ts – activates on startup, wires ConfigManager, StatusBarManager, SyncManager; registers commands:
  promptitude.syncNow • promptitude.showStatus • promptitude.openPromptsFolder • promptitude.addAzureDevOpsPAT • promptitude.clearAzureDevOpsPAT • promptitude.clearAzureDevOpsCache
- Sync: src/syncManager.ts – schedules by promptitude.frequency; per-repo (url or url|branch, default main) select provider via GitProviderFactory, authenticate, fetch tree, filter, download files. Filters agents/ (and legacy chatmodes/), instructions/, prompts/ and .md/.txt; writes files to repository storage then creates symlinks (or copies on Windows without admin/dev mode) to active prompts directory using unique names when conflicts exist across repos.
- Configuration: src/configManager.ts – reads promptitude.*; repositoryConfigs parses url|branch; getPromptsDirectory returns OS-specific path; flags: enabled, syncOnStartup, showNotifications, debug, syncChatmode (supports agents/ and chatmodes/), syncInstructions, syncPrompt.
- Providers: src/utils/github.ts (VS Code GitHub auth with scope repo; REST branches→sha→git/trees; contents for files). src/utils/azureDevOps.ts (PATs in SecretStorage; per-organization PAT index cached in globalState; supports dev.azure.com and legacy visualstudio.com; owner encoded as organization|project|baseUrl).
- Utilities/UI: src/utils/fileSystem.ts (fs ops); src/utils/notifications.ts (messages + auth flows); src/utils/logger.ts (single "Promptitude" output channel; debug gated by setting); src/statusBarManager.ts (Idle/Syncing/Success/Error + last sync time; click triggers sync).
- Storage: Repository files stored in {globalStorageUri}/repos/{encoded_url}/; active prompts symlinked (or copied on Windows) to {globalStorageUri}/prompts/. Cross-platform path handling normalizes separators (/ vs \).

Developer workflows
- Build/package: npm install → npm run compile (or npm run watch) → npm run package (VSIX). Lint: npm run lint. Tests: npm run test.
- Debug: set "promptitude.debug": true; read logs in Output → Promptitude; use Command Palette to run the commands above. Extension activates onStartupFinished.

Conventions & patterns (repo-specific)
- No console.log. Use Logger.get('Scope').debug|info|warn|error (debug visible only when promptitude.debug = true).
- Always use FileSystemManager for IO and NotificationManager for UX/auth prompts; do not duplicate provider auth logic.
- Settings drive behavior; avoid hard-coded paths/branches; use ConfigManager.repositoryConfigs for url|branch parsing.
- Provider code lives in GitApiManager implementations; select via GitProviderFactory.createFromUrl().
- Duplicate filenames across repos resolved with unique workspace names using repository identifiers.
- Allowed file types: .md, .txt.
- Cross-platform: Normalize path separators (replace \\ with / for comparisons); on Windows, symlink creation falls back to file copy if admin/dev mode unavailable; both symlinks and file copies tracked as "active" prompts.

Examples
- settings.json:
  {
    "promptitude.repositories": [
      "https://github.com/org/prompts",
      "https://github.com/org/prompts|develop",
      "https://dev.azure.com/acme/Project/_git/prompt-repo|release"
    ]
  }
- Logging:
  const log = Logger.get('MyFeature'); log.info('Starting'); log.debug('Detailed trace when promptitude.debug = true');
```
````