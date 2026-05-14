import type { Message, Channel } from '../socket-types';
import { browser } from '$app/environment';
import { IndexedDBWrapper } from './indexeddb';
import {
	resolveStorageScope,
	getScopedDbName,
	getStorageExportLabel,
	safeLocalGet,
	safeLocalSet,
	LEGACY_DB_NAME,
	LEGACY_MIGRATION_SCOPE_KEY,
	MAX_MESSAGES_PER_CHANNEL,
	MAX_ARCHIVES_TO_KEEP,
	ARCHIVE_WRITE_BATCH_MS
} from './utils';

export interface LoadMessagesResult {
	messages: Record<string, Message[]>;
	availableArchives: Record<string, string[]>;
}

export interface StorageStats {
	archives: Array<{
		period: string;
		size: number;
		messageCount: number;
	}>;
	totalSize: number;
	totalMessages: number;
}

export type RotationPeriod = 'week' | 'month' | 'half-year' | 'year';

export class ChatStorage {
	private rotationPeriod: RotationPeriod = 'month';
	private maxArchives = MAX_ARCHIVES_TO_KEEP;
	private db: IndexedDBWrapper;
	private initPromise: Promise<void> | null = null;
	private archiveCache = new Map<string, Record<string, Message[]>>();
	private archiveLoadPromises = new Map<string, Promise<Record<string, Message[]>>>();
	private pendingArchiveFlushes = new Map<string, ReturnType<typeof setTimeout>>();
	private rotatePromise: Promise<void> | null = null;
	private readonly serverScope: string;
	private readonly exportLabel: string;

	constructor() {
		this.serverScope = resolveStorageScope();
		this.exportLabel = getStorageExportLabel(this.serverScope);
		this.db = new IndexedDBWrapper(getScopedDbName(this.serverScope));
		if (browser) {
			this.initPromise = this.init();
		}
	}

