import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function processor() {
	let Processor: any;
	const messages: any[] = [];
	runInNewContext(readFileSync(new URL('./audio-worklet-playback.js', import.meta.url), 'utf8'), {
		AudioWorkletProcessor: class {
			port = { onmessage: null, postMessage: (value: any) => messages.push(value) };
		},
		registerProcessor: (_name: string, implementation: any) => { Processor = implementation; },
		Float32Array,
		sampleRate: 48000
	});
	const instance = new Processor();
	return {
		messages,
		push: (pcm: Float32Array) => instance.port.onmessage?.({ data: { pcm } }),
		render: (frames: number) => {
			const output = new Float32Array(frames).fill(99);
			instance.process([], [[output]]);
			return Array.from(output);
		}
	};
}

const RATE = 48000;
const PAGE = 1920; // 40 ms, what a sender ships
const QUANTUM = 128;
const ms = (value: number) => Math.round((RATE * value) / 1000);

/**
 * Play a call in simulated time: `arrivals(tick)` says how many samples land before each
 * render quantum. Returns the last report, which carries the totals a listener would notice.
 */
function simulate(seconds: number, arrivals: (tick: number) => number) {
	const p = processor();
	for (let tick = 0; tick < (seconds * RATE) / QUANTUM; tick++) {
		const landed = arrivals(tick);
		// Loud for about two seconds, quiet for about one, as talk is.
		if (landed > 0) p.push(new Float32Array(landed).fill(Math.floor((tick * QUANTUM) / RATE / 0.7) % 5 < 3 ? 0.5 : 0));
		p.render(QUANTUM);
	}
	return { ...p, last: p.messages.at(-1) };
}

/**
 * An in-order link like the relay's TCP socket: 40 ms pages are made at `rate` × real time, each
 * held up by as much as `jitterMs`, and now and then by a stall. Seeded, so every run is the same.
 */
function link(seed: number, jitterMs: number, stallChance = 0, stallMs = 0, rate = 1) {
	let state = seed;
	const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
	let made = 0;
	let paged = 0;
	let lastArrival = 0;
	const due: number[] = [];
	return (tick: number) => {
		const now = tick * QUANTUM;
		made += QUANTUM * rate;
		while (made - paged >= PAGE) {
			paged += PAGE;
			const held = ms(random() * jitterMs) + (random() < stallChance ? ms(stallMs) : 0);
			lastArrival = Math.max(lastArrival, now + held);
			due.push(lastArrival);
		}
		let landed = 0;
		while (due.length && due[0] <= now) {
			due.shift();
			landed += PAGE;
		}
		return landed;
	};
}

