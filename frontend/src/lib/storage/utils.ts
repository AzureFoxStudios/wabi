import { browser } from '$app/environment';
import { normalizeServerUrl, resolveServerUrl } from '../serverUrl';

export const LEGACY_DB_NAME = 'wabi-chat-db';
export const DB_NAME_PREFIX = 'wabi-chat-db:';
export const DB_VERSION = 1;
export const MESSAGES_STORE = 'messages';
export const SETTINGS_STORE = 'settings';
export const MAX_MESSAGES_PER_CHANNEL = 2000;
export const MAX_ARCHIVES_TO_KEEP = 2;
export const ARCHIVE_WRITE_BATCH_MS = 64;
export const LEGACY_MIGRATION_SCOPE_KEY = 'wabi_chat_db_legacy_scope_v1';
export const ENCRYPTION_KEY_SETTING = 'storage_encryption_key_v1';
export const ENCRYPTION_ENABLED_SETTING = 'storage_encryption_enabled';

export function resolveStorageScope(): string {
	if (!browser) return 'ssr_default';
	return normalizeServerUrl(resolveServerUrl().url) || 'browser_default';
}

export function getScopedDbName(serverScope: string): string {
	return `${DB_NAME_PREFIX}${encodeURIComponent(serverScope)}`;
}

export function getStorageExportLabel(serverScope: string): string {
	try {
		const parsed = new URL(serverScope);
		return parsed.hostname.replace(/[^a-z0-9.-]+/gi, '-').toLowerCase() || 'server';
	} catch {
		return 'server';
	}
}

export function safeLocalGet(key: string): string | null {
	if (!browser) return null;
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function safeLocalSet(key: string, value: string | null): void {
	if (!browser) return;
	try {
		if (value === null) {
			localStorage.removeItem(key);
			return;
		}
		localStorage.setItem(key, value);
	} catch {
		// Ignore storage failures
	}
}
