/**
 * audioMonitoring.ts
 * Audio monitoring and speaking detection for local and remote streams
 */

import { get } from 'svelte/store';
import { speakingUsers, activeCalls, isLocalSpeaking, isMuted, isDeafened } from './callingStateStores';
import { ensureSpeakingAudioContext } from './audioCapture';
import {
	SPEAKING_RMS_THRESHOLD,
	SPEAKING_POLL_INTERVAL_MS,
	SPEAKING_THRESHOLD,
	SPEAKING_DEBOUNCE_MS,
	type SpeakingMonitor,
	type AudioAnalyzer
} from './callingTypes';

const remoteSpeakingMonitors = new Map<string, SpeakingMonitor>();
let localSpeakingMonitor: SpeakingMonitor | null = null;
const audioAnalyzers = new Map<string, AudioAnalyzer>();

export function computeRms(data: Uint8Array): number {
	let sumSquares = 0;
	for (let i = 0; i < data.length; i += 1) {
		const normalized = (data[i] - 128) / 128;
		sumSquares += normalized * normalized;
	}
	return Math.sqrt(sumSquares / data.length);
}

function setRemoteSpeakingState(userId: string, isSpeaking: boolean): void {
	speakingUsers.update((users) => {
		const next = new Set(users);
		if (isSpeaking) {
			next.add(userId);
		} else {
			next.delete(userId);
		}
		return next;
	});
	activeCalls.update(calls =>
		calls.map(call => (call.userId === userId ? { ...call, isSpeaking } : call))
	);
}

export function stopRemoteSpeakingMonitor(userId: string): void {
	const monitor = remoteSpeakingMonitors.get(userId);
	if (!monitor) return;
	clearInterval(monitor.intervalId);
	try {
		monitor.source.disconnect();
		monitor.analyser.disconnect();
	} catch {
		// no-op
	}
	remoteSpeakingMonitors.delete(userId);
	setRemoteSpeakingState(userId, false);
}

export function stopAllRemoteSpeakingMonitors(): void {
	for (const userId of remoteSpeakingMonitors.keys()) {
		stopRemoteSpeakingMonitor(userId);
	}
}

export function startRemoteSpeakingMonitor(userId: string, stream: MediaStream): void {
	stopRemoteSpeakingMonitor(userId);

	const audioTrack = stream.getAudioTracks()[0];
	if (!audioTrack || audioTrack.readyState !== 'live') {
		setRemoteSpeakingState(userId, false);
		return;
	}

	const ctx = ensureSpeakingAudioContext();
	if (!ctx) return;

	void ctx.resume().catch(() => undefined);

	const analyser = ctx.createAnalyser();
	analyser.fftSize = 1024;
	analyser.smoothingTimeConstant = 0.5;
	const source = ctx.createMediaStreamSource(stream);
	source.connect(analyser);
	const data = new Uint8Array(analyser.frequencyBinCount);

	const intervalId = window.setInterval(() => {
		if (audioTrack.readyState !== 'live' || !audioTrack.enabled || audioTrack.muted) {
			setRemoteSpeakingState(userId, false);
			return;
		}
		analyser.getByteTimeDomainData(data);
		const speaking = computeRms(data) > SPEAKING_RMS_THRESHOLD;
		setRemoteSpeakingState(userId, speaking);
	}, SPEAKING_POLL_INTERVAL_MS);

	remoteSpeakingMonitors.set(userId, {
		intervalId,
		analyser,
		source,
		data
	});
}

export function stopLocalSpeakingMonitor(): void {
	if (!localSpeakingMonitor) {
		isLocalSpeaking.set(false);
		return;
	}
	clearInterval(localSpeakingMonitor.intervalId);
	try {
		localSpeakingMonitor.source.disconnect();
		localSpeakingMonitor.analyser.disconnect();
	} catch {
		// no-op
	}
	localSpeakingMonitor = null;
	isLocalSpeaking.set(false);
}

export function startLocalSpeakingMonitor(stream: MediaStream): void {
	stopLocalSpeakingMonitor();

	const audioTrack = stream.getAudioTracks()[0];
	if (!audioTrack || audioTrack.readyState !== 'live') {
		isLocalSpeaking.set(false);
		return;
	}

	const ctx = ensureSpeakingAudioContext();
	if (!ctx) return;

	void ctx.resume().catch(() => undefined);

	const analyser = ctx.createAnalyser();
	analyser.fftSize = 1024;
	analyser.smoothingTimeConstant = 0.5;
	const source = ctx.createMediaStreamSource(stream);
	source.connect(analyser);
	const data = new Uint8Array(analyser.frequencyBinCount);

	const intervalId = window.setInterval(() => {
		if (audioTrack.readyState !== 'live' || !audioTrack.enabled || audioTrack.muted || get(isMuted) || get(isDeafened)) {
			isLocalSpeaking.set(false);
			return;
		}
		analyser.getByteTimeDomainData(data);
		isLocalSpeaking.set(computeRms(data) > SPEAKING_RMS_THRESHOLD);
	}, SPEAKING_POLL_INTERVAL_MS);

	localSpeakingMonitor = {
		intervalId,
		analyser,
		source,
		data
	};
}

export function startAudioMonitoring(userId: string, stream: MediaStream, isLocal: boolean = false): void {
	if (audioAnalyzers.has(userId)) return;

	const audioTrack = stream.getAudioTracks()[0];
	if (!audioTrack) return;

	try {
		const context = new AudioContext();
		const analyzer = context.createAnalyser();
		analyzer.fftSize = 512;
		analyzer.smoothingTimeConstant = 0.8;

		const source = context.createMediaStreamSource(stream);
		source.connect(analyzer);

		const dataArray = new Uint8Array(analyzer.frequencyBinCount);

		const analyzerState: AudioAnalyzer = {
			analyser: analyzer,
			source,
			data: dataArray
		};

		audioAnalyzers.set(userId, analyzerState);

		let lastSpeaking = false;
		let debounceTimer: number | null = null;

		function checkAudioLevel() {
			analyzer.getByteFrequencyData(dataArray);

			const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
			const isSpeaking = average > SPEAKING_THRESHOLD;

			if (isSpeaking !== lastSpeaking) {
				if (debounceTimer) {
					clearTimeout(debounceTimer);
				}

				debounceTimer = window.setTimeout(() => {
					if (isLocal) {
						isLocalSpeaking.set(isSpeaking);
					} else {
						speakingUsers.update(users => {
							const newSet = new Set(users);
							if (isSpeaking) {
								newSet.add(userId);
							} else {
								newSet.delete(userId);
							}
							return newSet;
						});

						activeCalls.update(calls => {
							return calls.map(call => {
								if (call.userId === userId) {
									return { ...call, isSpeaking };
								}
								return call;
							});
						});
					}
					lastSpeaking = isSpeaking;
				}, SPEAKING_DEBOUNCE_MS);
			}

			requestAnimationFrame(checkAudioLevel);
		}

		checkAudioLevel();
		console.log(`[AudioMonitoring] Started monitoring for ${userId}`);
	} catch (error) {
		console.error(`[AudioMonitoring] Failed to start monitoring for ${userId}:`, error);
	}
}

export function stopAudioMonitoring(userId: string): void {
	const analyzerState = audioAnalyzers.get(userId);
	if (!analyzerState) return;

	analyzerState.source.disconnect();
	analyzerState.analyser.disconnect();
	audioAnalyzers.delete(userId);
}
