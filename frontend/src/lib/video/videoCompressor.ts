export type VideoCompressionPresetId = 'mobile_540p' | 'balanced_720p' | 'quality_1080p';

interface VideoCompressionPreset {
	maxWidth: number;
	maxHeight: number;
	frameRate: number;
	videoBitsPerSecond: number;
	audioBitsPerSecond: number;
}

type CaptureCapableVideoElement = HTMLVideoElement & {
	captureStream?: () => MediaStream;
};

export interface CompressVideoForUploadOptions {
	preset: VideoCompressionPresetId;
	timeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (percent: number) => void;
}

export interface VideoCompressionInputMetadata {
	durationSeconds: number;
	width: number;
	height: number;
	frameRate: number | null;
}

export interface VideoCompressionEstimate {
	estimatedBytes: number;
	estimatedReductionRatio: number;
	estimatedBitrate: number;
	sourceBitrate: number;
	durationSeconds: number;
	targetWidth: number;
	targetHeight: number;
	confidence: 'low' | 'medium' | 'high';
}

export type VideoCompressionCodecHint = 'vp9' | 'vp8' | 'h264' | 'hevc' | 'av1' | 'unknown';

export type VideoCompressionFailureCode =
	| 'unsupported_runtime'
	| 'not_video_file'
	| 'invalid_preset'
	| 'timeout'
	| 'cancelled'
	| 'invalid_metadata'
	| 'renderer_init_failed'
	| 'media_recorder_failed'
	| 'empty_output'
	| 'not_smaller'
	| 'unknown';

export class VideoCompressionError extends Error {
	readonly code: VideoCompressionFailureCode;
	readonly retryable: boolean;

	constructor(code: VideoCompressionFailureCode, message: string, retryable = true) {
		super(message);
		this.name = 'VideoCompressionError';
		this.code = code;
		this.retryable = retryable;
	}
}

function createVideoCompressionError(
	code: VideoCompressionFailureCode,
	message: string,
	retryable = true
): VideoCompressionError {
	return new VideoCompressionError(code, message, retryable);
}

export function classifyVideoCompressionFailure(error: unknown): VideoCompressionFailureCode {
	if (error instanceof VideoCompressionError) return error.code;
	if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
		return 'cancelled';
	}
	const message = error instanceof Error ? error.message.toLowerCase() : '';
	if (message.includes('abort') || message.includes('cancel')) return 'cancelled';
	if (message.includes('timeout')) return 'timeout';
	if (message.includes('metadata') || message.includes('dimension')) return 'invalid_metadata';
	if (message.includes('media recorder')) return 'media_recorder_failed';
	if (message.includes('empty output')) return 'empty_output';
	if (message.includes('reduce file size')) return 'not_smaller';
	return 'unknown';
}

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
const VIDEO_FILE_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mpeg', '.mpg'];

const PRESETS: Record<VideoCompressionPresetId, VideoCompressionPreset> = {
	mobile_540p: {
		maxWidth: 960,
		maxHeight: 540,
		frameRate: 24,
		videoBitsPerSecond: 900_000,
		audioBitsPerSecond: 64_000
	},
	balanced_720p: {
		maxWidth: 1280,
		maxHeight: 720,
		frameRate: 30,
		videoBitsPerSecond: 1_600_000,
		audioBitsPerSecond: 96_000
	},
	quality_1080p: {
		maxWidth: 1920,
		maxHeight: 1080,
		frameRate: 30,
		videoBitsPerSecond: 3_600_000,
		audioBitsPerSecond: 128_000
	}
};

function isMediaRecorderSupported(): boolean {
	return typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined';
}

function supportsMimeType(mimeType: string): boolean {
	return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType);
}

function pickMimeType(): string {
	const preferred = [
		'video/webm;codecs=vp9,opus',
		'video/webm;codecs=vp8,opus',
		'video/webm'
	];
	for (const mimeType of preferred) {
		if (supportsMimeType(mimeType)) return mimeType;
	}
	return '';
}

function toEvenDimension(value: number): number {
	const rounded = Math.max(2, Math.floor(value));
	return rounded % 2 === 0 ? rounded : rounded - 1;
}

