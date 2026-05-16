import { get } from 'svelte/store';
import {
	channelHasMoreHistory,
	channelHistoryLoading,
	channelAvailableArchives,
	channelLoadedArchives,
	channelLoadingOlder
} from '$lib/socket';
import type { Message } from '$lib/socket';

export function parseSearchQuery(query: string): { text: string; byUser?: string; hasTypes: string[] } {
	const byUserMatch = query.match(/by:(\S+)/);
	const hasMatches = query.match(/has:(\S+)/g) || [];
	const byUser = byUserMatch ? byUserMatch[1] : undefined;
	const hasTypes = hasMatches.map((match) => match.replace('has:', '').toLowerCase());
	const text = query.replace(/by:\S+/g, '').replace(/has:\S+/g, '').trim().toLowerCase();

	return { text, byUser, hasTypes };
}

export function filterMessages(msgs: Message[], query: string, workingSetLimit: number): Message[] {
	const workingSet = msgs.length > workingSetLimit ? msgs.slice(-workingSetLimit) : msgs;
	if (!query.trim()) return workingSet;

	const { text, byUser, hasTypes } = parseSearchQuery(query);

	return workingSet.filter((msg) => {
		if (byUser && msg.user.toLowerCase() !== byUser.toLowerCase()) {
			return false;
		}

		if (hasTypes.length > 0) {
			const hasMatch = hasTypes.some((type) => {
				if (type === 'image' && msg.type === 'file' && msg.fileUrl?.match(/\.(jpg|jpeg|png|gif|webp)$/i)) return true;
				if (type === 'video' && msg.type === 'file' && msg.fileUrl?.match(/\.(mp4|webm|mov)$/i)) return true;
				if (type === 'file' && msg.type === 'file') return true;
				if (type === 'link' && msg.text.match(/https?:\/\//i)) return true;
				if (type === 'gif' && msg.type === 'gif') return true;
				return false;
			});
			if (!hasMatch) return false;
		}

		if (text && !msg.text.toLowerCase().includes(text)) {
			return false;
		}

		return true;
	});
}

export type HistoryFlags = {
	hasMoreServer: boolean;
	serverLoading: boolean;
	hasMoreArchive: boolean;
	archiveLoading: boolean;
};

export function getChannelHistoryFlags(channelId: string): HistoryFlags {
	const available = get(channelAvailableArchives)[channelId] || [];
	const loaded = get(channelLoadedArchives)[channelId] || new Set<string>();
	return {
		hasMoreServer: get(channelHasMoreHistory)[channelId] ?? false,
		serverLoading: get(channelHistoryLoading)[channelId] || false,
		hasMoreArchive: available.length > loaded.size,
		archiveLoading: get(channelLoadingOlder)[channelId] || false
	};
}

export async function waitForHistoryIdle(channelId: string, timeoutMs = 12_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { serverLoading, archiveLoading } = getChannelHistoryFlags(channelId);
		if (!serverLoading && !archiveLoading) return;
		await new Promise((resolve) => setTimeout(resolve, 120));
	}
}
