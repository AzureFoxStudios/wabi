/**
 * callRecordingArtifact.ts
 * Recording artifact creation, handling, and disposal
 */

import { saveCallRecordingToDesktop } from './tauri-recording';
import { isDesktopTauri } from './tauri-platform';
import type {
	CallRecordingMode,
	CallRecordingPreset,
	CallRecordingSnapshot,
	RecordingArtifactExport,
	RecordingArtifactHandle
} from './callRecordingTypes';
import { PRESETS } from './callRecordingTypes';
import { RecordingAudioMixer, type RecordingAudioInputResolver } from './callRecordingAudio';
export type { RecordingAudioInputResolver };
import { RecordingVideoComposer } from './callRecordingVideo';
import { triggerBrowserDownload } from './callRecordingUtils';
import { getCurrentSnapshot } from './callRecordingSession';

export async function exportRecordingArtifact(blob: Blob, fileName: string): Promise<RecordingArtifactExport> {
	if (isDesktopTauri()) {
		const savedPath = await saveCallRecordingToDesktop(fileName, blob).catch((error) => {
			console.warn('[CallRecording] Desktop save failed, falling back to browser download:', error);
			return null;
		});
		if (savedPath) {
			return {
				fileName,
				savedPath,
				saveTarget: 'desktop',
				blob
			};
		}
	}

	triggerBrowserDownload(blob, fileName);
	return {
		fileName,
		savedPath: null,
		saveTarget: 'browser',
		blob
	};
}

export async function disposeRecordingArtifact(handle: RecordingArtifactHandle): Promise<void> {
	handle.videoComposer?.dispose();
	await handle.audioMixer.dispose();
	for (const track of handle.outputStream.getTracks()) {
		track.stop();
	}
}

export function createRecordingArtifact(options: {
	id: string;
	mode: CallRecordingMode;
	preset: CallRecordingPreset;
	fileName: string;
	mimeType: string;
	resolveInputs: RecordingAudioInputResolver;
	respectLocalMute: boolean | null;
	compressorEnabled?: boolean;
}): RecordingArtifactHandle {
	const snapshot: CallRecordingSnapshot = getCurrentSnapshot();
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

	// Guard against an empty stream: MediaRecorder throws an opaque
	// NotSupportedError if there are no tracks to record.
	if (outputStream.getTracks().length === 0) {
		void disposeRecordingArtifact({
			id: options.id,
			fileName: options.fileName,
			mimeType: options.mimeType,
			mode: options.mode,
			audioMixer,
			videoComposer,
			outputStream,
			recorder: null as unknown as MediaRecorder,
			chunks: [],
			stopPromise: Promise.resolve({ fileName: options.fileName, savedPath: null, saveTarget: 'browser' }),
			resolveStop: () => undefined,
			rejectStop: () => undefined
		}).catch(() => undefined);
		throw new Error('Cannot start recording: no audio or video tracks are available yet.');
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
			// Use the recorder's actual mimeType so the Blob container always
			// matches the bytes (the requested mimeType may be empty/unsupported).
			const effectiveMime =
				handle.recorder.mimeType ||
				handle.mimeType ||
				(handle.mode === 'audio' ? 'audio/webm' : 'video/webm');
			const blob = new Blob(handle.chunks, { type: effectiveMime });
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
