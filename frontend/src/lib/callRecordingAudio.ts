/**
 * callRecordingAudio.ts
 * Audio mixing and compression for call recording
 */

import { doesCallMuteAffectLocalRecording } from './mediaRuntime';
import type { CallRecordingSnapshot, RecordingAudioInput } from './callRecordingTypes';

export type RecordingAudioInputResolver = (snapshot: CallRecordingSnapshot, respectLocalMute: boolean) => RecordingAudioInput[];

// A single throwaway context used only to "unlock" audio output within a
// user gesture. Browsers start new AudioContexts in the `running` state once
// the document has sticky user activation, so resuming this from the Record
// button handler lets the per-mixer contexts below start un-suspended.
let gestureUnlockContext: AudioContext | null = null;

export function unlockAudioContext(): void {
	try {
		if (!gestureUnlockContext) {
			gestureUnlockContext = new AudioContext({ sampleRate: 48_000 });
		}
		void gestureUnlockContext.resume().catch(() => undefined);
	} catch {
		// Audio unlock is best-effort; ignore unsupported environments.
	}
}

export class RecordingAudioMixer {
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
		// The mixer context is created after async setup, so resume it eagerly.
		// If the document already has user activation (it does once the user is
		// in a call), this flips the context to `running` instead of `suspended`,
		// preventing silent recordings.
		if (this.context.state === 'suspended') {
			void this.context.resume().catch(() => undefined);
		}
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
