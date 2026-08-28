/**
 * callRecordingUtils.ts
 * Utility functions for MIME types, file naming, defaults, and audio inputs
 */

import { isDesktopTauri } from './tauri-platform';
import { getCallAudioGraphRecordStream } from './callAudioGraph';
import { getStoredCallRecordingStemMode } from './mediaRuntime';
import type { CallRecordingMode, CallRecordingPreset, CallRecordingSnapshot, RecordingAudioInput } from './callRecordingTypes';
import { AUDIO_MIME_CANDIDATES, VIDEO_MIME_CANDIDATES } from './callRecordingTypes';

export function supportsMimeType(mimeType: string): boolean {
	return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType);
}

export function pickMimeType(mode: CallRecordingMode): string {
	const candidates = mode === 'audio' ? AUDIO_MIME_CANDIDATES : VIDEO_MIME_CANDIDATES;
	for (const mimeType of candidates) {
		if (supportsMimeType(mimeType)) return mimeType;
	}
	return '';
}

export function extensionFromMimeType(mode: CallRecordingMode, mimeType: string): string {
	if (mimeType.includes('mp4')) return mode === 'audio' ? 'm4a' : 'mp4';
	if (mimeType.includes('ogg')) return 'ogg';
	return mode === 'audio' ? 'webm' : 'webm';
}

export function pickAudioMimeType(): string {
	return pickMimeType('audio');
}

function padNumber(value: number): string {
	return value.toString().padStart(2, '0');
}

export function formatTimestampForFileName(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getFullYear()}${padNumber(date.getMonth() + 1)}${padNumber(date.getDate())}-${padNumber(date.getHours())}${padNumber(date.getMinutes())}${padNumber(date.getSeconds())}`;
}

export function buildSuggestedFileName(mode: CallRecordingMode, mimeType: string, startedAt: number): string {
	const extension = extensionFromMimeType(mode, mimeType);
	return `wabi-call-recording-${formatTimestampForFileName(startedAt)}.${extension}`;
}

export function buildStemFileName(stemLabel: string, mimeType: string, startedAt: number): string {
	const extension = extensionFromMimeType('audio', mimeType);
	return `wabi-call-recording-${formatTimestampForFileName(startedAt)}-${sanitizeStemLabel(stemLabel)}.${extension}`;
}

export function getDefaultMode(snapshot: CallRecordingSnapshot): CallRecordingMode {
	if (snapshot.isSharing) return 'video';
	if (snapshot.localScreenStream?.getVideoTracks().length) return 'video';
	if (snapshot.localStream?.getVideoTracks().length && !snapshot.isVideoOff) return 'video';
	if (snapshot.activeCalls.some((call) => call.isVideoEnabled && call.stream.getVideoTracks().length > 0)) return 'video';
	if (snapshot.screenShares.some((share) => share.stream.getVideoTracks().length > 0)) return 'video';
	return 'audio';
}

export function getDefaultPreset(mode: CallRecordingMode): CallRecordingPreset {
	if (mode === 'audio') return 'podcast';
	return isDesktopTauri() ? 'creator' : 'class';
}

export function getDefaultStemMode() {
	return getStoredCallRecordingStemMode();
}

export function hashString(value: string): number {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = value.charCodeAt(index) + ((hash << 5) - hash);
	}
	return Math.abs(hash);
}

export function colorFromLabel(label: string): string {
	const colors = ['#2d5bff', '#0ea5a3', '#e17b2d', '#8b5cf6', '#dc2626', '#16a34a', '#ca8a04'];
	return colors[hashString(label) % colors.length];
}

export function sanitizeStemLabel(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48) || 'stem';
}

export function triggerBrowserDownload(blob: Blob, fileName: string): void {
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

export function buildMixedAudioInputs(snapshot: CallRecordingSnapshot, respectLocalMute: boolean): RecordingAudioInput[] {
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

	// Wabidb transport (2026-08-27): remote audio plays through the shared
	// callAudioGraph instead of per-peer MediaStreams, so the mixed recording
	// captured NOTHING from remote participants. Tap the graph's master bus —
	// but only when no WebRTC call streams are present, or remote voices would
	// be double-counted on p2p (p2p sources also attach to the graph).
	if (inputs.every((input) => input.id === 'local-mic' || input.id === 'share:local')) {
		try {
			const graphStream = getCallAudioGraphRecordStream();
			if (graphStream?.getAudioTracks().length) {
				inputs.push({ id: 'graph:remote', stream: graphStream, gain: 1 });
			}
		} catch {
			/* graph unavailable — mic-only recording still works */
		}
	}

	return inputs;
}

export function buildMicStemInputs(snapshot: CallRecordingSnapshot, respectLocalMute: boolean): RecordingAudioInput[] {
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

export function buildParticipantStemInputs(userId: string) {
	return (snapshot: CallRecordingSnapshot) => {
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

export function buildShareStemInputs(shareId: string, isLocal: boolean) {
	return (snapshot: CallRecordingSnapshot) => {
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

export function buildStemLabel(prefix: string, label: string, sourceId: string): string {
	const suffix = hashString(sourceId).toString(36).slice(0, 4) || 'src';
	return `${prefix}-${label}-${suffix}`;
}

export function ensureMediaRecorderSupport(): void {
	if (typeof MediaRecorder === 'undefined') {
		throw new Error('This runtime does not support call recording.');
	}
}
