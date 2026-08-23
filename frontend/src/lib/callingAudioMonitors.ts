import { get } from 'svelte/store';
import { activeCalls, isDeafened, isLocalSpeaking, isMuted, speakingUsers } from './callingStateStores';
import { ensureSpeakingAudioContext } from './audioCapture';
import {
	SPEAKING_DEBOUNCE_MS,
	SPEAKING_POLL_INTERVAL_MS,
	SPEAKING_RMS_THRESHOLD,
	SPEAKING_THRESHOLD,
	type SpeakingMonitor
} from './callingTypes';

const remoteSpeakingMonitors = new Map<string, SpeakingMonitor>();
let localSpeakingMonitor: SpeakingMonitor | null = null;

function computeRms(data: Uint8Array): number {
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

/**
 * Relay audio-activity pulse: mark a remote user as speaking for a short
 * decay window. The wabidb relay calls this on every inbound audio packet —
 * it has no MediaStream to analyse, so activity = speaking.
 */
let relaySpeakingDecay: Map<string, number> | null = null;
let relayDecayTimer: number | null = null;

export function notifyRelayAudioActivity(userId: string): void {
	if (!relaySpeakingDecay) relaySpeakingDecay = new Map();
	relaySpeakingDecay.set(userId, Date.now() + 700);
	setRemoteSpeakingState(userId, true);
	if (relayDecayTimer == null) {
		relayDecayTimer = window.setInterval(() => {
			const now = Date.now();
			const map = relaySpeakingDecay!;
			for (const [uid, until] of Array.from(map.entries())) {
				if (now > until) {
					map.delete(uid);
					setRemoteSpeakingState(uid, false);
				}
			}
			if (map.size === 0 && relayDecayTimer != null) {
				clearInterval(relayDecayTimer);
				relayDecayTimer = null;
			}
		}, 300);
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

// ============================================================================
// Audio Level Detection
// ============================================================================

interface AudioAnalyzer {
	context: AudioContext;
	analyzer: AnalyserNode;
	dataArray: Uint8Array;
	rafId: number | null;
	debounceTimer: number | null;
}

const audioAnalyzers = new Map<string, AudioAnalyzer>();

export function startAudioMonitoring(userId: string, stream: MediaStream, isLocal: boolean = false): void {
	// Don't monitor if already monitoring
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
			context,
			analyzer,
			dataArray,
			rafId: null,
			debounceTimer: null
		};

		audioAnalyzers.set(userId, analyzerState);

		let lastSpeaking = false;

		function checkAudioLevel() {
			analyzer.getByteFrequencyData(dataArray);

			// Calculate average volume
			const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
			const isSpeaking = average > SPEAKING_THRESHOLD;

			// Only update if state changed
			if (isSpeaking !== lastSpeaking) {
				// Clear existing debounce timer
				if (analyzerState.debounceTimer) {
					clearTimeout(analyzerState.debounceTimer);
				}

				// Debounce the update
				analyzerState.debounceTimer = window.setTimeout(() => {
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

						// Update the activeCalls store
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

			analyzerState.rafId = requestAnimationFrame(checkAudioLevel);
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

	if (analyzerState.rafId) {
		cancelAnimationFrame(analyzerState.rafId);
	}
	if (analyzerState.debounceTimer) {
		clearTimeout(analyzerState.debounceTimer);
	}
	analyzerState.context.close();
	audioAnalyzers.delete(userId);

	// Clean up speaking state
	speakingUsers.update(users => {
		const newSet = new Set(users);
		newSet.delete(userId);
		return newSet;
	});

	console.log(`[AudioMonitoring] Stopped monitoring for ${userId}`);
}
