import { get } from 'svelte/store';
import { releasePeerMicrophones, replacePeerMicrophone } from './peerMicrophone';
import { waitForPeerConnection } from './peerConnectionReady';
import { requestVoiceAdmission, requestGroupCallAnswer, requestGroupCallStart, requestGroupCallReadmission } from './voiceAdmission';
import { registerCallSocketOwner } from './callSocketLifecycle';
import { captureGroupAccess, groupMembership } from './groupAccess';
import { ensureChannelMembership } from './api/channelAccess';
import type { Socket } from 'socket.io-client';
import { brandName } from './branding';
import { showToast } from './toast';
import { disconnectWabidbCall, disconnectWabidbChannel, connectWabidbCall, syncWabidbCapture, wabidbTransportLive, setWabidbSpatialPosition, wabidbStopRemoteVideo } from './callingWabidb';
import { transportWatchdog } from './callingWatchdog';
import { addStub, peekPanel } from './layoutStoreRightPanel';
import { rightPanelMode } from './layoutStoreStates';
import {
	configureLivekitTokenRefresh
} from './callingLivekitTokenRefresh';
import { disconnectLivekitSfu,
	connectLivekitSfu,
	getLivekitRoom,
	getLivekitChannelId,
	initLivekitDeps,
	resolveVoiceParticipantLabel
} from './callingLivekit';
export {
	canScreenShare,
	startScreenShare,
	stopScreenShare,
	createScreenShareOffer,
	handleScreenShareOffer,
	handleScreenShareAnswer,
	handleScreenShareIceCandidate,
	screenShareTargetsCurrent,
	rejectScreenShare
} from './callingScreenShare';
import { initScreenShareDeps, cancelChannelScreenShare } from './callingScreenShare';
import { connectWithFallback, MESH_MAX_PARTICIPANTS, type CallSurface } from './callingFallback';
import { voiceChannelMembers, _updateVoiceChannelMember, _removeVoiceChannelMember } from './presenceStore';
import { getStoredDbUserId, getStoredUsername } from './authSession';
import { clearActiveAudioCaptureSession,
	prepareActiveAudioCaptureSession,
	getActiveAudioCaptureSession,
	getRTCConfig,
	requestCameraStream
} from './audioCapture';
import {
	startAudioMonitoring,
	startLocalSpeakingMonitor,
	startRemoteSpeakingMonitor,
	stopAllRemoteSpeakingMonitors,
	stopAudioMonitoring,
	stopLocalSpeakingMonitor,
	stopRemoteSpeakingMonitor
} from './callingAudioMonitors';
import {
	resetCallConnectionDiagnostics,
	startCallDiagnosticsPolling,
	stopCallDiagnosticsPolling
} from './callingDiagnostics';
import { prefetchTurnCredentials } from './turnConfig';
import { getSocket } from './socketConnection';
import { playCallActionSound, type CallSoundOptions } from './callSounds';
import { callSessionManager, callSessions, focusedCallSessionId } from './callSessionManager';
import { registerPeerAudioReceiver, releasePeerAudioReceivers } from './peerAudioPlayback';
import { channels as channelListStore } from './channelStore';
import { detachSession as detachSessionAudioChain, detachAllSessions as detachAllSessionAudioChains, setGraphOutputMuted } from './callAudioGraph';
import { resolveActiveTransport } from './callingTransport';
import {
	getStoredCallMuteBehavior,
	getStoredCallTransportMode,
	setCallTransportMode,
	getStoredAudioProcessingMode,
	getStoredSpatialAudioSettings,
	setSpatialAudioEnabled
} from './mediaRuntime';
import { SpatialAudioEngine, type SpatialPosition } from './audio/spatialEngine';
import {
	assignStableSeatOrder,
	computeSpatialPosition,
	resolveSpatialRuntimeMode,
	saveSpatialSeats,
	sortByUserId
} from './callingSpatialRuntime';
import {
	addOptimizedTrack,
	dropOrphanIceCandidates,
	flushIceCandidateQueue as flushQueuedIceCandidates,
	flushOrphanIceCandidates,
	getConnectionKey,
	keyTypeFromPCType,
	optimizeSender,
	queueIceCandidate as queuePendingIceCandidate,
	setPeerAudioSendEnabled
} from './callingWebrtcHelpers';
import {
	markExperimentalWabidbCallAttempt,
	type ExperimentalWabidbCallScope
} from './experimentalWabidbCalls';
import { clearAllRecordingPresence, removeDirectRecordingParticipant } from './callRecordingPresence';
import {
	PERFORMANCE_GUARD_SAMPLE_MS,
	PERFORMANCE_GUARD_LAG_THRESHOLD_MS,
	PERFORMANCE_GUARD_REQUIRED_STRIKES,
	type Call,
	type ScreenShare,
	type GroupCallRingingTarget,
	type CallConnectionDiagnostics,
	type ConnectionLifecycleState,
	type PeerConnectionState,
	type CallMediaScope
} from './callingTypes';
export type {
	Call,
	IncomingCall,
	OutgoingCall,
	GroupCallRingingTarget,
	ActiveVoiceChannel,
	ActiveGroupCall,
	ScreenShare,
	CallConnectionDiagnostics,
	ConnectionLifecycleState,
	PeerConnectionState,
	SenderMediaKind,
	VideoSource,
	VideoQualityTier,
	EffectiveAudioProcessingMode,
	DspAudioPipeline,
	LocalAudioCaptureSession,
	SpeakingMonitor,
	AudioAnalyzer
} from './callingTypes';
export {
	activeCalls,
	screenShares,
	incomingCall,
	outgoingCall,
	groupCallRingingTargets,
	isInCall,
	isSharing,
	isMuted,
	isDeafened,
	isVideoOff,
	isLocalSpeaking,
	localStream,
	localScreenStream,
	connectionState,
	speakingUsers,
	callConnectionDiagnostics,
	activeVoiceChannel,
	activeGroupCall,
	activeCallSessionId,
	callMode,
	channelCallPanelOpen,
	channelCallPanelSessionId,
	voiceChannelNotice,
	audioProcessingRuntimeStatus,
	callTransportState,
	listeningVoiceChannels,
	voiceTransmitMode,
	spatialAudioRuntimeStatus,
	spatialAudioDiagnostics,
	spatialSeatDebugState,
	sfuMediaActive
} from './callingStateStores';
import {
	activeCalls,
	screenShares,
	isInCall,
	isSharing,
	isMuted,
	isDeafened,
	isVideoOff,
	isLocalSpeaking,
	localStream,
	localScreenStream,
	connectionState,
	speakingUsers,
	callConnectionDiagnostics,
	activeVoiceChannel,
	activeGroupCall,
	activeCallSessionId,
	callMode,
	channelCallPanelOpen,
	channelCallPanelSessionId,
	voiceChannelNotice,
	audioProcessingRuntimeStatus,
	callTransportState,
	listeningVoiceChannels,
	voiceTransmitMode,
	spatialAudioRuntimeStatus,
	spatialAudioDiagnostics,
	spatialSeatDebugState,
	sfuMediaActive,
	callOfflineNotice,
	incomingCall,
	outgoingCall,
	groupCallRingingTargets
} from './callingStateStores';

/**
 * WO-5: resolve a channel's display name for call surfaces. Voice sessions
 * used to carry the raw channel id ("ch_1f2e") as their name, so cards,
 * chips and notices showed the id instead of "voice" / "derek's speaking
 * corner". Falls back to the id only when the channel list has not
 * hydrated the channel yet.
 */
function resolveVoiceChannelDisplayName(channelId: string): string {
	const match = get(channelListStore).find((channel) => channel.id === channelId);
	const name = match?.name?.trim();
	return name || channelId;
}

// ============================================================================
// Private State
// ============================================================================

// Single map for ALL peer connections (calls and screen shares)
// Keys are composite: `${targetId}:call` or `${targetId}:screen`
const peerConnections = new Map<string, PeerConnectionState>();

// Track call participants for targeted cleanup
const callParticipants = new Set<string>();
const voiceParticipantLabels = new Map<string, string>();
let activeVoiceChannelId: string | null = null;
let runtimeAudioModeOverride: 'dsp' | null = null;
let performanceGuardInterval: number | null = null;
let performanceLagStrikeCount = 0;
let performanceFallbackApplied = false;
let remoteVideoMuteDebounceTimers = new Map<string, number>();
let spatialAudioEngine: SpatialAudioEngine | null = null;
let spatialFallbackNoticeShown = false;
const callSpatialSeatMap = new Map<string, number>();
const shareSpatialSeatMap = new Map<string, number>();

// Multi-call session keys. `activeCallSessionId` tracks the DM/group call while
// `activeVoiceChannelId` tracks the primary voice channel. Both can be non-null
// at once so a call can coexist with a listen-only (TeamSpeak-style) voice
// channel.
function directCallSessionKey(targetUserId: string): string {
	return `direct:${targetUserId}`;
}

function groupCallSessionKey(channelId: string): string {
	return `group:${channelId}`;
}

// A group call has one local owner from the user's click through teardown.
// Membership revisions are not enough: remove -> re-add must not revive an
// older permission request, peer negotiation, or transport fallback.
type GroupCallRun = {
	channelId: string; socket: Socket; socketId: string | undefined;
	controller: AbortController; access: () => boolean;
	ready: Promise<void>; prepared: () => void; rejectReady: (error: unknown) => void;
	operation: Promise<MediaStream>; entering?: Promise<void>;
	established: boolean; cameraTracks: Set<MediaStreamTrack>; disconnected: () => void;
	suspended: boolean; membershipRevision: string; name: string; localName: string;
};
let groupCallRun: GroupCallRun | null = null;

function groupRunCurrent(run: GroupCallRun): boolean {
	return groupCallRun === run && !run.suspended && !run.controller.signal.aborted && run.access() &&
		run.socket.connected && run.socket.id === run.socketId;
}
function checkGroupRun(run: GroupCallRun): void {
	if (!groupRunCurrent(run) || !run.socket.connected || run.socket.id !== run.socketId) {
		throw new DOMException('Group call cancelled or connection changed', 'AbortError');
	}
}

/** Synchronous local revocation. Network cleanup must not own local state
 * after an await; a newly admitted call may already exist by then. */
export function revokeGroupCall(channelId: string): void {
	cancelChannelScreenShare(channelId);
	const run = groupCallRun?.channelId === channelId ? groupCallRun : null;
	const ownsView = get(activeGroupCall)?.id === channelId || get(outgoingCall)?.channelId === channelId;
	if (run) {
		groupCallRun = null;
		run.socket.off('disconnect', run.disconnected);
		run.controller.abort();
		run.rejectReady(new DOMException('Group call ended', 'AbortError'));
	}
	const peers = new Set(callSessionManager.get(channelId)?.participants.map(p => p.userId) ?? []);
	for (const state of peerConnections.values()) if (state.channelId === channelId) peers.add(state.targetId);
	for (const [key, state] of peerConnections) {
		if (state.channelId === channelId || (ownsView && state.type !== 'call' && !state.channelId && peers.has(state.targetId))) cleanupPeerConnection(key);
	}
	callSessionManager.unregister(channelId);
	detachSessionAudioChain(channelId);
	void disconnectWabidbChannel(channelId);
	if (getLivekitChannelId() === channelId) void disconnectLivekitSfu();
	if (get(incomingCall)?.channelId === channelId) incomingCall.set(null);
	if (!run && !ownsView) return;
	if (ownsView) {
		activeGroupCall.set(null);
		if (get(activeCallSessionId) === groupCallSessionKey(channelId)) activeCallSessionId.set(null);
		if (get(outgoingCall)?.channelId === channelId) outgoingCall.set(null);
		groupCallRingingTargets.set([]);
	}
	for (const track of run?.cameraTracks ?? []) { get(localStream)?.removeTrack(track); track.stop(); }
	isVideoOff.set(!get(localStream)?.getVideoTracks().some(track => track.readyState === 'live'));
	const otherConsumers = Boolean(activeVoiceChannelId || get(listeningVoiceChannels).length || pendingVoiceJoins.size ||
		get(activeCallSessionId) || callSessionManager.list().length);
	if (!otherConsumers) {
		get(localStream)?.getTracks().forEach(track => track.stop());
		localStream.set(null);
		clearActiveAudioCaptureSession(); // disposes even a late getUserMedia result
		stopLocalSpeakingMonitor(); stopAudioMonitoring('local'); stopPerformanceGuard();
		isLocalSpeaking.set(false);
		isInCall.set(false); callMode.set(null); channelCallPanelOpen.set(false);
		connectionState.set('idle'); stopCallDiagnosticsPolling('idle');
	} else if (!get(activeCallSessionId)) {
		callMode.set('channel');
		isInCall.set(Boolean(activeVoiceChannelId || get(listeningVoiceChannels).length || callSessionManager.list().length));
		connectionState.set(callSessionManager.list().some(s => s.lifecycle === 'connected') ? 'connected' : 'connecting');
	}
	syncSpatialAudioGraph();
	void syncLocalAudioState();
}

groupMembership.onRevoked(({ channelId }) => revokeGroupCall(channelId));
groupMembership.onContextChanged(() => {
	const id = groupCallRun?.channelId ?? get(activeGroupCall)?.id;
	if (id) revokeGroupCall(id);
});

function retireChannelMedia(channelId: string, notifyServer = false): void {
	cancelChannelScreenShare(channelId);
	for (const [key, peer] of peerConnections) if (peer.channelId === channelId) cleanupPeerConnection(key);
	// Synchronous local retirement before rebuilding on another socket. Do NOT
	// send a delayed account-level REST leave across a transient disconnect.
	void disconnectWabidbChannel(channelId, { notifyServer });
	if (getLivekitChannelId() === channelId) void disconnectLivekitSfu({ preserveCallState: true });
	callSessionManager.markReconnecting(channelId);
}

function suspendGroupCall(socket: Socket): void {
	const run = groupCallRun;
	if (!run || run.socket !== socket || run.suspended) return;
	if (!run.established) { revokeGroupCall(run.channelId); return; }
	run.suspended = true;
	run.controller.abort();
	run.rejectReady(new DOMException('Call connection interrupted', 'AbortError'));
	socket.off('disconnect', run.disconnected);
	retireChannelMedia(run.channelId);
	connectionState.set('reconnecting');
}

async function resumeGroupCall(socket: Socket): Promise<void> {
	const previous = groupCallRun;
	if (!previous?.suspended || !socket.connected || !groupMembership.ready()) return;
	if (!previous.access() || groupMembership.revision(previous.channelId) !== previous.membershipRevision) {
		revokeGroupCall(previous.channelId);
		callOfflineNotice.set('Group membership changed while disconnected. Join the call again.');
		return;
	}
	let prepared!: () => void, rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((resolve, reject) => { prepared = resolve; rejectReady = reject; });
	void ready.catch(() => {});
	// Fresh identity: mutating the old owner's socket would authorize its late
	// awaits against the new connection. Camera/mute/focus are retained intent.
	const run: GroupCallRun = {
		...previous, socket, socketId: socket.id, controller: new AbortController(),
		access: captureGroupAccess(previous.channelId), suspended: false,
		ready, prepared, rejectReady, entering: undefined,
		disconnected: () => suspendGroupCall(socket)
	};
	groupCallRun = run;
	socket.on('disconnect', run.disconnected);
	run.entering = (async () => {
		await requestGroupCallReadmission(socket, run.channelId, run.membershipRevision, ensureChannelMembership, run.controller.signal);
		checkGroupRun(run);
		await ensureLocalAudioStream();
		checkGroupRun(run);
		run.prepared();
		await enterEstablishedGroupCall(run.channelId, run.name, run.localName,
			{ playJoinSound: false, socket, run });
		checkGroupRun(run);
		callOfflineNotice.set(null);
	})();
	run.operation = run.entering.then(() => {
		checkGroupRun(run);
		const stream = get(localStream);
		if (!stream) throw new Error('Microphone capture ended during reconnect');
		return stream;
	});
	void run.operation.catch(() => {});
	try { await run.entering; }
	catch (error) {
		run.rejectReady(error);
		if (groupCallRun !== run || run.suspended) return;
		if (socket.connected && socket.id === run.socketId && run.access()) socket.emit('group-call-leave', { channelId: run.channelId });
		revokeGroupCall(run.channelId);
		callOfflineNotice.set(error instanceof Error ? error.message : 'Group call could not reconnect');
	}
}

registerCallSocketOwner({
	disconnected: socket => { suspendGroupCall(socket); suspendVoiceCalls(socket); },
	initialized: async socket => { await Promise.all([resumeGroupCall(socket), resumeVoiceCalls(socket)]); }
});