	private async init(): Promise<void> {
		await this.db.init();
		await this.migrateLegacyDatabaseIfNeeded();
		await this.loadSettings();
		await this.cleanupOldArchives();
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

	private async cleanupOldArchives(): Promise<void> {
		if (!browser) return;
		const archives = await this.db.getAllArchives();
		if (archives.length > this.maxArchives) {
			const toDelete = archives.slice(0, archives.length - this.maxArchives);
			console.log(`🧹 Cleaning up ${toDelete.length} old archives to free storage`);
			for (const archive of toDelete) {
				await this.db.deleteArchive(archive.period);
			}
		}
	}

	private async ensureInit(): Promise<void> {
		if (this.initPromise) {
			await this.initPromise;
		}
	}

	private async getCachedArchiveData(periodKey: string): Promise<Record<string, Message[]>> {
		const cached = this.archiveCache.get(periodKey);
		if (cached) return cached;

		const existingLoad = this.archiveLoadPromises.get(periodKey);
		if (existingLoad) return existingLoad;

		const loadPromise = (async () => {
			const loaded = ((await this.db.getArchive(periodKey)) || {}) as Record<string, Message[]>;
			this.archiveCache.set(periodKey, loaded);
			this.archiveLoadPromises.delete(periodKey);
			return loaded;
		})();

		this.archiveLoadPromises.set(periodKey, loadPromise);
		return loadPromise;
	}

	private scheduleArchiveFlush(periodKey: string): void {
		if (this.pendingArchiveFlushes.has(periodKey)) return;
		const handle = setTimeout(() => {
			this.pendingArchiveFlushes.delete(periodKey);
			void this.flushArchive(periodKey);
		}, ARCHIVE_WRITE_BATCH_MS);
		this.pendingArchiveFlushes.set(periodKey, handle);
	}

	private async flushArchive(periodKey: string): Promise<void> {
		const data = this.archiveCache.get(periodKey);
		if (!data) return;

		try {
			await this.db.setArchive(periodKey, data);
		} catch (error) {
			console.error('Failed to flush archive to IndexedDB:', error);
		}

		await this.scheduleRotateArchives();
	}

	private async flushPendingArchiveWrites(): Promise<void> {
		if (this.pendingArchiveFlushes.size === 0) return;

		const pendingPeriods = Array.from(this.pendingArchiveFlushes.keys());
		for (const handle of this.pendingArchiveFlushes.values()) {
			clearTimeout(handle);
		}
		this.pendingArchiveFlushes.clear();

		await Promise.all(pendingPeriods.map((periodKey) => this.flushArchive(periodKey)));
	}

	private async scheduleRotateArchives(): Promise<void> {
		if (!this.rotatePromise) {
			this.rotatePromise = (async () => {
				try {
					await this.rotateArchives();
				} finally {
					this.rotatePromise = null;
				}
			})();
		}
		await this.rotatePromise;
	}

	private async loadSettings() {
		if (!browser) return;

		const period = await this.db.getSetting('rotationPeriod');
		if (period) this.rotationPeriod = period as RotationPeriod;

		const max = await this.db.getSetting('maxArchives');
		if (max) this.maxArchives = parseInt(max);
	}

	async setRotationPeriod(period: RotationPeriod) {
		if (!browser) return;
		await this.ensureInit();
		await this.flushPendingArchiveWrites();
		this.rotationPeriod = period;
		await this.db.setSetting('rotationPeriod', period);
	}

	async setMaxArchives(max: number) {
		if (!browser) return;
		await this.ensureInit();
		await this.flushPendingArchiveWrites();
		this.maxArchives = max;
		await this.db.setSetting('maxArchives', max.toString());
		await this.rotateArchives();
	}

	getRotationPeriod(): RotationPeriod {
		return this.rotationPeriod;
	}

	getMaxArchives(): number {
		return this.maxArchives;
	}

	private getPeriodKey(): string {
		const now = new Date();
		const year = now.getFullYear();

		switch (this.rotationPeriod) {
			case 'week': {
				const week = this.getWeekNumber(now);
				return `${year}-W${String(week).padStart(2, '0')}`;
			}
			case 'month': {
				const month = now.getMonth() + 1;
				return `${year}-${String(month).padStart(2, '0')}`;
			}
			case 'half-year': {
				const half = now.getMonth() < 6 ? 'H1' : 'H2';
				return `${year}-${half}`;
			}
			case 'year': {
				return `${year}`;
			}
		}
	}

	private getWeekNumber(date: Date): number {
		const firstDay = new Date(date.getFullYear(), 0, 1);
		const days = Math.floor((date.getTime() - firstDay.getTime()) / (24 * 60 * 60 * 1000));
		return Math.ceil((days + firstDay.getDay() + 1) / 7);
	}

	async isEnabled(): Promise<boolean> {
		if (!browser) return false;
		await this.ensureInit();
		const enabled = await this.db.getSetting('saveHistory');
		return enabled === 'true' || enabled === true;
	}

	async setEnabled(enabled: boolean) {
		if (!browser) return;
		await this.ensureInit();
		await this.db.setSetting('saveHistory', enabled.toString());
	}

	async getSetting(key: string): Promise<any> {
		if (!browser) return null;
		await this.ensureInit();
		return this.db.getSetting(key);
	}

	async setSetting(key: string, value: any): Promise<void> {
		if (!browser) return;
		await this.ensureInit();
		return this.db.setSetting(key, value);
	}

	async saveMessage(channel: string, message: Message) {
		if (!browser) return;
		await this.ensureInit();

		const periodKey = this.getPeriodKey();

		const data = await this.getCachedArchiveData(periodKey);
		if (!Array.isArray(data[channel])) data[channel] = [];

		const channelMessages = data[channel];
		const existingIndex = channelMessages.findIndex((entry) => entry.id === message.id);
		if (existingIndex >= 0) {
			channelMessages[existingIndex] = message;
		} else {
			channelMessages.push(message);
		}

		this.scheduleArchiveFlush(periodKey);
	}

	private async rotateArchives() {
		if (!browser) return;
		await this.ensureInit();

		const allKeys = (await this.db.getAllArchiveKeys()).sort().reverse();

		if (allKeys.length > this.maxArchives) {
			const toDelete = allKeys.slice(this.maxArchives);
			for (const key of toDelete) {
				console.log(`🗑️ Auto-deleting old archive: ${key}`);
				await this.db.deleteArchive(key);
				this.archiveCache.delete(key);
				this.archiveLoadPromises.delete(key);
			}
		}
	}

	async loadAllMessages(channels?: Channel[]): Promise<LoadMessagesResult> {
		if (!browser) return { messages: {}, availableArchives: {} };
		await this.ensureInit();
		await this.flushPendingArchiveWrites();

		const allMessages: Record<string, Message[]> = {};
		const availableArchives: Record<string, string[]> = {};
		const persistByChannel = channels
			? new Map(channels.map((channel) => [channel.id, channel.persistMessages === true]))
			: null;

		const archives = await this.db.getAllArchives();

		for (const archive of archives) {
			const periodData = archive.data || {};

			Object.entries(periodData).forEach(([channel, messages]) => {
				if (persistByChannel && persistByChannel.get(channel) !== true) {
					return;
				}

				if (!allMessages[channel]) allMessages[channel] = [];
				allMessages[channel].push(...(messages as Message[]));

				if (!availableArchives[channel]) availableArchives[channel] = [];
				availableArchives[channel].push(archive.period);
			});
		}

		Object.keys(allMessages).forEach((channel) => {
			allMessages[channel].sort((a, b) => a.timestamp - b.timestamp);

			if (allMessages[channel].length > MAX_MESSAGES_PER_CHANNEL) {
				console.log(
					`📚 Pagination enabled for ${channel}: loading recent ${MAX_MESSAGES_PER_CHANNEL} of ${allMessages[channel].length} messages`
				);
				allMessages[channel] = allMessages[channel].slice(-MAX_MESSAGES_PER_CHANNEL);
			}

			if (availableArchives[channel]) {
				availableArchives[channel].sort();
			}
		});

		return { messages: allMessages, availableArchives };
	}

	async loadArchiveForChannel(channelId: string, archiveKey: string): Promise<Message[]> {
		if (!browser) return [];
		await this.ensureInit();
		await this.flushPendingArchiveWrites();

		const data = await this.db.getArchive(archiveKey);
		if (!data || !data[channelId]) return [];

		const messages = data[channelId] as Message[];
		return messages.sort((a, b) => a.timestamp - b.timestamp);
	}

	async getAvailableArchives(channelId: string): Promise<string[]> {
		if (!browser) return [];
		await this.ensureInit();
		await this.flushPendingArchiveWrites();

		const archives = await this.db.getAllArchives();
		const result: string[] = [];

		for (const archive of archives) {
			if (archive.data && archive.data[channelId]) {
				result.push(archive.period);
			}
		}

		return result.sort();
	}

	async deleteArchive(periodKey: string) {
		if (!browser) return;
		await this.ensureInit();
		const pendingHandle = this.pendingArchiveFlushes.get(periodKey);
		if (pendingHandle) {
			clearTimeout(pendingHandle);
			this.pendingArchiveFlushes.delete(periodKey);
		}
		await this.db.deleteArchive(periodKey);
		this.archiveCache.delete(periodKey);
		this.archiveLoadPromises.delete(periodKey);
		console.log(`🗑️ Deleted archive: ${periodKey}`);
	}

	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		if (!browser) return;
		await this.ensureInit();
		await this.flushPendingArchiveWrites();

		const archives = await this.db.getAllArchives();
		for (const archive of archives) {
			const data = (this.archiveCache.get(archive.period) || archive.data || {}) as Record<string, Message[]>;
			const channelMessages = data[channelId] as Message[] | undefined;
			if (!Array.isArray(channelMessages) || channelMessages.length === 0) continue;

			const filtered = channelMessages.filter((m) => m.id !== messageId);
			if (filtered.length === channelMessages.length) continue;

			if (filtered.length > 0) {
				data[channelId] = filtered;
				this.archiveCache.set(archive.period, data);
				await this.db.setArchive(archive.period, data);
				continue;
			}

			delete data[channelId];
			if (Object.keys(data).length === 0) {
				await this.db.deleteArchive(archive.period);
				this.archiveCache.delete(archive.period);
				this.archiveLoadPromises.delete(archive.period);
			} else {
				this.archiveCache.set(archive.period, data);
				await this.db.setArchive(archive.period, data);
			}
		}
	}

