import { get } from 'svelte/store';
import type { Socket } from 'socket.io-client';
import { disconnectWabidbCall, connectWabidbCall } from './callingWabidb';
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
import {
	initStorefwdDeps,
	startStorefwdRecording,
	stopStorefwdRecording
} from './callingStorefwd';
import {
	clearActiveAudioCaptureSession,
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
import { playCallActionSound } from './callSounds';
import { closeMediaGatewaySession } from './mediaGateway';
import {
	stopMediaGatewaySessionRenewal,
	getActiveMediaGatewaySessionId,
	setActiveMediaGatewaySessionId
} from './callingMediaGateway';
import { resolveActiveTransport } from './callingTransport';
import {
	getStoredCallMuteBehavior,
	getStoredAudioProcessingMode,
	getStoredSpatialAudioSettings,
	setSpatialAudioEnabled
} from './mediaRuntime';
import { SpatialAudioEngine, type SpatialPosition } from './audio/spatialEngine';
import {
	assignStableSeatOrder,
	computeSpatialPosition,
	resolveSpatialRuntimeMode,
	sortByUserId
} from './callingSpatialRuntime';
import {
	addOptimizedTrack,
	flushIceCandidateQueue as flushQueuedIceCandidates,
	getConnectionKey,
	keyTypeFromPCType,
	optimizeSender,
	queueIceCandidate as queuePendingIceCandidate,
	setPeerAudioSendEnabled
} from './callingWebrtcHelpers';
import {
	markExperimentalWabidbCallAttempt,
	shouldUseExperimentalWabidbCall,
	type ExperimentalWabidbCallScope
} from './experimentalWabidbCalls';
import { clearAllRecordingPresence } from './callRecordingPresence';
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
	if (activeVoiceChannelId === channelId) return true;
	return get(activeGroupCall)?.id === channelId;
}

