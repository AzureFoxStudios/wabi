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
	isMuted,
	activeGroupCall, activeCallSessionId, activeVoiceChannel
} from './callingStateStores';
import { getAuthToken, getStoredDbUserId } from './authSession';
import { getServerUrl } from './serverUrl';
import { tryRefresh } from './api/authRefresh';
import { transportWatchdog } from './callingWatchdog';
import { getStoredCallTransportMode } from './mediaRuntime';
import { bindCallSessionAudio, callSessionManager } from './callSessionManager';
import {
	setSessionVolume as graphSetSessionVolume,
	detachSession as graphDetachSession,
	resumeCallAudioGraph
} from './callAudioGraph';
import type { WabidbVideoLaneDiagnostics } from './wabidbVideoLane';
import { hasWebCodecs } from './wabidbVideoLane';
import { joinRelayRoom } from './relayRoom';
import { selectRelayAudio } from './peerAudioPlayback';
import { captureGroupAccess, groupMembership } from './groupAccess';

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
	return currentVideoSession()?.lane.diag ?? null;
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
// Lazily loaded media relays, indexed by legacy channel key and graph id.
const wabidbMediaRelays = new Map<string, any>();
// Direct calls have no voice-channel routing target. Their legacy map key
// is the peer id, which must never be mistaken for a listen-only channel.
const relayTransmitTargets = new WeakMap<object, string | undefined>();

// Round 6 (2026-09-03): autoplay policies keep the shared AudioContext
// suspended until a user gesture. While any relay is live, the first
// pointer/key interaction resumes it — otherwise decoded audio reaches a
// running graph that the browser refuses to actually run.
let audioGestureResumeListener: (() => void) | null = null;

function ensureAudioGestureResume(): void {
	if (audioGestureResumeListener || typeof document === 'undefined') return;
	audioGestureResumeListener = () => {
		void resumeCallAudioGraph().catch(() => undefined);
	};
	document.addEventListener('pointerdown', audioGestureResumeListener, { passive: true });
	document.addEventListener('keydown', audioGestureResumeListener);
}

function releaseAudioGestureResumeIfIdle(): void {
	if (wabidbMediaRelays.size > 0 || !audioGestureResumeListener) return;
	document.removeEventListener('pointerdown', audioGestureResumeListener);
	document.removeEventListener('keydown', audioGestureResumeListener);
	audioGestureResumeListener = null;
}
const sessionIds = new Map<string, string>();
const sessionMembershipRevisions = new Map<string, string>();
const sessionControllers = new Map<string, AbortController>();
let sessionId: string | null = null;
let channelId: string | null = null;
let currentUserId: number | null = null;

// A receive lane belongs to exactly one media session, just like its relay.
// Camera/screen capture has one explicit destination; a background listener
// must never become the destination merely because its relay connected first.
type VideoSession = {
	channelId: string; lane: WabidbVideoLane; relay: any; socket: Socket; access: () => boolean;
};
const videoSessions = new Map<string, VideoSession>();
const videoOwners = new Map<'camera' | 'screen', { session: VideoSession; stream: MediaStream }>();
const videoEpochs = new Map<'camera' | 'screen', number>();
const videoStarts = new Map<'camera' | 'screen', { session: VideoSession; promise: Promise<boolean> }>();

function currentVideoChannel(): string | null {
	const group = get(activeGroupCall);
	if (group) return group.id;
	const direct = get(activeCallSessionId);
	if (direct?.startsWith('direct:')) return direct.slice('direct:'.length);
	return get(activeVoiceChannel)?.id ?? null;
}

function currentVideoSession(): VideoSession | undefined {
	return videoSessions.get(currentVideoChannel() ?? '');
}

/** Does THIS call have a ready video relay? Not "any background call". */
export function wabidbVideoTransportLive(channel = currentVideoChannel()): boolean {
	// Linux desktop webviews may have WebRTC but no WebCodecs. Keep the
	// microphone relay and choose P2P for camera/screenshare in that case.
	return !!channel && videoSessions.has(channel) && hasWebCodecs();
}

