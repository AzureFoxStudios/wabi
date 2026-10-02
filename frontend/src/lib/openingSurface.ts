import { getStoredDbUserId, getStoredUsername } from './authSession';
import { getServerUrl } from './serverUrl';

import { accountPreferenceKey, parseOpeningSurface, type OpeningSurface } from './openingSurfacePreference';
export type { OpeningSurface } from './openingSurfacePreference';

function key(): string {
	const account = getStoredDbUserId() || getStoredUsername() || 'guest';
	return accountPreferenceKey('opening-surface', getServerUrl(), account);
}

/** A device preference, isolated by Authority and account. */
export function getOpeningSurface(): OpeningSurface {
	if (typeof localStorage === 'undefined') return 'last-channel';
	try { return parseOpeningSurface(localStorage.getItem(key())); }
	catch { return 'last-channel'; }
}

export function setOpeningSurface(surface: OpeningSurface): void {
	if (typeof localStorage === 'undefined') return;
	try { localStorage.setItem(key(), surface); }
	catch { /* Storage can be unavailable in private sessions. */ }
}
