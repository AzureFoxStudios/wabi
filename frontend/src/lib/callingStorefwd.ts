/**
 * callingStorefwd.ts
 * TerminalPhone-inspired store-and-forward voice over Socket.IO.
 * Record-hold-release semantics. No WebRTC. Works behind CGNAT / hotel WiFi.
 */

import type { Socket } from 'socket.io-client';
import { browser } from '$app/environment';

interface StorefwdState {
	isRecording: boolean;
	mediaRecorder: MediaRecorder | null;
	recordedChunks: Blob[];
	channelId: string | null;
	recordingStartTime: number;
}

const state: StorefwdState = {
	isRecording: false,
	mediaRecorder: null,
	recordedChunks: [],
	channelId: null,
	recordingStartTime: 0
};

let _socket: Socket | null = null;

// Opus bitrate target: 16kbps mono (TerminalPhone default)
const OPUS_BITRATE = 16000;

export function initStorefwdDeps(socket: Socket): void {
	_socket = socket;

	socket.on('voice-segment', (payload: { channelId: string; fromUserId?: string; audioBase64: string; durationMs: number; sentAt: number }) => {
		// Receive a voice segment from another user
		playSegment(payload.audioBase64, payload.fromUserId ?? 'unknown');
	});
}

export function isStorefwdRecording(): boolean {
	return state.isRecording;
}

export async function startStorefwdRecording(channelId: string): Promise<void> {
	if (!browser || !_socket) return;
	if (state.isRecording) return;

	try {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				sampleRate: 8000,
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true
			}
		});

		// Prefer audio/webcodecs or audio/ogg;codecs=opus, fall back to whatever browser supports
		const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
			? 'audio/webm;codecs=opus'
			: MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
				? 'audio/ogg;codecs=opus'
				: 'audio/webm';

		const recorder = new MediaRecorder(stream, {
			mimeType,
			audioBitsPerSecond: OPUS_BITRATE
		});

		state.recordedChunks = [];
		state.channelId = channelId;
		state.recordingStartTime = Date.now();
		state.isRecording = true;
		state.mediaRecorder = recorder;

		recorder.ondataavailable = (e) => {
			if (e.data.size > 0) {
				state.recordedChunks.push(e.data);
			}
		};

		recorder.onstop = () => {
			state.isRecording = false;
			state.mediaRecorder = null;
			// Stop all tracks to release microphone
			stream.getTracks().forEach(t => t.stop());
			void flushAndSendSegment();
		};

		recorder.start(100); // collect 100ms slices for responsiveness
	} catch (e) {
		console.error('[storefwd] Failed to start recording:', e);
		state.isRecording = false;
		throw e;
	}
}

export function stopStorefwdRecording(): void {
	if (!state.isRecording || !state.mediaRecorder) return;
	state.mediaRecorder.stop();
}

async function flushAndSendSegment(): Promise<void> {
	if (!state.channelId || !_socket || state.recordedChunks.length === 0) return;

	const blob = new Blob(state.recordedChunks, { type: state.recordedChunks[0].type });
	const durationMs = Date.now() - state.recordingStartTime;

	// Convert to base64 for Socket.IO transmission (TerminalPhone style)
	const buffer = await blob.arrayBuffer();
	const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

	_socket.emit('voice-segment', {
		channelId: state.channelId,
		audioBase64: base64,
		durationMs,
		mimeType: blob.type,
		sentAt: Date.now()
	});

	state.recordedChunks = [];
}

async function playSegment(audioUrlOrBase64: string, fromUserId: string): Promise<void> {
	if (!browser) return;
	try {
		let audio: HTMLAudioElement;
		if (audioUrlOrBase64.startsWith('data:') || audioUrlOrBase64.startsWith('http')) {
			audio = new Audio(audioUrlOrBase64);
		} else {
			// Assume base64 blob
			const blob = base64ToBlob(audioUrlOrBase64, 'audio/webm');
			audio = new Audio(URL.createObjectURL(blob));
		}
		audio.play().catch((e) => {
			console.warn('[storefwd] Playback failed:', e);
		});
	} catch (e) {
		console.error('[storefwd] Failed to play segment:', e);
	}
}

function base64ToBlob(base64: string, mimeType: string): Blob {
	const byteChars = atob(base64);
	const byteNumbers = new Array(byteChars.length);
	for (let i = 0; i < byteChars.length; i++) {
		byteNumbers[i] = byteChars.charCodeAt(i);
	}
	const byteArray = new Uint8Array(byteNumbers);
	return new Blob([byteArray], { type: mimeType });
}
