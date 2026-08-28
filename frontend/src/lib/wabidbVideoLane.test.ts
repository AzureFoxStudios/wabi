import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { get } from 'svelte/store';
import {
	WabidbVideoLane,
	splitFrameIntoChunks,
	wabidbRemoteVideoStreams,
	setWabidbRemoteVideoStream
} from './wabidbVideoLane';

/**
 * Round 5 regression suite: the receiver must expose remote video through the
 * decode canvas's captureStream — NEVER a bare MediaStreamTrackGenerator. The
 * generator track was never fed (no writable wiring), so every remote video
 * tile rendered black on Chromium while diagnostics counted rx/dec > 0
 * (2026-08-26 "picked a window, nothing rendered" / 2026-08-27 "call renders,
 * screenshare doesn't").
 */

class FakeVideoFrame {
	codedWidth: number;
	codedHeight: number;
	closed = false;
	constructor(codedWidth: number, codedHeight: number) {
		this.codedWidth = codedWidth;
		this.codedHeight = codedHeight;
	}
	close(): void {
		this.closed = true;
	}
}

class FakeEncodedVideoChunk {
	type: 'key' | 'delta';
	timestamp: number;
	data: Uint8Array;
	constructor(init: { type: 'key' | 'delta'; timestamp: number; data: Uint8Array }) {
		this.type = init.type;
		this.timestamp = init.timestamp;
		this.data = init.data;
	}
}

class FakeVideoDecoder {
	static instances: FakeVideoDecoder[] = [];
	output: (frame: FakeVideoFrame) => void;
	configuredWidth = 640;
	configuredHeight = 360;
	decodeCount = 0;
	constructor(init: { output: (frame: FakeVideoFrame) => void; error: (e: unknown) => void }) {
		this.output = init.output;
		FakeVideoDecoder.instances.push(this);
	}
	configure(config: { width?: number; height?: number }): void {
		this.configuredWidth = config.width ?? this.configuredWidth;
		this.configuredHeight = config.height ?? this.configuredHeight;
	}
	decode(_chunk: FakeEncodedVideoChunk): void {
		this.decodeCount++;
		// Emit synchronously with the configured dimensions — the lane sizes
		// its canvas from the first decoded frame.
		this.output(new FakeVideoFrame(this.configuredWidth, this.configuredHeight));
	}
	close(): void {}
}

class FakeVideoEncoder {
	static async isConfigSupported(): Promise<{ supported: boolean }> {
		return { supported: true };
	}
	configure(): void {}
	encode(): void {}
	close(): void {}
}

interface FakeCanvas {
	width: number;
	height: number;
	drawCount: number;
	capturedFps: number | null;
	lastStream: { __fromCanvas: boolean; getTracks: () => unknown[] } | null;
	getContext(kind: string): { drawImage: (...args: unknown[]) => void } | null;
	captureStream(fps?: number): { __fromCanvas: boolean; getTracks: () => unknown[] };
}

function fakeCanvas(): FakeCanvas {
	const canvas: FakeCanvas = {
		width: 0,
		height: 0,
		drawCount: 0,
		capturedFps: null,
		lastStream: null,
		getContext(kind) {
			if (kind !== '2d') return null;
			return { drawImage: () => { canvas.drawCount++; } };
		},
		captureStream(fps?: number) {
			canvas.capturedFps = fps ?? null;
			const stream = {
				__fromCanvas: true,
				getTracks: () => [{ kind: 'video', stop: () => {} }]
			};
			canvas.lastStream = stream;
			return stream;
		}
	};
	return canvas;
}

const createdCanvases: FakeCanvas[] = [];

const savedGlobals: Record<string, unknown> = {};

