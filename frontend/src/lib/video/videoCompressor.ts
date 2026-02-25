export type VideoCompressionPresetId = 'balanced_720p' | 'quality_1080p';

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

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
const VIDEO_FILE_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mpeg', '.mpg'];

const PRESETS: Record<VideoCompressionPresetId, VideoCompressionPreset> = {
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
	if (file.type.toLowerCase().startsWith('video/')) return true;
	const lowerName = file.name.toLowerCase();
	return VIDEO_FILE_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
}

export async function compressVideoFileForUpload(
	file: File,
	options: CompressVideoForUploadOptions
): Promise<File> {
	if (!isMediaRecorderSupported()) {
		throw new Error('Video compression is not supported in this runtime.');
	}
	if (!isVideoFile(file)) {
		throw new Error('Only video files can be compressed.');
	}

	const preset = PRESETS[options.preset];
	if (!preset) {
		throw new Error('Invalid compression preset.');
	}

	const timeoutMs = Math.max(10_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const timeoutController = new AbortController();
	const linkedAbortController = new AbortController();
	const activeSignal = linkedAbortController.signal;
	const timeoutId = window.setTimeout(() => timeoutController.abort(), timeoutMs);
	const handleTimeoutAbort = () => linkedAbortController.abort();
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
			throw new Error('Video metadata is invalid.');
		}
		if (!video.videoWidth || !video.videoHeight) {
			throw new Error('Video dimensions are unavailable.');
		}

		const { width, height } = resolveTargetDimensions(video.videoWidth, video.videoHeight, preset);
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d', { alpha: false });
		if (!context) {
			throw new Error('Unable to initialize video canvas renderer.');
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
			recorder!.addEventListener('error', () => reject(new Error('Media recorder failed.')), {
				once: true
			});
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
			throw new Error('Compression produced an empty output.');
		}
		if (compressedBlob.size >= file.size) {
			throw new Error('Compression did not reduce file size.');
		}

		return new File([compressedBlob], compressedFileName(file.name, blobType), {
			type: compressedBlob.type || 'video/webm',
			lastModified: Date.now()
		});
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
