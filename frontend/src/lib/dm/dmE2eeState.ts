/**
 * Per-conversation E2EE status for DM/private conversation surfaces.
 *
 * Server-side key wrapping: `/api/e2ee/channels/{id}` (status, enable, rekey).
 * Client-side: `e2ee.ts` holds device identity + room-key cache and does the
 * actual AES-GCM encryption/decryption of message payloads.
 *
 * This module is the UI-facing state: it caches the last known room status per
 * conversation so the header pill and composer indicator don't refetch on every
 * render, and exposes one enable action that both DmConversationView and DMTab
 * call.
 */
import { allowServerReadableRoom, e2eeClientRealmKey, enableE2eeRoom, ensureE2eeDeviceRegistered, getE2eeRoomStatus, rekeyE2eeRoom, storedE2eeRoomStatus, type E2eeRoomStatus } from '$lib/e2ee';
import { roomKeepReason, type KeepReason } from '$lib/privacy/contentEgress';
import { getServerUrl } from '$lib/serverUrl';
import { writable } from 'svelte/store';

const statusCache = new Map<string, E2eeRoomStatus>();

/**
 * Bumps whenever the cache above changes, so components that gate on a room's status
 * (privacy/contentEgress.ts) re-read `cachedE2eeStatus` instead of keeping their own copy.
 */
export const e2eeStatusRevision = writable(0);

function cacheKey(channelId: string): string | null {
	try { return `${e2eeClientRealmKey()}:${channelId}`; }
	catch { return null; }
}

function remember(channelId: string, status: E2eeRoomStatus): E2eeRoomStatus {
	const key = cacheKey(channelId);
	if (key) {
		statusCache.set(key, status);
		freshStatus.add(key);
		e2eeStatusRevision.update((value) => value + 1);
	}
	return status;
}

/**
 * Read-through cache: returns cached status without a network call. A miss is seeded from the
 * status this device stored last time (e2ee.ts keeps it in localStorage and never lets it
 * downgrade an observed encrypted room), so a server-readable DM does not first render as
 * "checking" on every page load. No stored status: null, and gates fail closed.
 */
export function cachedE2eeStatus(channelId: string): E2eeRoomStatus | null {
	const key = cacheKey(channelId);
	if (!key) return null;
	const cached = statusCache.get(key);
	if (cached) return cached;
	const stored = channelId ? storedE2eeRoomStatus(channelId) : null;
	if (stored) statusCache.set(key, stored);
	return stored;
}

/** DM and group ids the server mints ('dm-…', 'dm_…', 'group-…'). */
export function looksLikePrivateConversationId(channelId: string): boolean {
	return channelId.startsWith('dm-') || channelId.startsWith('dm_') || channelId.startsWith('group-');
}

/**
 * The one room derivation every gate uses (MessageList, MessageContent, MessageItem, the Albums
 * tab): why this room's content stays on the device, or null.
 *
 * - A known channel uses its own kind; DMs and groups read the cached status above.
 * - A channel missing from the channel list whose id is a DM/group id fails closed as a DM.
 * - Any other unlisted id is treated as a shared channel (server-readable). That room could only
 *   be encrypted if it were a DM or group; and every message that arrived encrypted is still
 *   kept by its own flag (contentEgress.keepReasonFor), whatever the room answer.
 *
 * `_revision` is `$e2eeStatusRevision`, so reactive callers re-run when the cache changes.
 */
export function roomContentKeepReason(
	channelId: string | null | undefined,
	channelType: string | null | undefined,
	_revision?: number
): KeepReason | null {
	const id = String(channelId ?? '');
	if (!id) return null;
	const type = channelType || (looksLikePrivateConversationId(id) ? 'dm' : 'text');
	const conversation = type === 'dm' || type === 'group';
	const reason = roomKeepReason({ channelType: type, policy: conversation ? cachedE2eeStatus(id) : null });
	// The server never answered after the retries (for example no E2EE endpoint): still kept, but
	// say so instead of "still checking" for good.
	if (reason === 'checking' && conversation && statusUnanswered(id)) return 'status-unavailable';
	return reason;
}

let STATUS_RETRY_DELAYS_MS = [2000, 4000, 8000];
/** Tests only: shorten the retry schedule. */
export function _setStatusRetryDelaysForTest(delays: number[]): void {
	STATUS_RETRY_DELAYS_MS = delays;
}
type StatusRequestState = { attempt: number; timer: ReturnType<typeof setTimeout> | null; inFlight: boolean; exhausted: boolean; channelId: string };
const statusRequests = new Map<string, StatusRequestState>();
/** Rooms whose status was fetched fresh this session (a seeded value is only this device's last answer). */
const freshStatus = new Set<string>();
let focusRetryBound = false;

