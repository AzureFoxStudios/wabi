import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
import {
	activeCalls,
	activeGroupCall,
	activeVoiceChannel,
	callMode,
	connectionState,
	isInCall,
	isLocalSpeaking,
	isMuted,
	isSharing,
	isVideoOff,
	listeningVoiceChannels,
	localScreenStream,
	localStream,
	screenShares,
	type Call,
	type ScreenShare
} from './calling';
import {
	buildActiveSpeakerLevels,
	buildParticipants,
	buildRenderTiles,
	buildShares,
	getInitial,
	type RenderTile
} from './callRenderModel';
import { computeCallLayout, DEFAULT_ACTIVE_SPEAKER_STATE, type ActiveSpeakerState } from './callLayoutManager';
import {
	doesCallMuteAffectLocalRecording,
	getStoredCallRecordingStemMode,
	type CallRecordingStemMode
} from './mediaRuntime';
import type { CallRecordingScope } from './callRecordingPresence';
import { getSocket } from './socket-manager';
import { isDesktopTauri } from './tauri-platform';
import { saveCallRecordingToDesktop } from './tauri-recording';

export type CallRecordingMode = 'audio' | 'video';
export type CallRecordingPreset = 'podcast' | 'class' | 'creator';
export type CallRecordingStatus = 'idle' | 'recording' | 'saving' | 'error';