function resolveTargetDimensions(
	sourceWidth: number,
	sourceHeight: number,
	preset: VideoCompressionPreset
): { width: number; height: number } {
	const widthScale = preset.maxWidth / sourceWidth;
	const heightScale = preset.maxHeight / sourceHeight;
	const scale = Math.min(1, widthScale, heightScale);
	const width = toEvenDimension(sourceWidth * scale);
	const height = toEvenDimension(sourceHeight * scale);
	return { width, height };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function inferVideoCodecHint(mimeType: string, fileName = ''): VideoCompressionCodecHint {
	const lowerMime = (mimeType || '').toLowerCase();
	const lowerName = fileName.toLowerCase();
	if (lowerMime.includes('vp9')) return 'vp9';
	if (lowerMime.includes('vp8')) return 'vp8';
	if (lowerMime.includes('av1')) return 'av1';
	if (lowerMime.includes('hevc') || lowerMime.includes('h265')) return 'hevc';
	if (lowerMime.includes('avc') || lowerMime.includes('h264')) return 'h264';

	if (lowerName.endsWith('.webm')) return 'vp9';
	if (lowerName.endsWith('.mov') || lowerName.endsWith('.m4v')) return 'h264';
	if (lowerName.endsWith('.mp4')) return 'h264';
	return 'unknown';
}

export function estimateCompressedVideoOutput(
	fileSize: number,
	metadata: VideoCompressionInputMetadata,
	presetId: VideoCompressionPresetId
): VideoCompressionEstimate {
	const preset = PRESETS[presetId] || PRESETS.balanced_720p;
	const durationSeconds = clamp(metadata.durationSeconds || 0, 0.2, 6 * 60 * 60);
	const sourceBitrate = (Math.max(fileSize, 1) * 8) / durationSeconds;
	const sourceArea = Math.max(1, metadata.width * metadata.height);
	const target = resolveTargetDimensions(
		Math.max(2, metadata.width),
		Math.max(2, metadata.height),
		preset
	);
	const targetArea = Math.max(1, target.width * target.height);
	const areaScale = clamp(targetArea / sourceArea, 0.05, 1);
	const frameRateScale =
		metadata.frameRate && metadata.frameRate > 0
			? clamp(preset.frameRate / metadata.frameRate, 0.25, 1)
			: 0.85;
	const structuralScale = clamp(Math.sqrt(areaScale * frameRateScale), 0.2, 1);
	const presetBitrate = preset.videoBitsPerSecond + preset.audioBitsPerSecond;
	const qualityAdjustedPresetBitrate = Math.round(presetBitrate * (0.82 + structuralScale * 0.28));
	const estimatedBitrate = Math.max(
		180_000,
		Math.min(
			Math.round(sourceBitrate * 0.98),
			qualityAdjustedPresetBitrate
		)
	);
	const overheadMultiplier = 1.04;
	const rawEstimatedBytes = Math.round((estimatedBitrate * durationSeconds * overheadMultiplier) / 8);
	const estimatedBytes = clamp(rawEstimatedBytes, 96 * 1024, Math.round(Math.max(fileSize, 1) * 0.995));
	const estimatedReductionRatio = clamp(
		1 - estimatedBytes / Math.max(fileSize, 1),
		-1,
		1
	);

	let confidence: 'low' | 'medium' | 'high' = 'medium';
	if (!metadata.frameRate || metadata.frameRate <= 0) {
		confidence = 'low';
	} else if (durationSeconds >= 2) {
		confidence = 'high';
	}

	return {
		estimatedBytes,
		estimatedReductionRatio,
		estimatedBitrate,
		sourceBitrate,
		durationSeconds,
		targetWidth: target.width,
		targetHeight: target.height,
		confidence
	};
}

function compressedFileName(originalName: string, mimeType: string): string {
	const ext = mimeType.includes('webm') ? 'webm' : 'bin';
	const base = originalName.replace(/\.[^.]+$/, '') || 'video';
	return `${base}-compressed.${ext}`;
}

function toAbortError(): Error {
	if (typeof DOMException !== 'undefined') {
		return new DOMException('Compression aborted.', 'AbortError');
	}
	return new Error('Compression aborted.');
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw toAbortError();
	}
}

function waitForEvent(
	target: EventTarget,
	eventName: string,
	signal?: AbortSignal
): Promise<Event> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(toAbortError());
		};
		const onEvent = (event: Event) => {
			cleanup();
			resolve(event);
		};
		const onError = () => {
			cleanup();
			reject(new Error(`Failed while waiting for "${eventName}".`));
		};
		const cleanup = () => {
			target.removeEventListener(eventName, onEvent);
			target.removeEventListener('error', onError);
			signal?.removeEventListener('abort', onAbort);
		};

		target.addEventListener(eventName, onEvent, { once: true });
		target.addEventListener('error', onError, { once: true });
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

