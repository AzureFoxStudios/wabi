import type { Message } from './socket';
import { browser } from '$app/environment';

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

const DB_NAME = 'wabi-chat-db';
const DB_VERSION = 1;
const MESSAGES_STORE = 'messages';
const SETTINGS_STORE = 'settings';

class IndexedDBWrapper {
	private db: IDBDatabase | null = null;
	private initPromise: Promise<void> | null = null;

	async init(): Promise<void> {
		if (!browser) return;
		if (this.db) return;
		if (this.initPromise) return this.initPromise;

		this.initPromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);

			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				this.db = request.result;
				resolve();
			};

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;

				// Create messages object store (key: period identifier like "2024-11")
				if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
					db.createObjectStore(MESSAGES_STORE, { keyPath: 'period' });
				}

				// Create settings object store (key: setting name)
				if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
					db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
				}
			};
		});

		return this.initPromise;
	}

	async getSetting(key: string): Promise<any> {
		if (!browser || !this.db) return null;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([SETTINGS_STORE], 'readonly');
			const store = transaction.objectStore(SETTINGS_STORE);
			const request = store.get(key);

			request.onsuccess = () => resolve(request.result?.value);
			request.onerror = () => reject(request.error);
		});
	}

	async setSetting(key: string, value: any): Promise<void> {
		if (!browser || !this.db) return;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([SETTINGS_STORE], 'readwrite');
			const store = transaction.objectStore(SETTINGS_STORE);
			const request = store.put({ key, value });

			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async getArchive(period: string): Promise<any> {
		if (!browser || !this.db) return null;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([MESSAGES_STORE], 'readonly');
			const store = transaction.objectStore(MESSAGES_STORE);
			const request = store.get(period);

			request.onsuccess = () => resolve(request.result?.data);
			request.onerror = () => reject(request.error);
		});
	}

	async setArchive(period: string, data: any): Promise<void> {
		if (!browser || !this.db) return;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([MESSAGES_STORE], 'readwrite');
			const store = transaction.objectStore(MESSAGES_STORE);
			const request = store.put({ period, data });

			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async deleteArchive(period: string): Promise<void> {
		if (!browser || !this.db) return;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([MESSAGES_STORE], 'readwrite');
			const store = transaction.objectStore(MESSAGES_STORE);
			const request = store.delete(period);

			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	async getAllArchiveKeys(): Promise<string[]> {
		if (!browser || !this.db) return [];

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([MESSAGES_STORE], 'readonly');
			const store = transaction.objectStore(MESSAGES_STORE);
			const request = store.getAllKeys();

			request.onsuccess = () => resolve(request.result as string[]);
			request.onerror = () => reject(request.error);
		});
	}

	async getAllArchives(): Promise<Array<{ period: string; data: any }>> {
		if (!browser || !this.db) return [];

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([MESSAGES_STORE], 'readonly');
			const store = transaction.objectStore(MESSAGES_STORE);
			const request = store.getAll();

			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	async clearAllArchives(): Promise<void> {
		if (!browser || !this.db) return;

		return new Promise((resolve, reject) => {
			const transaction = this.db!.transaction([MESSAGES_STORE], 'readwrite');
			const store = transaction.objectStore(MESSAGES_STORE);
			const request = store.clear();

			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
}

export class ChatStorage {
	private rotationPeriod: RotationPeriod = 'month'; // Default to monthly rotation
	private maxArchives = 4; // Keep last 4 periods
	private db: IndexedDBWrapper;
	private initPromise: Promise<void> | null = null;

	constructor() {
		this.db = new IndexedDBWrapper();
		if (browser) {
			this.initPromise = this.init();
		}
	}

	private async init(): Promise<void> {
		await this.db.init();
		await this.loadSettings();
	}

	private async ensureInit(): Promise<void> {
		if (this.initPromise) {
			await this.initPromise;
		}
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
		this.rotationPeriod = period;
		await this.db.setSetting('rotationPeriod', period);
	}

	async setMaxArchives(max: number) {
		if (!browser) return;
		await this.ensureInit();
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

	// Get current period identifier based on rotation setting
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

	// Check if storage is enabled
	async isEnabled(): Promise<boolean> {
		if (!browser) return false;
		await this.ensureInit();
		const enabled = await this.db.getSetting('saveHistory');
		return enabled === 'true' || enabled === true;
	}

	// Enable or disable storage
	async setEnabled(enabled: boolean) {
		if (!browser) return;
		await this.ensureInit();
		await this.db.setSetting('saveHistory', enabled.toString());
	}

	// Save message to current period's archive
	async saveMessage(channel: string, message: Message) {
		if (!browser) return;
		await this.ensureInit();

		const isEnabled = await this.isEnabled();
		if (!isEnabled) return;

		const periodKey = this.getPeriodKey();

		// Load current period's data
		const data = (await this.db.getArchive(periodKey)) || {};

		if (!data[channel]) data[channel] = [];
		data[channel].push(message);

		try {
			await this.db.setArchive(periodKey, data);
			await this.rotateArchives();
		} catch (e) {
			console.error('Failed to save message to IndexedDB:', e);
			// If quota exceeded, force rotation
			await this.rotateArchives();
		}
	}

	// Rotate: Delete old archives beyond maxArchives
	private async rotateArchives() {
		if (!browser) return;
		await this.ensureInit();

		const allKeys = (await this.db.getAllArchiveKeys()).sort().reverse();

		// Keep only the most recent maxArchives
		if (allKeys.length > this.maxArchives) {
			const toDelete = allKeys.slice(this.maxArchives);
			for (const key of toDelete) {
				console.log(`🗑️ Auto-deleting old archive: ${key}`);
				await this.db.deleteArchive(key);
			}
		}
	}

	// Load all messages from all archives
	async loadAllMessages(): Promise<Record<string, Message[]>> {
		if (!browser) return {};
		await this.ensureInit();

		const isEnabled = await this.isEnabled();
		if (!isEnabled) return {};

		const allMessages: Record<string, Message[]> = {};

		const archives = await this.db.getAllArchives();

		for (const archive of archives) {
			const periodData = archive.data || {};

			// Merge all channels
			Object.entries(periodData).forEach(([channel, messages]) => {
				if (!allMessages[channel]) allMessages[channel] = [];
				allMessages[channel].push(...(messages as Message[]));
			});
		}

		// Sort by timestamp
		Object.keys(allMessages).forEach((channel) => {
			allMessages[channel].sort((a, b) => a.timestamp - b.timestamp);
		});

		return allMessages;
	}

	// Delete specific archive
	async deleteArchive(periodKey: string) {
		if (!browser) return;
		await this.ensureInit();
		await this.db.deleteArchive(periodKey);
		console.log(`🗑️ Deleted archive: ${periodKey}`);
	}

	// Clear all history
	async clearAllHistory() {
		if (!browser) return;
		await this.ensureInit();
		await this.db.clearAllArchives();
		console.log('🗑️ Cleared all chat history');
	}

	// Export all archives as separate JSON files
	async exportArchives() {
		if (!browser) return;
		await this.ensureInit();

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
			a.download = `wabi-chat-${archive.period}.json`;
			a.click();
			URL.revokeObjectURL(url);
		});
	}

	// Export single archive
	async exportArchive(periodKey: string) {
		if (!browser) return;
		await this.ensureInit();

		const data = await this.db.getArchive(periodKey);

		if (!data) {
			alert('Archive not found');
			return;
		}

		const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `wabi-chat-${periodKey}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	// Get storage statistics
	async getStats(): Promise<StorageStats> {
		if (!browser) return { archives: [], totalSize: 0, totalMessages: 0 };
		await this.ensureInit();

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

export const chatStorage = new ChatStorage();
