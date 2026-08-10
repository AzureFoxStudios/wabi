/**
 * callingWabidb.ts — Wabidb-backed transport for voice calls.
 *
 * Owns its private state (wabidbCallState, wabidbMediaRelay, sessionId, channelId).
 */

import { get } from 'svelte/store';
import type { Socket } from 'socket.io-client';
import { WabiDbCallState } from './wabidbCallConnection';
import {
	connectionState,
	callTransportState,
	localStream
} from './callingStateStores';
import { getAuthToken, getStoredDbUserId } from './authSession';

// ============================================================================
// Private State
// ============================================================================

let wabidbCallState: WabiDbCallState | null = null;
// wabidbMediaRelay will be created in a follow-up card. For now we keep the
// existing wabidbMediaRelay imported lazily so the call flow doesn't break
// while the websocket media path is being migrated.
let wabidbMediaRelay: any = null;
let sessionId: string | null = null;
let channelId: string | null = null;
let currentUserId: number | null = null;

// ============================================================================
// Wabidb Call Functions
// ============================================================================

export async function disconnectWabidbCall(): Promise<void> {
	if (wabidbMediaRelay) {
		try { wabidbMediaRelay.stop?.(); } catch (_) {}
		wabidbMediaRelay = null;
	}
	if (wabidbCallState) {
		if (sessionId) {
			try { await wabidbCallState.leaveSession(sessionId, currentUserId ?? 0, ''); } catch (_) {}
		}
		wabidbCallState.disconnect();
		wabidbCallState = null;
	}
	sessionId = null;
	channelId = null;
	currentUserId = null;
	connectionState.set('idle');
	callTransportState.update((state) => ({
		...state,
		activeTransport: 'p2p' as const,
		reason: 'wabidb_disconnected'
	}));
}

const defaultWabidbServer = import.meta.env.VITE_WABI_SERVER_URL ?? '';

export async function connectWabidbCall(
	socket: Socket,
	targetChannelId: string,
	localDisplayName: string,
	serverUrl: string = defaultWabidbServer,
	peerUserId?: string,
): Promise<void> {
	if (wabidbCallState && channelId === targetChannelId) {
		return;
	}

	await disconnectWabidbCall();

	try {
		// Use the real authenticated user id instead of a random one so the
		// wabidb session roster is stable across reconnects.
		const dbUserId = getStoredDbUserId();
		const userId: number = dbUserId ?? 0;
		currentUserId = userId;
		const token = getAuthToken();

		wabidbCallState = new WabiDbCallState({
			serverUrl,
			token
		});

		const stream = get(localStream);
		if (!stream) {
			throw new Error('No local audio stream available');
		}

		const isDirectCall = Boolean(peerUserId);
		const newSessionId = isDirectCall
			? (await import('./wabidbMediaRelay')).wabidbDmSessionKey(String(userId), peerUserId)
			: `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		sessionId = newSessionId;
		channelId = targetChannelId;

		connectionState.set('connecting');

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('Wabidb connection timeout (10s)'));
			}, 10000);

			wabidbCallState!.onConnect(() => {
				clearTimeout(timeout);
				console.log('[Wabidb] Connected');
				resolve();
			});

			wabidbCallState!.onError((err) => {
				clearTimeout(timeout);
				console.error('[Wabidb] Connection error:', err);
				reject(err);
			});

			wabidbCallState!.onDisconnect(() => {
				console.log('[Wabidb] Disconnected');
			});

			wabidbCallState!.connect();
		});

		await wabidbCallState.createSession(newSessionId, targetChannelId, 'audio-call', currentUserId ?? 0, 100);

		// Join the session so the participant appears in the roster. Guarded:
		// a failure here must not break the audio relay that follows.
		try {
			await wabidbCallState.joinSession(newSessionId, currentUserId ?? 0, `user-${currentUserId ?? 0}`);
		} catch (joinErr) {
			console.warn('[Wabidb] joinSession failed (continuing):', joinErr);
		}

		// Connect the wabidb media relay — the audio path ships opus over
		// socket.io, bypassing CGNAT without STUN/TURN. For DM calls the
		// relay uses a deterministic session key derived from both peers so
		// caller and callee rendezvous on the same wabidb session.
		try {
			const { WabidbMediaRelay } = await import('./wabidbMediaRelay');
			wabidbMediaRelay = new WabidbMediaRelay({
				sessionId: newSessionId,
				userId: String(userId),
				socket,
				onError: (err: Error) => console.error('[WabidbMediaRelay]', err),
				...(isDirectCall
					? { kind: 'dm' as const, peerStableUserId: peerUserId }
					: {}),
			});
			await wabidbMediaRelay.start(stream);
		} catch (e) {
			console.warn('[Wabidb] Media relay import failed, continuing without:', e);
		}

		socket.emit('join-wabidb-call', { sessionId: newSessionId, channelId: targetChannelId });

		connectionState.set('connected');
		callTransportState.update((state) => ({
			...state,
			activeTransport: 'wabidb' as const,
			reason: 'wabidb_connected'
		}));

		console.log(`[Wabidb] Call connected to session ${newSessionId}`);
	} catch (error) {
		console.error('[Wabidb] Connection failed:', error);
		await disconnectWabidbCall();
		throw error;
	}
}