describe('actual relay playback processor', () => {
	test('holds a reserve before playing, then plays in order and silences underflow', () => {
		const p = processor();
		p.push(new Float32Array(ms(60)).fill(1));
		// Not enough in hand yet: silence, and nothing is consumed.
		expect(p.render(QUANTUM).every(value => value === 0)).toBe(true);
		p.push(new Float32Array(ms(60)).fill(2));
		expect(p.render(ms(60)).every(value => value === 1)).toBe(true);
		expect(p.render(ms(60) + 2)).toEqual([...new Array(ms(60)).fill(2), 0, 0]);
		expect(p.render(2)).toEqual([0, 0]);
	});

	test('the end of a sentence is played out, not held until the talker speaks again', () => {
		const p = processor();
		p.push(new Float32Array(ms(40)).fill(1));
		let heard = 0;
		for (let i = 0; i < ms(300) / QUANTUM; i++) heard += p.render(QUANTUM).filter(value => value === 1).length;
		expect(heard).toBe(ms(40));
	});

	test('acknowledges consumption, not merely receipt (including valid silence)', () => {
		const p = processor();
		p.push(new Float32Array(ms(120)));
		expect(p.messages).toHaveLength(0);
		p.render(480);
		expect(p.messages.some(m => m.type === 'rendered' && m.samples === 480)).toBe(true);
	});

	test('keeps reporting while it waits for the reserve, without claiming playback', () => {
		const p = processor();
		p.push(new Float32Array(ms(40)));
		p.render(QUANTUM);
		expect(p.messages.at(-1)).toMatchObject({ type: 'waiting', samples: 0, buffered: ms(40), target: ms(120) });
	});

	test('pages that land unevenly play without holes', () => {
		// Up to 60 ms late each, which playing every page on arrival turns into holes.
		const call = simulate(120, link(2, 60));
		expect(call.last).toMatchObject({ gaps: 0, cutSamples: 0, target: ms(120) });
	});

	test('a rough link earns more reserve, and loses no speech to catching up', () => {
		// Up to 100 ms late each, with a 400 ms stall about once every two seconds.
		const call = simulate(300, link(4, 100, 0.02, 400));
		expect(call.last.target).toBeGreaterThan(ms(120));
		expect(call.last.target).toBeLessThanOrEqual(ms(320));
		// The code this replaced left 52 holes and cut 808 ms on this same call.
		expect(call.last.gaps).toBeLessThanOrEqual(26);
		expect(call.last.cutSamples).toBeLessThanOrEqual(ms(400));
		expect(call.last.buffered).toBeLessThanOrEqual(ms(320 + 400 + 40));
	});

	test('catches up in the pauses between words, not by cutting speech', () => {
		const p = processor();
		// A late burst: 100 ms of speech, a 350 ms pause, then speech again.
		p.push(new Float32Array(ms(100)).fill(0.5));
		p.push(new Float32Array(ms(350)));
		p.push(new Float32Array(ms(60)).fill(0.5));
		let speech = 0;
		let silence = 0;
		for (let i = 0; i < ms(510) / QUANTUM; i++) {
			for (const value of p.render(QUANTUM)) value === 0.5 ? speech++ : silence++;
		}
		// Every sample of speech is heard, sooner than it would have been.
		expect(speech).toBe(ms(160));
		expect(p.messages.at(-1).trimmedSamples).toBeGreaterThan(0);
		expect(p.messages.at(-1).cutSamples).toBe(0);
		expect(silence).toBeGreaterThan(0);
	});

	test('a sender clock running fast is absorbed by rare skips, not constant slivers', () => {
		const call = simulate(600, link(5, 0, 0, 0, 1.001));
		expect(call.last.gaps).toBe(0);
		// 0.1% of ten minutes is 600 ms of surplus: one skip, or two.
		expect(call.last.cutSamples).toBeLessThanOrEqual(ms(800));
		expect(call.last.buffered).toBeLessThanOrEqual(ms(120 + 400 + 40));
	});

	test('a sender clock running slow costs a rare short pause, never a growing delay', () => {
		const call = simulate(600, link(6, 0, 0, 0, 0.999));
		expect(call.last.cutSamples).toBe(0);
		expect(call.last.gaps).toBeLessThanOrEqual(8);
		expect(call.last.target).toBeLessThanOrEqual(ms(320));
	});

	test('reports what a listener would hear as trouble: cuts and gaps', () => {
		const p = processor();
		const last = () => p.messages.at(-1);
		// Steady audio: nothing to report.
		p.push(new Float32Array(9600));
		p.render(4800);
		expect(last()).toMatchObject({ buffered: 4800, cutSamples: 0, gaps: 0 });
		// It runs dry mid-stream: one gap, counted once however long the silence lasts.
		p.render(4800);
		p.render(128);
		p.render(128);
		expect(last()).toMatchObject({ gaps: 1, buffered: 0 });
		p.push(new Float32Array(9600));
		p.render(4800);
		expect(last()).toMatchObject({ gaps: 1, cutSamples: 0 });
	});

	test('after a stall it skips ahead to the reserve and keeps the latest audio', () => {
		const p = processor();
		p.push(new Float32Array(ms(300)).fill(1));
		p.push(new Float32Array(ms(300)).fill(2));
		// 600 ms is past the reserve plus headroom: everything but the newest 120 ms goes.
		expect(p.render(ms(120)).every(value => value === 2)).toBe(true);
		expect(p.messages.at(-1).cutSamples).toBe(ms(480));
		expect(p.render(1)).toEqual([0]);
	});
});