export async function wabidbStartVideo(
	source: 'camera' | 'screen', providedStream?: MediaStream,
	targetChannelId = currentVideoChannel(), stillWanted: () => boolean = () => true
): Promise<boolean> {
	const session = targetChannelId ? videoSessions.get(targetChannelId) : undefined;
	if (!session || !session.access() || !stillWanted()) {
		providedStream?.getTracks().forEach(track => track.stop());
		return false;
	}
	const pending = videoStarts.get(source);
	if (!providedStream && pending?.session === session) return pending.promise;
	wabidbStopVideoSource(source);
	const epoch = (videoEpochs.get(source) ?? 0) + 1;
	videoEpochs.set(source, epoch);
	const current = () => videoEpochs.get(source) === epoch &&
		videoSessions.get(session.channelId) === session && session.access() && stillWanted();
	const retire = (stream: MediaStream | null) => {
		stream?.getTracks().forEach(track => track.stop());
		// Intent can expire without the relay disappearing (e.g. call focus).
		// Retire only this encoder, never its replacement on the same lane.
		if (videoEpochs.get(source) === epoch) wabidbStopVideoSource(source, session.channelId);
	};
	const promise = (async () => {
		let stream = providedStream ?? null;
		try {
			if (!stream) {
				stream = source === 'screen'
					? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
					: await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 } });
			}
			if (!current()) { stream.getTracks().forEach(track => track.stop()); return false; }
			videoOwners.set(source, { session, stream });
			await session.lane.startLocalVideo(source, stream);
			if (!current()) { retire(stream); return false; }
			if (source === 'screen') {
				await session.relay.startScreenAudioCapture(stream);
				if (!current()) { retire(stream); return false; }
			}
			return true;
		} catch (error) {
			retire(stream);
			if (!(error instanceof DOMException && error.name === 'AbortError')) console.warn('[Wabidb] start video failed:', error);
			return false;
		}
	})();
	videoStarts.set(source, { session, promise });
	try { return await promise; }
	finally { if (videoStarts.get(source)?.promise === promise) videoStarts.delete(source); }
}

/** Stop all outbound video, without affecting any receive lane or microphone. */
export function wabidbStopVideo(): void {
	wabidbStopVideoSource('camera');
	wabidbStopVideoSource('screen');
}

export function wabidbStopVideoSource(source: 'camera' | 'screen', channelId?: string): void {
	const owner = videoOwners.get(source);
	const pending = videoStarts.get(source);
	if (channelId && owner?.session.channelId !== channelId && pending?.session.channelId !== channelId) return;
	videoEpochs.set(source, (videoEpochs.get(source) ?? 0) + 1);
	videoStarts.delete(source);
	videoOwners.delete(source);
	owner?.session.lane.stopLocalVideoSource(source);
	if (source === 'screen') void owner?.session.relay.stopScreenAudioCapture().catch(() => {});
}

export function wabidbStopRemoteVideo(userId: string, channelId?: string): void {
	for (const session of videoSessions.values()) {
		if (!channelId || session.channelId === channelId) session.lane.stopRemoteUser(userId);
	}
}

function teardownWabidbVideoLane(channelId?: string): void {
	for (const [key, session] of videoSessions) {
		if (channelId && key !== channelId) continue;
		videoSessions.delete(key); // retire identity before closing callbacks
		wabidbStopVideoSource('camera', key);
		wabidbStopVideoSource('screen', key);
		session.relay.attachVideoLane(null);
		session.lane.stopAll();
	}
}

export async function disconnectWabidbCall(): Promise<void> {
	for (const controller of sessionControllers.values()) controller.abort();
	sessionControllers.clear();
	for (const relay of wabidbMediaRelays.values()) {
		try { relay.stop?.(); } catch (_) {}
	}
	wabidbMediaRelays.clear();
	wabidbConnectInflight.clear();
	teardownWabidbVideoLane();
	const oldState = wabidbCallState;
	const departing = [...sessionIds].map(([channel, id]) => ({ id, revision: sessionMembershipRevisions.get(channel) }));
	const departingUser = currentUserId ?? 0;
	wabidbCallState = null;
	sessionIds.clear();
	sessionMembershipRevisions.clear();
	sessionId = null;
	channelId = null;
	currentUserId = null;
	activeWatchdogSessionId = null;
	transportWatchdog.stop();
	releaseAudioGestureResumeIfIdle();
	connectionState.set('idle');
	callTransportState.update((state) => ({
		...state,
		activeTransport: 'p2p' as const,
		reason: 'wabidb_disconnected'
	}));
	// Retire local ownership BEFORE yielding. This completion may not clear
	// relays/session ids created by a newer call while its HTTP leave waits.
	if (oldState) {
		oldState.disconnect();
		await Promise.all(departing.map(({ id, revision }) => oldState.leaveSession(id, departingUser, '', { membershipRevision: revision }).catch(() => {})));
	}
}

