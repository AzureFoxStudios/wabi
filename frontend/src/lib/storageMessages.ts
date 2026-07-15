/**
 * storageMessages.ts
 * Message storage operations and loading
 */

import { browser } from '$app/environment';
import type { Channel, Message } from './socket-types';
import { MAX_MESSAGES_PER_CHANNEL } from './storageTypes';
import type { LoadMessagesResult, StorageStats } from './storageTypes';
import type { IndexedDBWrapper } from './storageDb';
import type { ArchiveManager } from './storageArchive';
import type { StorageSettings } from './storageSettings';

export class MessageManager {
	constructor(
		private db: IndexedDBWrapper,
		private archiveManager: ArchiveManager,
		private settings: StorageSettings
	) {}

	async saveMessage(channel: string, message: Message): Promise<void> {
		if (!browser) return;

		const periodKey = this.settings.getPeriodKey();

		const data = await this.archiveManager.getCachedArchiveData(periodKey);
		if (!Array.isArray(data[channel])) data[channel] = [];

		const channelMessages = data[channel];
		const existingIndex = channelMessages.findIndex((entry) => entry.id === message.id);
		if (existingIndex >= 0) {
			channelMessages[existingIndex] = message;
		} else {
			channelMessages.push(message);
		}

		this.archiveManager.scheduleArchiveFlush(periodKey);
	}

	async loadAllMessages(channels?: Channel[]): Promise<LoadMessagesResult> {
		if (!browser) return { messages: {}, availableArchives: {} };

		await this.archiveManager.flushPendingArchiveWrites();

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
					`📚 Pagination enabled for ${channel}: loading recent ${MAX_MESSAGES_PER_CHANNEL} of ${allMessages[channel].length} messages (${allMessages[channel].length - MAX_MESSAGES_PER_CHANNEL} available via pagination)`
				);
				allMessages[channel] = allMessages[channel].slice(-MAX_MESSAGES_PER_CHANNEL);
			}

			if (availableArchives[channel]) {
				availableArchives[channel].sort();
			}
		});

		return { messages: allMessages, availableArchives };
	}

	async loadMessagesFromArchive(periodKey: string, channels?: Channel[]): Promise<LoadMessagesResult> {
		if (!browser) return { messages: {}, availableArchives: {} };

		const allMessages: Record<string, Message[]> = {};
		const availableArchives: Record<string, string[]> = {};
		const persistByChannel = channels
			? new Map(channels.map((channel) => [channel.id, channel.persistMessages === true]))
			: null;

		const archive = await this.db.getArchive(periodKey);
		if (!archive) return { messages: {}, availableArchives: {} };

		Object.entries(archive).forEach(([channel, messages]) => {
			if (persistByChannel && persistByChannel.get(channel) !== true) {
				return;
			}

			if (!allMessages[channel]) allMessages[channel] = [];
			allMessages[channel].push(...(messages as Message[]));

			if (!availableArchives[channel]) availableArchives[channel] = [];
			availableArchives[channel].push(periodKey);
		});

		Object.keys(allMessages).forEach((channel) => {
			allMessages[channel].sort((a, b) => a.timestamp - b.timestamp);
			if (availableArchives[channel]) {
				availableArchives[channel].sort();
			}
		});

		return { messages: allMessages, availableArchives };
	}

	async cleanupChannelHistory(channelId: string, serverMessages: Message[]): Promise<void> {
		if (!browser) return;

		const serverIds = new Set(serverMessages.map((m) => m.id));
		const minServerTimestamp = Math.min(...serverMessages.map((m) => m.timestamp));

		const archives = await this.db.getAllArchives();
		for (const archive of archives) {
			const data = (this.archiveManager.getArchiveCache().get(archive.period) || archive.data || {}) as Record<
				string,
				Message[]
			>;
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
				this.archiveManager.getArchiveCache().set(archive.period, data);
				await this.db.setArchive(archive.period, data);
				continue;
			}

			delete data[channelId];
			if (Object.keys(data).length === 0) {
				await this.db.deleteArchive(archive.period);
				this.archiveManager.getArchiveCache().delete(archive.period);
				this.archiveManager.getLoadPromises().delete(archive.period);
			} else {
				this.archiveManager.getArchiveCache().set(archive.period, data);
				await this.db.setArchive(archive.period, data);
			}
		}
	}

	async clearChannelMessages(channelId: string): Promise<void> {
		if (!browser) return;
		if (!channelId) return;

		const archives = await this.db.getAllArchives();
		for (const archive of archives) {
			const data = (this.archiveManager.getArchiveCache().get(archive.period) || archive.data || {}) as Record<
				string,
				Message[]
			>;
			if (!data[channelId]) continue;

			delete data[channelId];
			if (Object.keys(data).length === 0) {
				await this.db.deleteArchive(archive.period);
				this.archiveManager.getArchiveCache().delete(archive.period);
				this.archiveManager.getLoadPromises().delete(archive.period);
			} else {
				this.archiveManager.getArchiveCache().set(archive.period, data);
				await this.db.setArchive(archive.period, data);
			}
		}
	}

	async getStats(): Promise<StorageStats> {
		if (!browser) return { archives: [], totalSize: 0, totalMessages: 0 };

		await this.archiveManager.flushPendingArchiveWrites();

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
