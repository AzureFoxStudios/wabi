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
	voiceTransmitMode,
	isSharing,
	localScreenStream
} from './callingStateStores';
import { getAuthToken, getStoredDbUserId } from './authSession';
import { transportWatchdog } from './callingWatchdog';
import { getStoredCallTransportMode } from './mediaRuntime';
import { WabidbVideoLane } from './wabidbVideoLane';

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

// Video lane state — camera + screenshare over the same wabidb-media channel.
let wabidbVideoLaneInst: WabidbVideoLane | null = null;
let wabidbActiveSocket: Socket | null = null;
let wabidbActiveSessionId: string | null = null;
let wabidbActiveUserId: string | null = null;
let wabidbTransportActive = false;
let screenShareSub: (() => void) | null = null;

// ============================================================================
// Wabidb Call Functions
// ============================================================================

/**
 * Start the LOCAL video lane on the wabidb transport. For `screen` we reuse
 * the screen-share store (set by the existing UI flow); for `camera` we
 * acquire a dedicated getUserMedia video stream. Returns true if the lane is
 * live. No-op (false) unless a wabidb call is currently active.
 */
export async function wabidbStartVideo(source: 'camera' | 'screen'): Promise<boolean> {
	if (!wabidbTransportActive || !wabidbVideoLaneInst) return false;
	let stream: MediaStream | null = null;
	try {
		if (source === 'screen') {
			const existing = get(localScreenStream);
			if (existing) {
				stream = existing;
			} else if (navigator.mediaDevices?.getDisplayMedia) {
				stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
				localScreenStream.set(stream);
				isSharing.set(true);
			}
		} else if (navigator.mediaDevices?.getUserMedia) {
			stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 } });
		}
		if (!stream) return false;
		await wabidbVideoLaneInst.startLocalVideo(source, stream);
		return true;
	} catch (e) {
		console.warn('[Wabidb] start video failed:', e);
		return false;
	}
}

/** Stop the LOCAL video lane (camera + screenshare) but keep the call up. */
export function wabidbStopVideo(): void {
	if (wabidbVideoLaneInst) wabidbVideoLaneInst.stopLocalVideo();
}

/** Stop exactly one outbound feed ('camera' | 'screen'); the other keeps running. */
export function wabidbStopVideoSource(source: 'camera' | 'screen'): void {
	wabidbVideoLaneInst?.stopLocalVideoSource(source);
}

/** Tear down the video lane for a specific remote participant's inbound feed. */
export function wabidbStopRemoteVideo(userId: string): void {
	if (wabidbVideoLaneInst) wabidbVideoLaneInst.stopRemoteUser(userId);
}

function teardownWabidbVideoLane(): void {
	if (screenShareSub) {
		screenShareSub();
		screenShareSub = null;
	}
	if (wabidbVideoLaneInst) {
		wabidbVideoLaneInst.stopAll();
		wabidbVideoLaneInst = null;
	}
	wabidbActiveSocket = null;
	wabidbActiveSessionId = null;
	wabidbActiveUserId = null;
	wabidbTransportActive = false;
}

