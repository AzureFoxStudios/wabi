/**
 * pendingNav.ts — one-shot deep-link handoff for surface UIs (C2).
 *
 * navigateToRef sets a pending target, switches channel, then Forum/Wiki/Gallery
 * take the pending ref once they mount/load and open the right item.
 *
 * NavRef lives here (not navigateToRef) to avoid a circular import.
 */
import { writable, get } from 'svelte/store';

export type NavRef =
	| { kind: 'user'; userId: string }
	| { kind: 'channel'; channelId: string }
	| { kind: 'forum_post'; channelId?: string; postId: string }
	| { kind: 'wiki_page'; channelId?: string; pageId: string }
	| { kind: 'gallery_work'; channelId?: string; workId: string }
	| { kind: 'place'; placeId: string; layerId?: string; poiId?: string };

const pending = writable<NavRef | null>(null);

export function setPendingNav(ref: NavRef): void {
	pending.set(ref);
}

export function peekPendingNav(): NavRef | null {
	return get(pending);
}

/**
 * Consume a pending nav of the given kind (once).
 * If channelId is provided and the pending ref has a different channelId, leave it.
 */
export function takePendingNav(kind: NavRef['kind'], channelId?: string | null): NavRef | null {
	const cur = get(pending);
	if (!cur || cur.kind !== kind) return null;
	if (
		channelId &&
		'channelId' in cur &&
		typeof cur.channelId === 'string' &&
		cur.channelId &&
		cur.channelId !== channelId
	) {
		return null;
	}
	pending.set(null);
	return cur;
}

export function clearPendingNav(): void {
	pending.set(null);
}
