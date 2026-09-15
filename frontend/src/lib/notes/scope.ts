import { get, readable } from 'svelte/store';
import { activeServerUrl, normalizeServerUrl } from '../serverUrl';
import { currentUser } from '../presenceIdentity';
import { authSessionGeneration, clearAuthSession, getAuthToken, getGuestSessionId, getStoredDbUserId, onAuthSessionCleared } from '../authSession';
import { NotebookError, type NotebookOwner } from './types';

export interface NotebookOwnerState {
	owner: NotebookOwner | null;
	error: string | null;
}

// No credentials or connection IDs leave this module. Unauthenticated offline
// use must be selected explicitly; it never adopts an earlier account's notes.
let offlineServer: string | null = null;
const temporaryGuests = new Map<string, { connection: string; id: string }>();
const refreshListeners = new Set<() => void>();

function server(): string {
	const value = normalizeServerUrl(get(activeServerUrl));
	if (!value) throw new NotebookError('unavailable', 'Choose a server before opening Notes.');
	return value;
}

function accountId(value: unknown): string | null {
	if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
	if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
	return value;
}

interface Identity { server: string; generation: number; kind: 'account' | 'guest' | 'offline'; id: string }

function identity(): Identity {
	if (typeof window === 'undefined') throw new NotebookError('unavailable', 'Notes needs device storage.');
	const endpoint = server();
	const generation = authSessionGeneration(endpoint);
	const user = get(currentUser);
	const token = getAuthToken(endpoint);
	const storedId = accountId(getStoredDbUserId(endpoint));
	const liveId = accountId(user?.dbUserId);
	if (token) {
		// A socket from a previous account/server can briefly remain mounted.
		// Stored identity belongs to the explicitly scoped authentication record.
		if (!storedId || (liveId && liveId !== storedId) || user?.isRegistered === false) {
			throw new NotebookError('unavailable', 'Waiting for your account identity before opening Notes.');
		}
		return { server: endpoint, generation, kind: 'account', id: storedId };
	}
	const guest = getGuestSessionId(endpoint);
	if (guest) return { server: endpoint, generation, kind: 'guest', id: guest };
	if (user && user.isRegistered !== true && !storedId) {
		let temporary = temporaryGuests.get(endpoint);
		if (!temporary || temporary.connection !== user.id) {
			temporary = { connection: user.id, id: crypto.randomUUID() };
			temporaryGuests.set(endpoint, temporary);
		}
		return { server: endpoint, generation, kind: 'guest', id: temporary.id };
	}
	if (offlineServer === endpoint) {
		const key = `wabi:notes:offline-device:v1:${encodeURIComponent(endpoint)}`;
		let id: string;
		try {
			const existing = window.localStorage.getItem(key);
			if (existing && !/^[0-9a-f-]{36}$/i.test(existing)) throw new Error('Invalid offline device identity');
			id = existing || crypto.randomUUID();
			if (!existing) window.localStorage.setItem(key, id);
		} catch {
			throw new NotebookError('unavailable', 'Device identity could not be saved. Enable local storage to use an offline notebook.');
		}
		return { server: endpoint, generation, kind: 'offline', id };
	}
	throw new NotebookError('unavailable', 'Sign in, join as a guest, or choose a separate offline notebook.');
}

function sameIdentity(a: Identity, b: Identity): boolean {
	return a.server === b.server && a.generation === b.generation && a.kind === b.kind && a.id === b.id;
}

