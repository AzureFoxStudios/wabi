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
import { getSocket } from './socketConnection';
import { bindCallSessionAudio, callSessionManager } from './callSessionManager';
import {
	setSessionVolume as graphSetSessionVolume,
	detachSession as graphDetachSession
} from './callAudioGraph';
import type { WabidbVideoLaneDiagnostics } from './wabidbVideoLane';

// WO-1/WO-2 smoke remediation: diagnostics for CallModal's Diag overlay.
// The relay Map is double-indexed (channel key AND graph id) — dedupe by
// relay object so a single relay isn't counted twice.
export function getWabidbRelayDiagnostics(): Array<Record<string, any>> {
	const out: Array<Record<string, any>> = [];
	const seen = new Set<unknown>();
	for (const [key, relay] of wabidbMediaRelays.entries()) {
		if (seen.has(relay)) continue;
		seen.add(relay);
		out.push({
			key,
			...(typeof relay?.getDiagnostics === 'function' ? relay.getDiagnostics() : {})
		});
	}
	return out;
}

export function getWabidbLaneDiagnostics(): WabidbVideoLaneDiagnostics | null {
	return wabidbVideoLaneInst?.diag ?? null;
}

export function formatWabidbLaneDiagnostics(d: WabidbVideoLaneDiagnostics | null): string {
	if (!d) return '';
	const none = { framesEncoded: 0, envelopesSent: 0, encodeErrors: 0 };
	const cam = d.senders.camera ?? none;
	const screen = d.senders.screen ?? none;
	return `Video: cam f=${cam.framesEncoded} env=${cam.envelopesSent} err=${cam.encodeErrors} · screen f=${screen.framesEncoded} env=${screen.envelopesSent} err=${screen.encodeErrors} · rx=${d.receiver.envelopesReceived} dec=${d.receiver.framesDecoded}`;
}

// Phase 2: session-model state changes drive the shared audio graph —
// per-call volume/mute reach the live chains, and ending a session disposes
// its chain even if the relay itself is already gone.
bindCallSessionAudio({
	onVolumeChanged: (id, effectiveVolume) => graphSetSessionVolume(id, effectiveVolume),
	onSessionEnded: (id) => graphDetachSession(id)
});

// Phase 2.5: the watchdog is a singleton armed for the most recent wabidb
// connect — remember WHICH session it serves so transport transitions keep
// the session model honest (reconnecting / fallback transport / heal).
let activeWatchdogSessionId: string | null = null;

transportWatchdog.onTransition((state, riding) => {
	if (!activeWatchdogSessionId) return;
	const id = activeWatchdogSessionId;
	if (state === 'demoting') {
		callSessionManager.markReconnecting(id);
	} else if (state === 'demoted' || state === 'monitoring') {
		// 'demoted' = alive on a fallback link; 'monitoring' = healed/promoted
		// back. Either way the session is connected — on `riding`.
		callSessionManager.markConnected(id, riding);
	}
	// 'stopped' is intentionally ignored: it fires both on total transport
	// loss AND on normal re-arm/teardown — the owning teardown path already
	// unregisters the session.
});
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
	activeWatchdogSessionId = null;
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
		// Phase 3: drop the graph/session-id alias if it points at this relay.
		for (const [key, candidate] of wabidbMediaRelays.entries()) {
			if (candidate === relay) wabidbMediaRelays.delete(key);
		}
		// Phase 2.5: if the watchdog served this session, it no longer does.
		if (activeWatchdogSessionId === targetChannelId) {
			activeWatchdogSessionId = null;
		}
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

/**
 * Phase 1 follow-up (review F6): after a main-socket reconnect the server's
 * socket.io rooms are GONE — new SocketRef, no memberships — so the hardened
 * `wabidb-media` relay would deny every envelope even though the relays and
 * the separate wabiDb call-state connection look healthy. Re-emit
 * join-wabidb-call for every live session; the server re-authorizes against
 * the roster, which the drain map restores first (presence before media —
 * same ordering as the initial join).
 */
export function rejoinWabidbCallRooms(): void {
	const socket = getSocket();
	if (!socket?.connected) return;
	for (const [channelId, sessionId] of sessionIds.entries()) {
		socket.emit('join-wabidb-call', { sessionId, channelId });
	}
	if (sessionIds.size > 0) {
		console.log(`[Wabidb] re-joined ${sessionIds.size} media room(s) after reconnect`);
	}
}

/**
 * Phase 3: position one remote user of one call in the stereo field. Safe
 * no-op when the call isn't on the wabidb transport (p2p seats go through
 * the spatial engine instead).
 */
export function setWabidbSpatialPosition(
	graphSessionId: string,
	userId: string,
	position: { x: number; y: number; z: number }
): void {
	const relay = wabidbMediaRelays.get(graphSessionId);
	if (!relay) return;
	try {
		relay.setSpatialPosition?.(userId, position);
	} catch (_) {
		/* relay mid-teardown */
	}
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
			const { directCallSessionId } = await import('./callSessionTypes');
			// Phase 2: the relay's audio chain id matches the CallSessionManager
			// session id (channelId for channels/groups, direct:{peer} for DMs)
			// so per-call volume addresses the same chain the model tracks.
			const audioSessionId = peerUserId ? directCallSessionId(peerUserId) : targetChannelId;
			activeWatchdogSessionId = audioSessionId;
			relay = new WabidbMediaRelay({
				sessionId: newSessionId,
				audioSessionId,
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
			// Phase 3: also index by the graph/session id (direct:{peer} for
			// DMs) so seat/volume lookups address the relay without knowing
			// the legacy channel-key convention.
			if (audioSessionId !== targetChannelId) {
				wabidbMediaRelays.set(audioSessionId, relay);
			}
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
					onError: (err: Error) => {
						console.error('[WabidbVideoLane]', err);
						// WO-2b: make lane failures VISIBLE to the sharer instead of
						// console-only. Dynamic import avoids a core ↔ here cycle.
						void import('./calling_impl_core').then(({ pushVoiceChannelNotice }) =>
							pushVoiceChannelNotice(`Screen/camera share error: ${err.message}`)
						).catch(() => undefined);
					}
				});
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
		// Route THIS relay's inbound video envelopes to the shared lane. The
		// lane is created once; without this attach, a SECOND concurrent
		// channel's relay dropped every inbound video envelope (round 5).
		relay?.attachVideoLane(wabidbVideoLaneInst ?? null);

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
				if (transport === 'p2p') {
					// 2026-08-27: a dead relay used to be a dead call — the watchdog
					// had no p2p path and just threw. Rebuild the mesh via the impl
					// module (dynamic import: calling_impl imports this module).
					const { reEstablishChannelP2P } = await import('./calling_impl_core');
					await reEstablishChannelP2P(socket, targetChannelId);
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