import { get, writable } from 'svelte/store';
import type { Writable } from 'svelte/store';

/**
 * Broadcast-lite lifecycle store for media-album deletion/creation.
 *
 * Problem: the chat announcement card (`MessageContent.svelte`, class
 * `album-message-card`) parses only `{ name, kind }` out of the message text
 * (`parseAlbumAnnouncement`), so it has no album id to query. When an album is
 * deleted in the Albums tab, nothing told the chat card and it stayed stuck on
 * "Empty album" / "Add Media" forever.
 *
 * Fix: the Albums tab records deletions here (by id AND by normalized name),
 * and the chat card matches by name via `isAlbumDeletedByName`. When an album
 * is recreated with the same name, the deleted flag for that name is cleared
 * so the card returns to the live empty state.
 *
 * Scope note: this store is same-tab-session only (Svelte store). A different
 * client that deletes the album will NOT update this client's chat cards —
 * cross-client propagation would need a socket event and is out of scope.
 */

/** Album ids known to be deleted in this session. */
export const deletedAlbumIds: Writable<Set<number>> = writable(new Set<number>());

/** Normalized (trimmed, lower-cased) album names known to be deleted. */
export const deletedAlbumNames: Writable<Set<string>> = writable(new Set<string>());

/** Name snapshot taken at delete time, keyed by album id. */
const deletedAlbumNameById: Map<number, string> = new Map();

export function normalizeAlbumLifecycleName(name: string | null | undefined): string {
	return (name ?? '').trim().toLowerCase();
}

export function markAlbumDeleted(id: number, name?: string | null): void {
	if (typeof id === 'number' && Number.isFinite(id)) {
		deletedAlbumIds.update((current) => {
			const next = new Set(current);
			next.add(id);
			return next;
		});
	}
	const trimmedName = (name ?? '').trim();
	if (trimmedName) {
		deletedAlbumNameById.set(id, trimmedName);
		const normalized = normalizeAlbumLifecycleName(trimmedName);
		deletedAlbumNames.update((current) => {
			const next = new Set(current);
			next.add(normalized);
			return next;
		});
	}
}

export function isAlbumDeleted(id: number): boolean {
	return get(deletedAlbumIds).has(id);
}

/** Snapshot of the album name taken when `markAlbumDeleted` was called. */
export function getAlbumName(id: number): string | null {
	return deletedAlbumNameById.get(id) ?? null;
}

/**
 * Pure helper for reactive Svelte usage: pass the subscribed store value
 * (`$deletedAlbumNames`) so the card re-renders when the set changes.
 */
export function isAlbumDeletedByNameSet(names: Set<string>, name: string | null | undefined): boolean {
	if (!name) return false;
	return names.has(normalizeAlbumLifecycleName(name));
}

/** Non-reactive convenience wrapper (reads the store via `get`). */
export function isAlbumDeletedByName(name: string | null | undefined): boolean {
	return isAlbumDeletedByNameSet(get(deletedAlbumNames), name);
}

/**
 * Clear the deleted flag for a name — called when an album is (re)created
 * with that name so the chat card returns to the live state.
 */
export function markAlbumCreated(name: string | null | undefined): void {
	const normalized = normalizeAlbumLifecycleName(name);
	if (!normalized) return;
	deletedAlbumNames.update((current) => {
		if (!current.has(normalized)) return current;
		const next = new Set(current);
		next.delete(normalized);
		return next;
	});
}