	async reconcileChannelWindow(channelId: string, serverMessages: Message[]): Promise<void> {
		if (!browser) return;
		await this.ensureInit();
		await this.flushPendingArchiveWrites();

		const serverIds = new Set(serverMessages.map((m) => m.id));
		const minServerTimestamp = serverMessages.length > 0
			? Math.min(...serverMessages.map((m) => m.timestamp))
			: Number.POSITIVE_INFINITY;

		const archives = await this.db.getAllArchives();
		for (const archive of archives) {
			const data = (this.archiveCache.get(archive.period) || archive.data || {}) as Record<string, Message[]>;
			const channelMessages = data[channelId] as Message[] | undefined;
			if (!Array.isArray(channelMessages) || channelMessages.length === 0) continue;

			const filtered = channelMessages.filter((m) => {
				if (serverMessages.length === 0) return false;
				if (m.timestamp < minServerTimestamp) return true;
				return serverIds.has(m.id);
			});

			if (filtered.length === channelMessages.length) continue;

			if (filtered.length > 0) {
				data[channelId] = filtered;
				this.archiveCache.set(archive.period, data);
				await this.db.setArchive(archive.period, data);
				continue;
			}

			delete data[channelId];
			if (Object.keys(data).length === 0) {
				await this.db.deleteArchive(archive.period);
				this.archiveCache.delete(archive.period);
				this.archiveLoadPromises.delete(archive.period);
			} else {
				this.archiveCache.set(archive.period, data);
				await this.db.setArchive(archive.period, data);
			}
		}
	}

