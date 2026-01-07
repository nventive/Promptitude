import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { Logger } from '../utils/logger';

const logger = Logger.get('RepositoryStorage');

/**
 * Encode a repository URL into a safe, reversible slug using Base64 URL encoding
 * @param url The repository URL to encode
 * @returns A Base64 URL-encoded slug that can be safely used as a directory name
 */
export function encodeRepositorySlug(url: string): string {
    try {
        // Use base64url encoding (URL-safe variant without padding)
        return Buffer.from(url, 'utf8').toString('base64url');
    } catch (error) {
        logger.error(`Failed to encode repository URL: ${url}`, error instanceof Error ? error : undefined);
        throw new Error(`Failed to encode repository URL: ${error}`);
    }
}

/**
 * Decode a repository slug back to its original URL
 * @param slug The Base64 URL-encoded slug
 * @returns The original repository URL
 */
export function decodeRepositorySlug(slug: string): string {
    try {
        // Decode from base64url
        return Buffer.from(slug, 'base64url').toString('utf8');
    } catch (error) {
        logger.error(`Failed to decode repository slug: ${slug}`, error instanceof Error ? error : undefined);
        throw new Error(`Failed to decode repository slug: ${error}`);
    }
}

/**
 * Get the repository storage directory path
 * Repository storage should be in globalStorage, not in User/prompts
 * This keeps downloaded repository files separate from active prompts
 * @param context Optional extension context to use globalStorageUri (preferred)
 * @returns The absolute path to the repository storage directory
 */
export function getRepositoryStorageDirectory(context?: vscode.ExtensionContext): string {
    // Try to use context's globalStorageUri first (most reliable)
    if (context?.globalStorageUri) {
        return path.join(context.globalStorageUri.fsPath, 'repos');
    }

    // Fallback: use platform-specific globalStorage path
    const packageJson = require('../../package.json') as { publisher?: string; name?: string };
    const extensionId =
        packageJson?.publisher && packageJson?.name
            ? `${packageJson.publisher}.${packageJson.name}`
            : 'logientnventive.promptitude-extension';
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
