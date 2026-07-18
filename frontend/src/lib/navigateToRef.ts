import { get } from 'svelte/store';
import { switchChannel } from './channelStore';
import { objectRefStore } from './objectRefRegistry';
import { openPreferredMapSurface } from './mapWorkspace';
import type { ObjectRefKind } from './objectRefRegistry';

export type NavRef =
  | { kind: 'user'; userId: string }
  | { kind: 'channel'; channelId: string }
  | { kind: 'forum_post'; channelId?: string; postId: string }
  | { kind: 'wiki_page'; channelId?: string; pageId: string }
  | { kind: 'gallery_work'; channelId?: string; workId: string }
  | { kind: 'place'; placeId: string; layerId?: string; poiId?: string };

function resolveObjectRefChannelId(kind: ObjectRefKind, targetId: string): string | undefined {
	const map = get(objectRefStore);
	for (const record of map.values()) {
		if (record.kind === kind && record.id === targetId) {
			return record.channelId || undefined;
		}
	}
	return undefined;
}

export async function navigateToRef(ref: NavRef): Promise<void> {
	switch (ref.kind) {
		case 'user':
			console.info(`[navigateToRef] User profile not yet implemented for userId: ${ref.userId}`);
			break;
		case 'channel':
			switchChannel(ref.channelId);
			break;
		case 'place':
			await openPreferredMapSurface(ref.placeId, {
				layerId: ref.layerId ?? null,
				poiId: ref.poiId ?? null
			});
			break;
		case 'forum_post': {
			const channelId = ref.channelId || resolveObjectRefChannelId('forum_post', ref.postId);
			if (channelId) switchChannel(channelId);
			console.info(`[navigateToRef] Forum post ${ref.postId} (surface UI pending)`);
			break;
		}
		case 'wiki_page': {
			const channelId = ref.channelId || resolveObjectRefChannelId('wiki_page', ref.pageId);
			if (channelId) switchChannel(channelId);
			console.info(`[navigateToRef] Wiki page ${ref.pageId} (surface UI pending)`);
			break;
		}
		case 'gallery_work': {
			const channelId = ref.channelId || resolveObjectRefChannelId('gallery_work', ref.workId);
			if (channelId) switchChannel(channelId);
			console.info(`[navigateToRef] Gallery work ${ref.workId} (surface UI pending)`);
			break;
		}
	}
}
