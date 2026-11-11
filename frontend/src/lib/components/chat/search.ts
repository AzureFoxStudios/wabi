import { get } from 'svelte/store';
import {
	channelHasMoreHistory,
	channelHistoryLoading,
	channelAvailableArchives,
	channelLoadedArchives,
	channelLoadingOlder
} from '$lib/socket';

export { parseSearchQuery, filterMessages } from './searchFilter';

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
