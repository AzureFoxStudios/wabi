import type { Channel } from './socket-types';

/** Recheck channel kind at execution time; never batch-leave a one-to-one DM. */
export async function leaveSelectedGroupChannels(
	channels: Channel[], selectedIds: string[], leave: (channelId: string) => Promise<void>
): Promise<{ attempted: number; leftIds: string[]; failedIds: string[] }> {
	const selected = new Set(selectedIds);
	const groups = channels.filter((channel) => channel.type === 'group' && selected.has(channel.id));
	const leftIds: string[] = [];
	const failedIds: string[] = [];
	for (const group of groups) {
		try { await leave(group.id); leftIds.push(group.id); }
		catch { failedIds.push(group.id); }
	}
	return { attempted: groups.length, leftIds, failedIds };
}