initLivekitDeps({
	shouldSendAudioToChannel,
	syncSpatialAudioGraph: () => syncSpatialAudioGraph(),
	voiceParticipantLabels
});
initScreenShareDeps({
	peerConnections,
	cleanupPeerConnection,
	createPeerConnection,
	addTrackWithOptimizations,
	captureScope: captureCallMediaScope,
	receiveScope: captureIncomingMediaScope,
	syncSpatialAudioGraph: () => syncSpatialAudioGraph()
});

export function captureCallMediaScope(): CallMediaScope | null {
	const run = groupCallRun;
	if (get(activeGroupCall)) {
		if (!run || !run.established || !groupRunCurrent(run)) return null;
		return { channelId: run.channelId, current: () => groupRunCurrent(run) };
	}
	const direct = get(activeCallSessionId);
	if (direct?.startsWith('direct:')) return {
		peerUserId: direct.slice('direct:'.length),
		current: () => get(activeCallSessionId) === direct && !get(activeGroupCall)
	};
	const channel = activeVoiceChannelId;
	return channel ? { channelId: channel, current: () => activeVoiceChannelId === channel && !get(activeCallSessionId) } : null;
}

export function captureIncomingMediaScope(channelId: string | undefined, peerId: string): CallMediaScope | null {
	if (channelId && groupMembership.tracks(channelId)) {
		const run = groupCallRun;
		if (!run || run.channelId !== channelId || !groupRunCurrent(run)) return null;
		return { channelId, current: () => groupRunCurrent(run) };
	}
	if (channelId) return get(listeningVoiceChannels).includes(channelId)
		? { channelId, current: () => get(listeningVoiceChannels).includes(channelId) } : null;
	const direct = directCallSessionKey(peerId);
	return get(activeCallSessionId) === direct
		? { peerUserId: peerId, current: () => get(activeCallSessionId) === direct } : null;
}
configureLivekitTokenRefresh(async (channelId, displayName) => {
	if (get(activeVoiceChannel)?.id !== channelId) return;
	if (getLivekitRoom() && getLivekitChannelId() === channelId) {
		await disconnectLivekitSfu({ preserveCallState: true });
	}
	await connectLivekitSfu(channelId, displayName);
});

function startPerformanceGuard(): void {
	if (typeof window === 'undefined') return;
	if (performanceGuardInterval !== null) return;

	let lastSampleAt = performance.now();
	performanceGuardInterval = window.setInterval(() => {
		const selectedMode = getStoredAudioProcessingMode();
		if (selectedMode !== 'auto') {
			performanceLagStrikeCount = 0;
			return;
		}

		const sessionMode = getActiveAudioCaptureSession()?.mode;
		if (sessionMode !== 'rnn') {
			performanceLagStrikeCount = 0;
			return;
		}

		const now = performance.now();
		const lag = now - lastSampleAt - PERFORMANCE_GUARD_SAMPLE_MS;
		lastSampleAt = now;

		if (lag > PERFORMANCE_GUARD_LAG_THRESHOLD_MS) {
			performanceLagStrikeCount += 1;
		} else {
			performanceLagStrikeCount = Math.max(0, performanceLagStrikeCount - 1);
		}

		if (performanceLagStrikeCount >= PERFORMANCE_GUARD_REQUIRED_STRIKES && !performanceFallbackApplied) {
			performanceFallbackApplied = true;
			runtimeAudioModeOverride = 'dsp';
			(globalThis as { __runtimeAudioModeOverride?: 'dsp' }).__runtimeAudioModeOverride = 'dsp';
			void applyCurrentAudioProcessingToLocalTrack().then(() => {
				if (getActiveAudioCaptureSession()?.mode === 'dsp') pushVoiceChannelNotice('Auto audio fallback: switched to DSP for performance');
			});
		}
	}, PERFORMANCE_GUARD_SAMPLE_MS);
}

function stopPerformanceGuard(): void {
	if (performanceGuardInterval !== null) {
		clearInterval(performanceGuardInterval);
		performanceGuardInterval = null;
	}
	performanceLagStrikeCount = 0;
	performanceFallbackApplied = false;
}

export function clearAudioPerformanceFallbackOverride(): void {
	runtimeAudioModeOverride = null;
	delete (globalThis as { __runtimeAudioModeOverride?: 'dsp' }).__runtimeAudioModeOverride;
	performanceFallbackApplied = false;
	audioProcessingRuntimeStatus.update(state => ({
		...state,
		fallbackActive: false,
		reason: null
	}));
}



// ============================================================================
// ICE Candidate Queue Management
// ============================================================================

function queueIceCandidate(key: string, candidate: RTCIceCandidateInit): void {
	queuePendingIceCandidate(peerConnections, key, candidate);
}

async function flushIceCandidateQueue(key: string): Promise<void> {
	await flushQueuedIceCandidates(peerConnections, key);
}

// ============================================================================
// Peer Connection Management
// ============================================================================

function createPeerConnection(
	targetId: string,
	username: string,
	type: PeerConnectionState['type'],
	socket: Socket,
	metadata: Pick<PeerConnectionState, 'channelId' | 'mediaRequestId'> = {}
): RTCPeerConnection {
	const key = getConnectionKey(targetId, keyTypeFromPCType(type));

	// Close existing connection of same type if any (prevents duplicates)
	const existing = peerConnections.get(key);
	if (existing) {
		console.log(`[WebRTC] Closing existing peer connection for ${key}`);
		peerConnections.delete(key);
		releasePeerMicrophones(existing.pc);
		releasePeerAudioReceivers(existing.pc);
		existing.pc.close();
	}

	const pc = new RTCPeerConnection(getRTCConfig());

	const state: PeerConnectionState = {
		...metadata,
		pc,
		type,
		targetId,
		username,
		lifecycleState: 'signaling',
		iceCandidateQueue: [],
		hasRemoteDescription: false
	};

	peerConnections.set(key, state);
	// Drain ICE candidates that arrived before this PC existed (trickle race).
	flushOrphanIceCandidates(peerConnections, key);
	connectionState.set('signaling');
	if (type === 'call') {
		startCallDiagnosticsPolling(
			() => [...peerConnections.values()].filter((state) => state.type === 'call'),
			pushVoiceChannelNotice
		);
	}

	// Connection state change handler
	pc.onconnectionstatechange = () => {
		if (peerConnections.get(key) !== state) return;
		console.log(`[WebRTC] Connection state for ${key}: ${pc.connectionState}`);

		switch (pc.connectionState) {
			case 'connected':
				state.lifecycleState = 'connected';
				connectionState.set('connected');
				callConnectionDiagnostics.update((current) => ({ ...current, connectionState: 'connected' }));
				if (state.type === 'call' && state.channelId && !transportSwitchInFlight && callSessionManager.get(state.channelId)?.transport !== 'wabidb') {
					callSessionManager.markConnected(state.channelId, 'p2p');
				}
				break;
			case 'disconnected':
				state.lifecycleState = 'disconnected';
				connectionState.set('disconnected');
				callConnectionDiagnostics.update((current) => ({ ...current, connectionState: 'disconnected' }));
				break;
			case 'failed':
				state.lifecycleState = 'failed';
				connectionState.set('failed');
				callConnectionDiagnostics.update((current) => ({ ...current, connectionState: 'failed' }));
				break;
			case 'closed':
				cleanupPeerConnection(key);
				break;
		}
	};

	// ICE connection state (more granular)
	pc.oniceconnectionstatechange = () => {
		if (peerConnections.get(key) !== state) return;
		console.log(`[WebRTC] ICE connection state for ${key}: ${pc.iceConnectionState}`);

		if (pc.iceConnectionState === 'checking') {
			state.lifecycleState = 'connecting';
			connectionState.set('connecting');
			callConnectionDiagnostics.update((current) => ({ ...current, connectionState: 'connecting' }));
		}
	};

	// ICE candidate handler
	pc.onicecandidate = (event) => {
		if (peerConnections.get(key) !== state || !socket.connected ||
			(state.channelId && !groupMembership.acceptsContent(state.channelId))) return;
		if (event.candidate) {
			const eventName = type === 'call' ? 'call-ice-candidate' : 'webrtc-ice-candidate';
			socket.emit(eventName, {
				candidate: event.candidate,
				targetId,
				channelId: state.channelId,
				membershipRevision: state.channelId ? groupMembership.revision(state.channelId) : undefined,
				requestId: state.mediaRequestId
			});
		}
	};

	// Track handler
	pc.ontrack = (event) => {
		if (peerConnections.get(key) !== state) return;
		if (type === 'call') registerPeerAudioReceiver(pc, state.channelId ?? directCallSessionKey(targetId), targetId, event.track);
		console.log(`[WebRTC] Received track from ${key}:`, event.track.kind);

		const stream = event.streams[0];
		if (!stream) {
			console.warn(`[WebRTC] No stream in ontrack event`);
			return;
		}

		// Handle track ended
		event.track.onended = () => {
			if (peerConnections.get(key) !== state) return;
			console.log(`[WebRTC] Track ended from ${key}:`, event.track.kind);
			handleRemoteTrackEnded(targetId, key, event.track, type);
		};

		// Handle track muted/unmuted for UI sync
		event.track.onmute = () => {
			if (peerConnections.get(key) !== state) return;
			console.log(`[WebRTC] Track muted from ${key}:`, event.track.kind);
			updateRemoteTrackState(targetId, event.track, type);
		};

		event.track.onunmute = () => {
			if (peerConnections.get(key) !== state) return;
			console.log(`[WebRTC] Track unmuted from ${key}:`, event.track.kind);
			updateRemoteTrackState(targetId, event.track, type);
		};

		if (type === 'call') {
			addRemoteCallStream(targetId, username, stream);
		} else if (type === 'screen-share-inbound') {
			addRemoteScreenShare(targetId, username, stream, state.channelId);
		}
	};

	return pc;
}

async function addTrackWithOptimizations(pc: RTCPeerConnection, track: MediaStreamTrack, stream: MediaStream): Promise<void> {
	const isScreenShareTrack = stream === get(localScreenStream);
	await addOptimizedTrack(pc, track, stream, isScreenShareTrack ? 'screen-share' : 'camera');
}

function cameraBelongsToPeer(channelId: string | undefined, peerId: string): boolean {
	// An accepted group's initial offer can arrive while its relay preparation
	// is still finishing. Capture was already authorized, but UI controls stay
	// disabled until establishment; do not suppress that initial camera track.
	if (channelId && groupCallRun?.channelId === channelId) {
		return !get(isVideoOff) && get(activeGroupCall)?.id === channelId && groupRunCurrent(groupCallRun);
	}
	const scope = captureCallMediaScope();
	return !get(isVideoOff) && !!scope?.current() &&
		(channelId ? scope.channelId === channelId : scope.peerUserId === peerId);
}

function shouldTransmitToChannel(channelId?: string): boolean {
	if (!channelId) return true;
	if (!groupMembership.acceptsContent(channelId)) return false;
	if (get(voiceTransmitMode) === 'all-listening') return true;
	// While a DM/group call is active, the primary voice channel becomes
	// listen-only (TeamSpeak style): audio goes to the call, not the channel.
	if (get(activeCallSessionId)) {
		return get(activeGroupCall)?.id === channelId;
	}
	if (activeVoiceChannelId === channelId) return true;
	return get(activeGroupCall)?.id === channelId;
}

export function shouldSendAudioToChannel(channelId?: string): boolean {
	// Mute gates the mic. Deafen does NOT (Discord semantics): toggleDeafen
	// already force-mutes on deafen, but a user who unmutes while still
	// deafened keeps transmitting — deafen only gates THEIR output, which for
	// the relay is handled by the shared graph's output mute.
	if (get(isMuted)) {
		return false;
	}
	return shouldTransmitToChannel(channelId);
}

async function syncLocalAudioState(): Promise<void> {
	const stream = get(localStream);
	if (stream) {
		applyLocalTrackPreferences(stream);
	}

	const tasks: Promise<unknown>[] = [];
	// Apply the relay's synchronous emission gate before awaiting ANY peer
	// operation. Outbound-only mute deliberately leaves local tracks live.
	setGraphOutputMuted(get(isDeafened));
	tasks.push(syncWabidbCapture((channelId) => shouldSendAudioToChannel(channelId)));

	if (getLivekitRoom() && get(sfuMediaActive)) {
		tasks.push(
			getLivekitRoom()!.localParticipant
				.setMicrophoneEnabled(shouldSendAudioToChannel(getLivekitChannelId() || undefined))
				.catch(() => undefined)
		);
	}

	peerConnections.forEach((state) => {
		if (state.type !== 'call') return;
		tasks.push(setPeerAudioSendEnabled(state.pc, shouldSendAudioToChannel(state.channelId)));
	});

	if (tasks.length > 0) {
		await Promise.allSettled(tasks);
	}

}

async function renegotiateCallConnection(state: PeerConnectionState, socket: Socket): Promise<void> {
	if (state.type !== 'call') return;
	const key = getConnectionKey(state.targetId, 'call');
	const access = state.channelId ? captureGroupAccess(state.channelId) : () => true;

	const offer = await state.pc.createOffer();
	await state.pc.setLocalDescription(offer);
	if (peerConnections.get(key) !== state || !access() || !socket.connected) return;

	socket.emit('call-offer', {
		offer,
		targetId: state.targetId,
		channelId: state.channelId
	});
}

function cleanupPeerConnection(key: string): void {
	const state = peerConnections.get(key);
	if (!state) return;

	console.log(`[WebRTC] Cleaning up peer connection for ${key}`);
	peerConnections.delete(key); // close events must not recursively remove a replacement
	releasePeerMicrophones(state.pc);
	releasePeerAudioReceivers(state.pc);

	try {
		state.pc.close();
	} catch (e) {
		// Ignore close errors
	}

	dropOrphanIceCandidates(key);

	// Only clean the relevant store based on connection type
	if (state.type === 'call') {
		const videoTimerKey = `${state.targetId}:video`;
		const pendingVideoTimer = remoteVideoMuteDebounceTimers.get(videoTimerKey);
		if (pendingVideoTimer != null) {
			clearTimeout(pendingVideoTimer);
			remoteVideoMuteDebounceTimers.delete(videoTimerKey);
		}
		stopRemoteSpeakingMonitor(state.targetId);
		callParticipants.delete(state.targetId);
		activeCalls.update(calls => calls.filter(c => c.userId !== state.targetId));
	} else {
		screenShares.update(shares => shares.filter(s => s.userId !== state.targetId));
	}

	// Check if any connections remain
	if (peerConnections.size === 0) {
		connectionState.set('idle');
		stopCallDiagnosticsPolling('idle');
	}
  syncSpatialAudioGraph();
}

function rememberVoiceParticipantLabel(userId: string, username?: string | null): void {
	const trimmed = username?.trim();
	if (!trimmed) return;
	voiceParticipantLabels.set(userId, trimmed);
}



function finalizeLocalCallEndState(): void {
	if (groupCallRun) revokeGroupCall(groupCallRun.channelId);
	// Phase 2: full call teardown ends every session and audio chain.
	callSessionManager.leaveAll();
	detachAllSessionAudioChains();
	const stream = get(localStream);
	if (stream) {
		stream.getTracks().forEach(track => track.stop());
		localStream.set(null);
	}
	clearActiveAudioCaptureSession();

	const screenStream = get(localScreenStream);
	if (screenStream) {
		screenStream.getTracks().forEach(track => track.stop());
		localScreenStream.set(null);
	}

	stopAudioMonitoring('local');
	isLocalSpeaking.set(false);

	isInCall.set(false);
	isSharing.set(false);
	isMuted.set(false);
	isDeafened.set(false);
	isVideoOff.set(false);
	channelCallPanelOpen.set(false);
	activeVoiceChannel.set(null);
	activeGroupCall.set(null);
	activeCallSessionId.set(null);
	groupCallRingingTargets.set([]);
	callMode.set(null);
	outgoingCall.set(null);
	incomingCall.set(null);
	clearAllRecordingPresence();

	const callKeys: string[] = [];
	peerConnections.forEach((state, key) => {
		if (state.type === 'call') {
			callKeys.push(key);
		}
	});
	callKeys.forEach(key => cleanupPeerConnection(key));

	activeCalls.set([]);
	screenShares.set([]);
	for (const timerId of remoteVideoMuteDebounceTimers.values()) {
		clearTimeout(timerId);
	}
	remoteVideoMuteDebounceTimers.clear();
	callParticipants.clear();
	voiceParticipantLabels.clear();
	activeVoiceChannelId = null;
	listeningVoiceChannels.set([]);
	stopAllRemoteSpeakingMonitors();
	stopLocalSpeakingMonitor();
	stopPerformanceGuard();
	clearAudioPerformanceFallbackOverride();
	connectionState.set('idle');
	stopCallDiagnosticsPolling('idle');
	disposeSpatialAudioEngine();
	spatialFallbackNoticeShown = false;
	spatialAudioRuntimeStatus.update((state) => ({
		...state,
		active: false,
		effectiveMode: 'off',
		fallbackReason: null
	}));

	void disconnectLivekitSfu();
	void disconnectWabidbCall();
}