beforeAll(() => {
	for (const key of [
		'VideoEncoder',
		'VideoDecoder',
		'VideoFrame',
		'EncodedVideoChunk',
		'MediaStreamTrackGenerator',
		'MediaStreamTrackProcessor',
		'document'
	]) {
		savedGlobals[key] = (globalThis as Record<string, unknown>)[key];
	}
	(globalThis as any).VideoEncoder = FakeVideoEncoder;
	(globalThis as any).VideoDecoder = FakeVideoDecoder;
	(globalThis as any).VideoFrame = FakeVideoFrame;
	(globalThis as any).EncodedVideoChunk = FakeEncodedVideoChunk;
	// If ANY code path reintroduces the generator fast path, constructing it
	// throws here — the black-tile bug must fail loudly, not silently.
	(globalThis as any).MediaStreamTrackGenerator = class {
		constructor() {
			throw new Error('MediaStreamTrackGenerator must not be used — its writable is never fed');
		}
	};
	(globalThis as any).MediaStreamTrackProcessor = class {};
	(globalThis as any).document = {
		createElement: (tag: string) => {
			if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
			const canvas = fakeCanvas();
			createdCanvases.push(canvas);
			return canvas;
		}
	};
});

afterAll(() => {
	for (const [key, value] of Object.entries(savedGlobals)) {
		(globalThis as Record<string, unknown>)[key] = value;
	}
	FakeVideoDecoder.instances.length = 0;
});

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	wabidbRemoteVideoStreams.set(new Map());
});

function makeLane(): WabidbVideoLane {
	return new WabidbVideoLane({
		sessionId: 'channel:c1',
		userId: '2',
		socket: { id: 'sock-self', emit: () => {} }
	});
}

function screenEnvelopeFrom(userId: string, seq: number, bytes: Uint8Array) {
	return splitFrameIntoChunks('channel:c1', userId, seq, bytes, {
		codec: 'vp8',
		width: 1280,
		height: 720,
		keyFrame: true,
		source: 'screen'
	});
}

describe('wabidb video lane receiver display path', () => {
	test('remote screen frames expose a canvas-captured stream (never an unfed generator)', async () => {
		const lane = makeLane();
		const envelopes = screenEnvelopeFrom('3', 0, new Uint8Array([1, 2, 3, 4]));
		lane.handleRemoteEnvelope({ ...envelopes[0], senderSocket: 'sock-other' });
		await flush();

		const streams = get(wabidbRemoteVideoStreams);
		expect(streams.has('user-3:screen')).toBe(true);
		const stream = streams.get('user-3:screen') as any;
		// The stream must come from canvas.captureStream — the only path that
		// actually carries the decoded frames.
		expect(stream?.__fromCanvas).toBe(true);
		expect(stream.getTracks().length).toBeGreaterThan(0);

		// The decode canvas received the frame and was captured at lane fps.
		const canvas = createdCanvases.at(-1)!;
		expect(canvas.drawCount).toBeGreaterThan(0);
		expect(canvas.capturedFps).toBe(15);

		lane.stopAll();
		setWabidbRemoteVideoStream('user-3:screen', null);
	});

	test('self envelopes (same socket) are dropped before decoding', async () => {
		FakeVideoDecoder.instances.length = 0;
		const lane = makeLane();
		const envelopes = screenEnvelopeFrom('3', 1, new Uint8Array([5, 6]));
		lane.handleRemoteEnvelope({ ...envelopes[0], senderSocket: 'sock-self' });
		await flush();
		expect(get(wabidbRemoteVideoStreams).has('user-3:screen')).toBe(false);
		expect(FakeVideoDecoder.instances.length).toBe(0);
	});

	test('stopAll tears the exposed stream back out of the store', async () => {
		const lane = makeLane();
		const envelopes = screenEnvelopeFrom('4', 0, new Uint8Array([7, 8, 9]));
		lane.handleRemoteEnvelope({ ...envelopes[0], senderSocket: 'sock-other' });
		await flush();
		expect(get(wabidbRemoteVideoStreams).has('user-4:screen')).toBe(true);
		lane.stopAll();
		expect(get(wabidbRemoteVideoStreams).has('user-4:screen')).toBe(false);
	});
});
