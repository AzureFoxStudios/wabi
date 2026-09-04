import { get } from 'svelte/store';
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
	handleScreenShareIceCandidate
} from './callingScreenShare';
import { initScreenShareDeps } from './callingScreenShare';
import { connectWithFallback, MESH_MAX_PARTICIPANTS, type CallSurface } from './callingFallback';
import { voiceChannelMembers, _updateVoiceChannelMember, _removeVoiceChannelMember } from './presenceStore';
import { getStoredDbUserId, getStoredUsername } from './authSession';
import { clearActiveAudioCaptureSession,
	createAudioCaptureSession,
	disposeAudioCaptureSession,
	getActiveAudioCaptureSession,
	getRTCConfig,
	requestCameraStream,
	setActiveAudioCaptureSession
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
import { callSessionManager } from './callSessionManager';
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
	type PeerConnectionState
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
	syncSpatialAudioGraph: () => syncSpatialAudioGraph()
});
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
			void applyCurrentAudioProcessingToLocalTrack().finally(() => {
				pushVoiceChannelNotice('Auto audio fallback: switched to DSP for performance');
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
	socket: Socket
): RTCPeerConnection {
	const key = getConnectionKey(targetId, keyTypeFromPCType(type));

	// Close existing connection of same type if any (prevents duplicates)
	const existing = peerConnections.get(key);
	if (existing) {
		console.log(`[WebRTC] Closing existing peer connection for ${key}`);
		existing.pc.close();
		peerConnections.delete(key);
	}

	const pc = new RTCPeerConnection(getRTCConfig());

	const state: PeerConnectionState = {
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
		console.log(`[WebRTC] Connection state for ${key}: ${pc.connectionState}`);

		switch (pc.connectionState) {
			case 'connected':
				state.lifecycleState = 'connected';
				connectionState.set('connected');
				callConnectionDiagnostics.update((current) => ({ ...current, connectionState: 'connected' }));
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
		console.log(`[WebRTC] ICE connection state for ${key}: ${pc.iceConnectionState}`);

		if (pc.iceConnectionState === 'checking') {
			state.lifecycleState = 'connecting';
			connectionState.set('connecting');
			callConnectionDiagnostics.update((current) => ({ ...current, connectionState: 'connecting' }));
		}
	};

	// ICE candidate handler
	pc.onicecandidate = (event) => {
		if (event.candidate) {
			const eventName = type === 'call' ? 'call-ice-candidate' : 'webrtc-ice-candidate';
			socket.emit(eventName, {
				candidate: event.candidate,
				targetId
			});
		}
	};

	// Track handler
	pc.ontrack = (event) => {
		console.log(`[WebRTC] Received track from ${key}:`, event.track.kind);

		const stream = event.streams[0];
		if (!stream) {
			console.warn(`[WebRTC] No stream in ontrack event`);
			return;
		}

		// Handle track ended
		event.track.onended = () => {
			console.log(`[WebRTC] Track ended from ${key}:`, event.track.kind);
			handleRemoteTrackEnded(targetId, key, event.track, type);
		};

		// Handle track muted/unmuted for UI sync
		event.track.onmute = () => {
			console.log(`[WebRTC] Track muted from ${key}:`, event.track.kind);
			updateRemoteTrackState(targetId, event.track, type);
		};

		event.track.onunmute = () => {
			console.log(`[WebRTC] Track unmuted from ${key}:`, event.track.kind);
			updateRemoteTrackState(targetId, event.track, type);
		};

		if (type === 'call') {
			addRemoteCallStream(targetId, username, stream);
		} else if (type === 'screen-share-inbound') {
			addRemoteScreenShare(targetId, username, stream);
		}
	};

	return pc;
}

async function addTrackWithOptimizations(pc: RTCPeerConnection, track: MediaStreamTrack, stream: MediaStream): Promise<void> {
	const isScreenShareTrack = stream === get(localScreenStream);
	await addOptimizedTrack(pc, track, stream, isScreenShareTrack ? 'screen-share' : 'camera');
}

function shouldTransmitToChannel(channelId?: string): boolean {
	if (!channelId) return true;
	if (get(voiceTransmitMode) === 'all-listening') return true;
	// While a DM/group call is active, the primary voice channel becomes
	// listen-only (TeamSpeak style): audio goes to the call, not the channel.
	if (get(activeCallSessionId)) {
		return get(activeGroupCall)?.id === channelId;
	}
	if (activeVoiceChannelId === channelId) return true;
	return get(activeGroupCall)?.id === channelId;
}

function shouldSendAudioToChannel(channelId?: string): boolean {
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

	// Gate the wabidb relays too — transmit routing ("all listening channels")
	// and mute must behave the same on the default transport. Deafen gates the
	// shared graph's OUTPUT (the relay's playback), not capture.
	setGraphOutputMuted(get(isDeafened));
	tasks.push(syncWabidbCapture((channelId) => shouldSendAudioToChannel(channelId)));
}

async function renegotiateCallConnection(state: PeerConnectionState, socket: Socket): Promise<void> {
	if (state.type !== 'call') return;

	const offer = await state.pc.createOffer();
	await state.pc.setLocalDescription(offer);

	socket.emit('call-offer', {
		offer,
		targetId: state.targetId,
		channelId: state.channelId
	});
}

/**
 * Close every channel-scoped p2p call mesh connection for one channel.
 * Used when the wabidb relay (the primary transport) heals after a fallback:
 * without this the orphaned mesh keeps playing the same voices alongside the
 * relay, out of sync — choppy stutter plus split-brain transport badges.
 * Screenshares (`screen-share-*`) are untouched; only `call` mesh goes.
 */
export function closeChannelP2PMesh(channelId: string): void {
	if (!channelId) return;
	const keys: string[] = [];
	peerConnections.forEach((state, key) => {
		if (state.type === 'call' && state.channelId === channelId) keys.push(key);
	});
	if (keys.length > 0) {
		console.log(`[Calling] closing ${keys.length} orphan p2p mesh connection(s) for ${channelId} (relay healed)`);
	}
	keys.forEach((key) => cleanupPeerConnection(key));
}

function cleanupPeerConnection(key: string): void {
	const state = peerConnections.get(key);
	if (!state) return;

	console.log(`[WebRTC] Cleaning up peer connection for ${key}`);

	try {
		state.pc.close();
	} catch (e) {
		// Ignore close errors
	}

	peerConnections.delete(key);
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

function addRemoteScreenShare(userId: string, username: string, stream: MediaStream): void {
	screenShares.update(shares => {
		const existingIndex = shares.findIndex(s => s.userId === userId);

		const newShare: ScreenShare = {
			userId,
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
	let stream = get(localStream);
	if (!stream) {
		const nextSession = await createAudioCaptureSession();
		const previousSession = getActiveAudioCaptureSession();
		setActiveAudioCaptureSession(nextSession);
		if (previousSession) {
			disposeAudioCaptureSession(previousSession);
		}
		stream = new MediaStream([nextSession.outputTrack]);
		localStream.set(stream);
		applyLocalTrackPreferences(stream);
		startLocalSpeakingMonitor(stream);
		void syncLocalAudioState();
		return stream;
	}

	const hasActiveAudioTrack = stream.getAudioTracks().some(track => track.readyState === 'live');
	if (hasActiveAudioTrack) {
		return stream;
	}

	const nextSession = await createAudioCaptureSession();
	const previousSession = getActiveAudioCaptureSession();
	setActiveAudioCaptureSession(nextSession);
	stream.getAudioTracks().forEach(track => {
		stream.removeTrack(track);
		try {
			track.stop();
		} catch {
			// no-op
		}
	});
	stream.addTrack(nextSession.outputTrack);
	if (previousSession) {
		disposeAudioCaptureSession(previousSession);
	}
	applyLocalTrackPreferences(stream);
	startLocalSpeakingMonitor(stream);
	void syncLocalAudioState();
	return stream;
}

export async function joinVoiceChannel(socket: Socket, channelId: string) {
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
		socket.emit('voice-channel-join', { channelId });
		socket.emit('voice-channel-subscribe', { channelId });
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
	const alreadyInCall = Boolean(get(activeCallSessionId));
	const hasPrimaryVoiceChannel = Boolean(activeVoiceChannelId);

	try {
		await prefetchTurnCredentials().catch((err) => {
			console.warn('[Calling] TURN prefetch failed, continuing without TURN', err);
		});
		const activeTransport = await resolveActiveTransport(channelId);
		const stream = await ensureLocalAudioStream();
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
		// Presence BEFORE transport: the server's wabidb room authorization
		// (Phase 1 hardening) checks the voice roster, so the join/subscribe
		// must land before join-wabidb-call or the relay join is denied.
		if (listenOnly) {
			socket.emit('voice-channel-subscribe', { channelId });
		} else {
			socket.emit('voice-channel-join', { channelId });
			socket.emit('voice-channel-subscribe', { channelId });
		}
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
		await connectWithFallback({
			mode: activeTransport === 'sfu' ? 'sfu-preferred' : getStoredCallTransportMode(),
			surface: 'channel' as CallSurface,
			expectedParticipants: Math.max(rosterSize, 1),
			connect: async (transport) => {
				if (transport === 'sfu') {
					await connectLivekitSfu(channelId, `${brandName} User`);
				} else if (transport === 'wabidb') {
					await connectWabidbCall(socket, channelId, `${brandName} User`, undefined, undefined, listenOnly);
				} else {
					// p2p tail for channels: build the mesh for real. This branch
					// used to be a bare console.warn — the chain then stamped
					// Transport: P2P with zero peers, no offers, no relay: a
					// call that LOOKS connected and is completely deaf
					// (2026-09-03 "nada" report). Same mesh path the watchdog
					// demote uses; forceTransport: 'p2p' bypasses the resolver.
					await reEstablishChannelP2P(socket, channelId);
				}
			}
		});
		// Record the transport the chain ACTUALLY landed on (the plan may have
		// demoted mid-connect; callTransportState holds the runtime truth).
		const effectiveTransport = get(callTransportState).activeTransport;
		callSessionManager.markConnected(channelId, effectiveTransport);
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
		// Phase 2: the optimistic session registration must not outlive a
		// failed join — drop it (and its audio chain slot).
		callSessionManager.markFailed(channelId);
		callSessionManager.unregister(channelId);
		detachSessionAudioChain(channelId);
		// Do not leave the sidebar/center-stage state claiming that we are
		// connected when transport setup failed after the local state was set.
		// Without this rollback a failed join can leave the channel highlighted,
		// suppress a later join attempt, and make the voice view appear connected
		// while no media transport exists.
		if (activeVoiceChannelId === channelId) {
			activeVoiceChannelId = null;
			listeningVoiceChannels.update((channels) => channels.filter((id) => id !== channelId));
			activeVoiceChannel.set(null);
		}
		// Phase 5: the optimistic self-chip must not survive a failed join —
		// the server never confirmed membership. Presence emits already went
		// out (Phase 1 ordering), so mirror them to keep every roster honest.
		// (listenOnly is try-scoped; recompute from the same outer conditions.)
		const failedSelfDbId = getStoredDbUserId();
		if (failedSelfDbId) {
			_removeVoiceChannelMember(channelId, `user-${failedSelfDbId}`);
		}
		const wasListenOnly = alreadyInCall || hasPrimaryVoiceChannel;
		socket.emit(wasListenOnly ? 'voice-channel-unsubscribe' : 'voice-channel-leave', { channelId });
		if (!wasListenOnly) {
			socket.emit('voice-channel-unsubscribe', { channelId });
		}
		void disconnectLivekitSfu();
		handleMediaError(error as DOMException, 'starting');
		if (!get(activeCallSessionId)) {
			isInCall.set(false);
		}
		throw error;
	}
}

export async function leaveVoiceChannel(socket: Socket, channelId: string) {
	if (activeVoiceChannelId !== channelId) {
		// Listening-only channel: only unsubscribe, do NOT emit the
		// primary `voice-channel-leave` (that would remove the socket
		// from whatever primary channel it's transmitting on).
		socket.emit('voice-channel-unsubscribe', { channelId });
		void disconnectWabidbChannel(channelId);
		listeningVoiceChannels.update((channels) => channels.filter((id) => id !== channelId));
		callSessionManager.unregister(channelId);
		detachSessionAudioChain(channelId);
		return;
	}

	socket.emit('voice-channel-leave', { channelId });
	socket.emit('voice-channel-unsubscribe', { channelId });
	void disconnectWabidbChannel(channelId);
	// Legacy behavior: leaving the primary clears every listening channel —
	// mirror that in the session model so it never claims a live session the
	// legacy layer has already torn down.
	callSessionManager.leaveAll();
	detachSessionAudioChain(channelId);
	activeVoiceChannelId = null;
	listeningVoiceChannels.set([]);
	pushVoiceChannelNotice(`Left voice: ${channelId}`);
	playCallActionSound('leave', sessionSoundOptionsFor(channelId));

	// Multi-call: leaving the primary voice channel keeps the DM/group call
	// alive. The shared local stream and transport belong to the call now.
	if (get(activeCallSessionId)) {
		activeVoiceChannel.set(null);
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
	isVideoOff.set(false);
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
	if (!socket || fromChannelId === toChannelId) return;

	const isPrimary = activeVoiceChannelId === fromChannelId;
	const isListening = get(listeningVoiceChannels).includes(fromChannelId);
	// Stale roster move for a channel we're not voice-connected to — ignore.
	if (!isPrimary && !isListening) return;

	await disconnectWabidbChannel(fromChannelId);
	socket.emit('voice-channel-unsubscribe', { channelId: fromChannelId });
	listeningVoiceChannels.update((channels) => channels.filter((id) => id !== fromChannelId));
	callSessionManager.unregister(fromChannelId);
	detachSessionAudioChain(fromChannelId);

	// While a DM/group call is active the channel stays a listen-only backdrop
	// (TeamSpeak style) — mirror joinVoiceChannel's listenOnly rule so a forced
	// move never starts a second capturing relay alongside the call.
	const captureHere = isPrimary && !get(activeCallSessionId);

	if (isPrimary) {
		activeVoiceChannelId = toChannelId;
		activeVoiceChannel.set({ id: toChannelId, name: resolveVoiceChannelDisplayName(toChannelId) });
	}
	listeningVoiceChannels.update((channels) => (
		channels.includes(toChannelId) ? channels : [...channels, toChannelId]
	));
	// Phase 2: the moved-to channel becomes a session immediately; focus
	// follows the primary (a forced move while listening stays background).
	callSessionManager.register({
		id: toChannelId,
		channelId: toChannelId,
		kind: 'channel',
		name: resolveVoiceChannelDisplayName(toChannelId),
		direction: captureHere ? 'transmit' : 'listen'
	});

	// Presence BEFORE transport (Phase 1 hardening): the server authorizes
	// wabidb room joins against the voice roster, so the join/subscribe must
	// land before the relay connects or the room join is denied.
	if (isPrimary) {
		socket.emit('voice-channel-join', { channelId: toChannelId });
	}
	socket.emit('voice-channel-subscribe', { channelId: toChannelId });

	if (get(sfuMediaActive)) {
		await disconnectLivekitSfu();
		if (captureHere) {
			await connectLivekitSfu(toChannelId, `${brandName} User`);
			callSessionManager.markConnected(toChannelId, 'sfu');
		}
	} else {
		try {
			await connectWabidbCall(socket, toChannelId, `${brandName} User`, undefined, undefined, !captureHere);
			callSessionManager.markConnected(toChannelId, 'wabidb');
		} catch (error) {
			console.error('[Calling] Failed to re-tune wabidb relay after forced move:', error);
			callSessionManager.markFailed(toChannelId);
		}
	}

	if (isPrimary) {
		callSessionManager.setFocus(toChannelId);
		// Server-side join resets the roster transmit mode to "primary";
		// re-assert an active broadcast routing so the roster stays honest.
		if (get(voiceTransmitMode) === 'all-listening') {
			socket.emit('set-voice-transmit-mode', { mode: 'all-listening' });
		}
		pushVoiceChannelNotice(`Moved to ${toChannelId}`);
		playCallActionSound('join');
	}
	syncSpatialAudioGraph();
}

export async function handleForcedVoiceLeave(socket: Socket, channelId: string): Promise<void> {
	if (!socket || !channelId) return;

	const isPrimary = activeVoiceChannelId === channelId;
	const isListening = get(listeningVoiceChannels).includes(channelId);
	// Stale kick for a channel we're not voice-connected to — ignore.
	if (!isPrimary && !isListening) return;

	await disconnectWabidbChannel(channelId);
	listeningVoiceChannels.update((channels) => channels.filter((id) => id !== channelId));
	// Phase 2.5: the kick must end the session too, or the session model
	// keeps claiming a call the server just removed us from.
	callSessionManager.unregister(channelId);
	detachSessionAudioChain(channelId);
	if (isPrimary) {
		activeVoiceChannelId = null;
		activeVoiceChannel.set(null);
	}
	syncSpatialAudioGraph();
	pushVoiceChannelNotice('You were removed from the voice channel');
	playCallActionSound('leave', sessionSoundOptionsFor(channelId));

	// If the kicked channel was the active group call, end the call locally
	// and tell the server we left it.
	if (get(activeGroupCall)?.id === channelId) {
		socket.emit('group-call-leave', { channelId });
		finalizeLocalCallEndState();
	}
}

export async function startCall(
	socket: Socket,
	targetUserId: string,
	isVideoCall: boolean = false,
	options: { scope?: ExperimentalWabidbCallScope; displayName?: string } = {}
) {
	try {
		if (!socket.connected) {
			callOfflineNotice.set(`No connection to server. Calls require an active connection to the ${brandName} server.`);
			throw new Error(`No connection to server. Calls require an active connection to the ${brandName} server.`);
		}

		if (get(activeCallSessionId) || get(outgoingCall) || get(incomingCall)) {
			throw new Error('A call is already active or ringing');
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
	options: { clearOutgoing?: boolean; playJoinSound?: boolean; socket?: Socket } = {}
): Promise<void> {
	const stream = get(localStream);
	const alreadyInSameGroupCall =
		get(isInCall) &&
		get(callMode) === 'group' &&
		get(activeGroupCall)?.id === channelId;

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

	const activeTransport = await resolveActiveTransport(channelId, 'group');
	// T2: previously this path logged "will use P2P" on total failure WITHOUT
	// establishing anything. The executor now walks the whole chain and
	// surfaces callOfflineNotice on exhaustion.
	await connectWithFallback({
		mode: activeTransport === 'sfu' ? 'sfu-preferred' : getStoredCallTransportMode(),
		surface: 'group' as CallSurface,
		expectedParticipants: Math.max(get(groupCallRingingTargets).length + 1, 1),
		connect: async (transport) => {
			if (transport === 'sfu') {
				await connectLivekitSfu(channelId, localDisplayName || `${brandName} User`);
			} else if (transport === 'wabidb' && options.socket) {
				await connectWabidbCall(options.socket, channelId, localDisplayName || `${brandName} User`);
			} else if (transport === 'p2p') {
				console.warn('[Calling] Group p2p tail reached — mesh audio only');
			}
		}
	});
	callSessionManager.markConnected(channelId, activeTransport === 'sfu' ? 'sfu' : activeTransport === 'p2p' ? 'p2p' : 'wabidb');
	callSessionManager.setFocus(channelId);
}

function removeGroupCallRingingTarget(stableUserId: string): void {
	if (!stableUserId) return;
	groupCallRingingTargets.update((targets) => targets.filter((target) => target.stableUserId !== stableUserId));
}

function maybeDismissEmptyPendingGroupCall(): void {
	if (get(isInCall)) return;
	if (get(callMode) !== 'group') return;
	if (get(groupCallRingingTargets).length > 0) return;
	finalizeLocalCallEndState();
}

export async function startGroupCall(
	socket: Socket,
	channelId: string,
	channelName: string,
	isVideoCall: boolean = false,
	options: { localDisplayName?: string; invitees?: GroupCallRingingTarget[] } = {}
) {
	try {
		if (!socket.connected) {
			callOfflineNotice.set(`No connection to server. Calls require an active connection to the ${brandName} server.`);
			throw new Error(`No connection to server. Calls require an active connection to the ${brandName} server.`);
		}

		if (get(activeCallSessionId) || get(outgoingCall) || get(incomingCall)) {
			throw new Error('A call is already active or ringing');
		}

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

		callMode.set('group');
		autoOpenChannelCallPanel();
		// Keep an active primary voice channel as a listen-only backdrop
		// (TeamSpeak style) instead of tearing it down.
		if (!activeVoiceChannelId) {
			activeVoiceChannel.set(null);
		}
		activeGroupCall.set({ id: channelId, name: channelName });
		activeCallSessionId.set(groupCallSessionKey(channelId));
		groupCallRingingTargets.set(options.invitees || []);
		isMuted.set(false);
		isVideoOff.set(!isVideoCall);
		connectionState.set('signaling');
		outgoingCall.set({
			channelId,
			channelName,
			username: channelName.trim() || 'Group',
			isVideoCall,
			startedAt: Date.now(),
			scope: 'group',
			localDisplayName: options.localDisplayName?.trim() || `${brandName} User`
		});

		const fallbackToP2P = getStoredCallTransportMode() === 'p2p-only';
		if (!fallbackToP2P) {
			await markExperimentalWabidbCallAttempt({ targetUserId: channelId, isVideoCall, scope: 'group' });
			socket.emit('call-initiate', {
				channelId,
				isVideoCall,
				experimental: {
					label: 'experimental-wabidb-call',
					route: 'desktop-wabidb',
					scope: 'group'
				}
			});
		} else {
			socket.emit('call-initiate', {
				channelId,
				isVideoCall
			});
		}

		callOfflineNotice.set(null);
		return stream;
	} catch (error) {
		console.error('Error starting group call:', error);
		callOfflineNotice.set('Could not start the call. Check your connection and try again.');
		handleMediaError(error as DOMException, 'starting');
		activeCallSessionId.set(null);
		activeGroupCall.set(null);
		outgoingCall.set(null);
		groupCallRingingTargets.set([]);
		if (!activeVoiceChannelId) {
			// Stop tracks before nulling — a bare localStream.set(null) leaks a
			// live mic (and camera, for video groups) until the next call
			// (hot-mic leak, 2026-08-27 round 5).
			const leakedStream = get(localStream);
			leakedStream?.getTracks().forEach(track => track.stop());
			localStream.set(null);
			clearActiveAudioCaptureSession();
			isInCall.set(false);
			callMode.set(null);
		} else {
			callMode.set('channel');
		}
		throw error;
	}
}

export function beginEstablishedDirectCall(): boolean {
	const pending = get(outgoingCall);
	if (!pending) {
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

		if (options.channelId) {
			groupCallRingingTargets.set([]);
			await enterEstablishedGroupCall(
				options.channelId,
				options.channelName || options.channelId,
				options.localDisplayName?.trim() || `${brandName} User`,
				{ playJoinSound: true, socket }
			);
		} else {
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

		socket.emit('call-answer', {
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
		wabidbStopRemoteVideo(userId);
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
	const pending = get(outgoingCall);
	const activeGroup = get(activeGroupCall);
	const localDisplayName = pending?.localDisplayName || `${brandName} User`;
	const isSameActiveGroup =
		get(isInCall) &&
		get(callMode) === 'group' &&
		activeGroup?.id === data.channelId;
	if (data.stableUserId) {
		removeGroupCallRingingTarget(data.stableUserId);
	}

	if (!isSameActiveGroup) {
		await enterEstablishedGroupCall(
			data.channelId,
			data.channelName || pending?.channelName || pending?.username || data.channelId,
			localDisplayName,
			{ clearOutgoing: pending?.channelId === data.channelId, playJoinSound: true, socket }
		);
	} else {
		handleVoiceParticipantJoined(data.userId, data.username);
	}

	if (get(sfuMediaActive)) {
		return;
	}

	await createCallOffer(socket, data.userId, data.username, { channelId: data.channelId });
}

export function handleGroupCallParticipantLeft(data: { channelId: string; userId: string }): void {
	if (get(activeGroupCall)?.id !== data.channelId) {
		return;
	}
	handleVoiceParticipantLeft(data.userId);
	removeCall(data.userId);
	removeScreenShare(data.userId);
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
	const stream = get(localStream);
	if (!stream) return;
	const existingAudioTrack = stream.getAudioTracks()[0];
	if (!existingAudioTrack || existingAudioTrack.readyState !== 'live') return;

	const previousSession = getActiveAudioCaptureSession();
	const nextSession = await createAudioCaptureSession();

	stream.removeTrack(existingAudioTrack);
	try {
		stream.addTrack(nextSession.outputTrack);
	} catch (addErr) {
		stream.addTrack(existingAudioTrack);
		disposeAudioCaptureSession(nextSession);
		throw addErr;
	}
	applyLocalTrackPreferences(stream);
	startLocalSpeakingMonitor(stream);

	setActiveAudioCaptureSession(nextSession);
	if (previousSession) {
		disposeAudioCaptureSession(previousSession);
	}
	try {
		existingAudioTrack.stop();
	} catch {
		// no-op
	}

	const tasks: Promise<unknown>[] = [];
	peerConnections.forEach((state) => {
		if (state.type !== 'call') return;
		const sender = state.pc.getSenders().find(s => s.track?.kind === 'audio');
		if (!sender) return;
		tasks.push(sender.replaceTrack(nextSession.outputTrack));
		tasks.push(optimizeSender(sender, state.pc, 'audio'));
	});
	const results = await Promise.allSettled(tasks);
	if (results.some(result => result.status === 'rejected')) {
		console.warn('[WebRTC] Audio mode switched locally, but one or more peer senders failed to update.');
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

export async function toggleVideo(socket?: Socket) {
	if (getLivekitRoom() && get(sfuMediaActive)) {
		const nextVideoOff = !get(isVideoOff);
		await getLivekitRoom()!.localParticipant.setCameraEnabled(!nextVideoOff);
		isVideoOff.set(nextVideoOff);
		return;
	}
	const stream = get(localStream);
	if (!stream) {
		return;
	}

	// wabidb relay transport: there are no peerConnections to renegotiate —
	// the camera must ride the wabidb video lane instead. Check RUNTIME state
	// (a live relay) rather than resolveActiveTransport(), which returns 'p2p'
	// for DM calls even when they connect via wabidb — that gating made the
	// camera dead on every direct call.
	try {
		const { wabidbStartVideo, wabidbStopVideoSource, wabidbTransportLive } = await import('./callingWabidb');
		if (wabidbTransportLive()) {
			if (get(isVideoOff)) {
				const started = await wabidbStartVideo('camera');
				if (started) isVideoOff.set(false);
			} else {
				// P1: stop ONLY the camera sender — an active screenshare keeps running.
				wabidbStopVideoSource('camera');
				isVideoOff.set(true);
			}
			return;
		}
	} catch (err) {
		console.error('[Calling] wabidb camera toggle failed:', err);
	}

	const existingTrack = stream.getVideoTracks()[0];
	if (existingTrack) {
		existingTrack.enabled = !existingTrack.enabled;
		isVideoOff.set(!existingTrack.enabled);
		return;
	}

	try {
		const cameraStream = await requestCameraStream();
		const cameraTrack = cameraStream.getVideoTracks()[0];
		if (!cameraTrack) {
			return;
		}

		stream.addTrack(cameraTrack);

		const renegotiationTasks: Promise<void>[] = [];
		peerConnections.forEach(state => {
			if (state.type !== 'call') return;

			const existingSender = state.pc.getSenders().find(sender => sender.track?.kind === 'video');
			if (existingSender) {
				renegotiationTasks.push(existingSender.replaceTrack(cameraTrack));
				renegotiationTasks.push(optimizeSender(existingSender, state.pc, 'video', 'camera'));
			} else {
				renegotiationTasks.push(addTrackWithOptimizations(state.pc, cameraTrack, stream));
			}

			if (socket) {
				renegotiationTasks.push(renegotiateCallConnection(state, socket));
			}
		});

		await Promise.all(renegotiationTasks);
		isVideoOff.set(false);
	} catch (error) {
		console.error('[WebRTC] Could not enable camera track:', error);
		handleMediaError(error as DOMException, 'starting');
	}
}

// ============================================================================
// WebRTC Signaling Handlers (called from socket.ts)
// ============================================================================

export async function createCallOffer(
	socket: Socket,
	targetId: string,
	username: string = '',
	options?: { channelId?: string; forceTransport?: 'p2p' }
) {
	// Check if wabidb relay is the active transport — if so, skip P2P/WebRTC
	// offer creation entirely and connect the wabidb media relay with the
	// peer's stable user ID for a deterministic shared session.
	// forceTransport is the watchdog/swap escape hatch: the p2p rebuild MUST
	// produce WebRTC offers even while the stored mode still routes to wabidb
	// (previously the early-return reconnected the dying relay instead).
	const activeTransport = options?.forceTransport ?? (await resolveActiveTransport(options?.channelId));
	if (activeTransport === 'wabidb') {
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
			await disconnectWabidbCall();
		}
	}

	await prefetchTurnCredentials().catch((err) => {
		console.warn('[Calling] TURN prefetch failed, continuing without TURN', err);
	});
	const pc = createPeerConnection(targetId, username, 'call', socket);
	const key = getConnectionKey(targetId, 'call');
	const state = peerConnections.get(key);
	if (state && options?.channelId) {
		state.channelId = options.channelId;
	}

	const stream = get(localStream);
	if (stream) {
		for (const track of stream.getTracks()) {
			await addTrackWithOptimizations(pc, track, stream);
		}
	}
	await setPeerAudioSendEnabled(pc, shouldSendAudioToChannel(options?.channelId));

	try {
		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);

		socket.emit('call-offer', {
			offer,
			targetId,
			channelId: options?.channelId
		});
	} catch (err) {
		console.error('[WebRTC] Failed to create call offer:', err);
		cleanupPeerConnection(key);
	}
}

export async function handleCallOffer(
	socket: Socket,
	senderId: string,
	username: string,
	offer: RTCSessionDescriptionInit,
	channelId?: string
) {
	await prefetchTurnCredentials().catch((err) => {
		console.warn('[Calling] TURN prefetch failed, continuing without TURN', err);
	});
	const pc = createPeerConnection(senderId, username, 'call', socket);
	const key = getConnectionKey(senderId, 'call');
	const offerState = peerConnections.get(key);
	if (offerState && channelId) {
		offerState.channelId = channelId;
	}

	const stream = get(localStream);
	if (stream) {
		for (const track of stream.getTracks()) {
			await addTrackWithOptimizations(pc, track, stream);
		}
	}
	await setPeerAudioSendEnabled(pc, shouldSendAudioToChannel(channelId));

	try {
		await pc.setRemoteDescription(offer);

		// Mark remote description as set and flush queue
		const state = peerConnections.get(key);
		if (state) {
			state.hasRemoteDescription = true;
			await flushIceCandidateQueue(key);
		}

		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);

		socket.emit('call-answer-sdp', {
			answer,
			targetId: senderId
		});
	} catch (err) {
		console.error('[WebRTC] Failed to handle call offer:', err);
		cleanupPeerConnection(key);
	}
}

export async function handleCallAnswer(senderId: string, answer: RTCSessionDescriptionInit) {
	const key = getConnectionKey(senderId, 'call');
	const state = peerConnections.get(key);
	if (!state) {
		console.warn(`[WebRTC] No peer connection for call answer from ${senderId}`);
		return;
	}

	try {
		await state.pc.setRemoteDescription(answer);
		state.hasRemoteDescription = true;
		await flushIceCandidateQueue(key);
	} catch (err) {
		console.error(`[WebRTC] Failed to set remote description:`, err);
	}
}

export async function handleCallIceCandidate(senderId: string, candidate: RTCIceCandidateInit) {
	const key = getConnectionKey(senderId, 'call');
	queueIceCandidate(key, candidate);
}

// ============================================================================
// Cleanup Functions
// ============================================================================

export function removeCall(userId: string) {
	cleanupPeerConnection(getConnectionKey(userId, 'call'));
}

export function removeScreenShare(userId: string) {
	cleanupPeerConnection(getConnectionKey(userId, 'screen'));
}

export function cleanupAllConnections() {
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
export async function reEstablishChannelP2P(socket: Socket, channelId: string): Promise<void> {
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
		try {
			await createCallOffer(socket, member.userId, member.username ?? '', {
				channelId,
				forceTransport: 'p2p'
			});
			offers++;
		} catch (err) {
			console.warn(`[Calling] p2p re-establish offer failed for ${member.userId}:`, err);
		}
	}
	if (offers === 0) {
		// Every per-peer failure is logged above; the session keeps its current
		// transport state rather than being mislabeled 'p2p' with no mesh.
		pushVoiceChannelNotice('P2P fallback could not reach any peer — call audio may be silent');
		return;
	}
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
 * Cleanly swap the active call transport between the wabidb relay and
 * traditional p2p (2026-08-27 request). The stored mode is updated first so
 * createCallOffer()/connectWabidbCall() route consistently, then every live
 * session is torn down on the old transport and re-established on the new
 * one WITHOUT dropping voice presence:
 *  - to p2p: relays leave their wabidb rooms (the server stops forwarding to
 *    us), then mesh call-offers go to every other channel member — their
 *    handleCallOffer() answers carry their audio back over WebRTC.
 *  - to wabidb: channel-scoped p2p peer connections close, then the relay
 *    rejoins the deterministic session key.
 * Refuses meshes above MESH_MAX_PARTICIPANTS (renegotiation hell guard).
 */
export async function switchCallTransport(socket: Socket, target: 'wabidb' | 'p2p'): Promise<void> {
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
	const rosterCounts = channelSessions.map(
		(session) => (session.channelId ? (get(voiceChannelMembers)[session.channelId]?.length ?? 1) : 1)
	);
	const largestRoster = Math.max(1, ...rosterCounts);

	if (target === 'p2p') {
		// Full-mesh guard (same law as effectiveChain): a big channel over p2p
		// is an outage, not a swap.
		if (largestRoster > MESH_MAX_PARTICIPANTS) {
			pushVoiceChannelNotice(`P2P mesh is capped at ${MESH_MAX_PARTICIPANTS} — this call is too large`);
			return;
		}
		// Preference first, so offer routing agrees with the swap.
		setCallTransportMode('p2p-only');
		// Stop the wabidb watchdog before tearing its transport down, or it
		// reads the teardown as a failure and demotes mid-swap.
		transportWatchdog.stop();
		for (const session of channelSessions) {
			const channelId = session.channelId ?? session.id;
			try { await disconnectWabidbChannel(channelId); } catch { /* already gone */ }
		}
		try { await disconnectWabidbCall(); } catch { /* already gone */ }

		// Mesh offers per channel session, then DM peers.
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
				try {
					await createCallOffer(socket, member.userId, member.username ?? '', { channelId });
					offers++;
				} catch (err) {
					console.warn(`[Calling] p2p swap offer failed for ${member.userId}:`, err);
				}
			}
		}
		for (const call of get(activeCalls)) {
			try {
				await createCallOffer(socket, call.userId, call.username ?? '');
				offers++;
			} catch (err) {
				console.warn(`[Calling] p2p swap offer failed for ${call.userId}:`, err);
			}
		}
		callTransportState.update((state) => ({
			...state,
			activeTransport: 'p2p' as const,
			isFallback: false,
			reason: 'user_switch',
			checkedAt: Date.now()
		}));
		for (const session of channelSessions) {
			callSessionManager.markConnected(session.channelId ?? session.id, 'p2p');
		}
		pushVoiceChannelNotice(
			offers > 0
				? `Switched to P2P (${offers} peer connection${offers === 1 ? '' : 's'})`
				: 'Switched to P2P — waiting for peers to answer'
		);
	} else {
		// Back to the wabidb-first chain (auto keeps the p2p tail as fallback).
		setCallTransportMode('auto');
		// Close channel-scoped p2p connections; unrelated screenshares survive.
		const keysToClose: string[] = [];
		peerConnections.forEach((state, key) => {
			if (state.type === 'call') keysToClose.push(key);
		});
		keysToClose.forEach((key) => cleanupPeerConnection(key));

		for (const session of channelSessions) {
			const channelId = session.channelId ?? session.id;
			try {
				await connectWabidbCall(socket, channelId, `${brandName} User`, undefined, undefined, session.direction === 'listen');
				callSessionManager.markConnected(channelId, 'wabidb');
			} catch (err) {
				console.warn(`[Calling] wabidb swap reconnect failed for ${channelId}:`, err);
			}
		}
		syncWabidbCapture((cid) => shouldSendAudioToChannel(cid));
		callTransportState.update((state) => ({
			...state,
			activeTransport: 'wabidb' as const,
			isFallback: false,
			reason: 'user_switch',
			checkedAt: Date.now()
		}));
		pushVoiceChannelNotice('Switched to WabiDB relay');
	}
	syncSpatialAudioGraph();
}

export function closeChannelCallPanel(): void {
	channelCallPanelOpen.set(false);
}

export function toggleChannelCallPanel(): void {
	channelCallPanelOpen.update((open) => !open);
}

export function setVoiceTransmitRoutingMode(mode: 'primary' | 'all-listening'): void {
	voiceTransmitMode.set(mode);
	void syncLocalAudioState();
}

export function refreshLocalAudioMuteState(): void {
	void syncLocalAudioState();
}

export function addVoiceChannelListen(socket: Socket, channelId: string): void {
	if (!channelId) return;
	socket.emit('voice-channel-subscribe', { channelId });
	listeningVoiceChannels.update((channels) => (
		channels.includes(channelId) ? channels : [...channels, channelId]
	));
}

export function removeVoiceChannelListen(socket: Socket, channelId: string): void {
	if (!channelId) return;
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
