// callState.ts
// State management, types, and lifecycle functions for calling

import { writable, get } from 'svelte/store';
import type { Socket } from 'socket.io-client';
import { Room, RoomEvent, Track } from 'livekit-client';
import { buildRTCConfig, prefetchTurnCredentials } from './turnConfig';
import { playCallActionSound } from './callSounds';
import { closeMediaGatewaySession, renewMediaGatewaySession, getMediaGatewaySession, createLivekitAccessToken } from './mediaGateway';
import {
	getAudioCaptureConstraints,
	getStoredCallMuteBehavior,
	getStoredAudioProcessingMode,
	getMediaRuntimeConfig,
	getScreenShareQualityProfile,
	getScreenShareBitrateOverrideBps,
	resolveCallTransportPlan,
	syncMediaRuntimeFromServer,
	getStoredSpatialAudioSettings,
	setSpatialAudioEnabled,
	getPreferredMicDeviceId,
	getPreferredCameraDeviceId,
	setPreferredMicDeviceId,
	setPreferredCameraDeviceId,
	type AudioProcessingMode,
	type EffectiveCallTransport,
	type CallTransportMode,
	type SpatialAudioMode
} from './mediaRuntime';
import { type EffectiveAudioProcessingMode } from './callingTypes';
import { SpatialAudioEngine, type SpatialRenderMode, type SpatialPosition } from './audio/spatialEngine';
import {
	markExperimentalStdbCallAttempt,
	shouldUseExperimentalStdbCall,
	type ExperimentalStdbCallScope
} from './experimentalStdbCalls';
import { clearAllRecordingPresence } from './callRecordingPresence';

// Import and re-export signaling, media, and action functions from their modules
export {
	createCallOffer,
	handleCallOffer,
	handleCallAnswer,
	handleCallIceCandidate,
	createScreenShareOffer,
	handleScreenShareOffer,
	handleScreenShareAnswer,
	handleScreenShareIceCandidate
} from './callSignaling';

export {
	toggleMute,
	toggleDeafen,
	toggleVideo,
	applyCurrentAudioProcessingToLocalTrack,
	startScreenShare,
	stopScreenShare,
	canScreenShare
} from './callMedia';

export {
	clearAudioPerformanceFallbackOverride,
	refreshSpatialAudioRuntime,
	toggleSpatialAudioEnabled,
	openChannelCallPanel,
	closeChannelCallPanel,
	toggleChannelCallPanel,
	setVoiceTransmitRoutingMode,
	refreshLocalAudioMuteState,
	addVoiceChannelListen,
	removeVoiceChannelListen,
	isSfuMediaTransportActive,
	updateCallUsername
} from './callActions';

// ============================================================================
// Type Definitions
// ============================================================================

export interface Call {
	userId: string;
	username: string;
	stream: MediaStream;
	isVideoEnabled: boolean;
	isAudioEnabled: boolean;
	isSpeaking: boolean;
	sfu?: boolean;
}

export interface IncomingCall {
	userId: string;
	username: string;
	isVideoCall: boolean;
	channelId?: string;
	channelName?: string;
}

export interface OutgoingCall {
	targetUserId?: string;
	channelId?: string;
	channelName?: string;
	username: string;
	isVideoCall: boolean;
	startedAt: number;
	scope: 'direct' | 'group';
	localDisplayName?: string;
}

export interface GroupCallRingingTarget {
	stableUserId: string;
	username: string;
}

export interface ActiveVoiceChannel {
	id: string;
	name: string;
}

export interface ActiveGroupCall {
	id: string;
	name: string;
}

export interface ScreenShare {
	userId: string;
	username: string;
	stream: MediaStream;
}

export type ConnectionLifecycleState =
	| 'idle'
	| 'signaling'
	| 'connecting'
	| 'connected'
	| 'reconnecting'
	| 'disconnected'
	| 'failed';

export interface CallConnectionDiagnostics {
	pingMs: number | null;
	jitterMs: number | null;
	outboundPacketLossPct: number | null;
	inboundPacketLossPct: number | null;
	outboundKbps: number | null;
	inboundKbps: number | null;
	connectionState: ConnectionLifecycleState;
	updatedAt: number | null;
}

// ============================================================================
// Public State Stores
// ============================================================================

