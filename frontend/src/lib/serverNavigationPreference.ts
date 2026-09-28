import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import type { SavedServerView } from './savedServers';

const RAIL_KEY = 'wabi.desktop.serverRailPinned';

function readRailPreference(): boolean {
	if (!browser) return false;
	try {
		return localStorage.getItem(RAIL_KEY) === 'true';
	} catch {
		return false;
	}
}

/** The server rail is an optional desktop shortcut, not permanent navigation. */
export const desktopServerRailPinned = writable(readRailPreference());

if (browser) {
	desktopServerRailPinned.subscribe((pinned) => {
		try {
			localStorage.setItem(RAIL_KEY, String(pinned));
		} catch {
			// Local preferences remain usable for this session without storage.
		}
	});
}

/** Keep the Wabi menu useful without reproducing the full server browser in it. */
export function recentSavedServers(servers: SavedServerView[], count = 5): SavedServerView[] {
	return [...servers]
		.sort((a, b) => b.lastConnectedAt - a.lastConnectedAt || a.order - b.order)
		.slice(0, count);
}
