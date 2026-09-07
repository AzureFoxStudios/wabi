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

describe('actual relay playback processor', () => {
	test('receives PCM, preserves partial blocks and explicitly silences underflow', () => {
		const p = processor();
		p.push(new Float32Array([1, 2, 3]));
		p.push(new Float32Array([4, 5]));
		expect(p.render(2)).toEqual([1, 2]);
		expect(p.render(4)).toEqual([3, 4, 5, 0]);
		expect(p.render(2)).toEqual([0, 0]);
	});

	test('acknowledges consumption, not merely receipt (including valid silence)', () => {
		const p = processor();
		p.push(new Float32Array(480));
		expect(p.messages).toHaveLength(0);
		p.render(480);
		expect(p.messages.some(m => m.type === 'rendered' && m.samples === 480)).toBe(true);
	});

	test('bounds backlog to half a second and keeps the latest audio', () => {
		const p = processor();
		p.push(new Float32Array(48000).fill(1));
		p.push(new Float32Array(24000).fill(2));
		expect(p.render(24000).every(value => value === 2)).toBe(true);
		expect(p.render(1)).toEqual([0]);
	});
});
