import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type Call = { command: string; args: any };
const calls: Call[] = [];
let capabilities = { available: true, requested: false };
let status: any = { capturing: false, playing: true, pagesSent: 0, captureLevel: 0, streams: [], active: [] };
const channels: Array<{ onmessage?: (page: { seq: number; payload: string }) => void }> = [];

class FakeChannel {
	onmessage?: (page: { seq: number; payload: string }) => void;
	constructor() { channels.push(this); }
}

mock.module('@tauri-apps/api/core', () => ({
	Channel: FakeChannel,
	invoke: async (command: string, args: any) => {
		calls.push({ command, args });
		if (command === 'voice_capabilities') return capabilities;
		if (command === 'voice_poll') return status;
		if (command === 'voice_capture_start' && startGate) await startGate;
		return undefined;
	}
}));

const { NativeRelayCapture, NativeRelayPlayback, nativeVoiceEnabled, resetNativeVoiceForTests, setNativeOutputMuted, setNativeSessionVolume, NATIVE_VOICE_STORAGE_KEY } =
	await import('./nativeVoice');

const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const commands = () => calls.map(call => call.command);
const storage = new Map<string, string>();

beforeEach(() => {
	calls.length = 0;
	channels.length = 0;
	storage.clear();
	capabilities = { available: true, requested: false };
	status = { capturing: false, playing: true, pagesSent: 0, captureLevel: 0, streams: [], active: [] };
	(globalThis as any).window = { __TAURI_INTERNALS__: {} };
	(globalThis as any).localStorage = { getItem: (key: string) => storage.get(key) ?? null };
	startGate = null;
	resetNativeVoiceForTests();
});

afterEach(() => {
	resetNativeVoiceForTests();
	delete (globalThis as any).window;
	delete (globalThis as any).localStorage;
});

describe('nativeVoiceEnabled', () => {
	test('is off outside the desktop shell without asking it', async () => {
		delete (globalThis as any).window;
		expect(await nativeVoiceEnabled()).toBe(false);
		expect(calls).toEqual([]);
	});

	test('needs the engine and an opt-in from the page or the shell', async () => {
		expect(await nativeVoiceEnabled()).toBe(false);
		resetNativeVoiceForTests();
		storage.set(NATIVE_VOICE_STORAGE_KEY, '1');
		expect(await nativeVoiceEnabled()).toBe(true);
		resetNativeVoiceForTests();
		storage.clear();
		capabilities = { available: true, requested: true };
		expect(await nativeVoiceEnabled()).toBe(true);
		resetNativeVoiceForTests();
		storage.set(NATIVE_VOICE_STORAGE_KEY, '0'); // the page's refusal wins
		expect(await nativeVoiceEnabled()).toBe(false);
		resetNativeVoiceForTests();
		storage.set(NATIVE_VOICE_STORAGE_KEY, '1');
		capabilities = { available: false, requested: false };
		expect(await nativeVoiceEnabled()).toBe(false);
	});
});

describe('NativeRelayPlayback', () => {
	const stream = (key: string, playedSamples: number, extra: Record<string, number> = {}) =>
		({ key, decodeOk: 0, decodeFail: 0, audibleChunks: 0, playedSamples, droppedHeaderless: 0, droppedOverflowSamples: 0, ...extra });

	test('forwards pages under the call prefix and applies deafen and volume set before playback', async () => {
		setNativeOutputMuted(true);
		setNativeSessionVolume('call-a', 40);
		const playback = new NativeRelayPlayback('call-a', { isRoomReady: () => true });
		playback.push('alice-mic', 'AAAA', 'alice', false);
		await settle();
		expect(calls.find(call => call.command === 'voice_push')?.args).toEqual({ stream: 'call-a\u001falice-mic', payload: 'AAAA' });
		expect(calls.find(call => call.command === 'voice_set_deafened')?.args).toEqual({ deafened: true });
		expect(calls.find(call => call.command === 'voice_set_group_volume')?.args).toEqual({ prefix: 'call-a\u001f', volume: 0.4 });
		playback.stop();
		await settle();
		expect(calls.find(call => call.command === 'voice_remove_group')?.args).toEqual({ prefix: 'call-a\u001f' });
		// Nothing uses the engine any more: its streams are closed.
		expect(commands().at(-1)).toBe('voice_shutdown');
	});

	test('a sender is ready after 500 ms played, unavailable after a stall, and screen audio never counts', () => {
		const events: string[] = [];
		let roomReady = true;
		const playback = new NativeRelayPlayback('call-b', {
			isRoomReady: () => roomReady,
			onRemoteAudioReady: user => events.push(`ready:${user}`),
			onRemoteAudioUnavailable: user => events.push(`gone:${user}`),
			onRemoteAudioActivity: user => events.push(`speaking:${user}`)
		});
		playback.push('bob-mic', 'AAAA', 'bob', false);
		playback.push('bob-screen', 'AAAA', 'bob', true);
		const base = { capturing: false, playing: true, pagesSent: 0, captureLevel: 0 };
		playback.applyStatus({ ...base, streams: [stream('call-b\u001fbob-screen', 96000), stream('other\u001fbob-mic', 96000)], active: ['call-b\u001fbob-screen'] }, 1000);
		expect(events).toEqual([]);
		playback.applyStatus({ ...base, streams: [stream('call-b\u001fbob-mic', 12000)], active: ['call-b\u001fbob-mic'] }, 1250);
		expect(events).toEqual(['speaking:bob']);
		playback.applyStatus({ ...base, streams: [stream('call-b\u001fbob-mic', 24000, { decodeOk: 25, audibleChunks: 20 })], active: [] }, 1500);
		expect(events).toEqual(['speaking:bob', 'ready:bob']);
		expect(playback.counters()).toMatchObject({ decodeOk: 25, audibleChunks: 20, playedChunks: 25 });
		playback.applyStatus({ ...base, streams: [stream('call-b\u001fbob-mic', 24000)], active: [] }, 3600);
		expect(events.at(-1)).toBe('gone:bob');
		// Ready again only after another 500 ms plays.
		playback.applyStatus({ ...base, streams: [stream('call-b\u001fbob-mic', 30000)], active: [] }, 3700);
		expect(events.at(-1)).toBe('gone:bob');
		playback.applyStatus({ ...base, streams: [stream('call-b\u001fbob-mic', 48000)], active: [] }, 3900);
		expect(events.at(-1)).toBe('ready:bob');
		roomReady = false;
		playback.applyStatus({ ...base, streams: [stream('call-b\u001fbob-mic', 60000)], active: [] }, 4000);
		expect(events.at(-1)).toBe('gone:bob');
		playback.stop();
	});
});