function bindFocusRetry(): void {
	if (focusRetryBound || typeof window === 'undefined') return;
	focusRetryBound = true;
	window.addEventListener('focus', () => {
		for (const [key, state] of statusRequests) {
			if (!state.exhausted) continue;
			statusRequests.delete(key);
			ensureE2eeStatus(state.channelId);
		}
	});
}

function statusUnanswered(channelId: string): boolean {
	const key = cacheKey(channelId);
	return Boolean(key && statusRequests.get(key)?.exhausted);
}

/**
 * Fetch a room's status once per session for surfaces that gate content on it (they may open
 * before the header or composer does). A failure retries after 2, 4 and 8 seconds, then on the
 * next window focus: the same cadence the composer uses. Every consumer shares one schedule per
 * room; while nothing is known, gates stay closed.
 */
export function ensureE2eeStatus(channelId: string): void {
	if (!channelId) return;
	const key = cacheKey(channelId);
	if (!key || freshStatus.has(key)) return;
	const existing = statusRequests.get(key);
	if (existing && (existing.inFlight || existing.timer || existing.exhausted)) return;
	const state: StatusRequestState = existing ?? { attempt: 0, timer: null, inFlight: false, exhausted: false, channelId };
	statusRequests.set(key, state);
	const run = (): void => {
		state.timer = null;
		state.inFlight = true;
		refreshE2eeStatus(channelId)
			.then(() => {
				freshStatus.add(key);
				statusRequests.delete(key);
			})
			.catch(() => {
				state.inFlight = false;
				const delay = STATUS_RETRY_DELAYS_MS[state.attempt];
				state.attempt += 1;
				if (delay === undefined) {
					state.exhausted = true;
					bindFocusRetry();
					e2eeStatusRevision.update((value) => value + 1);
					return;
				}
				state.timer = setTimeout(run, delay);
			});
	};
	run();
}

/** Fetch fresh status and update the cache (fail-closed: errors leave the cache as-is). */
export async function refreshE2eeStatus(channelId: string): Promise<E2eeRoomStatus> {
	return remember(channelId, await getE2eeRoomStatus(channelId, false));
}

/**
 * Encrypt future messages when every participant has an updated device.
 * Existing server-readable history remains readable; an explicit readable
 * choice on a new room is respected.
 */
export async function prepareNewConversationEncryption(channelId: string): Promise<E2eeRoomStatus> {
	await ensureE2eeDeviceRegistered();
	let status = await refreshE2eeStatus(channelId);
	if (status.enabled || status.serverReadableSelected || status.missingUserIds.length) return status;
	try {
		status = remember(channelId, await enableE2eeRoom(channelId));
	} catch (error) {
		// Another participant may have enabled encryption or explicitly chosen
		// server-readable mode while this device wrapped the room key.
		status = await refreshE2eeStatus(channelId);
		if (!status.enabled && !status.serverReadableSelected) throw error;
	}
	return status;
}

export async function chooseServerReadable(channelId: string): Promise<E2eeRoomStatus> {
	await allowServerReadableRoom(channelId);
	return refreshE2eeStatus(channelId);
}

/** Probe the endpoint once per session so a stale cache never lies about capabilities. */
let probed = false;
export async function probeE2eeOnce(): Promise<void> {
	if (probed) return;
	probed = true;
	try {
		await getE2eeRoomStatus('');
	} catch {
		// Endpoint present but "no conversation" style errors are fine.
	}
}

/**
 * Turn on E2EE for a conversation. Rekeys when the participant set changed.
 * Returns the fresh status. Callers show the actual setup failure to the user.
 */
export async function turnOnE2ee(channelId: string): Promise<E2eeRoomStatus> {
	return remember(channelId, await enableE2eeRoom(channelId));
}

/** Rekey after membership changes (or when the server reports needsRekey). */
export async function rekeyE2ee(channelId: string): Promise<E2eeRoomStatus> {
	return remember(channelId, await rekeyE2eeRoom(channelId, true));
}

/** Clear cached state (e.g. account/session switch). */
export function clearE2eeCache(): void {
	statusCache.clear();
	freshStatus.clear();
	for (const state of statusRequests.values()) if (state.timer) clearTimeout(state.timer);
	statusRequests.clear();
	e2eeStatusRevision.update((value) => value + 1);
}

/** True when the server we're talking to serves the E2EE endpoint. */
export function isE2eeEndpointReachable(): boolean {
	return typeof getServerUrl() === 'function' && !import.meta.env.SSR;
}
