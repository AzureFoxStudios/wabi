/**
 * presenceControl.ts — client side of self-selected presence.
 *
 * Owns the four-state picker (Online / Away / Busy / Invisible): persistence
 * in localStorage, optimistic local store updates, and the `set-presence`
 * socket emit. Invisible never exists as a wire value — the server masks it
 * to "offline" before broadcasting, so this module also writes the MASKED
 * status ("offline") into local stores to stay consistent with what others
 * see, while keeping the real selection only in localStorage.
 */

import { get } from 'svelte/store';
import { getSocket } from './socketConnection';
import { currentUser, users, serverMembers } from './socket-manager';

export type PresenceState = 'active' | 'away' | 'busy' | 'invisible';

const PRESENCE_KEY = 'wabi:presence';

/// What the rest of the world sees for each self-selected state.
/// Invisible masks to offline (Discord parity — your own dot goes grey too).
export function maskedStatus(presence: PresenceState): 'active' | 'away' | 'busy' | 'offline' {
	switch (presence) {
		case 'away':
			return 'away';
		case 'busy':
			return 'busy';
		case 'invisible':
			return 'offline';
		default:
			return 'active';
	}
}

export function isPresenceState(value: unknown): value is PresenceState {
	return value === 'active' || value === 'away' || value === 'busy' || value === 'invisible';
}

export function getStoredPresence(): PresenceState {
	try {
		const raw = localStorage.getItem(PRESENCE_KEY);
		if (isPresenceState(raw)) return raw;
	} catch {
		// localStorage unavailable (private mode) — default to active
	}
	return 'active';
}

function storePresence(presence: PresenceState): void {
	try {
		localStorage.setItem(PRESENCE_KEY, presence);
	} catch {
		// ignore
	}
}

/** Optimistically flip every local copy of SELF to the masked status. */
function applyLocalStatus(status: 'active' | 'away' | 'busy' | 'offline'): void {
	currentUser.update((me) => (me ? { ...me, status } : me));
	const selfId = get(currentUser)?.id;
	const selfDbId = get(currentUser)?.dbUserId;
	const matchesSelf = (u: { id: string; dbUserId?: number | null }): boolean =>
		(selfDbId != null && u.dbUserId === selfDbId) || u.id === selfId;
	users.update((list) => list.map((u) => (matchesSelf(u) ? { ...u, status } : u)));
	serverMembers.update((list) => list.map((u) => (matchesSelf(u) ? { ...u, status } : u)));
}

/**
 * Select a new presence: persist, optimistically update stores, and emit
 * `set-presence`. Safe to call when offline — the choice persists locally
 * and is re-asserted by `restorePresence()` on the next connect.
 */
export function selectPresence(presence: PresenceState): void {
	storePresence(presence);
	applyLocalStatus(maskedStatus(presence));
	getSocket()?.emit('set-presence', { presence });
}

/**
 * Re-assert the stored presence after (re)connect. Called once init lands
 * so a page reload restores Invisible/Away/Busy instead of snapping back
 * to Active. No-op for the default state.
 */
export function restorePresence(): void {
	const presence = getStoredPresence();
	if (presence === 'active') return;
	getSocket()?.emit('set-presence', { presence });
}
