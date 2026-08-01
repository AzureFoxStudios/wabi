/**
 * storage.ts (unified re-export)
 * Maintains 100% backward compatibility
 *
 * Re-exports from:
 * - storageTypes.ts: Type definitions and constants
 * - storageDb.ts: IndexedDB wrapper
 * - storageSettings.ts: Settings and rotation configuration
 * - storageArchive.ts: Archive management
 * - storageMessages.ts: Message operations
 * - storageEncryption.ts: Encryption management
 */

import { browser } from '$app/environment';
import { normalizeServerUrl, resolveServerUrl } from './serverUrl';
import { showToast } from '$lib/toast';
import type { RotationPeriod, LoadMessagesResult, StorageStats } from './storageTypes';
import { LEGACY_MIGRATION_SCOPE_KEY, LEGACY_DB_NAME } from './storageTypes';
import { IndexedDBWrapper } from './storageDb';
import { StorageSettings } from './storageSettings';
import { ArchiveManager } from './storageArchive';
import { MessageManager } from './storageMessages';
import type { Channel, Message } from './socket-types';

// ============================================================================
// RE-EXPORTS
// ============================================================================

export type { LoadMessagesResult, StorageStats, RotationPeriod } from './storageTypes';
export { enableStorageEncryption, disableStorageEncryption } from './storageEncryption';

// ============================================================================
// UTILITIES
// ============================================================================

function resolveStorageScope(): string {
	if (!browser) return 'ssr_default';
	return normalizeServerUrl(resolveServerUrl().url) || 'browser_default';
}

function getScopedDbName(serverScope: string): string {
	return `wabi-chat-db:${encodeURIComponent(serverScope)}`;
}

function getStorageExportLabel(serverScope: string): string {
	try {
		const parsed = new URL(serverScope);
		return parsed.hostname.replace(/[^a-z0-9.-]+/gi, '-').toLowerCase() || 'server';
	} catch {
		return 'server';
	}
}

