/**
 * callingTypes.ts
 * Type definitions, interfaces, and constants for calling functionality
 */

import type { AudioProcessingMode, EffectiveCallTransport, CallTransportMode, SpatialAudioMode } from './mediaRuntime';
import type { SpatialRenderMode, SpatialPosition } from './audio/spatialEngine';

// ============================================================================
// Interfaces
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
	/** 2026-08-27 — transport-agnostic packet totals (WebRTC getStats or
	 * wabidb relay envelope counters; null when the source doesn't report). */
	packetsSent?: number | null;
	packetsReceived?: number | null;
	/** Which transport produced this sample ('webrtc' | 'wabidb' | null). */
	source?: 'webrtc' | 'wabidb' | null;
}

export interface PeerConnectionState {
	pc: RTCPeerConnection;
	type: 'call' | 'screen-share-outbound' | 'screen-share-inbound';
	targetId: string;
	username: string;
	channelId?: string;
	lifecycleState: ConnectionLifecycleState;
	iceCandidateQueue: RTCIceCandidateInit[];
	hasRemoteDescription: boolean;
}

export type SenderMediaKind = 'audio' | 'video';
export type VideoSource = 'camera' | 'screen-share';

export type VideoQualityTier = 'high' | 'medium' | 'low' | 'audio-priority';

export type EffectiveAudioProcessingMode = 'dsp' | 'rnn' | 'studio';

export interface DspAudioPipeline {
	context: AudioContext;
	sourceNode: MediaStreamAudioSourceNode;
	highPass: BiquadFilterNode;
	lowPass: BiquadFilterNode;
	notch: BiquadFilterNode;
	compressor: DynamicsCompressorNode;
	destination: MediaStreamAudioDestinationNode;
	outputTrack: MediaStreamTrack;
}

export interface LocalAudioCaptureSession {
	sourceStream: MediaStream;
	outputTrack: MediaStreamTrack;
	mode: EffectiveAudioProcessingMode;
	pipeline?: DspAudioPipeline;
}

export interface SpeakingMonitor {
	intervalId: number;
	analyser: AnalyserNode;
	source: MediaStreamAudioSourceNode;
	data: Uint8Array;
}

export interface AudioAnalyzer {
	analyser: AnalyserNode;
	source: MediaStreamAudioSourceNode;
	data: Uint8Array;
}

// ============================================================================
// Constants
// ============================================================================

export const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
	width: { ideal: 1280, max: 1920 },
	height: { ideal: 720, max: 1080 },
	frameRate: { ideal: 24, max: 30 }
};

export const VIDEO_QUALITY_TIER_PARAMS: Record<VideoQualityTier, { maxBitrate: number; maxFramerate: number; scaleResolutionDownBy: number }> = {
	high: { maxBitrate: 1_200_000, maxFramerate: 24, scaleResolutionDownBy: 1 },
	medium: { maxBitrate: 750_000, maxFramerate: 20, scaleResolutionDownBy: 1.25 },
	low: { maxBitrate: 420_000, maxFramerate: 15, scaleResolutionDownBy: 1.6 },
	'audio-priority': { maxBitrate: 220_000, maxFramerate: 10, scaleResolutionDownBy: 2 }
};

export const SPEAKING_RMS_THRESHOLD = 0.045;
export const SPEAKING_POLL_INTERVAL_MS = 120;
export const SPEAKING_THRESHOLD = 25;
export const SPEAKING_DEBOUNCE_MS = 300;

export const PERFORMANCE_GUARD_SAMPLE_MS = 1000;
export const PERFORMANCE_GUARD_LAG_THRESHOLD_MS = 220;
export const PERFORMANCE_GUARD_REQUIRED_STRIKES = 3;

export const MEDIA_GATEWAY_RENEW_MS = 120_000;
export const MEDIA_GATEWAY_RENEW_FAILURE_LIMIT = 2;
export const MEDIA_GATEWAY_WATCHDOG_MS = 30000;
export const MEDIA_GATEWAY_RUNTIME_POLL_MS = 20_000;

export const LIVEKIT_TOKEN_REFRESH_BUFFER_MS = 60_000;
export const LIVEKIT_TOKEN_REFRESH_BASE_RETRY_MS = 3_000;
export const LIVEKIT_TOKEN_REFRESH_MAX_RETRY_MS = 30_000;
export const LIVEKIT_TOKEN_REFRESH_MAX_RETRIES = 3;

export type ConnectionKeyType = 'call' | 'screen';