export async function disconnectWabidbChannel(targetChannelId: string,
	options: { preserveRecovery?: boolean; notifyServer?: boolean } = {}): Promise<void> {
	const { preserveRecovery = false, notifyServer = true } = options;
	sessionControllers.get(targetChannelId)?.abort();
	sessionControllers.delete(targetChannelId);
	wabidbConnectInflight.delete(targetChannelId);
	const relay = wabidbMediaRelays.get(targetChannelId);
	if (relay) {
		try { relay.stop?.(); } catch (_) {}
		wabidbMediaRelays.delete(targetChannelId);
		// Phase 3: drop the graph/session-id alias if it points at this relay.
		for (const [key, candidate] of wabidbMediaRelays.entries()) {
			if (candidate === relay) wabidbMediaRelays.delete(key);
		}
		// Phase 2.5: if the watchdog served this session, it no longer does.
		if (activeWatchdogSessionId === targetChannelId && !preserveRecovery) {
			activeWatchdogSessionId = null;
			transportWatchdog.stop();
		}
	}
	const targetSessionId = sessionIds.get(targetChannelId);
	const revision = groupMembership.revision(targetChannelId) ?? sessionMembershipRevisions.get(targetChannelId);
	sessionIds.delete(targetChannelId);
	sessionMembershipRevisions.delete(targetChannelId);
	const oldState = wabidbCallState;
	const departingUser = currentUserId ?? 0;
	oldState?.revokeSession(targetSessionId ?? `channel:${targetChannelId}`);
	teardownWabidbVideoLane(targetChannelId);
	// If that was the last wabidb session, tear down the shared video lane.
	if (wabidbMediaRelays.size === 0) {
		teardownWabidbVideoLane();
		releaseAudioGestureResumeIfIdle();
	}
	// Transient socket loss retires local ownership, not account-level durable
	// participation. A delayed same-revision HTTP leave could erase a new join.
	if (notifyServer && targetSessionId && oldState) {
		try { await oldState.leaveSession(targetSessionId, departingUser, '', { membershipRevision: revision ?? undefined }); } catch (_) {}
	}
}

/**
 * Re-evaluate outbound capture on every wabidb relay. `shouldCapture` decides
 * per channel (transmit routing mode, mute) so the wabidb transport honors
 * the same gating as the WebRTC/LiveKit paths in syncLocalAudioState.
 * Awaited per relay: setCapture's enable path recreates the opus recorder,
 * and an unawaited toggle could leave `captureEnabled` true with
 * `opusRecorder === null` forever (Round 6).
 */
