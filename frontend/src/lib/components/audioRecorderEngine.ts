const MAX_DURATION = 300;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'];

export type RecordingState = 'idle' | 'recording' | 'stopped' | 'preview';

export interface RecorderEngine {
	state: RecordingState;
	duration: number;
	level: number;
	audioUrl: string | null;
	audioBlob: Blob | null;
	error: string | null;
	permissionDenied: boolean;
}

export function getSupportedMimeType(): string {
	for (const mimeType of MIME_TYPES) {
		if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
	}
	return 'audio/webm';
}

export function formatTime(seconds: number): string {
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export async function loadDevices(): Promise<MediaDeviceInfo[]> {
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices.filter((d) => d.kind === 'audioinput');
	} catch {
		return [];
	}
}

export function getDeviceLabel(device: MediaDeviceInfo, index: number, t: (key: string, opts?: { values: { index: number } }) => string): string {
	return device.label || t('audio.microphone_fallback', { values: { index: index + 1 } });
}

export interface StartRecordingOpts {
	deviceId: string;
	onStateChange: (state: RecordingState) => void;
	onDurationTick: (duration: number) => void;
	onLevelTick: (level: number) => void;
	onComplete: (blob: Blob, url: string) => void;
	onError: (error: string, permissionDenied: boolean) => void;
	t: (key: string) => string;
}

let timerInterval: number | null = null;
let animationId: number | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;

function stopTimer() {
	if (timerInterval !== null) { clearInterval(timerInterval); timerInterval = null; }
}

function stopVisualization() {
	if (animationId !== null) { cancelAnimationFrame(animationId); animationId = null; }
	if (audioContext) { void audioContext.close().catch(() => undefined); audioContext = null; }
	analyser = null;
}

export function cleanupVisualization() {
	stopVisualization();
}

export async function startRecording(opts: StartRecordingOpts): Promise<{ stream: MediaStream | null; recorder: MediaRecorder | null }> {
	let stream: MediaStream | null = null;
	let recorder: MediaRecorder | null = null;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
				echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000
			}
		});
		const mimeType = getSupportedMimeType();
		recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
		const chunks: Blob[] = [];
		recorder.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data); };
		recorder.onstop = () => {
			if (chunks.length === 0) { opts.onError(opts.t('audio.errors.no_audio'), false); return; }
			const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' });
			if (blob.size > 10 * 1024 * 1024) { opts.onError(opts.t('audio.errors.too_large'), false); return; }
			const url = URL.createObjectURL(blob);
			opts.onComplete(blob, url);
		};
		recorder.start(100);
		opts.onStateChange('recording');
		let duration = 0;
		timerInterval = window.setInterval(() => {
			duration++;
			opts.onDurationTick(duration);
			if (duration >= MAX_DURATION) { if (recorder && recorder.state === 'recording') recorder.stop(); }
		}, 1000);
		// Visualization
		try {
			audioContext = new AudioContext();
			analyser = audioContext.createAnalyser();
			const source = audioContext.createMediaStreamSource(stream);
			analyser.fftSize = 256;
			source.connect(analyser);
			const bufferLength = analyser.frequencyBinCount;
			const dataArray = new Uint8Array(bufferLength);
			const draw = () => {
				animationId = requestAnimationFrame(draw);
				if (!analyser) return;
				analyser.getByteFrequencyData(dataArray);
				opts.onLevelTick(computeLevel(dataArray));
			};
			draw();
		} catch { /* visualization optional */ }
	} catch (err) {
		let error = opts.t('audio.errors.start_failed');
		let permissionDenied = false;
		if (err instanceof Error) {
			if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') { error = opts.t('audio.errors.access_required'); permissionDenied = true; }
			else if (err.name === 'NotFoundError') error = opts.t('audio.errors.not_found');
		}
		opts.onError(error, permissionDenied);
	}
	return { stream, recorder };
}

export function stopRecording(recorder: MediaRecorder | null, state: RecordingState): void {
	if (recorder && state === 'recording') recorder.stop();
}

export function stopAll(stream: MediaStream | null, recorder: MediaRecorder | null, audioUrl: string | null): void {
	stopTimer();
	stopVisualization();
	if (stream) { stream.getTracks().forEach((track) => track.stop()); }
	if (recorder && recorder.state !== 'inactive') recorder.stop();
	if (audioUrl) URL.revokeObjectURL(audioUrl);
}

function computeLevel(data: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < data.length; i += 1) { const n = (data[i] - 128) / 128; sum += n * n; }
	return Math.min(1, Math.sqrt(sum / data.length) * 8);
}

export function drawWaveform(canvas: HTMLCanvasElement | null, analyserNode: AnalyserNode | null, state: RecordingState): void {
	if (!analyserNode || !canvas || state !== 'recording') return;
	const bufferLength = analyserNode.frequencyBinCount;
	const dataArray = new Uint8Array(bufferLength);
	analyserNode.getByteFrequencyData(dataArray);
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	const width = canvas.width;
	const height = canvas.height;
	ctx.clearRect(0, 0, width, height);
	const barWidth = width / bufferLength;
	let x = 0;
	for (let i = 0; i < bufferLength; i++) {
		const barHeight = (dataArray[i] / 255) * height * 0.8;
		const gradient = ctx.createLinearGradient(0, height - barHeight, 0, height);
		gradient.addColorStop(0, '#3b82f6');
		gradient.addColorStop(1, '#60a5fa');
		ctx.fillStyle = gradient;
		ctx.fillRect(x, height - barHeight, barWidth - 1, barHeight);
		x += barWidth;
	}
}
