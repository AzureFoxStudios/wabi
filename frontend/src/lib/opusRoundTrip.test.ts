import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/** Execute the shipped worker glue AND real libopus WASM with a minimal
 * worker host. This tests codecs, not physical devices, CSP or audibility. */
async function codec(kind: 'encoder' | 'decoder') {
	const outputs: any[] = [];
	const root = new URL('../../node_modules/opus-recorder/dist/', import.meta.url);
	const scope: any = {
		console, setTimeout, clearTimeout, WebAssembly, atob, close() {},
		postMessage: (message: any) => outputs.push(message),
		wasmBytes: kind === 'decoder' ? new Uint8Array(readFileSync(new URL('decoderWorker.min.wasm', root))) : undefined
	};
	scope.self = scope;
	// Declare Module in the script, matching the production blob prelude.
	// Bun's VM var binding does not preserve an injected Module property.
	runInNewContext('var Module={wasmBinary:wasmBytes};\n' + readFileSync(new URL(`${kind}Worker.min.js`, root), 'utf8'), scope);
	await scope.Module.mainReady;
	return { outputs, send: async (data: any) => {
		scope.onmessage({ data });
		for (let n = 0; n < 4; n++) await Promise.resolve();
	} };
}

test('real Opus pages -> real decoder -> actual playback processor preserve a continuous tone', async () => {
	const encoder = await codec('encoder');
	await encoder.send({ command: 'init', encoderSampleRate: 48000, originalSampleRate: 48000,
		numberOfChannels: 1, encoderFrameSize: 20, maxFramesPerPage: 2 });
	await encoder.send({ command: 'getHeaderPages' });
	const samples = 96000;
	for (let offset = 0; offset < samples; offset += 960) {
		const pcm = Float32Array.from({ length: 960 }, (_, i) => 0.4 * Math.sin(2 * Math.PI * 440 * (offset + i) / 48000));
		await encoder.send({ command: 'encode', buffers: [pcm] });
	}
	await encoder.send({ command: 'done' });
	const pages = encoder.outputs.filter(m => m.message === 'page').map(m => m.page);
	expect(pages.length).toBeGreaterThan(45); // ~40ms pages, not 800ms bursts
	const decoder = await codec('decoder');
	await decoder.send({ command: 'init', decoderSampleRate: 48000, outputBufferSampleRate: 48000, bufferLength: 960 });
	for (const page of pages) await decoder.send({ command: 'decode', pages: page });
	await decoder.send({ command: 'done' });
	const chunks = decoder.outputs.filter(Array.isArray).map(channels => new Float32Array(channels[0]));
	const decodedSamples = chunks.reduce((sum, pcm) => sum + pcm.length, 0);
	expect(decodedSamples).toBeGreaterThanOrEqual(samples - 1920);
	expect(decodedSamples).toBeLessThanOrEqual(samples + 1920);
	let Processor: any;
	runInNewContext(readFileSync(new URL('./audio-worklet-playback.js', import.meta.url), 'utf8'), {
		AudioWorkletProcessor: class { port = { onmessage: null, postMessage() {} }; },
		registerProcessor: (_name: string, p: any) => { Processor = p; }, Float32Array, sampleRate: 48000
	});
	const playback = new Processor();
	let energy = 0;
	let played = 0;
	for (const pcm of chunks) {
		playback.port.onmessage({ data: { pcm } });
		const output = new Float32Array(pcm.length);
		playback.process([], [[output]]);
		expect(output).toEqual(pcm);
		for (const sample of output) energy += sample * sample;
		played += output.length;
	}
	expect(Math.sqrt(energy / played)).toBeGreaterThan(0.2);
	expect(Math.sqrt(energy / played)).toBeLessThan(0.35);
	await encoder.send({ command: 'close' });
});
