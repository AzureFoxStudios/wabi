import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { WabidbMediaRelay } from './wabidbMediaRelay';

const globals = { window: globalThis.window, AudioContext: globalThis.AudioContext, AudioWorkletNode: globalThis.AudioWorkletNode, Worker: globalThis.Worker };
const live: WabidbMediaRelay[] = [];
afterEach(() => { live.splice(0).forEach(relay => relay.stop()); Object.assign(globalThis, globals); });
const tick = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };

async function fixture(suspended = false) {
	const workers: any[] = [];
	const worklets: any[] = [];
	const errors: Error[] = [];
	const rendered: string[] = [];
	const unavailable: string[] = [];
	class Node {
		gain = { value: 1, cancelScheduledValues() {}, linearRampToValueAtTime() {} };
		pan = this.gain;
		connect() {} disconnect() {}
	}
	class Context {
		state = suspended ? 'suspended' : 'running'; sampleRate = 48000; currentTime = 0;
		destination = new Node();
		audioWorklet = { addModule: async () => {} };
		createGain() { return new Node(); }
		createStereoPanner() { return new Node(); }
		async close() { this.state = 'closed'; }
		async resume() { if (suspended) await new Promise(() => {}); }
	}
	globalThis.window = { setInterval, clearInterval } as any;
	globalThis.AudioContext = Context as any;
	globalThis.AudioWorkletNode = class extends Node {
		messages: any[] = [];
		port = { onmessage: (_event: any) => {}, postMessage: (data: any) => this.messages.push(data) };
		constructor() { super(); worklets.push(this); }
	} as any;
	globalThis.Worker = class {
		onmessage = (_event: any) => {}; onerror = (_event: any) => {};
		messages: any[] = []; terminated = false;
		constructor() { workers.push(this); }
		postMessage(data: any) { this.messages.push(data); }
		terminate() { this.terminated = true; }
	} as any;
	const socket = Object.assign(new EventEmitter(), { connected: true, id: 'local' });
	const relay = new WabidbMediaRelay({ sessionId: 'channel:one', userId: '1', socket, capture: false,
		onError: e => errors.push(e), onRemoteAudioReady: userId => rendered.push(userId), onRemoteAudioUnavailable: userId => unavailable.push(userId) });
	live.push(relay);
	await relay.start({ getAudioTracks: () => [] } as any);
	await relay.setRoomReady(true);
	const page = (socketId = 'remote', screen = false, bos = true, userId = '2') => socket.emit('wabidb-media', {
		sessionId: 'channel:one', userId, senderSocket: socketId, kind: 'audio',
		...(screen ? { source: 'screen' } : {}), seq: bos ? 0 : 2,
		payload: btoa(String.fromCharCode(79, 103, 103, 83, 0, bos ? 2 : 0))
	});
	return { relay, socket, workers, worklets, errors, page, rendered: () => rendered.length, readyUsers: rendered, unavailable };
}