// Tears down only the DM/group call session, preserving an active primary voice
// channel so listen-only (TeamSpeak-style) voice survives the call. Falls back
// to a full teardown when no voice channel is running, keeping the legacy
// single-call behavior intact.
function teardownCallSessionOnly(): void {
	if (!activeVoiceChannelId) {
		finalizeLocalCallEndState();
		return;
	}

	// Phase 2: end only the DM/group sessions — a surviving connected voice
	// channel auto-inherits focus from the manager's handoff.
	for (const session of callSessionManager.list()) {
		if (session.kind === 'direct' || session.kind === 'group') {
			callSessionManager.unregister(session.id);
		}
	}

	const callKeys: string[] = [];
	peerConnections.forEach((state, key) => {
		if (state.type === 'call') {
			callKeys.push(key);
		}
	});
	callKeys.forEach((key) => cleanupPeerConnection(key));

	activeCalls.set([]);
	screenShares.set([]);
	for (const timerId of remoteVideoMuteDebounceTimers.values()) {
		clearTimeout(timerId);
	}
	remoteVideoMuteDebounceTimers.clear();
	callParticipants.clear();
	voiceParticipantLabels.clear();
	stopAllRemoteSpeakingMonitors();

	activeCallSessionId.set(null);
	activeGroupCall.set(null);
	outgoingCall.set(null);
	incomingCall.set(null);
	groupCallRingingTargets.set([]);
	// Auto-dissolve applies to the call that ended; a surviving voice-channel
	// session inherits focus from the manager, so re-spawn the panel for it —
	// unless the user explicitly dismissed the shell during this call.
	const survivingChannelSession = activeVoiceChannelId
		? callSessionManager.get(activeVoiceChannelId)
		: null;
	const reopenForSurvivor = !callPanelDismissedByUser && Boolean(survivingChannelSession);
	channelCallPanelOpen.set(false);

	if (peerConnections.size === 0) {
		connectionState.set('idle');
		stopCallDiagnosticsPolling('idle');
	}
	// A live SFU/wabidb voice transport survives the call teardown; reflect it.
	if (getLivekitRoom() || get(sfuMediaActive)) {
		connectionState.set('connected');
	}

	// Return to normal voice-channel mode. The local stream and transport stay
	// alive so listen-only voice keeps working, and transmit re-enables.
	callMode.set('channel');
	isInCall.set(true);
	isMuted.set(false);
	isVideoOff.set(true);
	if (reopenForSurvivor) {
		channelCallPanelOpen.set(true);
	}
	syncSpatialAudioGraph();
	void syncLocalAudioState();
}

// ============================================================================
// Remote Stream/Track Handlers
// ============================================================================

function addRemoteCallStream(userId: string, username: string, stream: MediaStream): void {
	rememberVoiceParticipantLabel(userId, username);
	activeCalls.update(calls => {
		const existingIndex = calls.findIndex(c => c.userId === userId);

		// Check actual track enabled states (not just existence)
		const videoTrack = stream.getVideoTracks()[0];
		const audioTrack = stream.getAudioTracks()[0];

		const newCall: Call = {
			userId,
			username: username || 'Unknown',
			stream,
			isVideoEnabled: videoTrack ? videoTrack.enabled : false,
			isAudioEnabled: audioTrack ? audioTrack.enabled : false,
			isSpeaking: false
		};

		if (existingIndex >= 0) {
			calls[existingIndex] = newCall;
			return [...calls];
		} else {
			return [...calls, newCall];
		}
	});

	callParticipants.add(userId);

	// Use the lower-overhead RMS monitor for remote speaking state.
	startRemoteSpeakingMonitor(userId, stream);
	syncSpatialAudioGraph();
}

function addRemoteScreenShare(userId: string, username: string, stream: MediaStream, channelId?: string): void {
	screenShares.update(shares => {
		const existingIndex = shares.findIndex(s => s.userId === userId);

		const newShare: ScreenShare = {
			userId,
			channelId,
			username: username || 'Unknown',
			stream
		};

		if (existingIndex >= 0) {
			shares[existingIndex] = newShare;
			return [...shares];
		} else {
			return [...shares, newShare];
		}
	});
	syncSpatialAudioGraph();
}

function handleRemoteTrackEnded(targetId: string, key: string, track: MediaStreamTrack, type: PeerConnectionState['type']): void {
	if (type === 'call') {
		if (track.kind === 'video') {
			const timerKey = `${targetId}:video`;
			const pendingTimer = remoteVideoMuteDebounceTimers.get(timerKey);
			if (pendingTimer != null) {
				clearTimeout(pendingTimer);
				remoteVideoMuteDebounceTimers.delete(timerKey);
			}
		}
		// Update call state to reflect ended track
		activeCalls.update(calls => {
			return calls.map(call => {
				if (call.userId === targetId) {
					if (track.kind === 'video') {
						return { ...call, isVideoEnabled: false };
					} else if (track.kind === 'audio') {
						return { ...call, isAudioEnabled: false, isSpeaking: false };
					}
				}
				return call;
			});
		});
	} else if (type === 'screen-share-inbound') {
		// Screen share track ended - remove the share
		screenShares.update(shares => shares.filter(s => s.userId !== targetId));
		cleanupPeerConnection(key);
	}
	syncSpatialAudioGraph();
}

function updateRemoteTrackState(targetId: string, track: MediaStreamTrack, type: PeerConnectionState['type']): void {
	if (type !== 'call') return;
	const timerKey = `${targetId}:${track.kind}`;

	// Avoid transient network hiccups causing rapid video flicker.
	if (track.kind === 'video' && track.muted) {
		if (remoteVideoMuteDebounceTimers.has(timerKey)) return;
		const timeoutId = window.setTimeout(() => {
			remoteVideoMuteDebounceTimers.delete(timerKey);
			activeCalls.update(calls => calls.map(call =>
				call.userId === targetId ? { ...call, isVideoEnabled: !track.muted && track.enabled } : call
			));
		}, 900);
		remoteVideoMuteDebounceTimers.set(timerKey, timeoutId);
		return;
	}
	if (track.kind === 'video') {
		const pendingTimer = remoteVideoMuteDebounceTimers.get(timerKey);
		if (pendingTimer != null) {
			clearTimeout(pendingTimer);
			remoteVideoMuteDebounceTimers.delete(timerKey);
		}
	}

	activeCalls.update(calls => {
		return calls.map(call => {
			if (call.userId === targetId) {
				if (track.kind === 'video') {
					return { ...call, isVideoEnabled: !track.muted && track.enabled };
				} else if (track.kind === 'audio') {
					const isAudioEnabled = !track.muted && track.enabled;
					return { ...call, isAudioEnabled, isSpeaking: isAudioEnabled ? call.isSpeaking : false };
				}
			}
			return call;
		});
	});
	syncSpatialAudioGraph();
}

let voiceChannelNoticeId = 0;

function applyLocalTrackPreferences(stream: MediaStream): void {
	const muted = get(isMuted);
	const deafened = get(isDeafened);
	const videoOff = get(isVideoOff);
	const callMuteBehavior = getStoredCallMuteBehavior();

	const audioTrack = stream.getAudioTracks()[0];
	if (audioTrack) {
		audioTrack.enabled = callMuteBehavior === 'outbound-only' ? true : !(muted || deafened);
	}

	const videoTrack = stream.getVideoTracks()[0];
	if (videoTrack) {
		videoTrack.enabled = !videoOff;
	}
}

// WO-2b: exported so the wabidb video lane (imported dynamically to avoid a
// module cycle) can surface encoder/start failures as visible notices.
export function pushVoiceChannelNotice(text: string): void {
	voiceChannelNoticeId += 1;
	const id = voiceChannelNoticeId;
	voiceChannelNotice.set({ id, text });
	setTimeout(() => {
		if (get(voiceChannelNotice)?.id === id) {
			voiceChannelNotice.set(null);
		}
	}, 2400);
}

function disposeSpatialAudioEngine(): void {
	if (!spatialAudioEngine) return;
	spatialAudioEngine.dispose();
	spatialAudioEngine = null;
}

function syncSpatialAudioGraph(): void {
	const settings = getStoredSpatialAudioSettings();
	spatialAudioRuntimeStatus.update((state) => ({
		...state,
		requestedMode: settings.mode,
		warningMuted: settings.warningMuted,
		quickToggleVisible: settings.quickToggleVisible
	}));

	if (!get(isInCall) || !settings.enabled || get(isDeafened)) {
		disposeSpatialAudioEngine();
		callSpatialSeatMap.clear();
		shareSpatialSeatMap.clear();
		spatialSeatDebugState.set({
			entries: [],
			updatedAt: Date.now()
		});
		spatialAudioDiagnostics.update((diag) => ({
			...diag,
			callSources: 0,
			shareSources: 0,
			totalSources: 0,
			callSeatSlots: 0,
			shareSeatSlots: 0,
			lastUpdatedAt: Date.now(),
			syncCount: diag.syncCount + 1
		}));
		spatialAudioRuntimeStatus.update((state) => ({
			...state,
			active: false,
			effectiveMode: 'off',
			fallbackReason: null
		}));
		return;
	}

	const resolved = resolveSpatialRuntimeMode(settings.mode);
	if (resolved.effective === 'off') {
		disposeSpatialAudioEngine();
		callSpatialSeatMap.clear();
		shareSpatialSeatMap.clear();
		spatialSeatDebugState.set({
			entries: [],
			updatedAt: Date.now()
		});
		spatialAudioDiagnostics.update((diag) => ({
			...diag,
			callSources: 0,
			shareSources: 0,
			totalSources: 0,
			callSeatSlots: 0,
			shareSeatSlots: 0,
			lastUpdatedAt: Date.now(),
			syncCount: diag.syncCount + 1
		}));
		spatialAudioRuntimeStatus.update((state) => ({
			...state,
			active: false,
			effectiveMode: 'off',
			fallbackReason: resolved.reason
		}));
		return;
	}

	if (!spatialAudioEngine || spatialAudioEngine.getMode() !== resolved.effective) {
		disposeSpatialAudioEngine();
		try {
			spatialAudioEngine = new SpatialAudioEngine(resolved.effective, {
				masterStrength: settings.masterStrength,
				distanceScale: settings.distanceScale
			});
		} catch (error) {
			disposeSpatialAudioEngine();
			spatialAudioRuntimeStatus.update((state) => ({
				...state,
				active: false,
				effectiveMode: 'off',
				fallbackReason: 'unsupported'
			}));
			if (!settings.warningMuted && !spatialFallbackNoticeShown) {
				spatialFallbackNoticeShown = true;
				pushVoiceChannelNotice('Spatial audio unavailable on this device.');
			}
			return;
		}
	}

	spatialAudioEngine.setOptions({
		masterStrength: settings.masterStrength,
		distanceScale: settings.distanceScale
	});
	void spatialAudioEngine.resume().catch(() => undefined);

	const remoteCalls = get(activeCalls);
	const remoteShares = get(screenShares);
	const nextSourceIds = new Set<string>();
	const sortedCalls = sortByUserId(remoteCalls);
	const callSeatPlan = assignStableSeatOrder(sortedCalls.map((call) => call.userId), callSpatialSeatMap);
	const callsById = new Map(sortedCalls.map((call) => [call.userId, call]));
	const seatDebugEntries: Array<{
		sourceId: string;
		sourceType: 'call' | 'share';
		userId: string;
		username: string;
		seatIndex: number;
		slotCount: number;
		position: SpatialPosition;
		hasAudio: boolean;
		isSpeaking: boolean;
	}> = [];
	callSeatPlan.orderedIds.forEach((userId) => {
		const call = callsById.get(userId);
		if (!call) return;
		const seatIndex = callSpatialSeatMap.get(userId) ?? 0;
		const position = computeSpatialPosition(seatIndex, callSeatPlan.slotCount);
		const sourceId = `call:${call.userId}`;
		nextSourceIds.add(sourceId);
		spatialAudioEngine?.attachSource(sourceId, call.stream, position);
		seatDebugEntries.push({
			sourceId,
			sourceType: 'call',
			userId: call.userId,
			username: call.username,
			seatIndex,
			slotCount: callSeatPlan.slotCount,
			position,
			hasAudio: call.stream.getAudioTracks().length > 0,
			isSpeaking: call.isSpeaking
		});
	});

	const sortedShares = sortByUserId(remoteShares);
	const shareSeatPlan = assignStableSeatOrder(sortedShares.map((share) => share.userId), shareSpatialSeatMap);
	const sharesById = new Map(sortedShares.map((share) => [share.userId, share]));
	shareSeatPlan.orderedIds.forEach((userId) => {
		const share = sharesById.get(userId);
		if (!share) return;
		if (!share.stream.getAudioTracks().length) return;
		const seatIndex = shareSpatialSeatMap.get(userId) ?? 0;
		const position = computeSpatialPosition(seatIndex, shareSeatPlan.slotCount, true);
		const sourceId = `share:${share.userId}`;
		nextSourceIds.add(sourceId);
		spatialAudioEngine?.attachSource(sourceId, share.stream, position);
		seatDebugEntries.push({
			sourceId,
			sourceType: 'share',
			userId: share.userId,
			username: share.username,
			seatIndex,
			slotCount: shareSeatPlan.slotCount,
			position,
			hasAudio: share.stream.getAudioTracks().length > 0,
			isSpeaking: false
		});
	});
	for (const sourceId of spatialAudioEngine?.getSourceIds() || []) {
		if (!nextSourceIds.has(sourceId)) {
			spatialAudioEngine?.detachSource(sourceId);
		}
	}
	spatialAudioDiagnostics.update((diag) => ({
		...diag,
		callSources: sortedCalls.length,
		shareSources: sortedShares.filter((share) => share.stream.getAudioTracks().length > 0).length,
		totalSources: nextSourceIds.size,
		callSeatSlots: callSeatPlan.slotCount,
		shareSeatSlots: shareSeatPlan.slotCount,
		lastUpdatedAt: Date.now(),
		syncCount: diag.syncCount + 1
	}));
	spatialSeatDebugState.set({
		entries: seatDebugEntries,
		updatedAt: Date.now()
	});

	spatialAudioRuntimeStatus.update((state) => ({
		...state,
		active: true,
		effectiveMode: resolved.effective,
		fallbackReason: resolved.reason
	}));

	if (resolved.reason && !settings.warningMuted && !spatialFallbackNoticeShown) {
		spatialFallbackNoticeShown = true;
		pushVoiceChannelNotice(`Spatial audio fallback active (${resolved.reason.replace('_', ' ')})`);
	}
}

export function refreshSpatialAudioRuntime(): void {
	syncSpatialAudioGraph();
}

export function toggleSpatialAudioEnabled(): void {
	const current = getStoredSpatialAudioSettings();
	setSpatialAudioEnabled(!current.enabled);
	if (current.enabled) {
		spatialFallbackNoticeShown = false;
	}
	syncSpatialAudioGraph();
}

/**
 * Phase 3: set one user's seat on a call's spatial stage. Drives every audio
 * path at once — persists the personal layout, records it in the session
 * model, positions the wabidb relay's per-user chain, and (when the p2p
 * spatial engine is attached to this peer) updates `call:{userId}`.
 */
export function applySpatialSeat(
	sessionId: string,
	userId: string,
	position: { x: number; y: number; z: number }
): void {
	callSessionManager.setSpatialSeat(sessionId, userId, position);
	const session = callSessionManager.get(sessionId);
	if (session) saveSpatialSeats(sessionId, session.spatialSeats);
	setWabidbSpatialPosition(sessionId, userId, position);
	if (spatialAudioEngine) {
		spatialAudioEngine.updateSourcePosition(`call:${userId}`, position as SpatialPosition);
	}
}

/**
 * Phase 3 (review fix): apply a seat to the AUDIO PATHS ONLY — no session
 * store write, no persistence. Bulk applications (mount, roster changes,
 * spatial toggle) must use this: writing through applySpatialSeat there
 * would (a) freeze auto-circle layouts into persisted manual seats, and
 * (b) re-trigger the applying effect through store → prop → derived
 * identity chains (an infinite churn loop).
 */
export function applySpatialSeatToAudio(
	sessionId: string,
	userId: string,
	position: { x: number; y: number; z: number }
): void {
	setWabidbSpatialPosition(sessionId, userId, position);
	if (spatialAudioEngine) {
		spatialAudioEngine.updateSourcePosition(`call:${userId}`, position as SpatialPosition);
	}
}

export function clearSpatialSeat(sessionId: string, userId: string): void {
	callSessionManager.clearSpatialSeat(sessionId, userId);
	const session = callSessionManager.get(sessionId);
	if (session) saveSpatialSeats(sessionId, session.spatialSeats);
	// Back to the auto-circle: recompute the stable seat for this user.
	if (spatialAudioEngine) {
		syncSpatialAudioGraph();
	}
}