function buildRecorderOptions(
	preset: VideoCompressionPreset,
	mimeType: string
): MediaRecorderOptions {
	const options: MediaRecorderOptions = {
		videoBitsPerSecond: preset.videoBitsPerSecond,
		audioBitsPerSecond: preset.audioBitsPerSecond
	};
	if (mimeType) {
		options.mimeType = mimeType;
	}
	return options;
}

export function isVideoFile(file: File): boolean {
	if (file.type.toLowerCase().startsWith('audio/')) return false;
	if (file.type.toLowerCase().startsWith('video/')) return true;
	const lowerName = file.name.toLowerCase();
	return VIDEO_FILE_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
}

export async function compressVideoFileForUpload(
	file: File,
	options: CompressVideoForUploadOptions
): Promise<File> {
	if (!isMediaRecorderSupported()) {
		throw createVideoCompressionError(
			'unsupported_runtime',
			'Video compression is not supported in this runtime.',
			false
		);
	}
	if (!isVideoFile(file)) {
		throw createVideoCompressionError('not_video_file', 'Only video files can be compressed.', false);
	}

	const preset = PRESETS[options.preset];
	if (!preset) {
		throw createVideoCompressionError('invalid_preset', 'Invalid compression preset.', false);
	}

	const timeoutMs = Math.max(10_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const timeoutController = new AbortController();
	const linkedAbortController = new AbortController();
	const activeSignal = linkedAbortController.signal;
	let didTimeout = false;
	const timeoutId = window.setTimeout(() => timeoutController.abort(), timeoutMs);
	const handleTimeoutAbort = () => {
		didTimeout = true;
		linkedAbortController.abort();
	};
	const handleExternalAbort = () => linkedAbortController.abort();

	timeoutController.signal.addEventListener('abort', handleTimeoutAbort, { once: true });
	options.signal?.addEventListener('abort', handleExternalAbort, { once: true });

	const sourceUrl = URL.createObjectURL(file);
	const video = document.createElement('video');
	video.src = sourceUrl;
	video.preload = 'metadata';
	video.muted = true;
	video.playsInline = true;
	video.crossOrigin = 'anonymous';

	let animationFrameId = 0;
	let canvasStream: MediaStream | null = null;
	let sourceStream: MediaStream | null = null;
	let recorder: MediaRecorder | null = null;

	try {
		throwIfAborted(activeSignal);
		await waitForEvent(video, 'loadedmetadata', activeSignal);
		throwIfAborted(activeSignal);

		if (!Number.isFinite(video.duration) || video.duration <= 0) {
			throw createVideoCompressionError('invalid_metadata', 'Video metadata is invalid.', false);
		}
		if (!video.videoWidth || !video.videoHeight) {
			throw createVideoCompressionError('invalid_metadata', 'Video dimensions are unavailable.', false);
		}

		const { width, height } = resolveTargetDimensions(video.videoWidth, video.videoHeight, preset);
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d', { alpha: false });
		if (!context) {
			throw createVideoCompressionError(
				'renderer_init_failed',
				'Unable to initialize video canvas renderer.',
				false
			);
		}

		canvasStream = canvas.captureStream(preset.frameRate);
		const captureCapableVideo = video as CaptureCapableVideoElement;
		if (typeof captureCapableVideo.captureStream === 'function') {
			sourceStream = captureCapableVideo.captureStream();
			for (const audioTrack of sourceStream.getAudioTracks()) {
				canvasStream.addTrack(audioTrack);
			}
		}

		const mimeType = pickMimeType();
		recorder = new MediaRecorder(canvasStream, buildRecorderOptions(preset, mimeType));
		const chunks: BlobPart[] = [];
		const finished = new Promise<void>((resolve, reject) => {
			recorder!.addEventListener('dataavailable', (event: BlobEvent) => {
				if (event.data && event.data.size > 0) {
					chunks.push(event.data);
				}
			});
			recorder!.addEventListener('stop', () => resolve(), { once: true });
			recorder!.addEventListener(
				'error',
				() =>
					reject(
						createVideoCompressionError('media_recorder_failed', 'Media recorder failed.', true)
					),
				{
					once: true
				}
			);
		});

		const drawFrame = (): void => {
			if (activeSignal.aborted || video.paused || video.ended) return;
			context.drawImage(video, 0, 0, width, height);
			if (options.onProgress) {
				const progress = Math.min(99, Math.max(0, (video.currentTime / video.duration) * 100));
				options.onProgress(progress);
			}
			animationFrameId = window.requestAnimationFrame(drawFrame);
		};

		recorder.start(500);
		await video.play();
		drawFrame();
		await waitForEvent(video, 'ended', activeSignal);
		if (animationFrameId) {
			window.cancelAnimationFrame(animationFrameId);
			animationFrameId = 0;
		}

		options.onProgress?.(100);
		recorder.stop();
		await finished;

		const blobType = recorder.mimeType.split(';')[0] || 'video/webm';
		const compressedBlob = new Blob(chunks, { type: blobType });
		if (compressedBlob.size <= 0) {
			throw createVideoCompressionError('empty_output', 'Compression produced an empty output.');
		}
		if (compressedBlob.size >= file.size) {
			throw createVideoCompressionError(
				'not_smaller',
				'Compression did not reduce file size.',
				false
			);
		}

		return new File([compressedBlob], compressedFileName(file.name, blobType), {
			type: compressedBlob.type || 'video/webm',
			lastModified: Date.now()
		});
	} catch (error) {
		if (error instanceof VideoCompressionError) {
			throw error;
		}
		if (didTimeout) {
			throw createVideoCompressionError('timeout', 'Compression timed out before completion.');
		}
		const classified = classifyVideoCompressionFailure(error);
		if (classified === 'cancelled') {
			throw createVideoCompressionError('cancelled', 'Compression was cancelled.');
		}
		const message = error instanceof Error ? error.message : 'Compression failed.';
		throw createVideoCompressionError(classified, message);
	} finally {
		if (animationFrameId) {
			window.cancelAnimationFrame(animationFrameId);
		}
		window.clearTimeout(timeoutId);
		timeoutController.signal.removeEventListener('abort', handleTimeoutAbort);
		options.signal?.removeEventListener('abort', handleExternalAbort);

		if (recorder && recorder.state !== 'inactive') {
			try {
				recorder.stop();
			} catch {
				// no-op
			}
		}
		for (const track of canvasStream?.getTracks() || []) {
			try {
				track.stop();
			} catch {
				// no-op
			}
		}
		for (const track of sourceStream?.getTracks() || []) {
			try {
				track.stop();
			} catch {
				// no-op
			}
		}
		try {
			video.pause();
		} catch {
			// no-op
		}
		video.removeAttribute('src');
		video.load();
		URL.revokeObjectURL(sourceUrl);
	}
}

export async function sampleVideoCompressionInputMetadata(
	file: File,
	signal?: AbortSignal
): Promise<VideoCompressionInputMetadata> {
	if (typeof document === 'undefined') {
		throw createVideoCompressionError(
			'unsupported_runtime',
			'Video metadata sampling is unavailable in this runtime.',
			false
		);
	}
	if (!isVideoFile(file)) {
		throw createVideoCompressionError('not_video_file', 'Only video files can be sampled.', false);
	}

	const sourceUrl = URL.createObjectURL(file);
	const video = document.createElement('video');
	video.src = sourceUrl;
	video.preload = 'metadata';
	video.muted = true;
	video.playsInline = true;
	video.crossOrigin = 'anonymous';

	try {
		throwIfAborted(signal);
		await waitForEvent(video, 'loadedmetadata', signal);
		throwIfAborted(signal);

		if (!Number.isFinite(video.duration) || video.duration <= 0) {
			throw createVideoCompressionError('invalid_metadata', 'Video metadata is invalid.', false);
		}
		if (!video.videoWidth || !video.videoHeight) {
			throw createVideoCompressionError('invalid_metadata', 'Video dimensions are unavailable.', false);
		}

		const quality =
			typeof video.getVideoPlaybackQuality === 'function'
				? video.getVideoPlaybackQuality()
				: null;
		const frameRateFromQuality =
			quality && Number.isFinite(quality.totalVideoFrames) && video.duration > 0
				? quality.totalVideoFrames / video.duration
				: null;
		const frameRate =
			frameRateFromQuality && Number.isFinite(frameRateFromQuality) && frameRateFromQuality > 1
				? Math.round(frameRateFromQuality)
				: null;

		return {
			durationSeconds: video.duration,
			width: video.videoWidth,
			height: video.videoHeight,
			frameRate
		};
	} finally {
		try {
			video.pause();
		} catch {
			// no-op
		}
		video.removeAttribute('src');
		video.load();
		URL.revokeObjectURL(sourceUrl);
	}
}