interface CallRecordingPresetConfig {
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
	stemMode: CallRecordingStemMode | null;
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

interface CallRecordingSnapshot {
	activeCalls: Call[];
	screenShares: ScreenShare[];
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

interface RecordingScopeDescriptor {
	scope: CallRecordingScope;
	channelId?: string;
}

interface CallRecordingStartOptions {
	mode?: CallRecordingMode;
	preset?: CallRecordingPreset;
	respectLocalMute?: boolean;
	stemMode?: CallRecordingStemMode;
}

interface RecordingArtifactExport {
	fileName: string;
	savedPath: string | null;
	saveTarget: 'browser' | 'desktop';
}

interface RecordingExportResult {
	savedPath: string | null;
	savedPaths: string[];
	savedFileCount: number;
	saveTarget: 'browser' | 'desktop';
}

const INITIAL_STATE: CallRecordingState = {
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

const PRESETS: Record<CallRecordingPreset, CallRecordingPresetConfig> = {
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

const AUDIO_MIME_CANDIDATES = [
	'audio/mp4;codecs=mp4a.40.2',
	'audio/mp4',
	'audio/webm;codecs=opus',
	'audio/webm',
	'audio/ogg'
];

const VIDEO_MIME_CANDIDATES = [
	'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
	'video/mp4',
	'video/webm;codecs=vp9,opus',
	'video/webm;codecs=vp8,opus',
	'video/webm'
];

export const callRecordingState = writable<CallRecordingState>({ ...INITIAL_STATE });

let currentSession: CallRecordingSession | null = null;
let recordingTimer: ReturnType<typeof setInterval> | null = null;

function getCurrentSnapshot(): CallRecordingSnapshot {
	return {
		activeCalls: get(activeCalls),
		screenShares: get(screenShares),
		isInCall: get(isInCall),
		isSharing: get(isSharing),
		isMuted: get(isMuted),
		isVideoOff: get(isVideoOff),
		isLocalSpeaking: get(isLocalSpeaking),
		localStream: get(localStream),
		localScreenStream: get(localScreenStream),
		callMode: get(callMode),
		activeVoiceChannelId: get(activeVoiceChannel)?.id || null,
		activeGroupCallId: get(activeGroupCall)?.id || null,
		listeningVoiceChannelIds: get(listeningVoiceChannels),
		connectionState: get(connectionState)
	};
}

function resolveRecordingScope(snapshot: CallRecordingSnapshot): RecordingScopeDescriptor | null {
	if (!snapshot.isInCall || !snapshot.callMode) {
		return null;
	}

	if (snapshot.callMode === 'direct') {
		return { scope: 'direct' };
	}

	if (snapshot.callMode === 'group') {
		return snapshot.activeGroupCallId ? { scope: 'group', channelId: snapshot.activeGroupCallId } : null;
	}

	const voiceChannelIds = new Set(snapshot.listeningVoiceChannelIds);
	if (snapshot.activeVoiceChannelId) {
		voiceChannelIds.add(snapshot.activeVoiceChannelId);
	}

	return voiceChannelIds.size > 0 ? { scope: 'channel' } : null;
}

async function updateRecordingPresence(active: boolean, snapshot = getCurrentSnapshot()): Promise<void> {
	const socket = getSocket();
	if (!socket) {
		if (active) {
			throw new Error('Recording requires an active socket connection.');
		}
		return;
	}

	const scope = active ? resolveRecordingScope(snapshot) : null;
	if (active && !scope) {
		throw new Error('Unable to determine the active call scope for recording transparency.');
	}

	const payload = active
		? {
			active,
			scope: scope?.scope,
			channelId: scope?.channelId
		}
		: { active };

	await new Promise<void>((resolve, reject) => {
		socket.emit(
			'call-recording-set-active',
			payload,
			(response?: { ok?: boolean; error?: string }) => {
				if (response?.ok) {
					resolve();
					return;
				}
				reject(new Error(response?.error || 'Failed to publish recording presence.'));
			}
		);
	});
}

function supportsMimeType(mimeType: string): boolean {
	return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType);
}

function pickMimeType(mode: CallRecordingMode): string {
	const candidates = mode === 'audio' ? AUDIO_MIME_CANDIDATES : VIDEO_MIME_CANDIDATES;
	for (const mimeType of candidates) {
		if (supportsMimeType(mimeType)) return mimeType;
	}
	return '';
}

function extensionFromMimeType(mode: CallRecordingMode, mimeType: string): string {
	if (mimeType.includes('mp4')) return mode === 'audio' ? 'm4a' : 'mp4';
	if (mimeType.includes('ogg')) return 'ogg';
	return mode === 'audio' ? 'webm' : 'webm';
}

function pickAudioMimeType(): string {
	return pickMimeType('audio');
}

function padNumber(value: number): string {
	return value.toString().padStart(2, '0');
}

function formatTimestampForFileName(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getFullYear()}${padNumber(date.getMonth() + 1)}${padNumber(date.getDate())}-${padNumber(date.getHours())}${padNumber(date.getMinutes())}${padNumber(date.getSeconds())}`;
}

function buildSuggestedFileName(mode: CallRecordingMode, mimeType: string, startedAt: number): string {
	const extension = extensionFromMimeType(mode, mimeType);
	return `wabi-call-recording-${formatTimestampForFileName(startedAt)}.${extension}`;
}

function buildStemFileName(stemLabel: string, mimeType: string, startedAt: number): string {
	const extension = extensionFromMimeType('audio', mimeType);
	return `wabi-call-recording-${formatTimestampForFileName(startedAt)}-${sanitizeStemLabel(stemLabel)}.${extension}`;
}

function getDefaultMode(snapshot: CallRecordingSnapshot): CallRecordingMode {
	if (snapshot.isSharing) return 'video';
	if (snapshot.localScreenStream?.getVideoTracks().length) return 'video';
	if (snapshot.localStream?.getVideoTracks().length && !snapshot.isVideoOff) return 'video';
	if (snapshot.activeCalls.some((call) => call.isVideoEnabled && call.stream.getVideoTracks().length > 0)) return 'video';
	if (snapshot.screenShares.some((share) => share.stream.getVideoTracks().length > 0)) return 'video';
	return 'audio';
}

function getDefaultPreset(mode: CallRecordingMode): CallRecordingPreset {
	if (mode === 'audio') return 'podcast';
	return isDesktopTauri() ? 'creator' : 'class';
}

function getDefaultStemMode(): CallRecordingStemMode {
	return getStoredCallRecordingStemMode();
}

function startRecordingTimer(): void {
	if (recordingTimer) {
		clearInterval(recordingTimer);
	}
	recordingTimer = setInterval(() => {
		const state = get(callRecordingState);
		if (state.status !== 'recording' || !state.startedAt) return;
		callRecordingState.update((current) => ({
			...current,
			elapsedMs: Date.now() - (current.startedAt || Date.now())
		}));
	}, 500);
}

function stopRecordingTimer(): void {
	if (recordingTimer) {
		clearInterval(recordingTimer);
		recordingTimer = null;
	}
}

function hashString(value: string): number {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = value.charCodeAt(index) + ((hash << 5) - hash);
	}
	return Math.abs(hash);
}

function colorFromLabel(label: string): string {
	const colors = ['#2d5bff', '#0ea5a3', '#e17b2d', '#8b5cf6', '#dc2626', '#16a34a', '#ca8a04'];
	return colors[hashString(label) % colors.length];
}

function sanitizeStemLabel(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48) || 'stem';
}

function triggerBrowserDownload(blob: Blob, fileName: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = fileName;
	anchor.rel = 'noopener';
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	window.setTimeout(() => {
		URL.revokeObjectURL(url);
	}, 60_000);
}

async function exportRecordingArtifact(blob: Blob, fileName: string): Promise<RecordingArtifactExport> {
	if (isDesktopTauri()) {
		const savedPath = await saveCallRecordingToDesktop(fileName, blob).catch((error) => {
			console.warn('[CallRecording] Desktop save failed, falling back to browser download:', error);
			return null;
		});
		if (savedPath) {
			return {
				fileName,
				savedPath,
				saveTarget: 'desktop'
			};
		}
	}

	triggerBrowserDownload(blob, fileName);
	return {
		fileName,
		savedPath: null,
		saveTarget: 'browser'
	};
}

function ensureMediaRecorderSupport(): void {
	if (!browser || typeof MediaRecorder === 'undefined') {
		throw new Error('This runtime does not support call recording.');
	}
}

interface RecordingAudioInput {
	id: string;
	stream: MediaStream;
	gain: number;
}

type RecordingAudioInputResolver = (
	snapshot: CallRecordingSnapshot,
	respectLocalMute: boolean
) => RecordingAudioInput[];

function buildMixedAudioInputs(snapshot: CallRecordingSnapshot, respectLocalMute: boolean): RecordingAudioInput[] {
	const inputs: RecordingAudioInput[] = [];

	if (snapshot.localStream?.getAudioTracks().length) {
		inputs.push({
			id: 'local-mic',
			stream: snapshot.localStream,
			gain: respectLocalMute && snapshot.isMuted ? 0 : 1
		});
	}

	for (const call of snapshot.activeCalls) {
		if (!call.stream.getAudioTracks().length) continue;
		inputs.push({
			id: `call:${call.userId}`,
			stream: call.stream,
			gain: 1
		});
	}

	if (snapshot.localScreenStream?.getAudioTracks().length) {
		inputs.push({
			id: 'share:local',
			stream: snapshot.localScreenStream,
			gain: 1
		});
	}

	for (const share of snapshot.screenShares) {
		if (!share.stream.getAudioTracks().length) continue;
		inputs.push({
			id: `share:${share.userId}`,
			stream: share.stream,
			gain: 1
		});
	}

	return inputs;
}

function buildMicStemInputs(snapshot: CallRecordingSnapshot, respectLocalMute: boolean): RecordingAudioInput[] {
	if (!snapshot.localStream?.getAudioTracks().length) {
		return [];
	}
	return [
		{
			id: 'local-mic',
			stream: snapshot.localStream,
			gain: respectLocalMute && snapshot.isMuted ? 0 : 1
		}
	];
}

function buildParticipantStemInputs(userId: string): RecordingAudioInputResolver {
	return (snapshot) => {
		const call = snapshot.activeCalls.find((entry) => entry.userId === userId);
		if (!call?.stream.getAudioTracks().length) {
			return [];
		}
		return [
			{
				id: `call:${call.userId}`,
				stream: call.stream,
				gain: 1
			}
		];
	};
}

function buildShareStemInputs(shareId: string, isLocal: boolean): RecordingAudioInputResolver {
	return (snapshot) => {
		if (isLocal) {
			if (!snapshot.localScreenStream?.getAudioTracks().length) {
				return [];
			}
			return [
				{
					id: 'share:local',
					stream: snapshot.localScreenStream,
					gain: 1
				}
			];
		}

		const share = snapshot.screenShares.find((entry) => entry.userId === shareId);
		if (!share?.stream.getAudioTracks().length) {
			return [];
		}
		return [
			{
				id: `share:${share.userId}`,
				stream: share.stream,
				gain: 1
			}
		];
	};
}

class RecordingAudioMixer {
	private readonly context = new AudioContext({ sampleRate: 48_000 });
	private readonly compressor = this.context.createDynamicsCompressor();
	private readonly destination = this.context.createMediaStreamDestination();
	private readonly sourceNodes = new Map<string, { source: MediaStreamAudioSourceNode; gain: GainNode }>();
	private readonly respectLocalMuteOverride: boolean | null;
	private readonly resolveInputs: RecordingAudioInputResolver;
	private readonly compressorEnabled: boolean;

	constructor(
		resolveInputs: RecordingAudioInputResolver,
		respectLocalMuteOverride: boolean | null,
		compressorEnabled = true
	) {
		this.resolveInputs = resolveInputs;
		this.respectLocalMuteOverride = respectLocalMuteOverride;
		this.compressorEnabled = compressorEnabled;
		this.compressor.threshold.value = -22;
		this.compressor.knee.value = 18;
		this.compressor.ratio.value = 2.8;
		this.compressor.attack.value = 0.003;
		this.compressor.release.value = 0.18;
		if (this.compressorEnabled) {
			this.compressor.connect(this.destination);
		}
	}

	sync(snapshot: CallRecordingSnapshot): void {
		const respectLocalMute = this.respectLocalMuteOverride ?? doesCallMuteAffectLocalRecording();
		const desired = new Map(this.resolveInputs(snapshot, respectLocalMute).map((input) => [input.id, input]));

		for (const [sourceId, entry] of this.sourceNodes.entries()) {
			const next = desired.get(sourceId);
			if (!next) {
				entry.source.disconnect();
				entry.gain.disconnect();
				this.sourceNodes.delete(sourceId);
				continue;
			}
			entry.gain.gain.value = next.gain;
		}

		for (const [sourceId, entry] of desired.entries()) {
			if (this.sourceNodes.has(sourceId)) continue;
			const source = this.context.createMediaStreamSource(entry.stream);
			const gain = this.context.createGain();
			gain.gain.value = entry.gain;
			source.connect(gain);
			gain.connect(this.compressorEnabled ? this.compressor : this.destination);
			this.sourceNodes.set(sourceId, { source, gain });
		}
	}

	getOutputStream(): MediaStream {
		return this.destination.stream;
	}

	async dispose(): Promise<void> {
		for (const entry of this.sourceNodes.values()) {
			entry.source.disconnect();
			entry.gain.disconnect();
		}
		this.sourceNodes.clear();
		await this.context.close().catch(() => undefined);
	}
}

interface TileRect {
	tile: RenderTile;
	x: number;
	y: number;
	width: number;
	height: number;
}

class RecordingVideoComposer {
	private readonly canvas: HTMLCanvasElement;
	private readonly context: CanvasRenderingContext2D;
	private readonly stream: MediaStream;
	private readonly videoElements = new Map<string, HTMLVideoElement>();
	private readonly width: number;
	private readonly height: number;
	private readonly frameRate: number;
	private activeSpeakerState: ActiveSpeakerState = { ...DEFAULT_ACTIVE_SPEAKER_STATE };
	private renderInterval: ReturnType<typeof setInterval> | null = null;
	private orderedTiles: RenderTile[] = [];
	private heroTileIds: string[] = [];

	constructor(preset: CallRecordingPresetConfig) {
		this.width = preset.width;
		this.height = preset.height;
		this.frameRate = preset.frameRate;
		this.canvas = document.createElement('canvas');
		this.canvas.width = this.width;
		this.canvas.height = this.height;
		const context = this.canvas.getContext('2d', { alpha: false });
		if (!context) {
			throw new Error('Unable to initialize call recording canvas.');
		}
		this.context = context;
		this.stream = this.canvas.captureStream(this.frameRate);
	}

	start(): void {
		if (this.renderInterval !== null) return;
		this.renderInterval = setInterval(() => {
			this.drawFrame();
		}, Math.max(24, Math.round(1000 / this.frameRate)));
		this.drawFrame();
	}

	sync(snapshot: CallRecordingSnapshot): void {
		const participants = buildParticipants(
			snapshot.activeCalls,
			snapshot.isInCall,
			snapshot.localStream,
			snapshot.isVideoOff
		);
		const shares = buildShares(snapshot.screenShares, snapshot.isSharing, snapshot.localScreenStream);
		const renderTiles = buildRenderTiles(participants, shares);
		const tileById = new Map(renderTiles.map((tile) => [tile.id, tile]));
		const activeSpeakerLevels = buildActiveSpeakerLevels(
			participants,
			snapshot.activeCalls,
			snapshot.isLocalSpeaking,
			snapshot.isMuted,
			false
		);
		const layoutResult = computeCallLayout({
			participants: participants.map((participant) => ({
				id: participant.id,
				hasVideo: participant.hasVideo
			})),
			shares: shares.map((share) => ({
				id: share.id,
				participantId: share.participantId
			})),
			pins: [],
			activeSpeakerLevels,
			nowMs: Date.now(),
			activeSpeakerState: this.activeSpeakerState
		});
		this.activeSpeakerState = layoutResult.nextActiveSpeakerState;
		this.heroTileIds = [...layoutResult.heroIds];
		this.orderedTiles = layoutResult.tileIds
			.map((tileId) => tileById.get(tileId))
			.filter((tile): tile is RenderTile => Boolean(tile));
		this.syncVideoElements();
	}

	getStream(): MediaStream {
		return this.stream;
	}

	private syncVideoElements(): void {
		const desired = new Map<string, MediaStream>();
		for (const tile of this.orderedTiles) {
			if (tile.kind === 'avatar' || !tile.stream) continue;
			if (!tile.stream.getVideoTracks().length) continue;
			desired.set(tile.id, tile.stream);
		}

		for (const [tileId, video] of this.videoElements.entries()) {
			if (desired.has(tileId)) continue;
			video.pause();
			video.srcObject = null;
			this.videoElements.delete(tileId);
		}

		for (const [tileId, stream] of desired.entries()) {
			const existing = this.videoElements.get(tileId);
			if (existing) {
				if (existing.srcObject !== stream) {
					existing.srcObject = stream;
					void existing.play().catch(() => undefined);
				}
				continue;
			}
			const video = document.createElement('video');
			video.autoplay = true;
			video.muted = true;
			video.playsInline = true;
			video.srcObject = stream;
			void video.play().catch(() => undefined);
			this.videoElements.set(tileId, video);
		}
	}

	private computeRects(): TileRect[] {
		const tiles = this.orderedTiles;
		if (tiles.length === 0) return [];
		const heroSet = new Set(this.heroTileIds);
		const heroes = tiles.filter((tile) => heroSet.has(tile.id));
		const secondary = tiles.filter((tile) => !heroSet.has(tile.id));

		if (heroes.length === 1) {
			const secondaryHeight = secondary.length > 0 ? Math.min(180, Math.max(104, Math.floor(this.height * 0.22))) : 0;
			const rects: TileRect[] = [
				{
					tile: heroes[0],
					x: 0,
					y: 0,
					width: this.width,
					height: this.height - secondaryHeight
				}
			];
			if (secondaryHeight > 0) {
				const gap = 12;
				const totalGap = gap * Math.max(0, secondary.length - 1);
				const secondaryWidth = Math.max(160, Math.floor((this.width - totalGap) / secondary.length));
				secondary.forEach((tile, index) => {
					rects.push({
						tile,
						x: index * (secondaryWidth + gap),
						y: this.height - secondaryHeight,
						width: secondaryWidth,
						height: secondaryHeight
					});
				});
			}
			return rects;
		}

		if (heroes.length >= 2) {
			const heroHeight = secondary.length > 0 ? Math.floor(this.height * 0.72) : this.height;
			const heroWidth = Math.floor((this.width - 12) / 2);
			const rects: TileRect[] = heroes.slice(0, 2).map((tile, index) => ({
				tile,
				x: index * (heroWidth + 12),
				y: 0,
				width: heroWidth,
				height: heroHeight
			}));
			if (secondary.length > 0) {
				const secondaryY = heroHeight + 12;
				const secondaryHeight = this.height - secondaryY;
				const gap = 12;
				const totalGap = gap * Math.max(0, secondary.length - 1);
				const secondaryWidth = Math.max(140, Math.floor((this.width - totalGap) / secondary.length));
				secondary.forEach((tile, index) => {
					rects.push({
						tile,
						x: index * (secondaryWidth + gap),
						y: secondaryY,
						width: secondaryWidth,
						height: secondaryHeight
					});
				});
			}
			return rects;
		}

		return this.computeGridRects(tiles);
	}

	private computeGridRects(tiles: RenderTile[]): TileRect[] {
		const count = tiles.length;
		const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
		const rows = Math.max(1, Math.ceil(count / columns));
		const gap = 12;
		const tileWidth = Math.floor((this.width - gap * (columns - 1)) / columns);
		const tileHeight = Math.floor((this.height - gap * (rows - 1)) / rows);
		return tiles.map((tile, index) => {
			const column = index % columns;
			const row = Math.floor(index / columns);
			return {
				tile,
				x: column * (tileWidth + gap),
				y: row * (tileHeight + gap),
				width: tileWidth,
				height: tileHeight
			};
		});
	}

	private drawFrame(): void {
		const ctx = this.context;
		ctx.fillStyle = '#0b1018';
		ctx.fillRect(0, 0, this.width, this.height);

		if (this.orderedTiles.length === 0) {
			this.drawEmptyState();
			return;
		}

		for (const rect of this.computeRects()) {
			this.drawTile(rect);
		}
	}

	private drawEmptyState(): void {
		const ctx = this.context;
		ctx.fillStyle = '#121a27';
		ctx.fillRect(0, 0, this.width, this.height);
		ctx.fillStyle = '#f8fafc';
		ctx.font = '600 42px sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText('Call recording', this.width / 2, this.height / 2 - 18);
		ctx.font = '400 24px sans-serif';
		ctx.fillStyle = '#94a3b8';
		ctx.fillText('Waiting for active media', this.width / 2, this.height / 2 + 28);
	}

	private drawTile(rect: TileRect): void {
		const { tile, x, y, width, height } = rect;
		const ctx = this.context;
		const radius = 18;
		ctx.save();
		this.roundRectPath(ctx, x, y, width, height, radius);
		ctx.clip();
		ctx.fillStyle = '#111827';
		ctx.fillRect(x, y, width, height);

		const video = this.videoElements.get(tile.id);
		if (video && video.readyState >= 2) {
			this.drawVideo(video, x, y, width, height, tile.kind === 'screen' ? 'contain' : 'cover');
		} else {
			this.drawAvatarCard(tile, x, y, width, height);
		}

		this.drawTileLabel(tile.label, x, y, width, height);
		ctx.restore();
	}

	private drawVideo(
		video: HTMLVideoElement,
		x: number,
		y: number,
		width: number,
		height: number,
		fit: 'cover' | 'contain'
	): void {
		const ctx = this.context;
		const sourceWidth = video.videoWidth || width;
		const sourceHeight = video.videoHeight || height;
		const sourceRatio = sourceWidth / sourceHeight;
		const destRatio = width / height;
		let drawWidth = width;
		let drawHeight = height;
		let drawX = x;
		let drawY = y;

		if ((fit === 'cover' && sourceRatio > destRatio) || (fit === 'contain' && sourceRatio < destRatio)) {
			drawWidth = height * sourceRatio;
			drawX = x - (drawWidth - width) / 2;
		} else {
			drawHeight = width / sourceRatio;
			drawY = y - (drawHeight - height) / 2;
		}

		ctx.drawImage(video, drawX, drawY, drawWidth, drawHeight);
	}

	private drawAvatarCard(tile: RenderTile, x: number, y: number, width: number, height: number): void {
		const ctx = this.context;
		const baseColor = colorFromLabel(tile.label);
		ctx.fillStyle = baseColor;
		ctx.fillRect(x, y, width, height);
		ctx.fillStyle = 'rgba(15, 23, 42, 0.18)';
		ctx.fillRect(x, y, width, height);

		const circleSize = Math.min(width, height) * 0.34;
		const circleX = x + width / 2;
		const circleY = y + height / 2 - 16;
		ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
		ctx.beginPath();
		ctx.arc(circleX, circleY, circleSize / 2, 0, Math.PI * 2);
		ctx.fill();

		ctx.fillStyle = '#ffffff';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.font = `700 ${Math.max(26, Math.floor(circleSize * 0.44))}px sans-serif`;
		ctx.fillText(getInitial(tile.label), circleX, circleY + 2);
	}

	private drawTileLabel(label: string, x: number, y: number, width: number, height: number): void {
		const ctx = this.context;
		const labelHeight = 34;
		ctx.fillStyle = 'rgba(2, 6, 23, 0.66)';
		ctx.fillRect(x, y + height - labelHeight, width, labelHeight);
		ctx.fillStyle = '#f8fafc';
		ctx.font = '600 16px sans-serif';
		ctx.textAlign = 'left';
		ctx.textBaseline = 'middle';
		ctx.fillText(label, x + 14, y + height - labelHeight / 2);
	}

	private roundRectPath(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		width: number,
		height: number,
		radius: number
	): void {
		const r = Math.min(radius, width / 2, height / 2);
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + width, y, x + width, y + height, r);
		ctx.arcTo(x + width, y + height, x, y + height, r);
		ctx.arcTo(x, y + height, x, y, r);
		ctx.arcTo(x, y, x + width, y, r);
		ctx.closePath();
	}

	dispose(): void {
		if (this.renderInterval !== null) {
			clearInterval(this.renderInterval);
			this.renderInterval = null;
		}
		for (const video of this.videoElements.values()) {
			video.pause();
			video.srcObject = null;
		}
		this.videoElements.clear();
		for (const track of this.stream.getTracks()) {
			track.stop();
		}
	}
}

interface StemArtifactSpec {
	id: string;
	fileLabel: string;
	resolveInputs: RecordingAudioInputResolver;
}

interface RecordingArtifactHandle {
	id: string;
	fileName: string;
	mimeType: string;
	mode: CallRecordingMode;
	audioMixer: RecordingAudioMixer;
	videoComposer: RecordingVideoComposer | null;
	outputStream: MediaStream;
	recorder: MediaRecorder;
	chunks: Blob[];
	stopPromise: Promise<RecordingArtifactExport>;
	resolveStop: (result: RecordingArtifactExport) => void;
	rejectStop: (reason?: unknown) => void;
}

function buildStemLabel(prefix: string, label: string, sourceId: string): string {
	const suffix = hashString(sourceId).toString(36).slice(0, 4) || 'src';
	return `${prefix}-${label}-${suffix}`;
}

function buildStemArtifactSpecs(snapshot: CallRecordingSnapshot, stemMode: CallRecordingStemMode): StemArtifactSpec[] {
	if (stemMode === 'mixed-only') {
		return [];
	}

	const specs: StemArtifactSpec[] = [];

	if (snapshot.localStream?.getAudioTracks().length) {
		specs.push({
			id: 'stem:mic',
			fileLabel: 'mic',
			resolveInputs: buildMicStemInputs
		});
	}

	if (stemMode !== 'mixed-plus-all-audio') {
		return specs;
	}

	for (const call of snapshot.activeCalls) {
		if (!call.stream.getAudioTracks().length) continue;
		specs.push({
			id: `stem:call:${call.userId}`,
			fileLabel: buildStemLabel('participant', call.username || call.userId, `call:${call.userId}`),
			resolveInputs: buildParticipantStemInputs(call.userId)
		});
	}

	if (snapshot.localScreenStream?.getAudioTracks().length) {
		specs.push({
			id: 'stem:share:local',
			fileLabel: 'screen-share-local',
			resolveInputs: buildShareStemInputs('local', true)
		});
	}

	for (const share of snapshot.screenShares) {
		if (!share.stream.getAudioTracks().length) continue;
		specs.push({
			id: `stem:share:${share.userId}`,
			fileLabel: buildStemLabel('screen-share', share.username || share.userId, `share:${share.userId}`),
			resolveInputs: buildShareStemInputs(share.userId, false)
		});
	}

	return specs;
}

async function disposeRecordingArtifact(handle: RecordingArtifactHandle): Promise<void> {
	handle.videoComposer?.dispose();
	await handle.audioMixer.dispose();
	for (const track of handle.outputStream.getTracks()) {
		track.stop();
	}
}

function createRecordingArtifact(options: {
	id: string;
	mode: CallRecordingMode;
	preset: CallRecordingPreset;
	fileName: string;
	mimeType: string;
	resolveInputs: RecordingAudioInputResolver;
	respectLocalMute: boolean | null;
	compressorEnabled?: boolean;
}): RecordingArtifactHandle {
	const snapshot = getCurrentSnapshot();
	const audioMixer = new RecordingAudioMixer(
		options.resolveInputs,
		options.respectLocalMute,
		options.compressorEnabled ?? true
	);
	audioMixer.sync(snapshot);

	let videoComposer: RecordingVideoComposer | null = null;
	let outputStream: MediaStream;
	if (options.mode === 'video') {
		videoComposer = new RecordingVideoComposer(PRESETS[options.preset]);
		videoComposer.sync(snapshot);
		videoComposer.start();
		outputStream = new MediaStream([
			...videoComposer.getStream().getVideoTracks(),
			...audioMixer.getOutputStream().getAudioTracks()
		]);
	} else {
		outputStream = new MediaStream(audioMixer.getOutputStream().getAudioTracks());
	}

	const recorder = new MediaRecorder(outputStream, {
		audioBitsPerSecond: PRESETS[options.preset].audioBitsPerSecond,
		videoBitsPerSecond: options.mode === 'video' ? PRESETS[options.preset].videoBitsPerSecond : undefined,
		mimeType: options.mimeType || undefined
	});

	let resolveStop!: (result: RecordingArtifactExport) => void;
	let rejectStop!: (reason?: unknown) => void;
	const handle: RecordingArtifactHandle = {
		id: options.id,
		fileName: options.fileName,
		mimeType: options.mimeType,
		mode: options.mode,
		audioMixer,
		videoComposer,
		outputStream,
		recorder,
		chunks: [],
		stopPromise: new Promise<RecordingArtifactExport>((resolve, reject) => {
			resolveStop = resolve;
			rejectStop = reject;
		}),
		resolveStop: () => undefined,
		rejectStop: () => undefined
	};
	handle.resolveStop = resolveStop;
	handle.rejectStop = rejectStop;

	recorder.ondataavailable = (event) => {
		if (event.data.size > 0) {
			handle.chunks.push(event.data);
		}
	};

	recorder.onerror = () => {
		handle.rejectStop(new Error(`Recording failed for ${handle.fileName}.`));
	};

	recorder.onstop = async () => {
		try {
			const blob = new Blob(handle.chunks, {
				type: handle.mimeType || (handle.mode === 'audio' ? 'audio/webm' : 'video/webm')
			});
			const exported = await exportRecordingArtifact(blob, handle.fileName);
			handle.resolveStop(exported);
		} catch (error) {
			handle.rejectStop(error);
		} finally {
			await disposeRecordingArtifact(handle);
		}
	};

	recorder.start(1000);
	return handle;
}

class CallRecordingSession {
	private readonly artifacts = new Map<string, RecordingArtifactHandle>();
	private readonly startedAt = Date.now();
	private readonly subscriptions: Array<() => void> = [];
	private readonly mode: CallRecordingMode;
	private readonly preset: CallRecordingPreset;
	private readonly stemMode: CallRecordingStemMode;
	private readonly mainMimeType: string;
	private readonly respectLocalMute: boolean | null;

	private constructor(
		mode: CallRecordingMode,
		preset: CallRecordingPreset,
		stemMode: CallRecordingStemMode,
		mainMimeType: string,
		respectLocalMute: boolean | null
	) {
		this.mode = mode;
		this.preset = preset;
		this.stemMode = stemMode;
		this.mainMimeType = mainMimeType;
		this.respectLocalMute = respectLocalMute;
		this.installSubscriptions();
	}

	static async create(options: {
		mode: CallRecordingMode;
		preset: CallRecordingPreset;
		stemMode: CallRecordingStemMode;
		respectLocalMute: boolean | null;
	}): Promise<CallRecordingSession> {
		ensureMediaRecorderSupport();
		const snapshot = getCurrentSnapshot();
		if (!snapshot.isInCall) {
			throw new Error('Join a call before starting a recording.');
		}

		const session = new CallRecordingSession(
			options.mode,
			options.preset,
			options.stemMode,
			pickMimeType(options.mode),
			options.respectLocalMute
		);

		try {
			session.ensureMainArtifact();
			session.ensureStemArtifacts(snapshot);
			session.refresh(snapshot);
			return session;
		} catch (error) {
			await session.dispose();
			throw error;
		}
	}

	private ensureMainArtifact(): void {
		if (this.artifacts.has('mixed')) return;
		this.artifacts.set(
			'mixed',
			createRecordingArtifact({
				id: 'mixed',
				mode: this.mode,
				preset: this.preset,
				fileName: buildSuggestedFileName(this.mode, this.mainMimeType, this.startedAt),
				mimeType: this.mainMimeType,
				resolveInputs: buildMixedAudioInputs,
				respectLocalMute: this.respectLocalMute,
				compressorEnabled: true
			})
		);
	}

	private ensureStemArtifacts(snapshot: CallRecordingSnapshot): void {
		const stemMimeType = pickAudioMimeType();
		for (const spec of buildStemArtifactSpecs(snapshot, this.stemMode)) {
			if (this.artifacts.has(spec.id)) continue;
			this.artifacts.set(
				spec.id,
				createRecordingArtifact({
					id: spec.id,
					mode: 'audio',
					preset: this.preset,
					fileName: buildStemFileName(spec.fileLabel, stemMimeType, this.startedAt),
					mimeType: stemMimeType,
					resolveInputs: spec.resolveInputs,
					respectLocalMute: this.respectLocalMute,
					compressorEnabled: false
				})
			);
		}
	}

	private installSubscriptions(): void {
		const sync = () => {
			const snapshot = getCurrentSnapshot();
			if (!snapshot.isInCall) {
				void stopCallRecording().catch(() => undefined);
				return;
			}
			this.refresh(snapshot);
		};

		this.subscriptions.push(activeCalls.subscribe(() => sync()));
		this.subscriptions.push(screenShares.subscribe(() => sync()));
		this.subscriptions.push(isSharing.subscribe(() => sync()));
		this.subscriptions.push(isMuted.subscribe(() => sync()));
		this.subscriptions.push(isVideoOff.subscribe(() => sync()));
		this.subscriptions.push(isLocalSpeaking.subscribe(() => sync()));
		this.subscriptions.push(localStream.subscribe(() => sync()));
		this.subscriptions.push(localScreenStream.subscribe(() => sync()));
		this.subscriptions.push(isInCall.subscribe(() => sync()));
	}

	private clearSubscriptions(): void {
		for (const unsubscribe of this.subscriptions) {
			unsubscribe();
		}
		this.subscriptions.length = 0;
	}

	refresh(snapshot = getCurrentSnapshot()): void {
		this.ensureStemArtifacts(snapshot);
		for (const artifact of this.artifacts.values()) {
			artifact.audioMixer.sync(snapshot);
			artifact.videoComposer?.sync(snapshot);
		}
	}

	getState(): Pick<CallRecordingState, 'mode' | 'preset' | 'stemMode' | 'mimeType' | 'fileName' | 'startedAt'> {
		const mainArtifact = this.artifacts.get('mixed');
		return {
			mode: this.mode,
			preset: this.preset,
			stemMode: this.stemMode,
			mimeType: this.mainMimeType || null,
			fileName: mainArtifact?.fileName || null,
			startedAt: this.startedAt
		};
	}

	async stop(): Promise<RecordingExportResult> {
		this.clearSubscriptions();
		const artifacts = [...this.artifacts.values()];
		for (const artifact of artifacts) {
			if (artifact.recorder.state !== 'inactive') {
				artifact.recorder.stop();
			}
		}

		const exports = await Promise.all(artifacts.map((artifact) => artifact.stopPromise));
		const mainExport = exports[0];
		return {
			savedPath: mainExport?.savedPath || exports.find((entry) => entry.savedPath)?.savedPath || null,
			savedPaths: exports.map((entry) => entry.savedPath).filter((value): value is string => Boolean(value)),
			savedFileCount: exports.length,
			saveTarget: mainExport?.saveTarget || 'browser'
		};
	}

	private async dispose(): Promise<void> {
		this.clearSubscriptions();

		const disposals = [...this.artifacts.values()].map((artifact) => disposeRecordingArtifact(artifact));
		this.artifacts.clear();
		await Promise.allSettled(disposals);
	}
}

export async function startCallRecording(options: CallRecordingStartOptions = {}): Promise<void> {
	if (currentSession) {
		throw new Error('A call recording is already active.');
	}

	const snapshot = getCurrentSnapshot();
	const mode = options.mode || getDefaultMode(snapshot);
	const preset = options.preset || getDefaultPreset(mode);
	const respectLocalMute = options.respectLocalMute ?? null;
	const stemMode = options.stemMode || getDefaultStemMode();

	callRecordingState.set({
		...INITIAL_STATE,
		status: 'recording',
		mode,
		preset,
		stemMode,
		startedAt: Date.now(),
		elapsedMs: 0,
		lastError: null
	});

	try {
		await updateRecordingPresence(true, snapshot);
		currentSession = await CallRecordingSession.create({
			mode,
			preset,
			stemMode,
			respectLocalMute
		});
		const sessionState = currentSession.getState();
		callRecordingState.update((current) => ({
			...current,
			mode: sessionState.mode,
			preset: sessionState.preset,
			stemMode: sessionState.stemMode,
			startedAt: sessionState.startedAt,
			mimeType: sessionState.mimeType,
			fileName: sessionState.fileName
		}));
		startRecordingTimer();
	} catch (error) {
		await updateRecordingPresence(false).catch(() => undefined);
		currentSession = null;
		stopRecordingTimer();
		callRecordingState.set({
			...INITIAL_STATE,
			status: 'error',
			lastError: error instanceof Error ? error.message : 'Failed to start call recording.'
		});
		throw error;
	}
}

export async function stopCallRecording(): Promise<void> {
	if (!currentSession) return;
	const session = currentSession;
	currentSession = null;
	stopRecordingTimer();
	await updateRecordingPresence(false).catch(() => undefined);
	callRecordingState.update((current) => ({
		...current,
		status: 'saving'
	}));
	try {
		const exported = await session.stop();
		callRecordingState.update((current) => ({
			...current,
			status: 'idle',
			savedPath: exported.savedPath,
			savedPaths: exported.savedPaths,
			savedFileCount: exported.savedFileCount,
			saveTarget: exported.saveTarget,
			elapsedMs: current.startedAt ? Date.now() - current.startedAt : current.elapsedMs
		}));
		window.setTimeout(() => {
			callRecordingState.update((current) => ({
				...INITIAL_STATE,
				savedPath: current.savedPath,
				savedPaths: current.savedPaths,
				savedFileCount: current.savedFileCount,
				saveTarget: current.saveTarget
			}));
		}, 6_000);
	} catch (error) {
		callRecordingState.set({
			...INITIAL_STATE,
			status: 'error',
			lastError: error instanceof Error ? error.message : 'Failed to save call recording.'
		});
		throw error;
	}
}

export function refreshCallRecordingMix(): void {
	currentSession?.refresh();
}
