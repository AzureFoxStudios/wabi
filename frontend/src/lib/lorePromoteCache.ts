/**
 * Client-side cache of chat→Lore promote provenance, keyed by message id.
 * Phase 1 population points: promote success (this client) and context-menu
 * open (lazy fetch). Full socket-push hydration is Phase 2.
 */
import { writable } from 'svelte/store';
import { getAuthToken } from '$lib/authSession';
import { getLorePromotesForMessage, type LorePromoteInfo } from '$lib/api/lore';

export const promoteCacheStore = writable<ReadonlyMap<string, LorePromoteInfo[]>>(new Map());
const promotesByMessage = new Map<string, LorePromoteInfo[]>();

export function getPromotesForMessage(messageId: string): LorePromoteInfo[] {
	return promotesByMessage.get(messageId) ?? [];
}

export function getPromoteForFile(messageId: string, fileUrl: string): LorePromoteInfo | undefined {
	return promotesByMessage.get(messageId)?.find((p) => p.fileUrl === fileUrl);
}

export function rememberPromotes(messageId: string, promotes: LorePromoteInfo[]): void {
	promotesByMessage.set(messageId, promotes);
	promoteCacheStore.set(promotesByMessage);
}

/** Lazy-fetch provenance for a message (used when its context menu opens). */
export async function fetchPromotesForMessage(messageId: string): Promise<void> {
	const token = getAuthToken();
	if (!token) return;
	try {
		rememberPromotes(messageId, await getLorePromotesForMessage(token, messageId));
	} catch {
		// Non-fatal: badge simply stays hidden.
	}
}