// ============================================================================
// Call Functions
// ============================================================================

async function ensureLocalAudioStream(): Promise<MediaStream> {
	const existing = get(localStream);
	if (existing?.getAudioTracks().some(track => track.readyState === 'live')) return existing;
	// Concurrent channel/call joins share the permission request. Leave and
	// device replacement invalidate it even before getUserMedia resolves.
	await prepareActiveAudioCaptureSession(session => {
		const stream = get(localStream) ?? new MediaStream();
		stream.getAudioTracks().forEach(track => { stream.removeTrack(track); track.stop(); });
		stream.addTrack(session.outputTrack);
		applyLocalTrackPreferences(stream);
		localStream.set(stream);
		startLocalSpeakingMonitor(stream);
	});
	const stream = get(localStream);
	if (!stream) throw new DOMException('Call ended during microphone setup', 'AbortError');
	void syncLocalAudioState();
	return stream;
}

const pendingVoiceJoins = new Map<string, { socket: Socket; controller: AbortController; promise: Promise<MediaStream | null>; listenOnly: boolean }>();
const voiceSocketOwners = new Map<string, Socket>();
type VoiceRecovery = {
	socket: Socket; joinedAt: number; realm: string | null; controller: AbortController; suspended: boolean;
	operation?: Promise<MediaStream | null>;
};
const voiceRecoveries = new Map<string, VoiceRecovery>();

function suspendVoiceCalls(socket: Socket): void {
	for (const pending of pendingVoiceJoins.values()) if (pending.socket === socket) pending.controller.abort();
	for (const session of callSessionManager.list()) {
		if (session.kind !== 'channel' || voiceSocketOwners.get(session.id) !== socket || pendingVoiceJoins.has(session.id)) continue;
		const previous = voiceRecoveries.get(session.id);
		if (previous?.socket === socket && previous.suspended) continue;
		previous?.controller.abort();
		voiceRecoveries.set(session.id, { socket, joinedAt: session.joinedAt,
			realm: groupMembership.realm(), controller: new AbortController(), suspended: true });
		retireChannelMedia(session.id);
	}
}

async function resumeVoiceCalls(socket: Socket): Promise<void> {
	if (groupMembership.realm() && !groupMembership.ready()) return;
	await Promise.all([...voiceRecoveries].map(([id, previous]) =>
		readmitVoiceSession(socket, id, previous).catch(() => null)));
}

/** One admission/transport path for reconnect and server-forced moves. */
function readmitVoiceSession(socket: Socket, id: string, previous: VoiceRecovery): Promise<MediaStream | null> {
	if (voiceRecoveries.get(id) !== previous || !previous.suspended || !socket.connected) return Promise.resolve(null);
	if (callSessionManager.get(id)?.joinedAt !== previous.joinedAt ||
		!get(listeningVoiceChannels).includes(id) || groupMembership.realm() !== previous.realm) {
		if (voiceRecoveries.get(id) === previous) voiceRecoveries.delete(id);
		return Promise.resolve(null);
	}
	const run: VoiceRecovery = { ...previous, socket, controller: new AbortController(), suspended: false, operation: undefined };
	voiceRecoveries.set(id, run);
	voiceSocketOwners.set(id, socket);
	const socketId = socket.id;
	const wanted = () => voiceRecoveries.get(id) === run && !run.controller.signal.aborted &&
		socket.connected && socket.id === socketId && groupMembership.realm() === run.realm &&
		callSessionManager.get(id)?.joinedAt === run.joinedAt && get(listeningVoiceChannels).includes(id);
	const check = () => { if (!wanted()) throw new DOMException('Voice recovery superseded', 'AbortError'); };
	const listenOnly = activeVoiceChannelId !== id;
	run.operation = (async () => {
		try {
			await requestVoiceAdmission(socket, id, listenOnly, ensureChannelMembership, run.controller.signal);
			check();
			await ensureLocalAudioStream();
			check();
			socket.emit('set-voice-transmit-mode', { mode: get(voiceTransmitMode) });
			const transport = await resolveActiveTransport(id, 'channel', wanted);
			check();
			const outcome = await connectWithFallback({
				mode: transport === 'sfu' ? 'sfu-preferred' : getStoredCallTransportMode(),
				surface: 'channel', stillWanted: wanted,
				expectedParticipants: Math.max(get(voiceChannelMembers)[id]?.length ?? 1, 1),
				connect: async candidate => {
					check();
					if (candidate === 'wabidb') await connectWabidbCall(socket, id, `${brandName} User`, undefined, undefined, listenOnly);
					else if (candidate === 'sfu') await connectLivekitSfu(id, `${brandName} User`, run.controller.signal);
					else await reEstablishChannelP2P(socket, id, { stillWanted: wanted });
				}
			});
			check();
			const effective = outcome.active;
			if (effective !== 'p2p' || hasConnectedChannelPeer(id)) callSessionManager.markConnected(id, effective);
			await syncLocalAudioState();
			check();
			return get(localStream);
		} catch (error) {
			if (wanted()) {
				await handleForcedVoiceLeave(socket, id);
				pushVoiceChannelNotice(`Voice connection failed: ${error instanceof Error ? error.message : 'admission unavailable'}`);
			}
			throw error;
		} finally {
			if (voiceRecoveries.get(id) === run) voiceRecoveries.delete(id);
		}
	})();
	return run.operation;
}

export function joinVoiceChannel(socket: Socket, channelId: string, options: { listenOnly?: boolean } = {}): Promise<MediaStream | null> {
	const recovery = voiceRecoveries.get(channelId);
	if (recovery?.socket === socket && !recovery.suspended && recovery.operation) return recovery.operation;
	if (recovery) {
		recovery.controller.abort();
		voiceRecoveries.delete(channelId);
	}
	const pending = pendingVoiceJoins.get(channelId);
	if (pending?.socket === socket) return pending.promise;
	if (pending) {
		pending.controller.abort();
		// Let old-attempt cleanup finish before a replacement can own media.
		return pending.promise.catch(() => null).then(() => joinVoiceChannel(socket, channelId, options));
	}
	const controller = new AbortController();
	const promise = joinVoiceChannelAttempt(socket, channelId, controller.signal, options.listenOnly).finally(() => {
		if (pendingVoiceJoins.get(channelId)?.controller === controller) pendingVoiceJoins.delete(channelId);
	});
	pendingVoiceJoins.set(channelId, { socket, controller, promise,
		listenOnly: Boolean(options.listenOnly || get(activeCallSessionId) || (activeVoiceChannelId && activeVoiceChannelId !== channelId)) });
	return promise;
}

function cancelVoiceJoin(socket: Socket | null, channelId: string): void {
	const pending = pendingVoiceJoins.get(channelId);
	if (pending && (!socket || pending.socket === socket)) pending.controller.abort();
	const recovery = voiceRecoveries.get(channelId);
	if (recovery && (!socket || recovery.socket === socket)) {
		recovery.controller.abort();
		voiceRecoveries.delete(channelId);
	}
}

async function joinVoiceChannelAttempt(socket: Socket, channelId: string, signal: AbortSignal, forceListen = false) {
	const socketId = socket.id;
	const wanted = () => !signal.aborted && socket.connected && socket.id === socketId;
	if (!socket.connected) {
		callOfflineNotice.set(`No connection to server. Calls require an active connection to the ${brandName} server.`);
		throw new Error(`No connection to server. Calls require an active connection to the ${brandName} server.`);
	}

	if (activeVoiceChannelId === channelId) {
		// Reconnect recovery: the server's new socket has no voice presence
		// after a transport drop, so re-emit the primary join (not just the
		// subscribe) to restore presence + relay. Idempotent server-side.
		listeningVoiceChannels.update((channels) => (
			channels.includes(channelId) ? channels : [...channels, channelId]
		));
		try {
			await requestVoiceAdmission(socket, channelId, false, ensureChannelMembership, signal);
			voiceSocketOwners.set(channelId, socket);
		} catch (error) {
			await handleForcedVoiceLeave(socket, channelId);
			if (!signal.aborted) handleMediaError(error as Error, 'starting');
			throw error;
		}
		// Heal the media layer: teardown paths can remove the wabidb relay
		// while these stores still say "connected" — silent one-way/no audio.
		// connectWabidbCall is a no-op when the relay is healthy, rebuilds it
		// (with capture ON — this is the primary channel) when missing.
		void connectWabidbCall(socket, channelId, `${brandName} User`).catch((err) => {
			console.warn('[Calling] relay heal failed:', err);
		});
		syncWabidbCapture((cid) => shouldSendAudioToChannel(cid));
		return get(localStream);
	}

	// Joining a voice channel while a DM/group call is active keeps the call
	// running and makes the channel listen-only (TeamSpeak-style).
	const alreadyInCall = Boolean(get(activeCallSessionId)) || forceListen;
	const hasPrimaryVoiceChannel = Boolean(activeVoiceChannelId);

	try {
		// Admission precedes microphone permission, optimistic UI and all media
		// routes. Socket.IO handlers are async: emit order is not completion.
		await requestVoiceAdmission(socket, channelId, alreadyInCall || hasPrimaryVoiceChannel, ensureChannelMembership, signal);
		voiceSocketOwners.set(channelId, socket);
		await prefetchTurnCredentials().catch((err) => {
			console.warn('[Calling] TURN prefetch failed, continuing without TURN', err);
		});
		signal.throwIfAborted();
		const activeTransport = await resolveActiveTransport(channelId, 'channel', wanted);
		signal.throwIfAborted();
		const stream = await ensureLocalAudioStream();
		signal.throwIfAborted();
		const listenOnly = alreadyInCall || hasPrimaryVoiceChannel;
		if (!listenOnly) {
			activeVoiceChannelId = channelId;
			callMode.set('channel');
			isInCall.set(true);
			isMuted.set(false);
			isVideoOff.set(true);
			startLocalSpeakingMonitor(stream);
			startPerformanceGuard();
		}
		if (!listenOnly) {
			activeVoiceChannel.set({ id: channelId, name: resolveVoiceChannelDisplayName(channelId) });
		}
		listeningVoiceChannels.update((channels) => (
			channels.includes(channelId) ? channels : [...channels, channelId]
		));
		isInCall.set(true);
		if (!get(activeCallSessionId)) callMode.set('channel');
		// Phase 5: optimistic self-membership — the chip renders on click,
		// before the server roster echo (Discord-style fluidity). The echo's
		// voice-channel-state upsert is idempotent over this entry.
		const selfDbId = getStoredDbUserId();
		if (selfDbId) {
			_updateVoiceChannelMember(channelId, `user-${selfDbId}`, {
				username: getStoredUsername() ?? `${brandName} User`,
				isSpeaking: false
			});
		}
		if (!get(incomingCall) && !get(outgoingCall)) {
			incomingCall.set(null);
		}
		pushVoiceChannelNotice(`Joined voice: ${resolveVoiceChannelDisplayName(channelId)}`);
		// Presence was acknowledged before acquiring capture. Both relay and
		// P2P can now rely on this connection's server-owned roster slot.
		// Phase 2: the session model is the source of truth for connected
		// calls — register optimistically (lifecycle 'joining') so the UI can
		// render the chip before transport setup finishes.
		callSessionManager.register({
			id: channelId,
			channelId,
			kind: 'channel',
			// Resolved display name; socketConnectionCore backfills the real
			// name once the channel list hydrates (WO-5).
			name: resolveVoiceChannelDisplayName(channelId),
			direction: listenOnly ? 'listen' : 'transmit'
		});
		// T2: declarative fallback chain — previously a wabidb failure here was
		// caught + logged with NO fallback (user silently deaf).
		const rosterSize = get(voiceChannelMembers)[channelId]?.length ?? 1;
		const outcome = await connectWithFallback({
			mode: activeTransport === 'sfu' ? 'sfu-preferred' : getStoredCallTransportMode(),
			surface: 'channel' as CallSurface,
			stillWanted: wanted,
			expectedParticipants: Math.max(rosterSize, 1),
			connect: async (transport) => {
				if (transport === 'sfu') {
					await connectLivekitSfu(channelId, `${brandName} User`, signal);
				} else if (transport === 'wabidb') {
					await connectWabidbCall(socket, channelId, `${brandName} User`, undefined, undefined, listenOnly);
				} else {
					// p2p tail for channels: build the mesh for real. This branch
					// used to be a bare console.warn — the chain then stamped
					// Transport: P2P with zero peers, no offers, no relay: a
					// call that LOOKS connected and is completely deaf
					// (2026-09-03 "nada" report). Same mesh path the watchdog
					// demote uses; forceTransport: 'p2p' bypasses the resolver.
					await reEstablishChannelP2P(socket, channelId, { stillWanted: wanted });
				}
			}
		});
		// The shared transport diagnostic can change while another session
		// connects. This session owns the result of its own fallback chain.
		const effectiveTransport = outcome.active;
		signal.throwIfAborted();
		if (effectiveTransport !== 'p2p' || hasConnectedChannelPeer(channelId)) {
			callSessionManager.markConnected(channelId, effectiveTransport);
		}
		if (!listenOnly) {
			callSessionManager.setFocus(channelId);
			// Auto-spawn contract: an active (non listen-only) channel join
			// opens the embedded call panel unless the user dismissed it.
			autoOpenChannelCallPanel();
		}
		syncSpatialAudioGraph();
		playCallActionSound('join', sessionSoundOptionsFor(channelId));
		callOfflineNotice.set(null);
		return stream;
	} catch (error) {
		console.error('Error joining voice channel:', error);
		// A server move can retire this attempt without awaiting a permission
		// dialog. Its late catch must not erase a subsequent visit to this ID.
		if (pendingVoiceJoins.get(channelId)?.controller.signal !== signal) throw error;
		const cancelled = signal.aborted;
		const selfDbId = getStoredDbUserId();
		if (selfDbId) _removeVoiceChannelMember(channelId, `user-${selfDbId}`);
		// A failed setup still owns peers and possibly screen/capture work.
		// Reuse scoped leave rather than maintaining a second partial teardown.
		await leaveVoiceChannel(socket, channelId, {
			notifyServer: socket.id === socketId,
			notice: `Voice connection failed: ${error instanceof Error ? error.message : 'setup unavailable'}`
		});
		if (!cancelled) handleMediaError(error as DOMException, 'starting');
		throw error;
	}
}

export async function leaveVoiceChannel(socket: Socket | null, channelId: string,
	options: { notifyServer?: boolean; notice?: string } = {}) {
	cancelVoiceJoin(socket, channelId);
	voiceSocketOwners.delete(channelId);
	const isPrimary = activeVoiceChannelId === channelId;
	if (options.notifyServer !== false && socket?.connected) {
		// Also cancel a primary admission that has not reached local state yet.
		const pending = pendingVoiceJoins.get(channelId);
		if (isPrimary || (pending?.socket === socket && !pending.listenOnly)) socket.emit('voice-channel-leave', { channelId });
		socket.emit('voice-channel-unsubscribe', { channelId });
	}
	cancelChannelScreenShare(channelId);
	for (const [key, peer] of peerConnections) if (peer.channelId === channelId) cleanupPeerConnection(key);
	void disconnectWabidbChannel(channelId);
	if (getLivekitChannelId() === channelId) void disconnectLivekitSfu({ preserveCallState: true });
	callSessionManager.unregister(channelId);
	detachSessionAudioChain(channelId);
	if (isPrimary) {
		activeVoiceChannelId = null;
		activeVoiceChannel.set(null);
	}
	listeningVoiceChannels.update(ids => ids.filter(id => id !== channelId));
	pushVoiceChannelNotice(options.notice ?? `Left voice: ${channelId}`);
	playCallActionSound('leave', sessionSoundOptionsFor(channelId));

	// One leave owns one session, including the primary. Never erase the
	// group or other listeners from the graph while their relays keep running.
	if (get(activeCallSessionId) || groupCallRun || activeVoiceChannelId || get(listeningVoiceChannels).length || callSessionManager.list().length ||
		[...pendingVoiceJoins].some(([id, run]) => id !== channelId && !run.controller.signal.aborted)) {
		void syncLocalAudioState();
		return;
	}

	const stream = get(localStream);
	if (stream) {
		stream.getTracks().forEach(track => track.stop());
		localStream.set(null);
	}
	clearActiveAudioCaptureSession();

	const screenStream = get(localScreenStream);
	if (screenStream) {
		screenStream.getTracks().forEach(track => track.stop());
		localScreenStream.set(null);
	}

	isInCall.set(false);
	isSharing.set(false);
	isMuted.set(false);
	isDeafened.set(false);
	isVideoOff.set(true);
	channelCallPanelOpen.set(false);
	activeVoiceChannel.set(null);
	activeGroupCall.set(null);
	callMode.set(null);

	const callKeys: string[] = [];
	peerConnections.forEach((state, key) => {
		if (state.type === 'call') {
			callKeys.push(key);
		}
	});
	callKeys.forEach(key => cleanupPeerConnection(key));

	activeCalls.set([]);
	for (const timerId of remoteVideoMuteDebounceTimers.values()) {
		clearTimeout(timerId);
	}
	remoteVideoMuteDebounceTimers.clear();
	callParticipants.clear();
	voiceParticipantLabels.clear();
	stopAllRemoteSpeakingMonitors();
	stopLocalSpeakingMonitor();
	screenShares.set([]);
	if (peerConnections.size === 0) {
		connectionState.set('idle');
	}
	stopPerformanceGuard();
	clearAudioPerformanceFallbackOverride();
	stopCallDiagnosticsPolling('idle');
	disposeSpatialAudioEngine();
	spatialFallbackNoticeShown = false;
	spatialAudioRuntimeStatus.update((state) => ({
		...state,
		active: false,
		effectiveMode: 'off',
		fallbackReason: null
	}));

	void disconnectLivekitSfu();
	void disconnectWabidbCall();
}

