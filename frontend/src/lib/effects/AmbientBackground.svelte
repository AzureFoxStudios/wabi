<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { effectsRegistry } from './registry';
	import { ConstellationsEffect } from './built-in/constellations';
	import { SynapseEffect } from './built-in/synapse';
	import { StarsEffect } from './built-in/stars';
	import { SakuraEffect } from './built-in/sakura';
	import { EmbersEffect } from './built-in/embers';
	import { CyberpunkGridEffect } from './built-in/cyberpunk-grid';
	import { StormEffect } from './built-in/storm';
	import type { EffectConfig } from './types';

	if (browser) {
		effectsRegistry.register(new ConstellationsEffect());
		effectsRegistry.register(new SynapseEffect());
		effectsRegistry.register(new StarsEffect());
		effectsRegistry.register(new SakuraEffect());
		effectsRegistry.register(new EmbersEffect());
		effectsRegistry.register(new CyberpunkGridEffect());
		effectsRegistry.register(new StormEffect());
	}

	let canvas: HTMLCanvasElement;

	let animId = 0;
	let lastTime = 0;
	let currentEffectId = '';
	let currentConfig: EffectConfig = {
		color: '#6366f1',
		intensity: 0,
		size: 1,
		speed: 1,
	};

	let reducedMotion = false;
	let canvasWidth = 0;
	let canvasHeight = 0;

	function readConfig(): { id: string; config: EffectConfig } {
		const root = document.documentElement;
		const style = getComputedStyle(root);
		return {
			id: style.getPropertyValue('--bg-effect-effect').trim() || 'none',
			config: {
				color: style.getPropertyValue('--bg-effect-color').trim() || '#6366f1',
				intensity: parseFloat(style.getPropertyValue('--bg-effect-intensity')) || 0,
				size: parseFloat(style.getPropertyValue('--bg-effect-size')) || 1,
				speed: parseFloat(style.getPropertyValue('--bg-effect-speed')) || 1,
			},
		};
	}

	function syncSize() {
		if (!canvas) return;
		const dpr = window.devicePixelRatio || 1;
		const w = window.innerWidth;
		const h = window.innerHeight;
		canvasWidth = w;
		canvasHeight = h;
		canvas.width = w * dpr;
		canvas.height = h * dpr;
		canvas.style.width = `${w}px`;
		canvas.style.height = `${h}px`;
		const ctx = canvas.getContext('2d');
		if (ctx) ctx.scale(dpr, dpr);
		const effect = effectsRegistry.get(currentEffectId);
		if (effect) effect.resize(w, h);
	}

	function switchEffect() {
		if (animId) {
			cancelAnimationFrame(animId);
			animId = 0;
		}

		const prev = effectsRegistry.get(currentEffectId);
		if (prev) prev.destroy();

		const { id, config } = readConfig();
		currentEffectId = id;
		currentConfig = config;

		if (id === 'none' || reducedMotion || config.intensity <= 0) return;

		const effect = effectsRegistry.get(id);
		if (!effect) return;

		syncSize();
		effect.init(canvas, config);
		lastTime = performance.now();
		loop();
	}

	function loop(time?: number) {
		animId = requestAnimationFrame(loop);
		const now = time ?? performance.now();
		const dt = now - lastTime;
		if (dt < 40) return;
		lastTime = now;
		const effect = effectsRegistry.get(currentEffectId);
		if (effect) effect.render(dt, currentConfig);
	}

	function handleResize() {
		syncSize();
	}

	let observer: MutationObserver | null = null;

	onMount(() => {
		if (!browser) return;
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		reducedMotion = mq.matches;
		mq.addEventListener('change', (e) => {
			reducedMotion = e.matches;
			if (reducedMotion) {
				if (animId) cancelAnimationFrame(animId);
				animId = 0;
				const prev = effectsRegistry.get(currentEffectId);
				if (prev) prev.destroy();
				currentEffectId = '';
			} else {
				switchEffect();
			}
		});

		switchEffect();

		window.addEventListener('resize', handleResize);

		observer = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (m.type === 'attributes' && m.attributeName === 'data-theme') {
					switchEffect();
					break;
				}
			}
		});
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
	});

	onDestroy(() => {
		if (!browser) return;
		if (animId) cancelAnimationFrame(animId);
		const effect = effectsRegistry.get(currentEffectId);
		if (effect) effect.destroy();
		window.removeEventListener('resize', handleResize);
		if (observer) observer.disconnect();
	});
</script>

<canvas
	bind:this={canvas}
	aria-hidden="true"
></canvas>

<style>
	canvas {
		position: fixed;
		inset: 0;
		pointer-events: none;
		/* z-index:0 places the canvas ABOVE <body>'s opaque background (which
		   paints in the root stacking context's in-flow layer, above a -1 child)
		   but still BELOW .app-content-layer (z-index:1). With .app-container
		   transparent, the frosted/translucent surfaces sample this canvas as
		   their backdrop and blend the animated effect through the chat UI.
		   Using -1 here previously hid the canvas behind body's fill, so the
		   effect only showed in the 16px margins (reading as "below the chat"). */
		z-index: 0;
	}
</style>
