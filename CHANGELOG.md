# VS Code Extension Change Log

All notable changes to the "promptitude" extension will be documented in this file.

## [Unreleased]

## [1.5.3] - 2026-01-08

### Fixed

- Fixed prompt details webview initializing with visible empty state instead of hidden state on load.
- Fixed prompt content textarea being editable instead of read-only in details view.
- Fixed empty state remaining visible when prompt is selected in details view.
- Fixed activate button styling in prompt details view to use blue color with plus icon for better visibility and consistency.
- Fixed marketplace icon not displaying on VS Code Extensions Marketplace by adding top-level icon property pointing to PNG file.

## [1.5.2] - 2026-01-07

### Changed

- Renamed "chatmodes" to "agents" throughout the UI to align with VS Code's current terminology
- Improved "Activate All" and "Deactivate All" operations to show progress notifications with individual prompt status.

### Fixed

- Fixed UI bugs including Windows path handling, activate/deactivate button behavior, and cross-platform compatibility issues
- Fixed prompt details view not opening for inactive prompts on Windows by correctly resolving repository storage paths
- Fixed "Activate All" to properly create symlinks for all prompts instead of just updating state.
- Fixed "Deactivate All" to efficiently remove all symlinks directly instead of looping through individual toggles, eliminating unnecessary counting behavior.
- Fixed issue where prompts that were active before "Activate All" would be in a broken state after "Deactivate All".
- Fixed prompt details view not refreshing when "Deactivate All" is clicked while viewing an active prompt.
- Fixed duplicate repositories persisting in configuration by automatically removing them and updating settings when detected.
- Fixed 'All Sources' dropdown preventing users from deselecting the only repository source by implementing sentinel value pattern to distinguish between "all sources" and "no sources selected" states.
- Fixed Activity Bar icon not displaying by converting SVG to monochrome format with currentColor support for proper theme adaptation.

## [1.5.0] - 2025-11-12

### Added

- **Prompt Management UI**: Interactive webview interface for browsing, searching, and managing prompts from configured repositories

## [1.4.0] - 2025-10-03

### Added

- **Azure DevOps Support**: Support for Azure DevOps repositories including both modern (`dev.azure.com`) and legacy (`visualstudio.com`) URL formats

- **Multiple Personal Access Token (PAT) Support**: Support for multiple Azure DevOps PATs with intelligent caching
  - Automatically tries all configured PATs until one works for a given organization
  - Caches successful PAT-to-organization mappings for optimal performance
  - PATs are securely stored using VS Code's SecretStorage API

- **New Azure DevOps Management Commands**:
  - `Promptitude: Add Azure DevOps Personal Access Token` - Add a new PAT to the list
  - `Promptitude: Remove Azure DevOps Personal Access Token(s)` - Remove specific or all PATs
  - `Promptitude: Clear Azure DevOps Authentication Cache` - Clear organization-to-PAT cache

- **Open Prompts Folder Command**: New command to quickly open the prompts directory in your system's file explorer


### Configuration

- Repository configuration now supports Azure DevOps URLs in addition to GitHub:
  - `https://dev.azure.com/org/project/_git/repo`
  - `https://dev.azure.com/org/project/_git/repo|branch`
  - `https://org.visualstudio.com/project/_git/repo`
  - `https://org.visualstudio.com/project/_git/repo|branch`
  - `https://org.visualstudio.com/_git/repo`
- URLs with encoded spaces and special characters are now properly supported

### Fixed

- Branch specification now works correctly for all repository types
- Authentication prompts no longer appear twice
- File filtering is more reliable with better logging
- Extension name consistently shows as "Promptitude" throughout the UI

## [1.3.0] - 2025-09-25

### Changed

- Configuration now supports per-repository branch selection via `promptitude.repositories` entries in the form `https://github.com/owner/repo|branch`.
- **Breaking** Removed the separate `promptitude.branch` setting. If no branch is provided for an entry, `main` is used by default.

## [1.2.0] - 2025-09-22

- Renamed extension to promptitude for better visibility on vscode extensions marketplace.

## [1.1.0] - 2025-09-01

### Changed

- **Breaking**: Updated to support new repository folder structure
- Consolidated folder structure: now syncs only from `prompts/` directory
- Removed support for separate `copilot-instructions/` and `language-guidelines/` directories
- Updated to support new subdirectories: `prompts/chatmode/`, `prompts/instructions/`, `prompts/prompt/`
- Updated documentation to reflect new folder structure

### Synced Content (Updated)

- `prompts/chatmode/` directory → User prompts/chatmode/
- `prompts/instructions/` directory → User prompts/instructions/
- `prompts/prompt/` directory → User prompts/prompt/

## [1.0.0] - 2025-09-01

### Added

- Initial release of Promptitude Extension
- Automatic sync functionality for GitHub Copilot prompts
- Support for configurable sync frequency (startup, hourly, daily, weekly, manual)
- Cross-platform support (macOS, Windows, Linux)
- GitHub authentication integration using VS Code's built-in authentication
- Status bar integration with sync status indicators
- Manual sync command (`Promptitude: Sync Now`)
- Status display command (`Promptitude: Show Status`)
- Comprehensive logging and debug mode
- User notifications for sync operations
- Configurable prompts directory with smart defaults
- Support for syncing from custom repository URLs and branches

### Features

- **Automatic Sync**: Configurable sync frequency with smart scheduling
- **Security**: Uses VS Code's GitHub authentication, read-only repository access
- **User Experience**: Clear status indicators, notifications, and error handling
- **Flexibility**: Customizable repository URL, branch, and target directory
- **Debugging**: Comprehensive logging with debug mode for troubleshooting

### Synced Content (Original)

- `prompts/` directory → User prompts directory
- `copilot-instructions/` directory → User prompts/copilot-instructions
- `language-guidelines/` directory → User prompts/language-guidelines

### Configuration Options

- `promptitude.enabled` - Enable/disable automatic syncing
- `promptitude.frequency` - Sync frequency (startup, hourly, daily, weekly, manual)
- `promptitude.customPath` - Custom prompts directory path
- `promptitude.repository` - Repository URL to sync from
- `promptitude.branch` - Repository branch to sync
- `promptitude.syncOnStartup` - Sync when VS Code starts
- `promptitude.showNotifications` - Show sync status notifications
- `promptitude.debug` - Enable debug logging

### Commands

- `promptitude.syncNow` - Manually trigger sync
- `promptitude.showStatus` - Show extension status and configuration