/**
 * The server relocated this socket's voice presence (moderator drag, breakout
 * auto-assign, breakout close). The roster move alone leaves our media session
 * on the old channel — re-tune it so audio actually follows the user.
 */
export async function handleForcedVoiceMove(
	socket: Socket,
	fromChannelId: string,
	toChannelId: string
): Promise<void> {
	if (!socket.connected || fromChannelId === toChannelId) return;
	const pending = pendingVoiceJoins.get(fromChannelId);
	if (voiceSocketOwners.get(fromChannelId) !== socket && pending?.socket !== socket) return;
	const source = callSessionManager.get(fromChannelId);
	if (!source && (!pending || pending.controller.signal.aborted)) return;
	const isPrimary = activeVoiceChannelId === fromChannelId || (pending?.socket === socket && !pending.listenOnly);
	const destination = callSessionManager.get(toChannelId);
	const controls = destination ?? source;
	const transferFocus = source?.focus === 'focused';
	// The server already moved presence. Retire the source BEFORE awaiting any
	// HTTP/admission/codec work. Old catches cannot erase a later visit here.
	cancelVoiceJoin(socket, fromChannelId);
	pendingVoiceJoins.delete(fromChannelId);
	voiceSocketOwners.delete(fromChannelId);
	retireChannelMedia(fromChannelId, true);
	cancelVoiceJoin(socket, toChannelId);
	pendingVoiceJoins.delete(toChannelId);
	if (destination) retireChannelMedia(toChannelId);
	if (isPrimary) {
		activeVoiceChannelId = toChannelId;
		activeVoiceChannel.set({ id: toChannelId, name: resolveVoiceChannelDisplayName(toChannelId) });
	}
	listeningVoiceChannels.update(ids => [...new Set([...ids.filter(id => id !== fromChannelId), toChannelId])]);
	// Moving intent is visible but NOT a connected/successful transport.
	const session = callSessionManager.register({ id: toChannelId, channelId: toChannelId,
		kind: 'channel', name: resolveVoiceChannelDisplayName(toChannelId),
		direction: controls?.direction ?? (isPrimary ? 'transmit' : 'listen'), volume: controls?.volume });
	if (controls) callSessionManager.setSessionMuted(toChannelId, controls.muted);
	if (transferFocus) callSessionManager.setFocus(toChannelId);
	callSessionManager.unregister(fromChannelId);
	detachSessionAudioChain(fromChannelId);
	callSessionManager.markReconnecting(toChannelId);
	voiceSocketOwners.set(toChannelId, socket);
	isInCall.set(true);
	if (!get(activeCallSessionId)) callMode.set('channel');
	const transfer: VoiceRecovery = { socket, joinedAt: session.joinedAt,
		realm: groupMembership.realm(), controller: new AbortController(), suspended: true };
	voiceRecoveries.set(toChannelId, transfer);
	await readmitVoiceSession(socket, toChannelId, transfer);
	// A newer move/disconnect may have replaced this operation while it waited.
	if (voiceSocketOwners.get(toChannelId) !== socket || callSessionManager.get(toChannelId)?.joinedAt !== session.joinedAt) return;
	pushVoiceChannelNotice(`Moved to ${resolveVoiceChannelDisplayName(toChannelId)}`);
	playCallActionSound('join', sessionSoundOptionsFor(toChannelId));
	syncSpatialAudioGraph();
}

export async function handleForcedVoiceLeave(socket: Socket, channelId: string): Promise<void> {
	if (!socket || !channelId) return;
	if (groupCallRun?.channelId === channelId && groupCallRun.socket === socket) { revokeGroupCall(channelId); return; }
	if (voiceSocketOwners.get(channelId) !== socket && pendingVoiceJoins.get(channelId)?.socket !== socket) return;
	await leaveVoiceChannel(socket, channelId, { notifyServer: false, notice: 'You were removed from the voice channel' });
}

export async function startCall(
	socket: Socket,
	targetUserId: string,
	isVideoCall: boolean = false,
	options: { scope?: ExperimentalWabidbCallScope; displayName?: string } = {}
) {
	if (groupCallRun || get(activeCallSessionId) || get(outgoingCall) || get(incomingCall)) {
		throw new Error('A call is already active or ringing');
	}
	try {
		if (!socket.connected) {
			callOfflineNotice.set(`No connection to server. Calls require an active connection to the ${brandName} server.`);
			throw new Error(`No connection to server. Calls require an active connection to the ${brandName} server.`);
		}

		await prefetchTurnCredentials().catch((err) => {
			console.warn('[Calling] TURN prefetch failed, continuing without TURN', err);
		});
		await resolveActiveTransport();
		const stream = await ensureLocalAudioStream();
		if (isVideoCall && !stream.getVideoTracks()[0]) {
			const cameraStream = await requestCameraStream();
			const cameraTrack = cameraStream.getVideoTracks()[0];
			if (cameraTrack) {
				stream.addTrack(cameraTrack);
			}
		}

		callMode.set('direct');
		autoOpenChannelCallPanel();
		// Keep an active primary voice channel as a listen-only backdrop
		// (TeamSpeak style) instead of tearing it down.
		if (!activeVoiceChannelId) {
			activeVoiceChannel.set(null);
		}
		activeGroupCall.set(null);
		activeCallSessionId.set(directCallSessionKey(targetUserId));
		isMuted.set(false);
		isVideoOff.set(!isVideoCall);
		connectionState.set('signaling');
		outgoingCall.set({
			targetUserId,
			username: options.displayName?.trim() || 'User',
			isVideoCall,
			startedAt: Date.now(),
			scope: 'direct'
		});

		const scope = options.scope ?? 'unknown';
		const fallbackToP2P = getStoredCallTransportMode() === 'p2p-only';
		if (!fallbackToP2P) {
			await markExperimentalWabidbCallAttempt({ targetUserId, isVideoCall, scope });
			socket.emit('call-initiate', {
				targetUserId,
				isVideoCall,
				experimental: {
					label: 'experimental-wabidb-call',
					route: 'desktop-wabidb',
					scope
				}
			});
		} else {
			socket.emit('call-initiate', {
				targetUserId,
				isVideoCall
			});
		}

		callOfflineNotice.set(null);
		return stream;
	} catch (error) {
		console.error('Error starting call:', error);
		callOfflineNotice.set('Could not start the call. Check your connection and try again.');
		const leakedStream = get(localStream);
		if (leakedStream && !activeVoiceChannelId) {
			leakedStream.getTracks().forEach(track => track.stop());
			localStream.set(null);
		}
		handleMediaError(error as DOMException, 'starting');
		activeCallSessionId.set(null);
		outgoingCall.set(null);
		if (!activeVoiceChannelId) {
			isInCall.set(false);
		}
		throw error;
	}
}

async function enterEstablishedGroupCall(
	channelId: string,
	channelName: string,
	localDisplayName: string,
	options: { clearOutgoing?: boolean; playJoinSound?: boolean; socket: Socket; run: GroupCallRun }
): Promise<void> {
	checkGroupRun(options.run);
	const stream = get(localStream);
	const alreadyInSameGroupCall = callSessionManager.get(channelId)?.kind === 'group';

	if (!alreadyInSameGroupCall) {
		isInCall.set(true);
		callMode.set('group');
		autoOpenChannelCallPanel();
		// Keep an active primary voice channel as a listen-only backdrop
		// (TeamSpeak style) instead of tearing it down.
		if (!activeVoiceChannelId) {
			activeVoiceChannel.set(null);
		}
		activeGroupCall.set({ id: channelId, name: channelName });
		activeCallSessionId.set(groupCallSessionKey(channelId));
		// Phase 2: group calls are sessions too — a DM/voice-channel backdrop
		// demotes to background while the group call takes focus.
		callSessionManager.register({
			id: channelId,
			channelId,
			kind: 'group',
			name: channelName,
			direction: 'transmit'
		});
		connectionState.set('signaling');
		isMuted.set(false);
		isVideoOff.set(!Boolean(stream?.getVideoTracks()[0]));
		if (stream) {
			startLocalSpeakingMonitor(stream);
			startAudioMonitoring('local', stream, true);
		}
		startPerformanceGuard();
		syncSpatialAudioGraph();
		if (options.playJoinSound !== false) {
			playCallActionSound('join', sessionSoundOptionsFor(channelId));
		}
	}

	if (options.clearOutgoing) {
		outgoingCall.set(null);
	}

	const activeTransport = await resolveActiveTransport(channelId, 'group', () => groupRunCurrent(options.run));
	checkGroupRun(options.run);
	// T2: previously this path logged "will use P2P" on total failure WITHOUT
	// establishing anything. The executor now walks the whole chain and
	// surfaces callOfflineNotice on exhaustion.
	const outcome = await connectWithFallback({
		mode: activeTransport === 'sfu' ? 'sfu-preferred' : getStoredCallTransportMode(),
		surface: 'group' as CallSurface,
		stillWanted: () => groupRunCurrent(options.run),
		expectedParticipants: Math.max(get(groupCallRingingTargets).length + 1, 1),
		connect: async (transport) => {
			if (transport === 'sfu') {
				await connectLivekitSfu(channelId, localDisplayName || `${brandName} User`, options.run.controller.signal);
			} else if (transport === 'wabidb' && options.socket) {
				await connectWabidbCall(options.socket, channelId, localDisplayName || `${brandName} User`);
			} else if (transport === 'p2p') {
				console.warn('[Calling] Group p2p tail reached — mesh audio only');
			}
		}
	});
	checkGroupRun(options.run);
	const effectiveTransport = outcome.active;
	if (effectiveTransport !== 'p2p' || hasConnectedChannelPeer(channelId)) {
		callSessionManager.markConnected(channelId, effectiveTransport);
	}
	if (effectiveTransport === 'wabidb' && !get(isVideoOff) && stream?.getVideoTracks().length) {
		const { wabidbStartVideo } = await import('./callingWabidb');
		checkGroupRun(options.run);
		const camera = new MediaStream(stream.getVideoTracks().map(track => track.clone()));
		const started = await wabidbStartVideo('camera', camera, channelId, () => groupRunCurrent(options.run));
		checkGroupRun(options.run);
		if (!started) pushVoiceChannelNotice('Camera relay unavailable; camera may still connect through P2P');
	}
	if (!alreadyInSameGroupCall) callSessionManager.setFocus(channelId);
}

function removeGroupCallRingingTarget(stableUserId: string): void {
	if (!stableUserId) return;
	groupCallRingingTargets.update((targets) => targets.filter((target) => target.stableUserId !== stableUserId));
}

function maybeDismissEmptyPendingGroupCall(): void {
	if (get(isInCall)) return;
	if (get(callMode) !== 'group') return;
	if (get(groupCallRingingTargets).length > 0) return;
	const id = groupCallRun?.channelId ?? get(activeGroupCall)?.id;
	if (id) revokeGroupCall(id);
}

export function startGroupCall(
	socket: Socket, channelId: string, channelName: string, isVideoCall = false,
	options: { localDisplayName?: string; invitees?: GroupCallRingingTarget[] } = {}
): Promise<MediaStream> {
	return beginGroupCall(socket, channelId, channelName, isVideoCall, options);
}

function beginGroupCall(
	socket: Socket, channelId: string, channelName: string, isVideoCall: boolean,
	options: { localDisplayName?: string; invitees?: GroupCallRingingTarget[] }, callerId?: string
): Promise<MediaStream> {
	if (groupCallRun?.channelId === channelId && groupCallRun.socket === socket) return groupCallRun.operation;
	// Guards are outside the attempt's catch: rejecting a second click must
	// never clean up the call that already owns the microphone.
	if (!socket.connected) return Promise.reject(new Error('Calls require an active server connection'));
	if (!groupMembership.ready() || groupMembership.revision(channelId) === null) {
		return Promise.reject(new Error('Reconnect to refresh group membership before joining a call'));
	}
	if (groupCallRun || get(activeCallSessionId) || get(outgoingCall) ||
		(get(incomingCall) && (!callerId || get(incomingCall)?.channelId !== channelId))) {
		return Promise.reject(new Error('A call is already active or ringing'));
	}
	let access: () => boolean;
	try { access = captureGroupAccess(channelId); }
	catch (error) { return Promise.reject(error); }
	if (!access()) return Promise.reject(new Error('Group call access is no longer available'));
	let prepared!: () => void;
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((resolve, reject) => { prepared = resolve; rejectReady = reject; });
	void ready.catch(() => {}); // no peer may be waiting when capture is cancelled
	const run: GroupCallRun = {
		channelId, socket, socketId: socket.id, access, controller: new AbortController(),
		ready, prepared, rejectReady, established: false, cameraTracks: new Set(),
		operation: null as unknown as Promise<MediaStream>,
		suspended: false, membershipRevision: groupMembership.revision(channelId) ?? '0',
		name: channelName, localName: options.localDisplayName?.trim() || `${brandName} User`,
		disconnected: () => suspendGroupCall(socket)
	};
	groupCallRun = run;
	socket.on('disconnect', run.disconnected);
	const localDisplayName = options.localDisplayName?.trim() || `${brandName} User`;
	// The ringing view owns cancellation even while admission is pending.
	if (!callerId) outgoingCall.set({
		channelId, channelName, username: channelName.trim() || 'Group', isVideoCall,
		startedAt: Date.now(), scope: 'group', localDisplayName
	});
	run.operation = (async () => {
		try {
			let alreadyEstablished = false;
			if (callerId) await requestGroupCallAnswer(socket, channelId, callerId, isVideoCall, ensureChannelMembership, run.controller.signal);
			else alreadyEstablished = await requestGroupCallStart(socket, channelId, isVideoCall, ensureChannelMembership, run.controller.signal);
			checkGroupRun(run);
			await prefetchTurnCredentials().catch(err => console.warn('[Calling] TURN prefetch failed:', err));
			checkGroupRun(run);
			const stream = await ensureLocalAudioStream();
			checkGroupRun(run);
			if (isVideoCall && !stream.getVideoTracks()[0]) {
				const cameraStream = await requestCameraStream();
				if (!groupRunCurrent(run) || !socket.connected || socket.id !== run.socketId) {
					cameraStream.getTracks().forEach(track => track.stop());
					checkGroupRun(run);
				}
				for (const track of cameraStream.getVideoTracks()) { run.cameraTracks.add(track); stream.addTrack(track); }
			}
			checkGroupRun(run);
			callMode.set('group');
			autoOpenChannelCallPanel();
			activeGroupCall.set({ id: channelId, name: channelName });
			activeCallSessionId.set(groupCallSessionKey(channelId));
			groupCallRingingTargets.set(callerId ? [] : options.invitees || []);
			isVideoOff.set(!isVideoCall);
			connectionState.set('signaling');
			run.prepared();
			if (callerId || alreadyEstablished) {
				await establishOwnedGroupCall(run, channelName, localDisplayName, true);
				checkGroupRun(run);
				if (get(incomingCall)?.channelId === channelId) incomingCall.set(null);
			}
			callOfflineNotice.set(null);
			return stream;
		} catch (error) {
			run.rejectReady(error);
			if (groupCallRun === run) {
				// Same-connection cleanup only. Never buffer a leave that could
				// later remove a fresh call after reconnect or re-add.
				if (socket.connected && socket.id === run.socketId && run.access()) socket.emit('group-call-leave', { channelId });
				revokeGroupCall(channelId);
				if (!(error instanceof DOMException && error.name === 'AbortError')) {
					callOfflineNotice.set(error instanceof Error ? error.message : 'Could not join the group call');
					handleMediaError(error as DOMException, callerId ? 'answering' : 'starting');
				}
			}
			throw error;
		}
	})();
	return run.operation;
}

