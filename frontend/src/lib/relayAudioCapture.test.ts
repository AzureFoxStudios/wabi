import { afterEach, describe, expect, test } from 'bun:test';
import OpusRecorder from 'opus-recorder';
import { RelayAudioCapture } from './relayAudioCapture';

const savedStream = globalThis.MediaStream;
afterEach(() => { globalThis.MediaStream = savedStream; });
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(r => { resolve = r; });
	return { promise, resolve };
}
function fixture(initialize = Promise.resolve(), start = () => Promise.resolve()) {
	globalThis.MediaStream = class { constructor(public tracks: any[]) {} } as any;
	const sources: any[] = [];
	const recorders: any[] = [];
	const ctx = {
		createMediaStreamSource(stream: any) {
			const source = { stream, context: ctx, disconnected: 0, disconnect() { this.disconnected++; } };
			sources.push(source);
			return source;
		}
	} as any;
	const capture = new RelayAudioCapture(config => {
		const recorder = {
			config, initialize, started: 0, closed: 0, ondataavailable: (_page: Uint8Array) => {},
			async start(...args: any[]) { expect(args).toHaveLength(0); this.started++; await start(); },
			async close() { this.closed++; }
		};
		recorders.push(recorder);
		return recorder as any;
	});
	const emitted: number[] = [];
	const emit = (_page: Uint8Array, seq: number) => emitted.push(seq);
	const track = (id: string) => ({ id, kind: 'audio', readyState: 'live', stop() { throw new Error('borrowed track stopped'); } }) as any;
	return { ctx, capture, recorders, sources, emitted, emit, track };
}

describe('relay encoder source ownership', () => {
	test('actual dependency source selection uses supplied track, never a second microphone', async () => {
		const f = fixture();
		const screen = f.track('screen-audio');
		await f.capture.start(f.ctx, screen, f.emit);
		const receiver = { config: f.recorders[0].config, sourceNode: null };
		// Execute the installed implementation. Its getUserMedia fallback
		// would fail here: there is deliberately no navigator/mediaDevices.
		await (OpusRecorder.prototype as any).initSourceNode.call(receiver);
		expect((receiver.sourceNode as any).stream.tracks).toEqual([screen]);
		expect(f.recorders[0].config.maxFramesPerPage).toBe(2);
		f.capture.stop();
	});

	test('same track is idempotent; replacement closes old source and resets sequence', async () => {
		const f = fixture();
		const mic = f.track('selected-mic');
		await f.capture.start(f.ctx, mic, f.emit);
		await f.capture.start(f.ctx, mic, f.emit);
		expect(f.recorders).toHaveLength(1);
		const staleCallback = f.recorders[0].ondataavailable;
		staleCallback(new Uint8Array(1));
		await f.capture.start(f.ctx, f.track('replacement-mic'), f.emit);
		staleCallback(new Uint8Array(1));
		f.recorders[1].ondataavailable(new Uint8Array(1));
		expect(f.emitted).toEqual([0, 0]);
		expect(f.recorders[0].closed).toBeGreaterThan(0);
		f.capture.stop();
	});

	test('stop during worklet initialization resolves cancellation and disposes late encoder', async () => {
		const init = deferred();
		const f = fixture(init.promise);
		const ready = f.capture.start(f.ctx, f.track('mic'), f.emit);
		f.capture.stop();
		await ready;
		init.resolve();
		await Promise.resolve();
		expect(f.recorders[0].started).toBe(0);
		expect(f.recorders[0].closed).toBeGreaterThanOrEqual(2);
	});

	test('stop during start suppresses late callbacks and disconnects late source wiring', async () => {
		const start = deferred();
		const f = fixture(Promise.resolve(), () => start.promise);
		const ready = f.capture.start(f.ctx, f.track('mic'), f.emit);
		await Promise.resolve();
		const staleCallback = f.recorders[0].ondataavailable;
		f.capture.stop();
		await ready;
		staleCallback(new Uint8Array(1));
		start.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(f.emitted).toEqual([]);
		expect(f.recorders[0].closed).toBeGreaterThanOrEqual(2);
	});

	test('initialization failure rejects honestly and releases owned nodes', async () => {
		const f = fixture(Promise.reject(new Error('worklet blocked')));
		await expect(f.capture.start(f.ctx, f.track('mic'), f.emit)).rejects.toThrow('worklet blocked');
		expect(f.sources[0].disconnected).toBeGreaterThan(0);
		expect(f.recorders[0].closed).toBeGreaterThan(0);
	});
});