export async function syncWabidbCapture(
	shouldCapture: (channelId?: string) => boolean
): Promise<void> {
	const seen = new Set<unknown>();
	const pending: Promise<void>[] = [];
	for (const [channelId, relay] of wabidbMediaRelays.entries()) {
		if (seen.has(relay)) continue; // graph-id aliases are not other channels
		seen.add(relay);
		// Invoke all gates synchronously: one initializing encoder must never
		// delay muting a different relay.
		pending.push(relay.setCapture(shouldCapture(relayTransmitTargets.get(relay))).catch((error: Error) => {
			console.error('[Wabidb] microphone routing failed:', error);
		}));
	}
	await Promise.all(pending);
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
	transport === 'wabidb' && activeWatchdogSessionId != null
		? Boolean(wabidbMediaRelays.get(activeWatchdogSessionId)?.isRoomReady()) : false;

const defaultWabidbServer = () => import.meta.env.VITE_WABI_SERVER_URL || getServerUrl();

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

// Coalesce a channel's whole setup, not just its stacked /ws auth waiters.
// Roster-heal events can arrive during setup; a map.has() check alone misses
// the interval before the receive relay is installed. Each failed run still
// tears down only its own relay, never another channel's healthy transport.
const wabidbConnectInflight = new Map<string, Promise<void>>();

export async function connectWabidbCall(
	socket: Socket,
	targetChannelId: string,
	localDisplayName: string,
	serverUrl: string = defaultWabidbServer(),
	peerUserId?: string,
	listenOnly = false,
): Promise<void> {
	const inflight = wabidbConnectInflight.get(targetChannelId);
	if (inflight) {
		await inflight;
		return;
	}
	if (wabidbMediaRelays.has(targetChannelId)) return;
	const controller = new AbortController();
	sessionControllers.set(targetChannelId, controller);
	const run = doConnectWabidbCall(socket, targetChannelId, localDisplayName, serverUrl, peerUserId, listenOnly, controller.signal);
	wabidbConnectInflight.set(targetChannelId, run);
	try {
		await run;
	} finally {
		if (wabidbConnectInflight.get(targetChannelId) === run) wabidbConnectInflight.delete(targetChannelId);
		if (!wabidbMediaRelays.has(targetChannelId) && sessionControllers.get(targetChannelId) === controller) sessionControllers.delete(targetChannelId);
		releaseAudioGestureResumeIfIdle();
	}
}

async function doConnectWabidbCall(
	socket: Socket,
	targetChannelId: string,
	localDisplayName: string,
	serverUrl: string = defaultWabidbServer(),
	peerUserId?: string,
	listenOnly = false,
	signal?: AbortSignal,
): Promise<void> {
	const access = captureGroupAccess(targetChannelId);
	const socketId = socket.id;
	const check = () => {
		signal?.throwIfAborted();
		if (!socket.connected || socket.id !== socketId) throw new DOMException('Relay socket changed', 'AbortError');
		if (!access()) throw new DOMException('Group relay access revoked', 'AbortError');
	};
	check();
	if (wabidbMediaRelays.has(targetChannelId)) {
		return;
	}

	let relay: any = null;
	let audioSessionId = targetChannelId;
	try {
		// Use the real authenticated user id instead of a random one so the
		// wabidb session roster is stable across reconnects.
		const dbUserId = getStoredDbUserId();
		const userId: number = dbUserId ?? 0;
		currentUserId = userId;
		if (!wabidbCallState) {
			const boundServer = serverUrl.replace(/\/+$/, '');
			wabidbCallState = new WabiDbCallState({ serverUrl: boundServer }, {
				getToken: () => getServerUrl().replace(/\/+$/, '') === boundServer ? getAuthToken(boundServer) : null,
				refresh: () => tryRefresh(boundServer)
			});
		}
		const stateClient = wabidbCallState;

		const stream = get(localStream);
		if (!stream) {
			throw new Error('No local audio stream available');
		}

		const isDirectCall = Boolean(peerUserId);
		const { wabidbDmSessionKey: dmKey, wabidbChannelSessionKey: channelKey } = await import('./wabidbMediaRelay');
		check();
		// DM: deterministic key from both peers. Channel/group: deterministic key
		// from the channel id — ALL participants must derive the SAME key or they
		// end up in separate wabidb sessions and audio never crosses.
		const newSessionId = isDirectCall
			? dmKey(String(userId), peerUserId)
			: channelKey(targetChannelId);
		sessionId = newSessionId;
		channelId = targetChannelId;

		connectionState.set('connecting');

		// The /ws disconnect tap stays single-slot (one subscriber: the
		// watchdog), but the handshake itself uses stacked waiters inside
		// requestConnect — overlapping runs can no longer steal each other's
		// resolve and hang to timeout.
		stateClient.onDisconnect(() => {
			if (wabidbCallState !== stateClient) return;
			console.log('[Wabidb] Disconnected');
			// T3: notify the mid-call watchdog; it runs the grace/reconnect
			// probe and demotes to the next chain link if the relay stays dead.
			// The socket.io media relay itself is untouched here — a bare /ws
			// flap (Cloudflare ~100s idle kill) heals via auto-reconnect inside
			// the grace window without dropping audio.
			transportWatchdog.handleDisconnect();
		});

		if (!stateClient.isConnected) {
			// Two 10s attempts, timeout-only: the /ws handshake can stall
			// transiently behind Cloudflare (2026-09-03 field report: 42
			// timeouts, then Connected). The old single window orphaned the
			// late connection — the chain demoted to the dead p2p tail while
			// the socket healed a moment later with nobody waiting for it.
			// runId makes concurrent/sequential runs attributable in field logs.
			const runId = `${targetChannelId}:${Date.now().toString(36)}`;
			let lastError: unknown = new Error('Wabidb connection timeout (10s)');
			for (let attempt = 0; attempt < 2 && !stateClient.isConnected; attempt++) {
				check();
				try {
					console.log(`[Wabidb] handshake ${runId} attempt ${attempt + 1}/2`);
					await stateClient.requestConnect(10000);
					check();
					console.log('[Wabidb] Connected');
					lastError = null;
				} catch (err) {
					lastError = err;
					console.warn(`[Wabidb] handshake ${runId} attempt ${attempt + 1} failed:`, err);
					// Only a timeout is worth retrying — explicit errors
					// (auth, protocol) fail fast to the fallback chain.
					if (!(err instanceof Error && err.message.includes('timeout'))) throw err;
				}
			}
			if (lastError) throw lastError;
		}

		check();
		const writeFence = () => {
			check();
			const membershipRevision = groupMembership.revision(targetChannelId) ?? undefined;
			if (membershipRevision !== undefined) sessionMembershipRevisions.set(targetChannelId, membershipRevision);
			return { signal, membershipRevision };
		};
		await stateClient.createSession(newSessionId, targetChannelId, 'audio-call', userId, 100, writeFence());
		check();

		// Denied/failed authoritative admission must not become a successful relay.
		await stateClient.joinSession(newSessionId, userId, `user-${userId}`, writeFence());
		check();

		// Connect the wabidb media relay — the audio path ships opus over
		// socket.io, bypassing CGNAT without STUN/TURN. For DM calls the
		// relay uses a deterministic session key derived from both peers so
		// caller and callee rendezvous on the same wabidb session.
		try {
			const { WabidbMediaRelay } = await import('./wabidbMediaRelay');
			signal?.throwIfAborted();
			const { directCallSessionId } = await import('./callSessionTypes');
			check();
			// Phase 2: the relay's audio chain id matches the CallSessionManager
			// session id (channelId for channels/groups, direct:{peer} for DMs)
			// so per-call volume addresses the same chain the model tracks.
			audioSessionId = peerUserId ? directCallSessionId(peerUserId) : targetChannelId;
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
				// Receive-only proof selects microphone playback, never tears
				// down a bidirectional PC (which also carries our mic/camera).
				onRemoteAudioReady: (fromUserId: string) => {
					if (wabidbMediaRelays.get(targetChannelId) !== relay || getStoredCallTransportMode() === 'p2p-only') return;
					selectRelayAudio(relay, audioSessionId, fromUserId, true);
				},
				onRemoteAudioUnavailable: (fromUserId: string) => {
					if (relay) selectRelayAudio(relay, audioSessionId, fromUserId, false);
				},
				...(isDirectCall
					? { kind: 'dm' as const, peerStableUserId: peerUserId }
					: {}),
				// "All listening channels" broadcast captures into every
				// subscribed channel session, not just the primary one.
				capture: !get(isMuted) && (!listenOnly || get(voiceTransmitMode) === 'all-listening'),
			});
			ensureAudioGestureResume();
			await relay.start(stream);
			check();
			relayTransmitTargets.set(relay, isDirectCall ? undefined : targetChannelId);
			wabidbMediaRelays.set(targetChannelId, relay);
			ensureAudioGestureResume();
			// Phase 3: also index by the graph/session id (direct:{peer} for
			// DMs) so seat/volume lookups address the relay without knowing
			// the legacy channel-key convention.
			if (audioSessionId !== targetChannelId) {
				wabidbMediaRelays.set(audioSessionId, relay);
			}
		} catch (e) {
			console.warn('[Wabidb] Media relay start failed:', e);
			relay?.stop();
			relay = null;
			check();
			throw e;
		}
		// A wabidb attempt without a live receive relay is a failed attempt:
		// claiming "connected" here leaves the user silently deaf on a
		// transport the router believes is healthy. Throw so the fallback
		// chain (or the next heal) can carry audio instead. A redundant run
		// that finds another run's relay already live returns via the guards.
		if (!wabidbMediaRelays.has(targetChannelId)) {
			throw new Error('Wabidb media relay failed to start');
		}
		relay = wabidbMediaRelays.get(targetChannelId);
		sessionIds.set(targetChannelId, newSessionId);
		await joinRelayRoom(socket, newSessionId, targetChannelId, signal);
		check();
		// Read CURRENT intent after all async setup, not the mute/routing
		// snapshot from before permissions/HTTP/room authorization completed.
		const { shouldSendAudioToChannel } = await import('./calling_impl_core');
		check();
		await relay.setCapture(shouldSendAudioToChannel(relayTransmitTargets.get(relay)));
		check();
		await relay.setRoomReady(true);
		check();

		// Each receive relay owns a separate video decoder/reassembly lane.
		// Outbound capture is started explicitly for the intended call, never
		// by a global localScreenStream subscription on whichever joined first.
		const { WabidbVideoLane: Lane } = await import('./wabidbVideoLane');
		check();
		let lastVideoErrorNotice = 0;
		const videoSession: VideoSession = {
			channelId: targetChannelId, relay, socket, access,
			lane: new Lane({
				sessionId: newSessionId, userId: String(userId), socket,
				viewSessionId: audioSessionId,
				canSend: () => !signal?.aborted && access() &&
					videoSessions.get(targetChannelId) === videoSession &&
					socket.connected && relay.isRoomReady(),
				onError: (error: Error) => {
					if (videoSessions.get(targetChannelId) !== videoSession) return;
					console.error('[WabidbVideoLane]', error);
					if (error.name === 'AbortError' || Date.now() - lastVideoErrorNotice < 5_000) return;
					lastVideoErrorNotice = Date.now();
					void import('./calling_impl_core').then(({ pushVoiceChannelNotice }) => {
						if (videoSessions.get(targetChannelId) === videoSession) {
							pushVoiceChannelNotice(`Screen/camera share error: ${error.message}`);
						}
					}).catch(() => undefined);
				}
			})
		};
		videoSessions.set(targetChannelId, videoSession);
		relay.attachVideoLane(videoSession.lane);

		// Phase 1 hardening: on denial, onWabidbCallDenied feeds the transport
		// watchdog so the fallback chain demotes to the next link (p2p)
		// instead of leaving the user silently deaf. off-then-on keeps the
		// registration idempotent across repeated connects.
		socket.off('wabidb-call-denied', onWabidbCallDenied);
		socket.on('wabidb-call-denied', onWabidbCallDenied);
		sessionIds.set(targetChannelId, newSessionId);

		// Room membership is control readiness, not bidirectional media proof.
		// Per-peer worklet rendering selects reception without closing a PC.

		connectionState.set('connected');
		callTransportState.update((state) => ({
			...state,
			activeTransport: 'wabidb' as const,
			reason: 'wabidb_connected'
		}));

		// T3: arm the mid-call watchdog on this transport.
		activeWatchdogSessionId = audioSessionId;
		transportWatchdog.start({
			mode: getStoredCallTransportMode(),
			active: 'wabidb',
			connect: async (transport) => {
				if (!access() || !socket.connected) throw new DOMException('Call recovery superseded', 'AbortError');
				if (transport === 'wabidb') {
					await connectWabidbCall(socket, targetChannelId, localDisplayName, serverUrl, peerUserId, listenOnly);
					return;
				}
				if (transport === 'p2p') {
					// 2026-08-27: a dead relay used to be a dead call — the watchdog
					// had no p2p path and just threw. Rebuild the mesh via the impl
					// module (dynamic import: calling_impl imports this module).
					const { reEstablishChannelP2P } = await import('./calling_impl_core');
					if (!access()) throw new DOMException('Call recovery superseded', 'AbortError');
					await reEstablishChannelP2P(socket, targetChannelId);
					return;
				}
				throw new Error(`watchdog cannot re-establish ${transport} from here`);
			},
			disconnectCurrent: async () => {
				try { await disconnectWabidbChannel(targetChannelId, { preserveRecovery: true }); } catch { /* best-effort */ }
			}
		});

		console.log(`[Wabidb] Call connected to session ${newSessionId}`);
	} catch (error) {
		console.error('[Wabidb] Connection failed:', error);
		// Ownership: only tear down what THIS run built. A failed (or
		// redundant) handshake must never stop a healthy relay another run
		// established — that was the Connected→2×timeout→Stopped self-kill.
		// Explicit leaves bypass this catch via disconnectWabidbChannel/Call.
		if (relay && wabidbMediaRelays.get(targetChannelId) === relay) {
			await disconnectWabidbChannel(targetChannelId);
		}
		throw error;
	}
}
