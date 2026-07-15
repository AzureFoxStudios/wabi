/**
 * calling.ts (unified re-export)
 * Maintains 100% backward compatibility
 *
 * Re-exports from:
 * - callingTypes.ts: Type definitions and interfaces
 * - callingStateStores.ts: Svelte stores for state management
 * - audioCapture.ts: Audio capture, DSP, and constraints
 * - audioMonitoring.ts: Speaking detection and audio analysis
 * - livekitToken.ts: LiveKit token refresh logic
 * - calling_impl.ts: Implementation (temporary during refactoring)
 */

// Re-export all types and interfaces
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
	CAMERA_CONSTRAINTS,
	VIDEO_QUALITY_TIER_PARAMS,
	SPEAKING_RMS_THRESHOLD,
	SPEAKING_POLL_INTERVAL_MS,
	SPEAKING_THRESHOLD,
	SPEAKING_DEBOUNCE_MS,
	PERFORMANCE_GUARD_SAMPLE_MS,
	PERFORMANCE_GUARD_LAG_THRESHOLD_MS,
	PERFORMANCE_GUARD_REQUIRED_STRIKES,
	MEDIA_GATEWAY_RENEW_MS,
	MEDIA_GATEWAY_RENEW_FAILURE_LIMIT,
	MEDIA_GATEWAY_WATCHDOG_MS,
	MEDIA_GATEWAY_RUNTIME_POLL_MS,
	LIVEKIT_TOKEN_REFRESH_BUFFER_MS,
	LIVEKIT_TOKEN_REFRESH_BASE_RETRY_MS,
	LIVEKIT_TOKEN_REFRESH_MAX_RETRY_MS,
	LIVEKIT_TOKEN_REFRESH_MAX_RETRIES
} from './callingTypes';

// Re-export all stores
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
	sfuMediaActive,
	callOfflineNotice
} from './callingStateStores';

// Re-export audio capture functions
export {
	getRTCConfig,
	supportsNoiseSuppressionConstraint,
	resolveEffectiveAudioProcessingMode,
	clearActiveAudioCaptureSession,
	createAudioCaptureSession,
	requestCameraStream,
	ensureSpeakingAudioContext
} from './audioCapture';

// Re-export audio monitoring functions
export {
	computeRms,
	stopRemoteSpeakingMonitor,
	stopAllRemoteSpeakingMonitors,
	startRemoteSpeakingMonitor,
	stopLocalSpeakingMonitor,
	startLocalSpeakingMonitor,
	startAudioMonitoring,
	stopAudioMonitoring
} from './audioMonitoring';

// Re-export LiveKit token functions
export {
	scheduleLivekitTokenRefresh,
	cancelLivekitTokenRefresh
} from './livekitToken';

// Import and re-export remaining functionality from implementation
// These will be refactored into separate modules gradually
import {
	clearAudioPerformanceFallbackOverride,
	refreshSpatialAudioRuntime,
	toggleSpatialAudioEnabled,
	joinVoiceChannel,
	leaveVoiceChannel,
	startCall,
	startGroupCall,
	beginEstablishedDirectCall,
	answerCall,
	rejectCall,
	cancelOutgoingCall,
	handleIncomingCallCancelled,
	handleGroupCallInviteCleared,
	handleVoiceParticipantJoined,
	handleVoiceParticipantLeft,
	handleRemoteDirectCallEnded,
	handleGroupCallParticipantJoined,
	handleGroupCallParticipantLeft,
	stopGroupCallRingingTarget,
	endCall,
	toggleMute,
	applyCurrentAudioProcessingToLocalTrack,
	toggleDeafen,
	toggleVideo,
	createCallOffer,
	handleCallOffer,
	handleCallAnswer,
	handleCallIceCandidate,
	canScreenShare,
	startScreenShare,
	stopScreenShare,
	createScreenShareOffer,
	handleScreenShareOffer,
	handleScreenShareAnswer,
	handleScreenShareIceCandidate,
	removeCall,
	removeScreenShare,
	cleanupAllConnections,
	openChannelCallPanel,
	closeChannelCallPanel,
	toggleChannelCallPanel,
	setVoiceTransmitRoutingMode,
	refreshLocalAudioMuteState,
	addVoiceChannelListen,
	removeVoiceChannelListen,
	isSfuMediaTransportActive,
	updateCallUsername
} from './calling_impl';

export {
	clearAudioPerformanceFallbackOverride,
	refreshSpatialAudioRuntime,
	toggleSpatialAudioEnabled,
	joinVoiceChannel,
	leaveVoiceChannel,
	startCall,
	startGroupCall,
	beginEstablishedDirectCall,
	answerCall,
	rejectCall,
	cancelOutgoingCall,
	handleIncomingCallCancelled,
	handleGroupCallInviteCleared,
	handleVoiceParticipantJoined,
	handleVoiceParticipantLeft,
	handleRemoteDirectCallEnded,
	handleGroupCallParticipantJoined,
	handleGroupCallParticipantLeft,
	stopGroupCallRingingTarget,
	endCall,
	toggleMute,
	applyCurrentAudioProcessingToLocalTrack,
	toggleDeafen,
	toggleVideo,
	createCallOffer,
	handleCallOffer,
	handleCallAnswer,
	handleCallIceCandidate,
	canScreenShare,
	startScreenShare,
	stopScreenShare,
	createScreenShareOffer,
	handleScreenShareOffer,
	handleScreenShareAnswer,
	handleScreenShareIceCandidate,
	removeCall,
	removeScreenShare,
	cleanupAllConnections,
	openChannelCallPanel,
	closeChannelCallPanel,
	toggleChannelCallPanel,
	setVoiceTransmitRoutingMode,
	refreshLocalAudioMuteState,
	addVoiceChannelListen,
	removeVoiceChannelListen,
	isSfuMediaTransportActive,
	updateCallUsername
};