let startGate: Promise<void> | null = null;

describe('NativeRelayCapture', () => {
	const track = (enabled = true) => ({ kind: 'audio', readyState: 'live', enabled }) as unknown as MediaStreamTrack;
	const context = {} as AudioContext;

	test('delivers engine pages to the relay and stops the engine when it stops', async () => {
		const pages: Array<[number[], number]> = [];
		const capture = new NativeRelayCapture();
		await capture.start(context, track(), (page, seq) => pages.push([Array.from(page), seq]));
		expect(commands()).toContain('voice_capture_start');
		channels[0].onmessage?.({ seq: 0, payload: btoa('Og') });
		expect(pages).toEqual([[[79, 103], 0]]);
		capture.stop();
		await settle();
		expect(commands().at(-1)).toBe('voice_capture_stop');
		channels[0].onmessage?.({ seq: 1, payload: btoa('Og') }); // a page already in flight
		expect(pages.length).toBe(1);
	});

	test('a muted microphone track keeps the engine microphone closed', async () => {
		const microphone = track(false);
		const pages: number[] = [];
		const capture = new NativeRelayCapture();
		await capture.start(context, microphone, (_page, seq) => pages.push(seq));
		expect(commands()).not.toContain('voice_capture_start');
		(microphone as any).enabled = true;
		await settle(400); // the watcher notices the unmute
		expect(commands()).toContain('voice_capture_start');
		(microphone as any).enabled = false;
		channels[0].onmessage?.({ seq: 5, payload: btoa('Og') });
		expect(pages).toEqual([]);
		await settle(400);
		expect(commands()).toContain('voice_capture_stop');
		capture.stop();
	});

	test('a stop that lands while the start is still in flight closes the microphone afterwards', async () => {
		let open!: () => void;
		startGate = new Promise<void>(resolve => { open = resolve; });
		const capture = new NativeRelayCapture();
		const starting = capture.start(context, track(), () => {});
		await settle();
		expect(commands()).toContain('voice_capture_start');
		capture.stop(); // the shell has not finished opening the microphone yet
		await settle();
		expect(commands()).not.toContain('voice_capture_stop');
		open();
		startGate = null;
		await starting;
		await settle();
		expect(commands().lastIndexOf('voice_capture_stop')).toBeGreaterThan(commands().lastIndexOf('voice_capture_start'));
	});

	test('a second transmitting relay restarts the capture so its listeners get headers', async () => {
		const first: number[] = [];
		const second: number[] = [];
		const one = new NativeRelayCapture();
		const two = new NativeRelayCapture();
		await one.start(context, track(), (_page, seq) => first.push(seq));
		await two.start(context, track(), (_page, seq) => second.push(seq));
		expect(commands().filter(command => command === 'voice_capture_start').length).toBe(2);
		channels[0].onmessage?.({ seq: 9, payload: btoa('Og') }); // the retired capture
		channels[1].onmessage?.({ seq: 0, payload: btoa('Og') });
		expect(first).toEqual([0]);
		expect(second).toEqual([0]);
		one.stop();
		await settle();
		expect(commands()).not.toContain('voice_capture_stop'); // the other relay still transmits
		two.stop();
		await settle();
		expect(commands()).toContain('voice_capture_stop');
	});
});
