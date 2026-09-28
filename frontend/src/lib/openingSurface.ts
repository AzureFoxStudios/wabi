import { getStoredDbUserId, getStoredUsername } from './authSession';
import { getServerUrl } from './serverUrl';

export type OpeningSurface = 'server' | 'messages';

function key(): string {
	const account = getStoredDbUserId() || getStoredUsername() || 'guest';
	return `wabi:opening-surface:${encodeURIComponent(getServerUrl())}:${encodeURIComponent(String(account))}`;
}

/** A device preference, isolated by Authority and account. */
export function getOpeningSurface(): OpeningSurface {
	if (typeof localStorage === 'undefined') return 'server';
	try { return localStorage.getItem(key()) === 'messages' ? 'messages' : 'server'; }
	catch { return 'server'; }
}

export function setOpeningSurface(surface: OpeningSurface): void {
	if (typeof localStorage === 'undefined') return;
	try { localStorage.setItem(key(), surface); }
	catch { /* Storage can be unavailable in private sessions. */ }
}
