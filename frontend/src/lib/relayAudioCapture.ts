import OpusRecorder from 'opus-recorder';

type RecorderFactory = (config: ConstructorParameters<typeof OpusRecorder>[0]) => OpusRecorder;
interface Capture {
	track: MediaStreamTrack;
	source: MediaStreamAudioSourceNode;
	recorder: OpusRecorder;
	ready: Promise<void>;
	cancel: () => void;
}

/** One borrowed audio track, one encoder. Never acquires or stops a microphone.
 * Source identity and cancellation are synchronous even while initialization
 * waits on a worklet/worker. Every callback belongs to one capture generation.
 */
export class RelayAudioCapture {
	private current: Capture | null = null;
	constructor(private readonly createRecorder: RecorderFactory = config => new OpusRecorder(config)) {}

	start(ctx: AudioContext, track: MediaStreamTrack, emit: (page: Uint8Array, seq: number) => void): Promise<void> {
		if (this.current?.track === track) return this.current.ready;
		this.stop();
		if (track.kind !== 'audio' || track.readyState !== 'live') return Promise.resolve();
		// A one-track view is intentional: MediaStreamAudioSourceNode chooses a
		// track at construction and does NOT follow later stream.addTrack calls.
		const source = ctx.createMediaStreamSource(new MediaStream([track]));
		let recorder: OpusRecorder;
		try {
			recorder = this.createRecorder({
				sourceNode: source,
				numberOfChannels: 1,
				encoderSampleRate: 48000,
				encoderFrameSize: 20,
				maxFramesPerPage: 2, // 40ms, not the dependency's 800ms default
				bufferLength: 1024,
				monitorGain: 0,
				streamPages: true,
				encoderPath: new URL('opus-recorder/dist/encoderWorker.min.js', import.meta.url).href
			});
		} catch (error) {
			source.disconnect();
			throw error;
		}
		let cancel!: () => void;
		const cancelled = new Promise<void>(resolve => { cancel = resolve; });
		const capture: Capture = { track, source, recorder, ready: Promise.resolve(), cancel };
		this.current = capture;
		let seq = 0;
		recorder.ondataavailable = page => {
			if (this.current === capture && track.readyState === 'live') emit(page, seq++);
		};
		const initialize = recorder.initialize;
		// close() before initEncoder completes is insufficient: dispose the
		// late-created encoder too, even when the caller has already left.
		void initialize.then(() => {
			if (this.current !== capture) this.close(capture);
		}, () => {});
		let timer: ReturnType<typeof setTimeout>;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('Relay audio encoder initialization timed out')), 10000);
		});
		const run = async () => {
			await initialize;
			if (this.current !== capture) return;
			try { await recorder.start(); }
			finally { if (this.current !== capture) this.close(capture); }
		};
		capture.ready = Promise.race([run(), cancelled, timeout]).catch(error => {
			if (this.current === capture) this.stop();
			throw error;
		}).finally(() => clearTimeout(timer));
		return capture.ready;
	}

	stop(): void {
		const capture = this.current;
		if (!capture) return;
		this.current = null; // invalidate emission BEFORE any asynchronous cleanup
		capture.cancel();
		capture.recorder.ondataavailable = () => {};
		this.close(capture);
	}

	private close(capture: Capture): void {
		try { capture.source.disconnect(); } catch { /* already detached */ }
		// Live calls discard final pages on mute/leave; flushing via stop()
		// would retain a worker waiter and emit buffered speech after mute.
		try { void capture.recorder.close().catch(() => {}); } catch { /* partially initialized */ }
	}
}
