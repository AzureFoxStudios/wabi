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
import { allowServerReadableRoom, e2eeClientRealmKey, enableE2eeRoom, ensureE2eeDeviceRegistered, getE2eeRoomStatus, rekeyE2eeRoom, type E2eeRoomStatus } from '$lib/e2ee';
import { getServerUrl } from '$lib/serverUrl';

const statusCache = new Map<string, E2eeRoomStatus>();

function cacheKey(channelId: string): string | null {
	try { return `${e2eeClientRealmKey()}:${channelId}`; }
	catch { return null; }
}

function remember(channelId: string, status: E2eeRoomStatus): E2eeRoomStatus {
	const key = cacheKey(channelId);
	if (key) statusCache.set(key, status);
	return status;
}

/** Read-through cache: returns cached status without a network call. */
export function cachedE2eeStatus(channelId: string): E2eeRoomStatus | null {
	const key = cacheKey(channelId);
	return key ? statusCache.get(key) ?? null : null;
}

/** Fetch fresh status and update the cache (fail-closed: errors leave the cache as-is). */
export async function refreshE2eeStatus(channelId: string): Promise<E2eeRoomStatus> {
	return remember(channelId, await getE2eeRoomStatus(channelId, false));
}

/** New private rooms default to encryption, once every member has a device. */
export async function prepareNewConversationEncryption(channelId: string): Promise<E2eeRoomStatus> {
	await ensureE2eeDeviceRegistered();
	let status = await refreshE2eeStatus(channelId);
	if (!status.pendingDefault || status.enabled || status.missingUserIds.length) return status;
	try {
		status = remember(channelId, await enableE2eeRoom(channelId));
	} catch (error) {
		// Another participant may have enabled encryption or explicitly chosen
		// server-readable mode while this device wrapped the room key.
		status = await refreshE2eeStatus(channelId);
		if (status.pendingDefault && !status.enabled) throw error;
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
 * Returns the fresh status, or null when the endpoint is unsupported / unauthenticated.
 */
export async function turnOnE2ee(channelId: string): Promise<E2eeRoomStatus | null> {
	try {
		const status = await enableE2eeRoom(channelId);
		return remember(channelId, status);
	} catch {
		return null;
	}
}

/** Rekey after membership changes (or when the server reports needsRekey). */
export async function rekeyE2ee(channelId: string): Promise<E2eeRoomStatus | null> {
	try {
		const status = await rekeyE2eeRoom(channelId, true);
		return remember(channelId, status);
	} catch {
		return null;
	}
}

/** Clear cached state (e.g. account/session switch). */
export function clearE2eeCache(): void {
	statusCache.clear();
}

/** True when the server we're talking to serves the E2EE endpoint. */
export function isE2eeEndpointReachable(): boolean {
	return typeof getServerUrl() === 'function' && !import.meta.env.SSR;
}