function establishOwnedGroupCall(run: GroupCallRun, name: string, localName: string, clearOutgoing: boolean): Promise<void> {
	checkGroupRun(run);
	return run.entering ??= enterEstablishedGroupCall(run.channelId, name, localName,
		{ clearOutgoing, playJoinSound: true, socket: run.socket, run }).then(() => {
			checkGroupRun(run);
			run.established = true;
		}).catch(error => {
			if (groupCallRun === run) {
				if (run.socket.connected && run.socket.id === run.socketId && run.access()) run.socket.emit('group-call-leave', { channelId: run.channelId });
				revokeGroupCall(run.channelId);
			}
			throw error;
		});
}

export function beginEstablishedDirectCall(): boolean {
	const pending = get(outgoingCall);
	if (!pending || pending.scope === 'group') {
		return false;
	}

	const stream = get(localStream);
	isInCall.set(true);
	callMode.set('direct');
	autoOpenChannelCallPanel();
	// Keep an active primary voice channel as a listen-only backdrop
	// (TeamSpeak style) instead of tearing it down.
	if (!activeVoiceChannelId) {
		activeVoiceChannel.set(null);
	}
	activeGroupCall.set(null);
	activeCallSessionId.set(directCallSessionKey(pending.targetUserId || ''));
	// Phase 2: the DM call is a session; any voice-channel backdrop demotes
	// to background while the direct call takes focus.
	callSessionManager.register({
		id: directCallSessionKey(pending.targetUserId || ''),
		channelId: null,
		kind: 'direct',
		name: pending.username || pending.targetUserId || 'Direct call',
		direction: 'transmit'
	});
	connectionState.set('signaling');
	outgoingCall.set(null);
	if (stream) {
		startLocalSpeakingMonitor(stream);
		startAudioMonitoring('local', stream, true);
	}
	startPerformanceGuard();
	syncSpatialAudioGraph();
	callSessionManager.markConnected(directCallSessionKey(pending.targetUserId || ''), wabidbTransportLive() ? 'wabidb' : 'p2p');
	callSessionManager.setFocus(directCallSessionKey(pending.targetUserId || ''));
	playCallActionSound('join', sessionSoundOptionsFor(directCallSessionKey(pending.targetUserId || '')));
	return true;
}

export async function answerCall(
	socket: Socket,
	callerId: string,
	isVideoCall: boolean = false,
	options: { channelId?: string; channelName?: string; localDisplayName?: string } = {}
) {
	if (options.channelId) return beginGroupCall(socket, options.channelId,
		options.channelName || options.channelId, isVideoCall, options, callerId);
	if (groupCallRun) throw new Error('A group call is already active or ringing');
	try {
		await prefetchTurnCredentials().catch((err) => {
			console.warn('[Calling] TURN prefetch failed, continuing without TURN', err);
		});
		const stream = await ensureLocalAudioStream();
		if (isVideoCall && !stream.getVideoTracks()[0]) {
			const cameraStream = await requestCameraStream();
			const cameraTrack = cameraStream.getVideoTracks()[0];
			if (cameraTrack) {
				stream.addTrack(cameraTrack);
			}
		}

		{
			const activeTransport = await resolveActiveTransport();
			isInCall.set(true);
			callMode.set('direct');
			autoOpenChannelCallPanel();
			// Keep an active primary voice channel as a listen-only backdrop
			// (TeamSpeak style) instead of tearing it down.
			if (!activeVoiceChannelId) {
				activeVoiceChannel.set(null);
			}
			activeGroupCall.set(null);
			activeCallSessionId.set(directCallSessionKey(callerId));
			// Phase 2: DM answer registers the session and takes focus.
			callSessionManager.register({
				id: directCallSessionKey(callerId),
				channelId: null,
				kind: 'direct',
				name: callerId,
				direction: 'transmit'
			});
			connectionState.set('signaling');
			isMuted.set(false);
			isVideoOff.set(!isVideoCall);
			startLocalSpeakingMonitor(stream);
			startPerformanceGuard();
			syncSpatialAudioGraph();
			playCallActionSound('join', sessionSoundOptionsFor(directCallSessionKey(callerId)));

			// Start monitoring local audio
			startAudioMonitoring('local', stream, true);

			// T2: DM callee joins via the same fallback chain. The caller (in
			// createCallOffer) will have already connected with the shared DM
			// session key when the relay head succeeds.
			await connectWithFallback({
				mode: activeTransport === 'wabidb' ? getStoredCallTransportMode() : (activeTransport === 'sfu' ? 'sfu-preferred' : 'p2p-only'),
				surface: 'direct' as CallSurface,
				expectedParticipants: 2,
				connect: async (transport) => {
					if (transport === 'wabidb') {
						try {
							await connectWabidbCall(
								socket,
								callerId || 'direct-call',
								options.localDisplayName?.trim() || `${brandName} User`,
								undefined,
								callerId,
							);
						} catch (err) {
							await disconnectWabidbCall();
							throw err;
						}
					}
					// 'p2p': the answer path below negotiates the P2P mesh natively;
					// 'sfu': LiveKit DM rooms are not wired — treat as failure and
					// let the chain continue.
					if (transport === 'sfu') throw new Error('LiveKit DM path not wired');
				}
			});
			callSessionManager.markConnected(directCallSessionKey(callerId), wabidbTransportLive() ? 'wabidb' : 'p2p');
			callSessionManager.setFocus(directCallSessionKey(callerId));
		}

		if (!options.channelId) socket.emit('call-answer', {
			callerId,
			isVideoCall,
			channelId: options.channelId
		});

		incomingCall.set(null);

		callOfflineNotice.set(null);
		return stream;
	} catch (error) {
		console.error('Error answering call:', error);
		callOfflineNotice.set('Could not answer the call. Check your connection and try again.');
		handleMediaError(error as DOMException, 'answering');
		activeCallSessionId.set(null);
		groupCallRingingTargets.set([]);
		if (!activeVoiceChannelId) {
			// Release the mic/camera acquired for the failed answer. Nulling the
			// store alone leaves the tracks live — the browser mic indicator
			// stays on and the raw capture session keeps the device open
			// (hot-mic leak, 2026-08-27 round 5).
			const leakedStream = get(localStream);
			leakedStream?.getTracks().forEach(track => track.stop());
			localStream.set(null);
			clearActiveAudioCaptureSession();
			isInCall.set(false);
			activeGroupCall.set(null);
			callMode.set(null);
		} else {
			callMode.set('channel');
		}
		throw error;
	}
}

export function rejectCall(socket: Socket, callerId: string, options: { channelId?: string } = {}) {
	if (options.channelId && groupCallRun?.channelId === options.channelId) {
		socket.emit('group-call-leave', { channelId: options.channelId });
		revokeGroupCall(options.channelId);
	}
	socket.emit('call-reject', { callerId, channelId: options.channelId });
	incomingCall.set(null);
}

export function cancelOutgoingCall(socket: Socket) {
	const pending = get(outgoingCall);
	if (pending) {
		if (pending.scope === 'group' && pending.channelId) {
			socket.emit('call-cancel', { channelId: pending.channelId });
		} else if (pending.targetUserId) {
			socket.emit('call-cancel', { targetUserId: pending.targetUserId });
		}
	}
	endCall(socket);
}

export function handleIncomingCallCancelled(callerId: string, channelId?: string): void {
	if (channelId && groupCallRun?.channelId === channelId && !groupCallRun.established) {
		revokeGroupCall(channelId);
		return;
	}
	// Outgoing DM call that was rejected/cancelled/errored by the callee. The
	// caller holds an outgoingCall (not an incomingCall), so tear the pending
	// call down and release the local media captured at startCall time.
	const pendingOutgoing = get(outgoingCall);
	if (
		pendingOutgoing &&
		pendingOutgoing.scope !== 'group' &&
		pendingOutgoing.targetUserId === callerId
	) {
		teardownCallSessionOnly();
		return;
	}

	const current = get(incomingCall);
	if (!current || current.userId !== callerId) return;
	if (channelId && current.channelId && current.channelId !== channelId) return;
	incomingCall.set(null);
}

export function handleGroupCallInviteCleared(data: { channelId: string; stableUserId: string }): void {
	const activeGroupId = get(activeGroupCall)?.id;
	const pendingChannelId = get(outgoingCall)?.channelId;
	if (data.channelId !== activeGroupId && data.channelId !== pendingChannelId) {
		return;
	}
	removeGroupCallRingingTarget(data.stableUserId);
	maybeDismissEmptyPendingGroupCall();
}

/**
 * Phase 2: per-call sound attribution. Each connected call gets a distinct
 * pitch slot and stereo pan, scaled by that session's own volume — a join in
 * a silenced call is silent; a join in the focused call is unmistakable.
 */
function sessionSoundOptionsFor(channelId?: string): CallSoundOptions | undefined {
	const sessions = callSessionManager.list();
	if (sessions.length === 0) return undefined;
	const session = channelId ? sessions.find((s) => s.id === channelId || s.channelId === channelId) : undefined;
	const target = session ?? sessions.find((s) => s.focus === 'focused') ?? sessions[0];
	const index = sessions.indexOf(target);
	const pan = sessions.length > 1 ? Math.max(-1, Math.min(1, (index / Math.max(1, sessions.length - 1)) * 1.6 - 0.8)) : undefined;
	return {
		sessionIndex: index,
		volumeScale: target.volume / 100,
		pan
	};
}

export function handleVoiceParticipantJoined(userId: string, username: string, channelId?: string): void {
	rememberVoiceParticipantLabel(userId, username);
	const connectedToChannel = !channelId || get(listeningVoiceChannels).includes(channelId);
	if (connectedToChannel) {
		playCallActionSound('join', sessionSoundOptionsFor(channelId));
		if (channelId) {
			callSessionManager.upsertParticipant(channelId, { userId, username });
		}
	}
	const label = resolveVoiceParticipantLabel(userId);
	if (label) {
		pushVoiceChannelNotice(`${label} joined voice`);
	}
}

export function handleVoiceParticipantLeft(userId: string, channelId?: string): void {
	const connectedToChannel = !channelId || get(listeningVoiceChannels).includes(channelId);
	if (connectedToChannel) {
		playCallActionSound('leave', sessionSoundOptionsFor(channelId));
		if (channelId) {
			callSessionManager.removeParticipant(channelId, userId);
		}
		// Their relay video/screen envelopes stop with them — tear down the
		// receiver-side decoders/tiles too (server fires this on leave AND on
		// socket disconnect). Scoped to channels we actually listen to so a
		// user leaving one shared channel keeps their tiles in another.
		wabidbStopRemoteVideo(userId, channelId);
	}
	const label = resolveVoiceParticipantLabel(userId);
	if (label) {
		pushVoiceChannelNotice(`${label} left voice`);
	}
	voiceParticipantLabels.delete(userId);
}

export function handleRemoteDirectCallEnded(userId: string): void {
	const isActiveDirectCall =
		get(callMode) === 'direct' &&
		(get(isInCall) || get(activeCalls).some((call) => call.userId === userId) || callParticipants.has(userId));

	// Their REC badge dies with the call (server clears on disconnect; this
	// covers an explicit end while their recorder entry lives on).
	removeDirectRecordingParticipant(userId);

	if (!isActiveDirectCall) {
		removeCall(userId);
		removeScreenShare(userId);
		wabidbStopRemoteVideo(userId);
		return;
	}

	playCallActionSound('leave', sessionSoundOptionsFor(directCallSessionKey(userId)));
	teardownCallSessionOnly();
	wabidbStopRemoteVideo(userId);
}

export async function handleGroupCallParticipantJoined(
	socket: Socket,
	data: { channelId: string; channelName?: string; userId: string; username: string; stableUserId?: string }
): Promise<void> {
	const run = groupCallRun;
	if (!run || run.socket !== socket || run.channelId !== data.channelId || !groupRunCurrent(run)) return;
	try { await run.ready; checkGroupRun(run); } catch { return; }
	const pending = get(outgoingCall);
	const localDisplayName = pending?.localDisplayName || `${brandName} User`;
	const isSameActiveGroup = run.established;
	if (data.stableUserId) {
		removeGroupCallRingingTarget(data.stableUserId);
	}

	if (!isSameActiveGroup) {
		await establishOwnedGroupCall(
			run,
			data.channelName || pending?.channelName || pending?.username || data.channelId,
			localDisplayName,
			pending?.channelId === data.channelId
		);
	} else {
		handleVoiceParticipantJoined(data.userId, data.username);
	}

	if (get(sfuMediaActive)) {
		return;
	}

	checkGroupRun(run);
	await createCallOffer(socket, data.userId, data.username, {
		channelId: data.channelId, forceTransport: 'p2p', stillWanted: () => groupRunCurrent(run)
	});
}

export function handleGroupCallParticipantLeft(data: { channelId: string; userId: string }): void {
	if (get(activeGroupCall)?.id !== data.channelId) {
		return;
	}
	wabidbStopRemoteVideo(data.userId, data.channelId);
	callSessionManager.removeParticipant(data.channelId, data.userId);
	for (const [key, state] of peerConnections) {
		if (state.targetId === data.userId && state.channelId === data.channelId) cleanupPeerConnection(key);
	}
}

export function stopGroupCallRingingTarget(socket: Socket, stableUserId: string): void {
	const groupId = get(activeGroupCall)?.id || get(outgoingCall)?.channelId;
	if (!groupId || !stableUserId) return;
	removeGroupCallRingingTarget(stableUserId);
	socket.emit('group-call-stop-ringing', {
		channelId: groupId,
		targetUserId: stableUserId
	});
	maybeDismissEmptyPendingGroupCall();
}

export function endCall(socket: Socket) {
	const groupId = groupCallRun?.channelId ?? get(activeGroupCall)?.id;
	if (groupId) {
		if (socket.connected) socket.emit('group-call-leave', { channelId: groupId });
		revokeGroupCall(groupId);
		playCallActionSound('leave');
		return;
	}
	playCallActionSound('leave');
	const endingMode = get(callMode);
	const endingVoiceChannelId = activeVoiceChannelId;
	const endingListeningChannels = get(listeningVoiceChannels);
	const endingGroupCall = get(activeGroupCall);
	const endingCallSessionId = get(activeCallSessionId);
	const participantIds = new Set<string>(callParticipants);

	peerConnections.forEach((state) => {
		if (state.type === 'call') {
			participantIds.add(state.targetId);
		}
	});

	// If this is a channel voice call, explicitly leave/unsubscribe server-side.
	if (endingMode === 'channel') {
		if (endingVoiceChannelId) {
			socket.emit('voice-channel-leave', { channelId: endingVoiceChannelId });
		}
		for (const channelId of endingListeningChannels) {
			socket.emit('voice-channel-unsubscribe', { channelId });
		}
	} else if (endingMode === 'group' && endingGroupCall?.id && get(isInCall)) {
		socket.emit('group-call-leave', { channelId: endingGroupCall.id });
		// Leaving the group call on a channel must also leave that channel
		// server-side (primary or listen-only). Otherwise the roster chip stays
		// stuck for every other client, with no UI affordance left to remove it.
		if (endingVoiceChannelId === endingGroupCall.id || endingListeningChannels.includes(endingGroupCall.id)) {
			socket.emit('voice-channel-leave', { channelId: endingGroupCall.id });
			socket.emit('voice-channel-unsubscribe', { channelId: endingGroupCall.id });
		}
	}

	// Only notify the server when a peer-targeted call session exists.
	// This avoids broadcasting a fake "call ended" event when an outgoing
	// call never connected or was rejected before peer negotiation started.
	if ((endingMode === 'channel' || participantIds.size > 0) && endingMode !== 'group') {
		socket.emit('call-end', {
			participants: Array.from(participantIds)
		});
	}

	// Multi-call: ending a DM/group call keeps a distinct primary voice channel
	// alive as a listen-only backdrop (TeamSpeak style). If the call's channel
	// IS the voice channel (e.g. a group call on a voice channel), tear down
	// everything as before.
	const groupCallChannelId = endingMode === 'group' ? endingGroupCall?.id : null;
	const voiceChannelIsSameAsCall = endingVoiceChannelId != null && endingVoiceChannelId === groupCallChannelId;
	if (endingCallSessionId && endingVoiceChannelId && !voiceChannelIsSameAsCall) {
		teardownCallSessionOnly();
		return;
	}

	finalizeLocalCallEndState();
}

// ============================================================================
// Audio/Video Controls
// ============================================================================

export function toggleMute() {
	const nextMuted = !get(isMuted);
	isMuted.set(nextMuted);
	if (nextMuted) {
		isLocalSpeaking.set(false);
	}
	emitVoiceSelfState();
	void syncLocalAudioState();
	playCallActionSound(nextMuted ? 'mute' : 'unmute');
}

