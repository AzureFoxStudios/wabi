/**
 * callRecordingAudio.ts
 * Audio mixing and compression for call recording
 */

import { doesCallMuteAffectLocalRecording } from './mediaRuntime';
import type { CallRecordingSnapshot, RecordingAudioInput } from './callRecordingTypes';

export type RecordingAudioInputResolver = (snapshot: CallRecordingSnapshot, respectLocalMute: boolean) => RecordingAudioInput[];

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