function safeLocalGet(key: string): string | null {
	if (!browser) return null;
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeLocalSet(key: string, value: string | null): void {
	if (!browser) return;
	try {
		if (value === null) {
			localStorage.removeItem(key);
			return;
		}
		localStorage.setItem(key, value);
	} catch {
		// Ignore storage failures.
	}
}

// ============================================================================
// CHAT STORAGE CLASS
// ============================================================================

export class ChatStorage {
	private db: IndexedDBWrapper;
	private settings: StorageSettings;
	private archiveManager: ArchiveManager;
	private messageManager: MessageManager;
	private initPromise: Promise<void> | null = null;
	private readonly serverScope: string;
	private readonly exportLabel: string;

	constructor() {
		this.serverScope = resolveStorageScope();
		this.exportLabel = getStorageExportLabel(this.serverScope);
		this.db = new IndexedDBWrapper(getScopedDbName(this.serverScope));
		this.settings = new StorageSettings(this.db);
		this.archiveManager = new ArchiveManager(this.db, this.settings);
		this.messageManager = new MessageManager(this.db, this.archiveManager, this.settings);

		if (browser) {
			this.initPromise = this.init();
		}
	}

	private async init(): Promise<void> {
		await this.db.init();
		await this.migrateLegacyDatabaseIfNeeded();
		await this.settings.load();
		await this.archiveManager.cleanupOldArchives();
	}

	private async migrateLegacyDatabaseIfNeeded(): Promise<void> {
		if (!browser) return;

		const migrationScope = safeLocalGet(LEGACY_MIGRATION_SCOPE_KEY);
		if (migrationScope && migrationScope !== this.serverScope) {
			return;
		}

		const currentArchives = await this.db.getAllArchives();
		const currentSettings = await this.db.getAllSettings();
		if (currentArchives.length > 0 || currentSettings.length > 0) {
			if (!migrationScope) {
				safeLocalSet(LEGACY_MIGRATION_SCOPE_KEY, this.serverScope);
			}
			return;
		}

		const legacyDb = new IndexedDBWrapper(LEGACY_DB_NAME);
		await legacyDb.init();
		const legacyArchives = await legacyDb.getAllArchives();
		const legacySettings = await legacyDb.getAllSettings();
		if (legacyArchives.length === 0 && legacySettings.length === 0) {
			return;
		}

		for (const setting of legacySettings) {
			await this.db.setSetting(setting.key, setting.value);
		}
		for (const archive of legacyArchives) {
			await this.db.setArchive(archive.period, archive.data);
		}

		safeLocalSet(LEGACY_MIGRATION_SCOPE_KEY, this.serverScope);
		console.log(`Migrated legacy chat storage into server-scoped cache for ${this.serverScope}`);
	}

	private async ensureInit(): Promise<void> {
		if (this.initPromise) {
			await this.initPromise;
		}
	}

	async setRotationPeriod(period: RotationPeriod): Promise<void> {
		if (!browser) return;
		await this.ensureInit();
		await this.archiveManager.flushPendingArchiveWrites();
		await this.settings.setRotationPeriod(period);
	}

	async setMaxArchives(max: number): Promise<void> {
		if (!browser) return;
		await this.ensureInit();
		await this.archiveManager.flushPendingArchiveWrites();
		await this.archiveManager.setMaxArchives(max);
	}

	getRotationPeriod(): RotationPeriod {
		return this.settings.getRotationPeriod();
	}

	getMaxArchives(): number {
		return this.settings.getMaxArchives();
	}

	async isEnabled(): Promise<boolean> {
		if (!browser) return false;
		await this.ensureInit();
		return this.settings.isEnabled();
	}

	async setEnabled(enabled: boolean): Promise<void> {
		if (!browser) return;
		await this.ensureInit();
		await this.settings.setEnabled(enabled);
	}

	async getSetting(key: string): Promise<any> {
		if (!browser) return null;
		await this.ensureInit();
		return this.settings.getSetting(key);
	}

	async setSetting(key: string, value: any): Promise<void> {
		if (!browser) return;
		await this.ensureInit();
		return this.settings.setSetting(key, value);
	}

	async saveMessage(channel: string, message: Message): Promise<void> {
		if (!browser) return;
		await this.ensureInit();
		await this.messageManager.saveMessage(channel, message);
	}

	async loadAllMessages(channels?: Channel[]): Promise<LoadMessagesResult> {
		if (!browser) return { messages: {}, availableArchives: {} };
		await this.ensureInit();
		return this.messageManager.loadAllMessages(channels);
	}

	async loadMessagesFromArchive(periodKey: string, channels?: Channel[]): Promise<LoadMessagesResult> {
		if (!browser) return { messages: {}, availableArchives: {} };
		await this.ensureInit();
		return this.messageManager.loadMessagesFromArchive(periodKey, channels);
	}

	async cleanupChannelHistory(channelId: string, serverMessages: Message[]): Promise<void> {
		if (!browser) return;
		await this.ensureInit();
		await this.messageManager.cleanupChannelHistory(channelId, serverMessages);
	}

	async deleteArchive(periodKey: string): Promise<void> {
		if (!browser) return;
		await this.ensureInit();
		await this.db.deleteArchive(periodKey);
	}

	async clearAllHistory(): Promise<void> {
		if (!browser) return;
		await this.ensureInit();
		await this.archiveManager.clearAllArchives();
	}

	async clearChannelMessages(channelId: string): Promise<void> {
		if (!browser) return;
		if (!channelId) return;
		await this.ensureInit();
		await this.messageManager.clearChannelMessages(channelId);
	}

	async exportArchives(): Promise<void> {
		if (!browser) return;
		await this.ensureInit();
		await this.archiveManager.flushPendingArchiveWrites();

		const archives = await this.db.getAllArchives();

		if (archives.length === 0) {
			showToast('No archives to export', 'warning');
			return;
		}

		archives.forEach((archive) => {
			const data = JSON.stringify(archive.data);
			const blob = new Blob([data], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `wabi-chat-${this.exportLabel}-${archive.period}.json`;
			a.click();
			URL.revokeObjectURL(url);
		});
	}

	async exportArchive(periodKey: string): Promise<void> {
		if (!browser) return;
		await this.ensureInit();
		await this.archiveManager.flushPendingArchiveWrites();

		const data = await this.db.getArchive(periodKey);

		if (!data) {
			showToast('Archive not found', 'warning');
			return;
		}

		const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `wabi-chat-${this.exportLabel}-${periodKey}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	async getStats(): Promise<StorageStats> {
		if (!browser) return { archives: [], totalSize: 0, totalMessages: 0 };
		await this.ensureInit();
		return this.messageManager.getStats();
	}
}

export const chatStorage = new ChatStorage();