export async function disconnectWabidbCall(): Promise<void> {
	for (const relay of wabidbMediaRelays.values()) {
		try { relay.stop?.(); } catch (_) {}
	}
	wabidbMediaRelays.clear();
	teardownWabidbVideoLane();
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
	// If that was the last wabidb session, tear down the shared video lane.
	if (wabidbMediaRelays.size === 0) {
		teardownWabidbVideoLane();
	}
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

/**
 * True when at least one wabidb media relay is currently attached — i.e. the
 * active call is riding the wabidb transport. Used by toggleVideo to route
 * camera to the video lane; unlike resolveActiveTransport(), this reflects
 * RUNTIME state (DM calls resolve 'p2p' by plan but connect via wabidb).
 */
export function wabidbTransportLive(): boolean {
	return wabidbMediaRelays.size > 0;
}

// T3: health probe consumed by callingWatchdog via a global hook (avoids a
// circular import watchdog -> wabidb -> watchdog).
(globalThis as any).__wabidbProbePrimary = (transport: string) =>
	transport === 'wabidb' ? Boolean(wabidbCallState?.isConnected) : false;

const defaultWabidbServer = import.meta.env.VITE_WABI_SERVER_URL ?? '';

// Phase 1 hardening: the server denies unauthorized wabidb media room joins
// (voice roster / group session / dm key check). When one of OUR sessions is
// denied, hand the loss to the transport watchdog so the fallback chain
// demotes to the next link (p2p) instead of staying silently deaf.
function onWabidbCallDenied(payload: { sessionId?: string; reason?: string }): void {
	const denied = payload?.sessionId;
	if (!denied) return;
	let ownsDeniedSession = false;
	for (const sid of sessionIds.values()) {
		if (sid === denied) {
			ownsDeniedSession = true;
			break;
		}
	}
	if (!ownsDeniedSession) return;
	console.warn(`[Wabidb] media room join denied (${payload.reason ?? 'unknown'}) — demoting transport`);
	transportWatchdog.handleDisconnect();
}

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

	let relay: any = null;
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
				// T3: notify the mid-call watchdog; it runs the grace/reconnect
				// probe and demotes to the next chain link if the relay stays dead.
				transportWatchdog.handleDisconnect();
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
			relay = new WabidbMediaRelay({
				sessionId: newSessionId,
				userId: String(userId),
				socket,
				onError: (err: Error) => console.error('[WabidbMediaRelay]', err),
				onRemoteAudioActivity: (fromUserId: string) => {
					void import('./callingAudioMonitors').then(({ notifyRelayAudioActivity }) =>
						notifyRelayAudioActivity(fromUserId)
					);
				},
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

		// Attach the video lane (camera + screenshare) to the relay so inbound
		// video envelopes are routed to it. The lane owns its own outbound emit
		// path. On the wabidb transport, starting a screen share now feeds this
		// lane instead of silently no-op'ing (the old P2P-only path).
		if (!wabidbVideoLaneInst) {
			try {
				const { WabidbVideoLane: Lane } = await import('./wabidbVideoLane');
				wabidbActiveSocket = socket;
				wabidbActiveSessionId = newSessionId;
				wabidbActiveUserId = String(userId);
				wabidbTransportActive = true;
				const lane = new Lane({
					sessionId: newSessionId,
					userId: String(userId),
					socket,
					onError: (err: Error) => console.error('[WabidbVideoLane]', err)
				});
				relay?.attachVideoLane(lane);
				wabidbVideoLaneInst = lane;

				// Auto-start the lane when the user toggles screen share while on
				// the wabidb transport. Only react to transitions, never double-start.
				if (screenShareSub) screenShareSub();
				screenShareSub = localScreenStream.subscribe((screenStream) => {
					if (!wabidbTransportActive || !wabidbVideoLaneInst) return;
					// P1: only touch the SCREEN sender — an active camera lane must
					// keep running while screenshare starts/stops.
					if (screenStream && !wabidbVideoLaneInst.activeSources.includes('screen')) {
						void wabidbVideoLaneInst.startLocalVideo('screen', screenStream).catch((e) =>
							console.warn('[Wabidb] auto screen-share video failed:', e)
						);
					} else if (!screenStream && wabidbVideoLaneInst.activeSources.includes('screen')) {
						wabidbVideoLaneInst.stopLocalVideoSource('screen');
					}
				});
			} catch (e) {
				console.warn('[Wabidb] Video lane import failed, continuing without:', e);
			}
		}

		socket.emit('join-wabidb-call', { sessionId: newSessionId, channelId: targetChannelId });
		// Phase 1 hardening: on denial, onWabidbCallDenied feeds the transport
		// watchdog so the fallback chain demotes to the next link (p2p)
		// instead of leaving the user silently deaf. off-then-on keeps the
		// registration idempotent across repeated connects.
		socket.off('wabidb-call-denied', onWabidbCallDenied);
		socket.on('wabidb-call-denied', onWabidbCallDenied);
		sessionIds.set(targetChannelId, newSessionId);

		connectionState.set('connected');
		callTransportState.update((state) => ({
			...state,
			activeTransport: 'wabidb' as const,
			reason: 'wabidb_connected'
		}));

		// T3: arm the mid-call watchdog on this transport.
		transportWatchdog.start({
			mode: getStoredCallTransportMode(),
			active: 'wabidb',
			connect: async (transport) => {
				if (transport === 'wabidb') {
					await connectWabidbCall(socket, targetChannelId, localDisplayName, serverUrl, peerUserId, listenOnly);
					return;
				}
				throw new Error(`watchdog cannot re-establish ${transport} from here`);
			},
			disconnectCurrent: async () => {
				try { await disconnectWabidbChannel(targetChannelId); } catch { /* best-effort */ }
			}
		});

		console.log(`[Wabidb] Call connected to session ${newSessionId}`);
	} catch (error) {
		console.error('[Wabidb] Connection failed:', error);
		await disconnectWabidbChannel(targetChannelId);
		throw error;
	}
}