/**
 * callRecordingTypes.ts
 * Type definitions and preset configurations for call recording
 */

export type CallRecordingMode = 'audio' | 'video';
export type CallRecordingPreset = 'podcast' | 'class' | 'creator';
export type CallRecordingStatus = 'idle' | 'recording' | 'saving' | 'error';

export interface CallRecordingPresetConfig {
	width: number;
	height: number;
	frameRate: number;
	audioBitsPerSecond: number;
	videoBitsPerSecond: number;
}

export interface CallRecordingState {
	status: CallRecordingStatus;
	mode: CallRecordingMode | null;
	preset: CallRecordingPreset | null;
	stemMode: any; // CallRecordingStemMode from mediaRuntime
	startedAt: number | null;
	elapsedMs: number;
	mimeType: string | null;
	fileName: string | null;
	savedPath: string | null;
	savedPaths: string[];
	savedFileCount: number;
	saveTarget: 'browser' | 'desktop' | null;
	lastError: string | null;
}

export interface CallRecordingSnapshot {
	activeCalls: any[];
	screenShares: any[];
	isInCall: boolean;
	isSharing: boolean;
	isMuted: boolean;
	isVideoOff: boolean;
	isLocalSpeaking: boolean;
	localStream: MediaStream | null;
	localScreenStream: MediaStream | null;
	callMode: 'direct' | 'channel' | 'group' | null;
	activeVoiceChannelId: string | null;
	activeGroupCallId: string | null;
	listeningVoiceChannelIds: string[];
	connectionState: 'idle' | 'signaling' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';
}

export interface RecordingScopeDescriptor {
	scope: any; // CallRecordingScope
	channelId?: string;
}

export interface CallRecordingStartOptions {
	mode?: CallRecordingMode;
	preset?: CallRecordingPreset;
	respectLocalMute?: boolean;
	stemMode?: any; // CallRecordingStemMode
}

export interface RecordingArtifactExport {
	fileName: string;
	savedPath: string | null;
	saveTarget: 'browser' | 'desktop';
}

export interface RecordingExportResult {
	savedPath: string | null;
	savedPaths: string[];
	savedFileCount: number;
	saveTarget: 'browser' | 'desktop';
}

export interface RecordingAudioInput {
	id: string;
	stream: MediaStream;
	gain: number;
}

export interface TileRect {
	tile: any; // RenderTile
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface StemArtifactSpec {
	id: string;
	fileLabel: string;
	resolveInputs: any; // RecordingAudioInputResolver
}

export interface RecordingArtifactHandle {
	id: string;
	fileName: string;
	mimeType: string;
	mode: CallRecordingMode;
	audioMixer: any; // RecordingAudioMixer
	videoComposer: any; // RecordingVideoComposer | null
	outputStream: MediaStream;
	recorder: MediaRecorder;
	chunks: Blob[];
	stopPromise: Promise<RecordingArtifactExport>;
	resolveStop: (result: RecordingArtifactExport) => void;
	rejectStop: (reason?: unknown) => void;
}

export const INITIAL_STATE: CallRecordingState = {
	status: 'idle',
	mode: null,
	preset: null,
	stemMode: null,
	startedAt: null,
	elapsedMs: 0,
	mimeType: null,
	fileName: null,
	savedPath: null,
	savedPaths: [],
	savedFileCount: 0,
	saveTarget: null,
	lastError: null
};

export const PRESETS: Record<CallRecordingPreset, CallRecordingPresetConfig> = {
	podcast: {
		width: 1280,
		height: 720,
		frameRate: 24,
		audioBitsPerSecond: 160_000,
		videoBitsPerSecond: 2_200_000
	},
	class: {
		width: 1280,
		height: 720,
		frameRate: 30,
		audioBitsPerSecond: 128_000,
		videoBitsPerSecond: 3_600_000
	},
	creator: {
		width: 1920,
		height: 1080,
		frameRate: 30,
		audioBitsPerSecond: 160_000,
		videoBitsPerSecond: 8_000_000
	}
};

export const AUDIO_MIME_CANDIDATES = [
	'audio/mp4;codecs=mp4a.40.2',
	'audio/mp4',
	'audio/webm;codecs=opus',
	'audio/webm',
	'audio/ogg'
];

export const VIDEO_MIME_CANDIDATES = [
	'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
	'video/mp4',
	'video/webm;codecs=vp9,opus',
	'video/webm;codecs=vp8,opus',
	'video/webm'
];
