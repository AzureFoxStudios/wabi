/**
 * storageArchive.ts
 * Archive management, caching, flushing, rotation, and cleanup
 */

import { browser } from '$app/environment';
import { ARCHIVE_WRITE_BATCH_MS, MAX_ARCHIVES_TO_KEEP } from './storageTypes';
import type { IndexedDBWrapper } from './storageDb';
import type { StorageSettings } from './storageSettings';
import type { Message } from './socket-types';

export class ArchiveManager {
	private archiveCache = new Map<string, Record<string, Message[]>>();
	private archiveLoadPromises = new Map<string, Promise<Record<string, Message[]>>>();
	private pendingArchiveFlushes = new Map<string, ReturnType<typeof setTimeout>>();
	private rotatePromise: Promise<void> | null = null;
	private maxArchives = MAX_ARCHIVES_TO_KEEP;

	constructor(
		private db: IndexedDBWrapper,
		private settings: StorageSettings
	) {
		this.maxArchives = settings.getMaxArchives();
	}

	async setMaxArchives(max: number): Promise<void> {
		this.maxArchives = max;
		await this.settings.setMaxArchives(max);
		await this.rotateArchives();
	}

	async getCachedArchiveData(periodKey: string): Promise<Record<string, Message[]>> {
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

	scheduleArchiveFlush(periodKey: string): void {
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

	async flushPendingArchiveWrites(): Promise<void> {
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

	private async rotateArchives(): Promise<void> {
		if (!browser) return;

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

	async cleanupOldArchives(): Promise<void> {
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

	async clearAllArchives(): Promise<void> {
		if (!browser) return;
		for (const [periodKey, handle] of this.pendingArchiveFlushes.entries()) {
			clearTimeout(handle);
			this.pendingArchiveFlushes.delete(periodKey);
		}
		await this.db.clearAllArchives();
		this.archiveCache.clear();
		this.archiveLoadPromises.clear();
		console.log('🗑️ Cleared all chat history');
	}

	getArchiveCache(): Map<string, Record<string, Message[]>> {
		return this.archiveCache;
	}

	getLoadPromises(): Map<string, Promise<Record<string, Message[]>>> {
		return this.archiveLoadPromises;
	}
}