export async function applyCurrentAudioProcessingToLocalTrack(): Promise<void> {
	try { await replaceLocalAudioProcessing(); }
	catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') return;
		const current = getActiveAudioCaptureSession();
		if (current) audioProcessingRuntimeStatus.update(status => ({ ...status, effective: current.mode }));
		console.error('[Calling] Microphone replacement failed:', error);
		pushVoiceChannelNotice('Could not change microphone processing — current input retained');
	}
}

async function replaceLocalAudioProcessing(): Promise<void> {
	const stream = get(localStream);
	if (!stream) return;
	const existingAudioTrack = stream.getAudioTracks()[0];
	if (!existingAudioTrack || existingAudioTrack.readyState !== 'live') return;

	const nextSession = await prepareActiveAudioCaptureSession(session => {
		if (get(localStream) !== stream) throw new DOMException('Call ended during microphone replacement', 'AbortError');
		stream.addTrack(session.outputTrack);
		stream.removeTrack(existingAudioTrack);
		applyLocalTrackPreferences(stream);
		startLocalSpeakingMonitor(stream);
	}, true);
	// A leave/new replacement can run before this continuation resumes.
	if (getActiveAudioCaptureSession() !== nextSession || get(localStream) !== stream) return;
	existingAudioTrack.stop();

	const tasks: Promise<unknown>[] = [];
	tasks.push(syncWabidbCapture(shouldSendAudioToChannel));
	peerConnections.forEach((state) => {
		if (state.type !== 'call') return;
		const sender = state.pc.getSenders().find(s => s.track?.kind === 'audio');
		if (!sender) return;
		tasks.push(replacePeerMicrophone(sender, nextSession.outputTrack));
		tasks.push(optimizeSender(sender, state.pc, 'audio'));
	});
	const results = await Promise.allSettled(tasks);
	if (results.some(result => result.status === 'rejected')) {
		console.warn('[WebRTC] Audio mode switched locally, but one or more peer senders failed to update.');
		pushVoiceChannelNotice('Microphone changed locally, but some peer connections could not update');
	}
	void syncLocalAudioState();
}

export function toggleDeafen(socket?: Socket) {
	const currentlyDeafened = get(isDeafened);
	const newDeafened = !currentlyDeafened;
	isDeafened.set(newDeafened);
	playCallActionSound(currentlyDeafened ? 'undeafen' : 'deafen');

	if (!currentlyDeafened) {
		// Becoming deafened - also mute self
		isMuted.set(true);
		isLocalSpeaking.set(false);
	}
	// Sync deafen state to server so it persists across reconnects
	if (socket && activeVoiceChannelId) {
		socket.emit(newDeafened ? 'voice-deafen' : 'voice-undeafen', { channelId: activeVoiceChannelId });
	}
	emitVoiceSelfState();
	// Note: Actual deafen (muting remote audio) is handled in the UI component
	// by setting audio elements to muted based on isDeafened store
	void syncLocalAudioState();
	syncSpatialAudioGraph();
}

/**
 * Client-authority self mute/deafen mirror. Emits `voice-self-state` so the
 * server roster (every shared channel this socket occupies) reflects our chip
 * state for other members' tiles. Best-effort: no socket / not connected is a
 * silent no-op.
 */
function emitVoiceSelfState(): void {
	try {
		const sock = getSocket?.() ?? null;
		if (!sock) return;
		sock.emit('voice-self-state', {
			muted: get(isMuted),
			deafened: get(isDeafened)
		});
	} catch {
		/* best-effort only */
	}
}

let cameraToggle: { scope: CallMediaScope; promise: Promise<void> } | null = null;
export function toggleVideo(socket?: Socket): Promise<void> {
	if (cameraToggle?.scope.current()) return cameraToggle.promise;
	const scope = captureCallMediaScope();
	if (!scope?.current()) return Promise.resolve();
	const groupOwner = groupCallRun;
	const stream = get(localStream);
	const matchesPeer = (state: PeerConnectionState) => state.type === 'call' &&
		(scope.channelId ? state.channelId === scope.channelId : state.targetId === scope.peerUserId && !state.channelId);
	const promise = (async () => {
		let captured: MediaStream | null = null;
		try {
			const room = getLivekitRoom();
			if (room && get(sfuMediaActive) && getLivekitChannelId() === scope.channelId) {
				const off = !get(isVideoOff);
				await room.localParticipant.setCameraEnabled(!off);
				if (scope.current() && getLivekitRoom() === room) isVideoOff.set(off);
				return;
			}
			if (!stream) return;
			const { wabidbStartVideo, wabidbStopVideoSource, wabidbVideoTransportLive } = await import('./callingWabidb');
			if (!scope.current() || get(localStream) !== stream) return;
			const destination = scope.channelId ?? scope.peerUserId;
			if (!get(isVideoOff)) {
				wabidbStopVideoSource('camera', destination);
				for (const track of stream.getVideoTracks()) { stream.removeTrack(track); track.stop(); }
				await Promise.all([...peerConnections.values()].filter(matchesPeer).map(async state => {
					const sender = state.pc.getSenders().find(sender => sender.track?.kind === 'video');
					if (sender) await sender.replaceTrack(null);
				}));
				if (scope.current()) isVideoOff.set(true);
				return;
			}
			captured = await requestCameraStream();
			if (!scope.current() || get(localStream) !== stream) {
				captured.getTracks().forEach(track => track.stop()); return;
			}
			const camera = captured.getVideoTracks()[0];
			if (!camera) throw new Error('Camera did not produce a video track');
			stream.addTrack(camera);
			if (groupOwner && groupCallRun === groupOwner) groupOwner.cameraTracks.add(camera);
			if (wabidbVideoTransportLive(destination)) {
				const relayStream = new MediaStream([camera.clone()]);
				if (!await wabidbStartVideo('camera', relayStream, destination, scope.current)) throw new Error('Camera relay could not start');
			} else {
				await Promise.all([...peerConnections.values()].filter(matchesPeer).map(async state => {
					if (!scope.current()) return;
					const sender = state.pc.getSenders().find(sender => sender.track?.kind === 'video');
					if (sender) await sender.replaceTrack(camera);
					else await addTrackWithOptimizations(state.pc, camera, stream);
					if (socket && scope.current()) await renegotiateCallConnection(state, socket);
				}));
			}
			if (scope.current()) isVideoOff.set(false);
			else { stream.removeTrack(camera); camera.stop(); }
		} catch (error) {
			if (captured) for (const track of captured.getTracks()) { stream?.removeTrack(track); track.stop(); }
			if (scope.current()) {
				console.error('[Calling] Camera toggle failed:', error);
				handleMediaError(error as DOMException, 'starting');
			}
		}
	})();
	cameraToggle = { scope, promise };
	void promise.finally(() => { if (cameraToggle?.promise === promise) cameraToggle = null; });
	return promise;
}

// ============================================================================
// WebRTC Signaling Handlers (called from socket.ts)
// ============================================================================

export async function createCallOffer(
	socket: Socket,
	targetId: string,
	username: string = '',
	options?: { channelId?: string; forceTransport?: 'p2p'; stillWanted?: () => boolean }
) {
	const access = options?.channelId ? captureGroupAccess(options.channelId) : () => true;
	const socketId = socket.id;
	const wanted = () => access() && socket.connected && socket.id === socketId && (!options?.stillWanted || options.stillWanted());
	const check = () => { if (!wanted()) throw new DOMException('Call offer cancelled', 'AbortError'); };
	check();
	// Check if wabidb relay is the active transport — if so, skip P2P/WebRTC
	// offer creation entirely and connect the wabidb media relay with the
	// peer's stable user ID for a deterministic shared session.
	// forceTransport is the watchdog/swap escape hatch: the p2p rebuild MUST
	// produce WebRTC offers even while the stored mode still routes to wabidb
	// (previously the early-return reconnected the dying relay instead).
	const activeTransport = options?.forceTransport ?? (await resolveActiveTransport(options?.channelId));
	check();
	if (activeTransport === 'wabidb') {
		// Channel/group relays are owned by admission, not by a peer offer.
		// Using targetId here creates a second, unrelated DM relay.
		if (options?.channelId) return;
		try {
			await connectWabidbCall(
				socket,
				targetId || 'direct-call',
				username || `${brandName} User`,
				undefined,
				targetId,
			);
			console.log('[Wabidb] Direct call using wabiDB relay for target:', targetId);
			return;
		} catch (err) {
			console.warn('[Calling] wabiDB direct relay failed, falling back to P2P:', err);
			check();
			await disconnectWabidbChannel(targetId || 'direct-call');
		}
	}

	await prefetchTurnCredentials().catch((err) => {
		console.warn('[Calling] TURN prefetch failed, continuing without TURN', err);
	});
	check();
	// Re-check after TURN prefetch: another channel preparation may have
	// acquired this peer while we awaited credentials.
	const currentPeer = peerConnections.get(getConnectionKey(targetId, 'call'));
	if (currentPeer && currentPeer.channelId !== options?.channelId && currentPeer.pc.connectionState !== 'closed') {
		throw new Error('P2P peer belongs to another call');
	}
	const pc = createPeerConnection(targetId, username, 'call', socket, { channelId: options?.channelId });
	const key = getConnectionKey(targetId, 'call');
	const state = peerConnections.get(key);
	if (state && options?.channelId) {
		state.channelId = options.channelId;
	}

	try {
		const stream = get(localStream);
		if (stream) {
			for (const track of stream.getTracks()) {
				check();
				if (track.kind === 'video' && !cameraBelongsToPeer(options?.channelId, targetId)) continue;
				await addTrackWithOptimizations(pc, track, stream);
			}
		}
		await setPeerAudioSendEnabled(pc, shouldSendAudioToChannel(options?.channelId));

		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		if (peerConnections.get(key)?.pc !== pc || !wanted()) {
			throw new DOMException('P2P offer superseded or call ended', 'AbortError');
		}

		socket.emit('call-offer', {
			offer,
			targetId,
			channelId: options?.channelId
		});
	} catch (err) {
		console.error('[WebRTC] Failed to create call offer:', err);
		if (peerConnections.get(key)?.pc === pc) cleanupPeerConnection(key);
		throw err;
	}
	return pc;
}

export async function handleCallOffer(
	socket: Socket,
	senderId: string,
	username: string,
	offer: RTCSessionDescriptionInit,
	channelId?: string
) {
	const access = channelId ? captureGroupAccess(channelId) : () => true;
	const run = channelId && groupMembership.tracks(channelId) ? groupCallRun : null;
	if (channelId && groupMembership.tracks(channelId)) {
		if (!run || run.channelId !== channelId || !groupRunCurrent(run)) return;
		try { await run.ready; } catch { return; }
	}
	const socketId = socket.id;
	const wanted = () => access() && socket.connected && socket.id === socketId && (!run || groupRunCurrent(run));
	if (!wanted()) return;
	await prefetchTurnCredentials().catch((err) => {
		console.warn('[Calling] TURN prefetch failed, continuing without TURN', err);
	});
	if (!wanted()) return;
	const existing = peerConnections.get(getConnectionKey(senderId, 'call'));
	if (existing && existing.channelId !== channelId && existing.pc.connectionState !== 'closed') return;
	const pc = createPeerConnection(senderId, username, 'call', socket, { channelId });
	const key = getConnectionKey(senderId, 'call');
	const offerState = peerConnections.get(key);
	if (offerState && channelId) {
		offerState.channelId = channelId;
	}

	try {
	const stream = get(localStream);
	if (stream) {
		for (const track of stream.getTracks()) {
			if (!wanted()) throw new DOMException('Call answer cancelled', 'AbortError');
			if (track.kind === 'video' && !cameraBelongsToPeer(channelId, senderId)) continue;
			await addTrackWithOptimizations(pc, track, stream);
		}
	}
	await setPeerAudioSendEnabled(pc, shouldSendAudioToChannel(channelId));

		await pc.setRemoteDescription(offer);

		// Mark remote description as set and flush queue
		if (!wanted() || peerConnections.get(key) !== offerState) throw new DOMException('Call answer superseded', 'AbortError');
		if (offerState) {
			offerState.hasRemoteDescription = true;
			await flushIceCandidateQueue(key);
		}

		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);
		if (peerConnections.get(key)?.pc !== pc || !wanted()) throw new DOMException('Call answer superseded', 'AbortError');

		socket.emit('call-answer-sdp', {
			answer,
			targetId: senderId,
			channelId
		});
	} catch (err) {
		console.error('[WebRTC] Failed to handle call offer:', err);
		if (peerConnections.get(key)?.pc === pc) cleanupPeerConnection(key);
	}
}

export async function handleCallAnswer(senderId: string, answer: RTCSessionDescriptionInit, channelId?: string) {
	const key = getConnectionKey(senderId, 'call');
	const state = peerConnections.get(key);
	const scope = captureIncomingMediaScope(channelId, senderId);
	if (!state || state.channelId !== channelId || !scope?.current()) {
		console.warn(`[WebRTC] No peer connection for call answer from ${senderId}`);
		return;
	}

	try {
		await state.pc.setRemoteDescription(answer);
		if (peerConnections.get(key) !== state || !scope.current()) return;
		state.hasRemoteDescription = true;
		await flushIceCandidateQueue(key);
	} catch (err) {
		console.error(`[WebRTC] Failed to set remote description:`, err);
	}
}

export async function handleCallIceCandidate(senderId: string, candidate: RTCIceCandidateInit, channelId?: string) {
	const key = getConnectionKey(senderId, 'call');
	const scope = captureIncomingMediaScope(channelId, senderId);
	if (scope?.current()) queuePendingIceCandidate(peerConnections, key, candidate,
		state => scope.current() && state.channelId === channelId);
}

// ============================================================================
// Cleanup Functions
// ============================================================================

export function removeCall(userId: string) {
	cleanupPeerConnection(getConnectionKey(userId, 'call'));
}

export function removeScreenShare(userId: string, channelId?: string, requestId?: string) {
	const key = getConnectionKey(userId, 'screen');
	const state = peerConnections.get(key);
	if (state && (channelId === undefined || state.channelId === channelId) &&
		(requestId === undefined || state.mediaRequestId === requestId)) cleanupPeerConnection(key);
}

export function cleanupAllConnections() {
	if (groupCallRun) revokeGroupCall(groupCallRun.channelId);
	// Stop all local media
	const stream = get(localStream);
	if (stream) {
		stream.getTracks().forEach(track => track.stop());
		localStream.set(null);
	}
	clearActiveAudioCaptureSession();

	const screenStream = get(localScreenStream);
	if (screenStream) {
		screenStream.getTracks().forEach(track => track.stop());
		localScreenStream.set(null);
	}

	// Close all peer connections
	peerConnections.forEach((state) => {
		releasePeerMicrophones(state.pc);
		releasePeerAudioReceivers(state.pc);
		try {
			state.pc.close();
		} catch (e) {
			// Ignore
		}
	});

	peerConnections.clear();
	for (const timerId of remoteVideoMuteDebounceTimers.values()) {
		clearTimeout(timerId);
	}
	remoteVideoMuteDebounceTimers.clear();
	callParticipants.clear();
	voiceParticipantLabels.clear();
	activeVoiceChannelId = null;
	listeningVoiceChannels.set([]);
	stopAllRemoteSpeakingMonitors();
	stopLocalSpeakingMonitor();
	stopPerformanceGuard();
	clearAudioPerformanceFallbackOverride();
	disposeSpatialAudioEngine();
	spatialFallbackNoticeShown = false;

	// Reset all stores
	activeCalls.set([]);
	screenShares.set([]);
	incomingCall.set(null);
	outgoingCall.set(null);
	groupCallRingingTargets.set([]);
	isInCall.set(false);
	isSharing.set(false);
	isMuted.set(false);
	isDeafened.set(false);
	isVideoOff.set(false);
	isLocalSpeaking.set(false);
	channelCallPanelOpen.set(false);
	activeVoiceChannel.set(null);
	activeGroupCall.set(null);
	activeCallSessionId.set(null);
	callMode.set(null);
	connectionState.set('idle');
	spatialAudioRuntimeStatus.update((state) => ({
		...state,
		active: false,
		effectiveMode: 'off',
		fallbackReason: null
	}));
	void disconnectLivekitSfu();
}

export function openChannelCallPanel(): void {
	channelCallPanelOpen.set(true);
}

/**
 * Remote screen-share presentation (2026-08-27 report: "no confirmation at
 * all to the user"). Called from the `screen-share-started` socket handler
 * for every AUDIENCE member: visible notice + auto-open of the embedded call
 * panel (honoring an explicit user dismissal for this call). The sharer also
 * receives the event (server emits to sender + audience) — filtered here.
 */
export function presentRemoteScreenShare(sharerStableId: string, username?: string): void {
	const selfDbId = getStoredDbUserId();
	const selfStableId = selfDbId != null ? `user-${selfDbId}` : getStoredUsername() || null;
	if (sharerStableId === selfStableId) return;
	const label = username || sharerStableId.replace(/^user-/, '');
	pushVoiceChannelNotice(`${label} started sharing their screen`);
	if (!callPanelDismissedByUser) {
		channelCallPanelOpen.set(true);
	}
}

