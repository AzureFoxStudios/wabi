/// <reference types="vite/client" />
import { mount, unmount, tick } from 'svelte';
import MouseFeeler from '../src/lib/effects/MouseFeeler.svelte';
import Harness from './pointer-effects-browser-harness.svelte';
import * as config from '../src/lib/effects/mouseFeelerConfig';
import * as library from '../src/lib/effects/localVisualEffects';
import '../src/styles/tokens.css';
import '../src/styles/components/settings-core-part1.css';
import '../src/styles/components/settings-core-part2.css';
import '../src/styles/components/settings-controls.css';

// The application theme manager writes resolved tokens inline. tokens.css also
// contains compatibility aliases, so reproduce that real initialization here.
for (const [name, value] of Object.entries({
	'--text-heading': '#edf0fa', '--text-primary': '#edf0fa', '--text-secondary': '#bdc4d7', '--text-muted': '#7e8aa7',
	'--accent-primary-color': '#b0a4fa', '--accent-secondary-color': '#8e9dde', '--accent-primary': '#b0a4fa',
	'--surface-app': '#12151e', '--surface-base': '#1a1e2b', '--surface-raised': '#252a3d', '--surface-sunken': '#12151e',
	'--border-subtle': '#3c4256', '--font-size-xs': '12px', '--font-size-sm': '13px', '--font-size-base': '14px'
})) document.documentElement.style.setProperty(name, value);

const state = { frames: 0, draws: 0, errors: [] as string[], running: false, allocations: [] as Blob[], requests: [] as string[] };
const pending = new Set<number>();
const requestFrame = window.requestAnimationFrame.bind(window), cancelFrame = window.cancelAnimationFrame.bind(window);
window.requestAnimationFrame = callback => { const id = requestFrame(now => { pending.delete(id); state.frames++; callback(now); }); pending.add(id); return id; };
window.cancelAnimationFrame = id => { pending.delete(id); cancelFrame(id); };
const glPixels = new WeakMap<HTMLCanvasElement, { count: number; max: number; sum: number; red: number; blue: number }>();
const originalDraw = WebGLRenderingContext.prototype.drawArrays;
WebGLRenderingContext.prototype.drawArrays = function (mode, first, count) {
	originalDraw.call(this, mode, first, count); state.draws++;
	if (this.canvas instanceof HTMLCanvasElement && this.canvas.closest('.pointer-effects-overlay')) {
		const data = new Uint8Array(this.drawingBufferWidth * this.drawingBufferHeight * 4);
		this.readPixels(0, 0, this.drawingBufferWidth, this.drawingBufferHeight, this.RGBA, this.UNSIGNED_BYTE, data);
		glPixels.set(this.canvas, summarize(data));
	}
};
const createUrl = URL.createObjectURL.bind(URL);
URL.createObjectURL = object => { if (object instanceof Blob) state.allocations.push(object); return createUrl(object); };
const get = IDBObjectStore.prototype.get;
const delayed = new Map<string, number>();
IDBObjectStore.prototype.get = function (key) {
	state.requests.push(String(key));
	const request = get.call(this, key), delay = delayed.get(String(key));
	if (!delay) return request;
	const proxy = { get result() { return request.result; }, get error() { return request.error; }, onsuccess: null as any, onerror: null as any };
	request.onsuccess = () => setTimeout(() => proxy.onsuccess?.(new Event('success')), delay);
	request.onerror = () => proxy.onerror?.(new Event('error'));
	return proxy as unknown as IDBRequest;
};
function summarize(data: Uint8Array | Uint8ClampedArray) {
	let count = 0, max = 0, sum = 0, red = 0, blue = 0;
	for (let i = 3; i < data.length; i += 4) {
		const alpha = data[i]; if (alpha > 1) count++; max = Math.max(max, alpha); sum += alpha;
		red += data[i - 3] * alpha; blue += data[i - 1] * alpha;
	}
	return { count, max, sum, red, blue };
}
function stats() {
	const overlay = document.querySelector<HTMLElement>('.pointer-effects-overlay');
	const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('.pointer-effects-overlay canvas')).map(canvas => {
		let pixels = glPixels.get(canvas);
		if (!pixels) {
			const context = canvas.getContext('2d');
			pixels = context ? summarize(context.getImageData(0, 0, canvas.width, canvas.height).data) : { count: 0, max: 0, sum: 0, red: 0, blue: 0 };
		}
		return { ...pixels, width: canvas.width, height: canvas.height, display: getComputedStyle(canvas).display, opacity: Number(getComputedStyle(canvas).opacity), rect: canvas.getBoundingClientRect().toJSON() };
	});
	const glow = document.querySelector<HTMLElement>('.mouse-feeler');
	return { frames: state.frames, draws: state.draws, pending: pending.size, errors: [...state.errors], running: state.running,
		overlay: overlay ? getComputedStyle(overlay).display : 'none', glow: Number(glow?.style.opacity ?? 0), glowRect: glow?.getBoundingClientRect().toJSON(),
		canvases, enabled: config.readFeelerSettings().enabled, settings: config.readFeelerSettings(), requests: state.requests.slice() };
}
window.addEventListener(config.FEELER_ERROR_EVENT, event => { const value = (event as CustomEvent).detail; if (value) state.errors.push(value); });
window.addEventListener(config.FEELER_DEMO_STATE_EVENT, event => { state.running = (event as CustomEvent).detail.running; });
const target = document.createElement('div'), pointerTarget = document.createElement('div'); document.body.append(target, pointerTarget);
let harness = mount(Harness, { target });
let pointer = mount(MouseFeeler, { target: pointerTarget });
(window as any).__pointerSmoke = {
	ready: false, stats, patterns: [...config.BASIC_FEELER_PATTERNS, ...config.LITTLE_WORLD_PATTERNS, ...config.CONNECTED_WORLD_PATTERNS],
	apply: async (patch: Partial<config.FeelerSettings>) => { config.applyFeelerSettings(patch); await tick(); },
	demo: (stop = false) => window.dispatchEvent(new CustomEvent(config.FEELER_DEMO_EVENT, { detail: stop ? { stop: true } : { bounds: { left: 650, top: 500, width: 550, height: 240 } } })),
	hidden: (hidden: boolean) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden }); document.dispatchEvent(new Event('visibilitychange')); },
	delay: (id: string, milliseconds: number) => delayed.set(id, milliseconds),
	clearAllocations: () => { state.allocations.length = 0; },
	allocations: async () => Promise.all(state.allocations.map(blob => blob.text())),
	unmount: async () => { await unmount(pointer); },
	remount: async () => { pointer = mount(MouseFeeler, { target: pointerTarget }); await tick(); },
	remountSettings: async () => { await unmount(harness); harness = mount(Harness, { target }); await tick(); },
	import: async (name: string, color: string) => library.importLocalImageEffect(new File([`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48"><rect width="96" height="48" fill="${color}"/></svg>`], name + '.svg', { type: 'image/svg+xml' })),
	library, cleanup: async () => { await unmount(pointer); await unmount(harness); }
};
await tick();
(window as any).__pointerSmoke.ready = true;