function shouldSendAudioToChannel(channelId?: string): boolean {
	if (get(isMuted) || get(isDeafened)) {
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

	const __mgwSessionId = getActiveMediaGatewaySessionId();
	if (__mgwSessionId) {
		void closeMediaGatewaySession(__mgwSessionId).catch((error) => {
			console.warn('[MediaGateway] Failed to close session on call teardown:', error);
		});
		stopMediaGatewaySessionRenewal();
		setActiveMediaGatewaySessionId(null);
	}
	void disconnectLivekitSfu();
	void disconnectWabidbCall();
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

function pushVoiceChannelNotice(text: string): void {
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
		callOfflineNotice.set('No connection to server. Calls require an active connection to the Wabi server.');
		throw new Error('No connection to server. Calls require an active connection to the Wabi server.');
	}

	if (activeVoiceChannelId === channelId) {
		listeningVoiceChannels.update((channels) => (
			channels.includes(channelId) ? channels : [...channels, channelId]
		));
		socket.emit('voice-channel-subscribe', { channelId });
		return get(localStream);
	}

	if (activeVoiceChannelId && activeVoiceChannelId !== channelId) {
		await leaveVoiceChannel(socket, activeVoiceChannelId);
	}

	try {
		await prefetchTurnCredentials().catch((err) => {
			console.warn('[Calling] TURN prefetch failed, continuing without TURN', err);
		});
		const activeTransport = await resolveActiveTransport(channelId);
		const stream = await ensureLocalAudioStream();
		activeVoiceChannelId = channelId;
		callMode.set('channel');
		channelCallPanelOpen.set(false);
		activeVoiceChannel.set({ id: channelId, name: channelId });
		listeningVoiceChannels.set([channelId]);
		incomingCall.set(null);
		pushVoiceChannelNotice(`Joined voice: ${channelId}`);
		isInCall.set(true);
		isMuted.set(false);
		isVideoOff.set(true);
		startLocalSpeakingMonitor(stream);
		startPerformanceGuard();
		initStorefwdDeps(socket);
		if (activeTransport === 'sfu') {
			await connectLivekitSfu(channelId, 'Wabi User');
		}
		if (activeTransport === 'storefwd') {
			// Storefwd is passive — no connection setup, just subscribe
			// PTT is handled by UI button calling start/stopStorefwdRecording
			pushVoiceChannelNotice('Joined voice (storefwd mode)');
		}
		if (activeTransport === 'wabidb') {
			// Default transport: wabidb/socket.io opus relay. Guarded so a
			// relay failure doesn't abort the whole channel join.
			try {
				await connectWabidbCall(socket, channelId, 'Wabi User');
			} catch (wabidbErr) {
				console.error('[Calling] wabiDB voice connection failed:', wabidbErr);
			}
		}
		syncSpatialAudioGraph();
		playCallActionSound('join');
		socket.emit('voice-channel-join', { channelId });
		socket.emit('voice-channel-subscribe', { channelId });
		callOfflineNotice.set(null);
		return stream;
	} catch (error) {
		console.error('Error joining voice channel:', error);
		void disconnectLivekitSfu();
		const __mgwSessionId = getActiveMediaGatewaySessionId();
		if (__mgwSessionId) {
			void closeMediaGatewaySession(__mgwSessionId).catch((closeError) => {
				console.warn('[MediaGateway] Failed closing session after join failure:', closeError);
			});
			stopMediaGatewaySessionRenewal();
			setActiveMediaGatewaySessionId(null);
		}
		handleMediaError(error as DOMException, 'starting');
		isInCall.set(false);
		throw error;
	}
}

export async function leaveVoiceChannel(socket: Socket, channelId: string) {
	if (activeVoiceChannelId !== channelId) {
		socket.emit('voice-channel-leave', { channelId });
		socket.emit('voice-channel-unsubscribe', { channelId });
		listeningVoiceChannels.update((channels) => channels.filter((id) => id !== channelId));
		return;
	}

	socket.emit('voice-channel-leave', { channelId });
	socket.emit('voice-channel-unsubscribe', { channelId });
	activeVoiceChannelId = null;
	listeningVoiceChannels.set([]);
	pushVoiceChannelNotice(`Left voice: ${channelId}`);
	playCallActionSound('leave');

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

	const __mgwSessionId2 = getActiveMediaGatewaySessionId();
	if (__mgwSessionId2) {
		void closeMediaGatewaySession(__mgwSessionId2).catch((error) => {
			console.warn('[MediaGateway] Failed to close session on leave:', error);
		});
		stopMediaGatewaySessionRenewal();
		setActiveMediaGatewaySessionId(null);
	}
	void disconnectLivekitSfu();
	void disconnectWabidbCall();
}

export async function startCall(
	socket: Socket,
	targetUserId: string,
	isVideoCall: boolean = false,
	options: { scope?: ExperimentalWabidbCallScope; displayName?: string } = {}
) {
	try {
		if (!socket.connected) {
			callOfflineNotice.set('No connection to server. Calls require an active connection to the Wabi server.');
			throw new Error('No connection to server. Calls require an active connection to the Wabi server.');
		}

		if (get(isInCall) || get(outgoingCall) || get(incomingCall)) {
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
		channelCallPanelOpen.set(false);
		activeVoiceChannel.set(null);
		activeGroupCall.set(null);
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
		const useExperimentalWabidb = shouldUseExperimentalWabidbCall(scope);
		if (useExperimentalWabidb) {
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
		if (leakedStream) {
			leakedStream.getTracks().forEach(track => track.stop());
			localStream.set(null);
		}
		handleMediaError(error as DOMException, 'starting');
		isInCall.set(false);
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
		channelCallPanelOpen.set(true);
		activeVoiceChannel.set(null);
		activeGroupCall.set({ id: channelId, name: channelName });
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
			playCallActionSound('join');
		}
	}

	if (options.clearOutgoing) {
		outgoingCall.set(null);
	}

	const activeTransport = await resolveActiveTransport(channelId);
	if (activeTransport === 'sfu') {
		await connectLivekitSfu(channelId, localDisplayName || 'Wabi User');
	} else if (activeTransport === 'wabidb' && options.socket) {
		try {
			await connectWabidbCall(options.socket, channelId, localDisplayName || 'Wabi User');
		} catch (error) {
			console.warn('[Calling] wabiDB connection failed, attempting SFU fallback:', error);
			try {
				await connectLivekitSfu(channelId, localDisplayName || 'Wabi User');
			} catch (sfuError) {
				console.error('[Calling] Both wabiDB and SFU failed, will use P2P:', sfuError);
			}
		}
	}
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
			callOfflineNotice.set('No connection to server. Calls require an active connection to the Wabi server.');
			throw new Error('No connection to server. Calls require an active connection to the Wabi server.');
		}

		if (get(isInCall) || get(outgoingCall) || get(incomingCall)) {
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
		channelCallPanelOpen.set(false);
		activeVoiceChannel.set(null);
		activeGroupCall.set({ id: channelId, name: channelName });
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
			localDisplayName: options.localDisplayName?.trim() || 'Wabi User'
		});

		const useExperimentalWabidb = shouldUseExperimentalWabidbCall('group');
		if (useExperimentalWabidb) {
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
		isInCall.set(false);
		localStream.set(null);
		outgoingCall.set(null);
		activeGroupCall.set(null);
		groupCallRingingTargets.set([]);
		callMode.set(null);
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
	channelCallPanelOpen.set(true);
	activeVoiceChannel.set(null);
	activeGroupCall.set(null);
	connectionState.set('signaling');
	outgoingCall.set(null);
	if (stream) {
		startLocalSpeakingMonitor(stream);
		startAudioMonitoring('local', stream, true);
	}
	startPerformanceGuard();
	syncSpatialAudioGraph();
	playCallActionSound('join');
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
				options.localDisplayName?.trim() || 'Wabi User',
				{ playJoinSound: true, socket }
			);
		} else {
			await resolveActiveTransport();
			isInCall.set(true);
			callMode.set('direct');
			channelCallPanelOpen.set(true);
			activeVoiceChannel.set(null);
			activeGroupCall.set(null);
			connectionState.set('signaling');
			isMuted.set(false);
			isVideoOff.set(!isVideoCall);
			startLocalSpeakingMonitor(stream);
			startPerformanceGuard();
			syncSpatialAudioGraph();
			playCallActionSound('join');

			// Start monitoring local audio
			startAudioMonitoring('local', stream, true);
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
		isInCall.set(false);
		localStream.set(null);
		activeGroupCall.set(null);
		groupCallRingingTargets.set([]);
		callMode.set(null);
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
		finalizeLocalCallEndState();
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

export function handleVoiceParticipantJoined(userId: string, username: string): void {
	rememberVoiceParticipantLabel(userId, username);
	playCallActionSound('join');
	const label = resolveVoiceParticipantLabel(userId);
	if (label) {
		pushVoiceChannelNotice(`${label} joined voice`);
	}
}

export function handleVoiceParticipantLeft(userId: string): void {
	playCallActionSound('leave');
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

	if (!isActiveDirectCall) {
		removeCall(userId);
		removeScreenShare(userId);
		return;
	}

	playCallActionSound('leave');
	finalizeLocalCallEndState();
}

export async function handleGroupCallParticipantJoined(
	socket: Socket,
	data: { channelId: string; channelName?: string; userId: string; username: string; stableUserId?: string }
): Promise<void> {
	const pending = get(outgoingCall);
	const activeGroup = get(activeGroupCall);
	const localDisplayName = pending?.localDisplayName || 'Wabi User';
	const isSameActiveGroup = get(callMode) === 'group' && activeGroup?.id === data.channelId;
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
	}

	// Only notify the server when a peer-targeted call session exists.
	// This avoids broadcasting a fake "call ended" event when an outgoing
	// call never connected or was rejected before peer negotiation started.
	if ((endingMode === 'channel' || participantIds.size > 0) && endingMode !== 'group') {
		socket.emit('call-end', {
			participants: Array.from(participantIds)
		});
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
	// Note: Actual deafen (muting remote audio) is handled in the UI component
	// by setting audio elements to muted based on isDeafened store
	void syncLocalAudioState();
	syncSpatialAudioGraph();
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
	options?: { channelId?: string }
) {
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
	callMode.set(null);
	connectionState.set('idle');
	spatialAudioRuntimeStatus.update((state) => ({
		...state,
		active: false,
		effectiveMode: 'off',
		fallbackReason: null
	}));
	const __mgwSessionId3 = getActiveMediaGatewaySessionId();
	if (__mgwSessionId3) {
		void closeMediaGatewaySession(__mgwSessionId3).catch((error) => {
			console.warn('[MediaGateway] Failed to close session on cleanupAllConnections:', error);
		});
		stopMediaGatewaySessionRenewal();
		setActiveMediaGatewaySessionId(null);
	}
	void disconnectLivekitSfu();
}

export function openChannelCallPanel(): void {
	channelCallPanelOpen.set(true);
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

function handleMediaError(error: DOMException, action: string) {
	if (error.name === 'NotAllowedError') {
		alert(`Permission denied: Please allow camera and microphone access to ${action === 'starting' ? 'start' : 'answer'} a call.`);
	} else if (error.name === 'NotFoundError') {
		alert(`No camera or microphone found to ${action === 'starting' ? 'start' : 'answer'} the call.`);
	} else if (error.name === 'NotReadableError' || error.name === 'OverconstrainedError') {
		alert('Camera or microphone is in use or inaccessible. Please close other applications that might be using it.');
	} else {
		alert(`Error ${action} call: ${error.message}`);
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
