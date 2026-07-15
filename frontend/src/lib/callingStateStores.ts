/**
 * callingStateStores.ts
 * Svelte stores for call state management
 */

import { writable } from 'svelte/store';
import { getStoredAudioProcessingMode, getStoredSpatialAudioSettings } from './mediaRuntime';
import type {
	Call,
	IncomingCall,
	OutgoingCall,
	GroupCallRingingTarget,
	ActiveVoiceChannel,
	ActiveGroupCall,
	ScreenShare,
	CallConnectionDiagnostics,
	ConnectionLifecycleState
} from './callingTypes';
import type { AudioProcessingMode, EffectiveCallTransport, CallTransportMode, SpatialAudioMode } from './mediaRuntime';
import type { SpatialPosition } from './audio/spatialEngine';

// ============================================================================
// Call State Stores
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

// ============================================================================
// Voice Channel and Group Call Stores
// ============================================================================

export const activeVoiceChannel = writable<ActiveVoiceChannel | null>(null);
export const activeGroupCall = writable<ActiveGroupCall | null>(null);
export const callMode = writable<'direct' | 'channel' | 'group' | null>(null);
export const channelCallPanelOpen = writable(false);
export const voiceChannelNotice = writable<{ id: number; text: string } | null>(null);

// ============================================================================
// Audio Processing Stores
// ============================================================================

export const audioProcessingRuntimeStatus = writable<{
	selected: AudioProcessingMode;
	effective: 'dsp' | 'rnn' | 'studio';
	fallbackActive: boolean;
	reason: string | null;
}>({
	selected: getStoredAudioProcessingMode(),
	effective: 'dsp',
	fallbackActive: false,
	reason: null
});

// ============================================================================
// Transport and Gateway Stores
// ============================================================================

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

// ============================================================================
// Voice Channel Listening Stores
// ============================================================================

export const listeningVoiceChannels = writable<string[]>([]);
export const voiceTransmitMode = writable<'primary' | 'all-listening'>('primary');

// ============================================================================
// Spatial Audio Stores
// ============================================================================

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

// ============================================================================
// SFU Media Activity Store
// ============================================================================

export const sfuMediaActive = writable(false);

// ============================================================================
// Offline / Call Error Notice
// ============================================================================

// Short, user-facing notice shown when a call cannot start due to missing
// server connection or other offline/resilience failures. Cleared on success.
export const callOfflineNotice = writable<string | null>(null);
