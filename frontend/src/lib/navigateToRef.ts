import { get } from 'svelte/store';
import { switchChannel, channels } from './channelStore';
import { objectRefStore } from './objectRefRegistry';
import { openPreferredMapSurface } from './mapWorkspace';
import { setPendingNav, type NavRef } from './pendingNav';
import type { ObjectRefKind } from './objectRefRegistry';

export type { NavRef } from './pendingNav';

function resolveObjectRefChannelId(kind: ObjectRefKind, targetId: string): string | undefined {
	const map = get(objectRefStore);
	for (const record of map.values()) {
		if (record.kind === kind && record.id === targetId) {
			return record.channelId || undefined;
		}
	}
	return undefined;
}

/** Resolve a channel ref: raw `ch_*` id, or channel name (case-insensitive). */
export function resolveChannelId(ref: string): string | null {
	if (!ref) return null;
	const cleaned = ref.replace(/^#/, '').trim();
	if (!cleaned) return null;
	if (cleaned.startsWith('ch_')) return cleaned;
	const name = cleaned.toLowerCase();
	const list = get(channels);
	const hit = list.find(
		(c) => c.id === cleaned || (c.name && c.name.toLowerCase() === name)
	);
	return hit?.id ?? null;
}

export async function navigateToRef(ref: NavRef): Promise<void> {
	switch (ref.kind) {
		case 'user':
			console.info(`[navigateToRef] User profile not yet implemented for userId: ${ref.userId}`);
			break;
		case 'channel': {
			const id = resolveChannelId(ref.channelId);
			if (id) switchChannel(id);
			break;
		}
		case 'place':
			await openPreferredMapSurface(ref.placeId, {
				layerId: ref.layerId ?? null,
				poiId: ref.poiId ?? null
			});
			break;
		case 'forum_post': {
			const channelId = ref.channelId || resolveObjectRefChannelId('forum_post', ref.postId);
			setPendingNav({ ...ref, channelId });
			if (channelId) switchChannel(channelId);
			break;
		}
		case 'wiki_page': {
			const channelId = ref.channelId || resolveObjectRefChannelId('wiki_page', ref.pageId);
			setPendingNav({ ...ref, channelId });
			if (channelId) switchChannel(channelId);
			break;
		}
		case 'gallery_work': {
			const channelId = ref.channelId || resolveObjectRefChannelId('gallery_work', ref.workId);
			setPendingNav({ ...ref, channelId });
			if (channelId) switchChannel(channelId);
			break;
		}
	}
}
