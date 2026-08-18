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
	localStream,
	voiceTransmitMode
} from './callingStateStores';
import { getAuthToken, getStoredDbUserId } from './authSession';

// ============================================================================
// Private State
// ============================================================================

let wabidbCallState: WabiDbCallState | null = null;
// wabidbMediaRelay will be created in a follow-up card. For now we keep the
// existing wabidbMediaRelay imported lazily so the call flow doesn't break
// while the websocket media path is being migrated.
const wabidbMediaRelays = new Map<string, any>();
const sessionIds = new Map<string, string>();
let sessionId: string | null = null;
let channelId: string | null = null;
let currentUserId: number | null = null;

// ============================================================================
// Wabidb Call Functions
// ============================================================================

export async function disconnectWabidbCall(): Promise<void> {
	for (const relay of wabidbMediaRelays.values()) {
		try { relay.stop?.(); } catch (_) {}
	}
	wabidbMediaRelays.clear();
	if (wabidbCallState) {
		for (const targetSessionId of sessionIds.values()) {
			try { await wabidbCallState.leaveSession(targetSessionId, currentUserId ?? 0, ''); } catch (_) {}
		}
		wabidbCallState.disconnect();
		wabidbCallState = null;
	}
	sessionIds.clear();
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

export async function disconnectWabidbChannel(targetChannelId: string): Promise<void> {
	const relay = wabidbMediaRelays.get(targetChannelId);
	if (relay) {
		try { relay.stop?.(); } catch (_) {}
		wabidbMediaRelays.delete(targetChannelId);
	}
	const targetSessionId = sessionIds.get(targetChannelId);
	if (targetSessionId && wabidbCallState) {
		try { await wabidbCallState.leaveSession(targetSessionId, currentUserId ?? 0, ''); } catch (_) {}
	}
	sessionIds.delete(targetChannelId);
}

/**
 * Re-evaluate outbound capture on every wabidb relay. `shouldCapture` decides
 * per channel (transmit routing mode, mute/deafen) so the wabidb transport
 * honors the same gating as the WebRTC/LiveKit paths in syncLocalAudioState.
 */
export function syncWabidbCapture(shouldCapture: (channelId: string) => boolean): void {
	for (const [channelId, relay] of wabidbMediaRelays.entries()) {
		try {
			void relay.setCapture?.(shouldCapture(channelId));
		} catch (_) {}
	}
}

const defaultWabidbServer = import.meta.env.VITE_WABI_SERVER_URL ?? '';

export async function connectWabidbCall(
	socket: Socket,
	targetChannelId: string,
	localDisplayName: string,
	serverUrl: string = defaultWabidbServer,
	peerUserId?: string,
	listenOnly = false,
): Promise<void> {
	if (wabidbMediaRelays.has(targetChannelId)) {
		return;
	}

	try {
		// Use the real authenticated user id instead of a random one so the
		// wabidb session roster is stable across reconnects.
		const dbUserId = getStoredDbUserId();
		const userId: number = dbUserId ?? 0;
		currentUserId = userId;
		const token = getAuthToken();

		if (!wabidbCallState) wabidbCallState = new WabiDbCallState({
			serverUrl,
			token
		});

		const stream = get(localStream);
		if (!stream) {
			throw new Error('No local audio stream available');
		}

		const isDirectCall = Boolean(peerUserId);
		const { wabidbDmSessionKey: dmKey, wabidbChannelSessionKey: channelKey } = await import('./wabidbMediaRelay');
		// DM: deterministic key from both peers. Channel/group: deterministic key
		// from the channel id — ALL participants must derive the SAME key or they
		// end up in separate wabidb sessions and audio never crosses.
		const newSessionId = isDirectCall
			? dmKey(String(userId), peerUserId)
			: channelKey(targetChannelId);
		sessionId = newSessionId;
		channelId = targetChannelId;

		connectionState.set('connecting');

		if (!wabidbCallState.isConnected) await new Promise<void>((resolve, reject) => {
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
			const relay = new WabidbMediaRelay({
				sessionId: newSessionId,
				userId: String(userId),
				socket,
				onError: (err: Error) => console.error('[WabidbMediaRelay]', err),
				...(isDirectCall
					? { kind: 'dm' as const, peerStableUserId: peerUserId }
					: {}),
				// "All listening channels" broadcast captures into every
				// subscribed channel session, not just the primary one.
				capture: !listenOnly || get(voiceTransmitMode) === 'all-listening',
			});
			await relay.start(stream);
			wabidbMediaRelays.set(targetChannelId, relay);
		} catch (e) {
			console.warn('[Wabidb] Media relay import failed, continuing without:', e);
		}

		socket.emit('join-wabidb-call', { sessionId: newSessionId, channelId: targetChannelId });
		sessionIds.set(targetChannelId, newSessionId);

		connectionState.set('connected');
		callTransportState.update((state) => ({
			...state,
			activeTransport: 'wabidb' as const,
			reason: 'wabidb_connected'
		}));

		console.log(`[Wabidb] Call connected to session ${newSessionId}`);
	} catch (error) {
		console.error('[Wabidb] Connection failed:', error);
		await disconnectWabidbChannel(targetChannelId);
		throw error;
	}
}