// Retirement is permanent, including a switch away and back to the same server.
// These leaf subscriptions outlive individual editor mounts and pending saves.
let ownershipEpoch = 0;
let observed: Identity | null = null;
function observeBoundary(): void {
	let next: Identity | null = null;
	try { next = identity(); } catch { /* Not yet admitted to a notebook. */ }
	if ((observed === null) !== (next === null) || (observed && next && !sameIdentity(observed, next))) ownershipEpoch++;
	observed = next;
}
if (typeof window !== 'undefined') {
	const logoutKey = 'wabi:notes:session-retired:v1';
	const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(logoutKey);
	let receivingLogout = false;
	const received = new Set<string>();
	const receiveLogout = (message: unknown) => {
		if (!message || typeof message !== 'object') return;
		const { endpoint, nonce } = message as { endpoint?: unknown; nonce?: unknown };
		if (typeof endpoint !== 'string' || normalizeServerUrl(endpoint) !== endpoint || typeof nonce !== 'string' || received.has(nonce)) return;
		received.add(nonce);
		if (received.size > 100) received.delete(received.values().next().value!);
		receivingLogout = true;
		try { clearAuthSession(endpoint); } finally { receivingLogout = false; }
	};
	channel?.addEventListener('message', (event) => receiveLogout(event.data));
	window.addEventListener('storage', (event) => {
		if (event.key !== logoutKey || !event.newValue) return;
		try { receiveLogout(JSON.parse(event.newValue)); } catch { /* Malformed notification has no authority. */ }
	});
	activeServerUrl.subscribe(observeBoundary);
	currentUser.subscribe(observeBoundary);
	onAuthSessionCleared((endpoint) => {
		temporaryGuests.delete(endpoint);
		if (offlineServer === endpoint) offlineServer = null;
		observeBoundary();
		for (const refresh of refreshListeners) refresh();
		if (!receivingLogout) {
			const notice = { endpoint, nonce: crypto.randomUUID() };
			received.add(notice.nonce);
			channel?.postMessage(notice);
			try { window.localStorage.setItem(logoutKey, JSON.stringify(notice)); } catch { /* BroadcastChannel remains available when localStorage is full. */ }
		}
	});
}

/** Captures ownership before asynchronous reads/writes; never recalculate it at save time. */
export async function captureNotebookOwner(): Promise<NotebookOwner> {
	observeBoundary();
	const captured = identity();
	const epoch = ownershipEpoch;
	// Guest session identifiers can authenticate requests. Persist only a digest.
	const id = captured.kind === 'guest'
		? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(captured.id))), (byte) => byte.toString(16).padStart(2, '0')).join('')
		: captured.id;
	const isCurrent = () => {
		observeBoundary();
		try { return epoch === ownershipEpoch && sameIdentity(captured, identity()); } catch { return false; }
	};
	if (!isCurrent()) throw new NotebookError('retired', 'Your Notes account changed. Reopen the notebook.');
	return { scopeId: `notebook:v1:${encodeURIComponent(captured.server)}:${captured.kind}:${encodeURIComponent(id)}`, isCurrent };
}

/** User-selected, separate notebook; never merges or exposes a signed-out account. */
export async function chooseOfflineNotebook(): Promise<NotebookOwner> {
	offlineServer = server();
	const owner = await captureNotebookOwner();
	for (const refresh of refreshListeners) refresh();
	return owner;
}

export const notebookOwner = readable<NotebookOwnerState>({ owner: null, error: null }, (set) => {
	let request = 0;
	let disposed = false;
	let published: NotebookOwner | null = null;
	const refresh = () => {
		observeBoundary();
		if (published?.isCurrent()) return;
		const ticket = ++request;
		published = null;
		set({ owner: null, error: null });
		void captureNotebookOwner().then(
			(owner) => { if (!disposed && ticket === request) { published = owner; set({ owner, error: null }); } },
			(error: unknown) => { if (!disposed && ticket === request) set({ owner: null, error: error instanceof Error ? error.message : 'Notes ownership is unavailable.' }); }
		);
	};
	refreshListeners.add(refresh);
	const stopServer = activeServerUrl.subscribe(refresh);
	const stopUser = currentUser.subscribe(refresh);
	if (typeof window !== 'undefined') {
		window.addEventListener('storage', refresh);
		window.addEventListener('focus', refresh);
	}
	return () => {
		disposed = true;
		refreshListeners.delete(refresh);
		stopServer(); stopUser();
		if (typeof window !== 'undefined') {
			window.removeEventListener('storage', refresh);
			window.removeEventListener('focus', refresh);
		}
	};
});