// Auto-spawn contract (decision 2026-08-26): joining any call auto-opens the
// embedded call panel and leaving auto-dissolves it. An explicit user
// minimize/dismiss keeps it closed for the remainder of THAT call; every new
// join resets the dismissal. Teardown paths keep using plain set(false) —
// only user intent goes through dismissChannelCallPanel.
let callPanelDismissedByUser = false;

export function dismissChannelCallPanel(): void {
	callPanelDismissedByUser = true;
	channelCallPanelOpen.set(false);
}

function autoOpenChannelCallPanel(): void {
	// 2026-08-27: channel joins must NOT force a call surface over the chat
	// (Discord model — the roster lands in the sidebar, the Calls panel peeks).
	// channelCallPanelOpen drove the old translucent CallModal spawn; the
	// explicit panel toggle (openChannelCallPanel from the sidebar/panel
	// buttons) still sets it.
	callPanelDismissedByUser = false;
	summonCallsStubOnJoin();
}

/**
 * Summon the Calls right-panel stub when a call joins (2026-08-27 request):
 * the stub is ADDED to the edge strip if missing (persistent, discoverable)
 * and the panel PEEKS when nothing is pinned — visible confirmation without
 * stealing chat width. A pinned panel is left alone (user intent wins).
 */
function summonCallsStubOnJoin(): void {
	try {
		addStub('calls');
		if (get(rightPanelMode) === 'none') {
			peekPanel('calls');
		}
	} catch {
		/* layout stores unavailable (SSR / early boot) — never block a join */
	}
}

/**
 * Re-establish ONE channel call over p2p mesh offers. Used by the transport
 * swap AND by the watchdog's demote path (callingWabidb arms the watchdog
 * with wabidb as the active transport; before this helper its p2p branch
 * just threw "watchdog cannot re-establish p2p from here", so a dead relay
 * = dead call — the wabi.chat wss outage, 2026-08-27).
 *
 * 2026-09-03 fix: offers are now created with forceTransport: 'p2p'. Without
 * it createCallOffer consulted resolveActiveTransport() — still 'wabidb'
 * under mode 'auto' — and quietly reconnected the relay the watchdog had just
 * declared dead, then stamped the session 'p2p' anyway. markConnected now
 * only fires when a real offer went out, and the old "no peers answered the
 * offer path yet" warning (which actually meant "zero offers created") is
 * split into its two real cases: empty roster vs offer failure per peer.
 */
function hasConnectedChannelPeer(channelId: string): boolean {
	return [...peerConnections.values()].some(state => state.type === 'call' && state.channelId === channelId && state.pc.connectionState === 'connected');
}

export async function reEstablishChannelP2P(
	socket: Socket,
	channelId: string,
	options: { requireAllPeers?: boolean; stillWanted?: () => boolean } = {}
): Promise<void> {
	const initialSession = callSessionManager.get(channelId);
	const stillWanted = () => Boolean(initialSession && callSessionManager.get(channelId)?.joinedAt === initialSession.joinedAt && (options.stillWanted?.() ?? true));
	const assertWanted = () => {
		if (!stillWanted()) throw new DOMException('Call ended during transport preparation', 'AbortError');
	};
	assertWanted();
	let roster = get(voiceChannelMembers)[channelId] ?? [];
	const selfStable = (() => {
		const dbId = getStoredDbUserId();
		return dbId != null ? `user-${dbId}` : null;
	})();
	let peers = roster.filter((member) => !selfStable || member.userId !== selfStable);
	if (peers.length === 0) {
		// Presence may still be repopulating after a socket.io reconnect
		// (voice-channel-state 0 → 1 → 2 arrives 100-300ms later) — the last
		// field report showed exactly this race, so retry once before giving up.
		await new Promise<void>((resolve) => setTimeout(resolve, 700));
		assertWanted();
		roster = get(voiceChannelMembers)[channelId] ?? [];
		peers = roster.filter((member) => !selfStable || member.userId !== selfStable);
		if (peers.length === 0) {
			console.warn(
				`[Calling] p2p re-establish for ${channelId}: roster has no other members yet — nothing to offer (presence may still be repopulating after a reconnect)`
			);
			return;
		}
	}
	let offers = 0;
	for (const member of peers) {
		assertWanted();
		try {
			const existing = peerConnections.get(getConnectionKey(member.userId, 'call'));
			if (existing && existing.channelId !== channelId && existing.pc.connectionState !== 'closed') {
				throw new Error('Peer already belongs to another call; cannot replace that call during handover');
			}
			const pc = existing?.channelId === channelId && existing.pc.connectionState === 'connected'
				? existing.pc : await createCallOffer(socket, member.userId, member.username ?? '', {
				channelId,
				forceTransport: 'p2p',
				stillWanted
			});
			if (!pc) throw new Error('P2P offer did not create a peer connection');
			try { await waitForPeerConnection(pc); }
			catch (error) {
				// An incoming offer can supersede this PC while negotiation is
				// pending. Judge the current owner, not a deliberately closed PC.
				const replacement = peerConnections.get(getConnectionKey(member.userId, 'call'));
				if (!replacement || replacement.pc === pc || replacement.channelId !== channelId) throw error;
				await waitForPeerConnection(replacement.pc);
			}
			offers++;
		} catch (err) {
			console.warn(`[Calling] p2p re-establish offer failed for ${member.userId}:`, err);
		}
	}
	assertWanted();
	if (offers === 0 || (options.requireAllPeers && offers !== peers.length)) {
		// Every per-peer failure is logged above; the session keeps its current
		// transport state rather than being mislabeled 'p2p' with no mesh.
		throw new Error(`P2P connected to ${offers}/${peers.length} peers`);
	}
	if (options.requireAllPeers) return; // the switch publishes after every channel is ready
	callSessionManager.markConnected(channelId, 'p2p');
	callTransportState.update((state) => ({
		...state,
		activeTransport: 'p2p' as const,
		isFallback: true,
		reason: 'watchdog_p2p_reestablish',
		checkedAt: Date.now()
	}));
}

/**
 * Make-before-break voice-channel handover. P2P must connect every roster
 * peer before relay teardown; relay receive proof is per peer. Failed
 * preparation retains the existing transport and restores the preference.
 * DM/group switching and cross-channel ownership of one P2P peer are not
 * supported by the current peer-key contract.
 */
let transportSwitchInFlight = false;
export async function switchCallTransport(socket: Socket, target: 'wabidb' | 'p2p'): Promise<void> {
	if (transportSwitchInFlight) { pushVoiceChannelNotice('A transport switch is already in progress'); return; }
	transportSwitchInFlight = true;
	try { await performCallTransportSwitch(socket, target); }
	finally { transportSwitchInFlight = false; }
}

async function performCallTransportSwitch(socket: Socket, target: 'wabidb' | 'p2p'): Promise<void> {
	if (!get(isInCall)) {
		pushVoiceChannelNotice('Not in a call — nothing to swap');
		return;
	}
	const current = get(callTransportState).activeTransport;
	if (current === target) {
		pushVoiceChannelNotice(`Already on ${target.toUpperCase()}`);
		return;
	}

	const channelSessions = callSessionManager.list().filter((session) => session.kind === 'channel');
	if (!channelSessions.length) {
		pushVoiceChannelNotice('Manual transport switching is available for voice-channel calls');
		return;
	}
	const rosterCounts = channelSessions.map(
		(session) => (session.channelId ? (get(voiceChannelMembers)[session.channelId]?.length ?? 1) : 1)
	);
	const largestRoster = Math.max(1, ...rosterCounts);
	let cancelled = false;
	const unsubscribe = callSessions.subscribe(sessions => {
		if (channelSessions.some(session => !sessions.has(session.id))) cancelled = true;
	});
	const stillWanted = () => !cancelled && get(isInCall);
	try {

		if (target === 'p2p') {
			// Full-mesh guard (same law as effectiveChain): a big channel over p2p
			// is an outage, not a swap.
			if (largestRoster > MESH_MAX_PARTICIPANTS) {
				pushVoiceChannelNotice(`P2P mesh is capped at ${MESH_MAX_PARTICIPANTS} — this call is too large`);
				return;
			}
			// Preference first, so offer routing agrees with the swap.
			const previousMode = getStoredCallTransportMode();
			const previousState = get(callTransportState);
			const previousPeers = new Map(peerConnections);
			setCallTransportMode('p2p-only');
			// Prepare and verify candidates while the relay remains usable.
			try {
				// Settle every preparation before rollback: Promise.all's early
				// rejection allowed a late channel to overwrite the restored state.
				const results = await Promise.allSettled(channelSessions.map(session => reEstablishChannelP2P(socket, session.channelId ?? session.id, { requireAllPeers: true, stillWanted })));
				const failure = results.find(result => result.status === 'rejected');
				if (failure?.status === 'rejected') throw failure.reason;
				if (!stillWanted()) throw new DOMException('Call ended during transport switch', 'AbortError');
			} catch (error) {
				setCallTransportMode(previousMode);
				for (const [key, peer] of peerConnections) {
					if (peer.type === 'call' && channelSessions.some(session => session.id === peer.channelId) && previousPeers.get(key) !== peer) cleanupPeerConnection(key);
				}
				if (stillWanted()) {
					callTransportState.set(previousState);
					for (const session of channelSessions) {
						if (session.transport && session.lifecycle === 'connected') callSessionManager.markConnected(session.id, session.transport);
						else callSessionManager.markReconnecting(session.id);
					}
				}
				pushVoiceChannelNotice('P2P switch failed — existing relay retained');
				throw error;
			}

			// Count verified channel peers for the user-visible result.
			let offers = 0;
			const selfStable = (() => {
				const dbId = getStoredDbUserId();
				return dbId != null ? `user-${dbId}` : null;
			})();
			for (const session of channelSessions) {
				const channelId = session.channelId ?? session.id;
				const members = get(voiceChannelMembers)[channelId] ?? [];
				for (const member of members) {
					if (selfStable && member.userId === selfStable) continue;
					const peer = peerConnections.get(getConnectionKey(member.userId, 'call'));
					if (peer?.channelId === channelId && peer.pc.connectionState === 'connected') offers++;
				}
			}
			transportWatchdog.stop();
			for (const session of channelSessions) {
				if (!stillWanted()) return;
				await disconnectWabidbChannel(session.channelId ?? session.id);
			}
			if (!stillWanted()) return;
			// Unrelated DM/group relays are not owned by this channel switch.
			callTransportState.update((state) => ({
				...state,
				activeTransport: 'p2p' as const,
				isFallback: false,
				reason: 'user_switch',
				checkedAt: Date.now()
			}));
			for (const session of channelSessions) {
				if (hasConnectedChannelPeer(session.channelId ?? session.id)) callSessionManager.markConnected(session.channelId ?? session.id, 'p2p');
			}
			pushVoiceChannelNotice(
				offers > 0
					? `Switched to P2P (${offers} peer connection${offers === 1 ? '' : 's'})`
					: 'P2P selected — waiting for peers'
			);
		} else {
			// Back to the wabidb-first chain (auto keeps the p2p tail as fallback).
			const previousMode = getStoredCallTransportMode();
			const previousState = get(callTransportState);
			setCallTransportMode('auto');
			// Relay render evidence selects reception per peer; bidirectional
			// P2P connections remain available for outgoing audio and recovery.
			let joined = 0;

			for (const session of channelSessions) {
				const channelId = session.channelId ?? session.id;
				try {
					if (!stillWanted()) return;
					await connectWabidbCall(socket, channelId, `${brandName} User`, undefined, undefined, session.direction === 'listen');
					if (!stillWanted()) return;
					callSessionManager.markConnected(channelId, 'wabidb');
					joined++;
				} catch (err) {
					console.warn(`[Calling] wabidb swap reconnect failed for ${channelId}:`, err);
				}
			}
			if (joined === 0) {
				setCallTransportMode(previousMode);
				if (stillWanted()) callTransportState.set(previousState);
				pushVoiceChannelNotice('Relay switch failed — existing P2P connections retained');
				throw new Error('No channel relay could be established');
			}
			syncWabidbCapture((cid) => shouldSendAudioToChannel(cid));
			callTransportState.update((state) => ({
				...state,
				activeTransport: 'wabidb' as const,
				isFallback: false,
				reason: 'user_switch',
				checkedAt: Date.now()
			}));
			pushVoiceChannelNotice(joined === channelSessions.length
				? 'Relay joined — playback switches as audio arrives; P2P kept as backup'
				: `Relay joined for ${joined}/${channelSessions.length} channels — other calls retained on P2P`);
		}
		syncSpatialAudioGraph();
	} finally { unsubscribe(); }
}

export function closeChannelCallPanel(): void {
	channelCallPanelOpen.set(false);
}

export function toggleChannelCallPanel(): void {
	channelCallPanelOpen.update((open) => !open);
}

/**
 * Toggle the embedded call panel for a SPECIFIC session (2026-09-07 stage
 * targeting). The clicked session's stage renders in the panel WITHOUT
 * becoming the transmit focus — that stays on the focused session (the
 * "Speak here" model). Clicking the already-shown session folds the panel
 * away; clicking a different one retargets in place; a dead id falls back
 * to the focused session at render time (CallModal).
 */
export function toggleChannelCallPanelFor(sessionId?: string): void {
	const open = get(channelCallPanelOpen);
	if (open) {
		const target = get(channelCallPanelSessionId);
		const showing = target && callSessionManager.get(target) ? target : get(focusedCallSessionId);
		// Clicked the call the panel already shows → fold it away.
		if (!sessionId || sessionId === showing) {
			channelCallPanelOpen.set(false);
			return;
		}
	}
	channelCallPanelSessionId.set(sessionId ?? null);
	channelCallPanelOpen.set(true);
}

export function setVoiceTransmitRoutingMode(mode: 'primary' | 'all-listening'): void {
	voiceTransmitMode.set(mode);
	void syncLocalAudioState();
}

export function refreshLocalAudioMuteState(): void {
	void syncLocalAudioState();
}

export async function addVoiceChannelListen(socket: Socket, channelId: string): Promise<void> {
	if (!channelId) return;
	await requestVoiceAdmission(socket, channelId, true, ensureChannelMembership);
	listeningVoiceChannels.update((channels) => (
		channels.includes(channelId) ? channels : [...channels, channelId]
	));
}

export function removeVoiceChannelListen(socket: Socket, channelId: string): void {
	if (!channelId) return;
	cancelVoiceJoin(socket, channelId);
	socket.emit('voice-channel-unsubscribe', { channelId });
	listeningVoiceChannels.update((channels) => channels.filter((id) => id !== channelId));
}

export function isSfuMediaTransportActive(): boolean {
	return get(sfuMediaActive);
}

// ============================================================================
// Utility Functions
// ============================================================================

function handleMediaError(error: DOMException | Error, action: string) {
	const message = error?.message || String(error);
	const insecure =
		message.includes('mediaDevices') ||
		message.includes('secure context') ||
		message.includes('127.0.0.1');
	if (insecure) {
		showToast(
			`Cannot ${action === 'starting' ? 'start' : 'answer'} call: mic/camera API is blocked. Open ${brandName} at http://127.0.0.1:5173 (or HTTPS), not a plain LAN IP over HTTP.`,
			'error'
		);
		return;
	}
	if (error instanceof DOMException && error.name === 'NotAllowedError') {
		showToast(`Permission denied: Please allow camera and microphone access to ${action === 'starting' ? 'start' : 'answer'} a call.`, 'error');
	} else if (error instanceof DOMException && error.name === 'NotFoundError') {
		showToast(`No camera or microphone found to ${action === 'starting' ? 'start' : 'answer'} the call.`, 'error');
	} else if (
		error instanceof DOMException &&
		(error.name === 'NotReadableError' || error.name === 'OverconstrainedError')
	) {
		showToast('Camera or microphone is in use or inaccessible. Please close other applications that might be using it.', 'error');
	} else {
		showToast(`Error ${action} call: ${message}`, 'error');
	}
}

// Update username for a call (called when username info becomes available)
export function updateCallUsername(userId: string, username: string) {
	// Update all peer connection states for this user
	const callKey = getConnectionKey(userId, 'call');
	const screenKey = getConnectionKey(userId, 'screen');
	const callState = peerConnections.get(callKey);
	if (callState) {
		callState.username = username;
	}
	const screenState = peerConnections.get(screenKey);
	if (screenState) {
		screenState.username = username;
	}

	activeCalls.update(calls => {
		return calls.map(call => {
			if (call.userId === userId) {
				return { ...call, username };
			}
			return call;
		});
	});

	screenShares.update(shares => {
		return shares.map(share => {
			if (share.userId === userId) {
				return { ...share, username };
			}
			return share;
		});
	});
	syncSpatialAudioGraph();
}