export const activeCalls = writable<Call[]>([]);
export const screenShares = writable<ScreenShare[]>([]);
export const incomingCall = writable<IncomingCall | null>(null);
export const outgoingCall = writable<OutgoingCall | null>(null);
export const groupCallRingingTargets = writable<GroupCallRingingTarget[]>([]);
export const isInCall = writable(false);
export const isSharing = writable(false);
export const isMuted = writable(false);
export const isDeafened = writable(false);
export const isVideoOff = writable(false);
export const isLocalSpeaking = writable(false);
export const localStream = writable<MediaStream | null>(null);
export const localScreenStream = writable<MediaStream | null>(null);
export const connectionState = writable<ConnectionLifecycleState>('idle');
export const speakingUsers = writable<Set<string>>(new Set());
export const callConnectionDiagnostics = writable<CallConnectionDiagnostics>({
	pingMs: null,
	jitterMs: null,
	outboundPacketLossPct: null,
	inboundPacketLossPct: null,
	outboundKbps: null,
	inboundKbps: null,
	connectionState: 'idle',
	updatedAt: null
});
export const activeVoiceChannel = writable<ActiveVoiceChannel | null>(null);
export const activeGroupCall = writable<ActiveGroupCall | null>(null);
export const callMode = writable<'direct' | 'channel' | 'group' | null>(null);
export const channelCallPanelOpen = writable(false);
export const voiceChannelNotice = writable<{ id: number; text: string } | null>(null);
export const audioProcessingRuntimeStatus = writable<{
	selected: AudioProcessingMode;
	effective: EffectiveAudioProcessingMode;
	fallbackActive: boolean;
	reason: string | null;
}>({
	selected: getStoredAudioProcessingMode(),
	effective: 'dsp',
	fallbackActive: false,
	reason: null
});
export const callTransportState = writable<{
	mode: CallTransportMode;
	activeTransport: EffectiveCallTransport;
	isFallback: boolean;
	reason: string | null;
	gatewayHealthy: boolean;
	checkedAt: number | null;
	gatewaySessionId: string | null;
	gatewayControlPlaneStatus: 'idle' | 'ready' | 'degraded' | 'lost';
	gatewayMediaPlaneStatus: 'idle' | 'pending' | 'ready' | 'degraded' | 'lost';
	gatewayActiveStreams: number | null;
	gatewayLastSeenAt: number | null;
}>({
	mode: 'auto',
	activeTransport: 'p2p',
	isFallback: false,
	reason: null,
	gatewayHealthy: false,
	checkedAt: null,
	gatewaySessionId: null,
	gatewayControlPlaneStatus: 'idle',
	gatewayMediaPlaneStatus: 'idle',
	gatewayActiveStreams: null,
	gatewayLastSeenAt: null
});
export const listeningVoiceChannels = writable<string[]>([]);
export const voiceTransmitMode = writable<'primary' | 'all-listening'>('primary');
export const spatialAudioRuntimeStatus = writable<{
	active: boolean;
	requestedMode: SpatialAudioMode;
	effectiveMode: 'off' | 'pan_distance' | 'full_3d' | 'stereo';
	fallbackReason: string | null;
	warningMuted: boolean;
	quickToggleVisible: boolean;
}>({
	active: false,
	requestedMode: getStoredSpatialAudioSettings().mode,
	effectiveMode: 'off',
	fallbackReason: null,
	warningMuted: getStoredSpatialAudioSettings().warningMuted,
	quickToggleVisible: getStoredSpatialAudioSettings().quickToggleVisible
});
export const spatialAudioDiagnostics = writable<{
	callSources: number;
	shareSources: number;
	totalSources: number;
	callSeatSlots: number;
	shareSeatSlots: number;
	syncCount: number;
	lastUpdatedAt: number | null;
}>({
	callSources: 0,
	shareSources: 0,
	totalSources: 0,
	callSeatSlots: 0,
	shareSeatSlots: 0,
	syncCount: 0,
	lastUpdatedAt: null
});
export const spatialSeatDebugState = writable<{
	entries: Array<{
		sourceId: string;
		sourceType: 'call' | 'share';
		userId: string;
		username: string;
		seatIndex: number;
		slotCount: number;
		position: SpatialPosition;
		hasAudio: boolean;
		isSpeaking: boolean;
	}>;
	updatedAt: number | null;
}>({
	entries: [],
	updatedAt: null
});
export const sfuMediaActive = writable(false);

// NOTE: The implementation of lifecycle and management functions is in:
// - callSignaling.ts: WebRTC signaling (offer/answer/ICE)
// - callMedia.ts: Media streams (audio/video/screen share)
// - callActions.ts: UI actions (panels, settings, etc.)
// Functions are exported here for convenience

export {
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
	removeCall,
	removeScreenShare,
	cleanupAllConnections
} from './callLifecycle';