describe('relay streaming media integration', () => {
	test('autoplay-blocked resume cannot deadlock receive setup or teardown', async () => {
		const f = await fixture(true);
		f.page();
		expect(f.workers).toHaveLength(1);
		f.relay.stop();
		expect(f.workers[0].terminated).toBe(true);
	}, 500);
	test('header-only input is not a timeout; all nine PCM outputs reach playback in order', async () => {
		const f = await fixture();
		f.page();
		expect(f.workers[0].messages[0]).toMatchObject({ command: 'init', bufferLength: 960, outputBufferSampleRate: 48000 });
		await tick();
		expect(f.relay.getDiagnostics().decodeFail).toBe(0);
		for (let n = 1; n <= 9; n++) f.workers[0].onmessage({ data: [new Float32Array(960).fill(n)] });
		await tick();
		expect(f.worklets).toHaveLength(1);
		expect(f.worklets[0].messages.map((m: any) => m.pcm[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(f.relay.getDiagnostics().playedChunks).toBe(0);
		expect(f.rendered()).toBe(0); // queued or decoded is not rendered
		for (let n = 0; n < 25; n++) f.worklets[0].port.onmessage({ data: { type: 'rendered', samples: 960 } });
		expect(f.rendered()).toBe(1);
		expect(f.readyUsers).toEqual(['user-2']);
	});
	test('same-account devices and screen sound have independent decoders', async () => {
		const f = await fixture();
		f.page('device-a'); f.page('device-b'); f.page('device-a', true);
		expect(f.workers).toHaveLength(3);
		f.workers[2].onmessage({ data: [new Float32Array([0.2, 0.4]), new Float32Array([0.6, 0.8])] });
		await tick();
		expect(f.worklets[0].messages[0].pcm[0]).toBeCloseTo(0.4);
		expect(f.worklets[0].messages[0].pcm).toHaveLength(2); // downmix, not concatenate
		for (let n = 0; n < 8; n++) f.worklets[0].port.onmessage({ data: { type: 'rendered', samples: 960 } });
		expect(f.rendered()).toBe(0); // screen alone cannot retire microphone fallback
	});
	test('screen and other peers cannot prime microphone readiness; each peer needs 500ms', async () => {
		const f = await fixture();
		f.page('a'); f.page('b', false, true, '3'); f.page('screen', true);
		for (const worker of f.workers) worker.onmessage({ data: [new Float32Array(960)] });
		await tick();
		const render = (index: number, samples: number) => f.worklets[index].port.onmessage({ data: { type: 'rendered', samples } });
		render(2, 48000); // a whole second of screen sound proves no mic
		render(0, 24000);
		expect(f.readyUsers).toEqual(['user-2']);
		render(1, 128);
		expect(f.readyUsers).toEqual(['user-2']);
		render(1, 24000 - 128);
		expect(f.readyUsers).toEqual(['user-2', 'user-3']);
		render(0, 24000);
		expect(f.readyUsers).toHaveLength(2);
	});
	test('stalled playback and room loss revoke readiness, then require new render evidence', async () => {
		const f = await fixture();
		f.page(); f.workers[0].onmessage({ data: [new Float32Array(960)] });
		await tick();
		const render = () => f.worklets[0].port.onmessage({ data: { type: 'rendered', samples: 24000 } });
		render();
		(f.relay as any).lastRenderedAt.set('2', Date.now() - 2001);
		(f.relay as any).checkPlaybackHealth();
		expect(f.unavailable).toEqual(['user-2']);
		render();
		expect(f.readyUsers).toEqual(['user-2', 'user-2']);
		await f.relay.setRoomReady(false);
		expect(f.unavailable).toHaveLength(2);
		render();
		expect(f.readyUsers).toHaveLength(2);
	});
	test('encoder restart and teardown invalidate late worker output', async () => {
		const f = await fixture();
		f.page();
		const old = f.workers[0];
		f.page();
		expect(old.terminated).toBe(true);
		old.onmessage({ data: [new Float32Array(960)] });
		await tick();
		expect(f.worklets).toHaveLength(0);
		f.workers[1].onmessage({ data: [new Float32Array(960)] });
		f.relay.stop();
		await tick();
		expect(f.worklets).toHaveLength(0);
		expect(f.socket.listenerCount('wabidb-media')).toBe(0);
	});
	test('headerless pages are rejected; socket loss immediately closes the emission gate', async () => {
		const f = await fixture();
		f.page('remote', false, false);
		expect(f.workers).toHaveLength(0);
		expect(f.relay.getDiagnostics().droppedHeaderless).toBe(1);
		let sent = 0;
		f.socket.on('wabidb-media', () => sent++);
		await f.relay.setRoomReady(true);
		(f.relay as any).emitAudio(new Uint8Array(1), 0);
		f.socket.emit('disconnect');
		(f.relay as any).emitAudio(new Uint8Array(1), 1);
		expect(sent).toBe(1);
	});
});