	async clearAllHistory() {
		if (!browser) return;
		await this.ensureInit();
		for (const [periodKey, handle] of this.pendingArchiveFlushes.entries()) {
			clearTimeout(handle);
			this.pendingArchiveFlushes.delete(periodKey);
		}
		await this.db.clearAllArchives();
		this.archiveCache.clear();
		this.archiveLoadPromises.clear();
		console.log('🗑️ Cleared all chat history');
	}

	async exportArchives() {
		if (!browser) return;
		await this.ensureInit();
		await this.flushPendingArchiveWrites();

		const archives = await this.db.getAllArchives();

		if (archives.length === 0) {
			alert('No archives to export');
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

	async exportArchive(periodKey: string) {
		if (!browser) return;
		await this.ensureInit();
		await this.flushPendingArchiveWrites();

		const data = await this.db.getArchive(periodKey);

		if (!data) {
			alert('Archive not found');
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
		await this.flushPendingArchiveWrites();

		const archives = await this.db.getAllArchives();

		const stats = archives
			.map((archive) => {
				const data = JSON.stringify(archive.data);
				const size = new Blob([data]).size;
				const parsed = archive.data as Record<string, Message[]>;
				const messageCount = Object.values(parsed).reduce((sum, msgs) => sum + msgs.length, 0);

				return { period: archive.period, size, messageCount };
			})
			.sort((a, b) => b.period.localeCompare(a.period));

		const totalSize = stats.reduce((sum, a) => sum + a.size, 0);
		const totalMessages = stats.reduce((sum, a) => sum + a.messageCount, 0);

		return { archives: stats, totalSize, totalMessages };
	}
}
