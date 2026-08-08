<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { effectsRegistry } from './registry';
	import { ConstellationsEffect } from './built-in/constellations';
	import { SynapseEffect } from './built-in/synapse';
	import { StarsEffect } from './built-in/stars';
	import { SakuraEffect } from './built-in/sakura';
	import { EmbersEffect } from './built-in/embers';
	import { FirefliesEffect } from './built-in/fireflies';
	import { CyberpunkGridEffect } from './built-in/cyberpunk-grid';
	import { StormEffect } from './built-in/storm';
	import { JokerEffect } from './built-in/balatro';
	import { SpireEffect } from './built-in/spire';
	import { WarpEffect } from './built-in/warp';
	import { MatrixRainEffect } from './built-in/matrix';
	import type { EffectConfig } from './types';

	if (browser) {
		effectsRegistry.register(new ConstellationsEffect());
		effectsRegistry.register(new SynapseEffect());
		effectsRegistry.register(new StarsEffect());
		effectsRegistry.register(new SakuraEffect());
		effectsRegistry.register(new EmbersEffect());
		effectsRegistry.register(new FirefliesEffect());
		effectsRegistry.register(new CyberpunkGridEffect());
		effectsRegistry.register(new StormEffect());
		effectsRegistry.register(new JokerEffect());
		effectsRegistry.register(new SpireEffect());
		effectsRegistry.register(new WarpEffect());
		effectsRegistry.register(new MatrixRainEffect());
	}

	let canvas: HTMLCanvasElement;

	let animId = 0;
	let lastTime = 0;
	let currentEffectId = '';
	let currentConfig: EffectConfig = {
		color: '#6366f1',
		color2: '#006bb4',
		color3: '#162325',
		intensity: 0,
		size: 1,
		speed: 1,
	};

	const watermarkSuits = [
		{ glyph: '♠', left: '6%', top: '12%', size: '22vh', color: 'rgba(246, 240, 226, 0.045)', rotate: '-12deg' },
		{ glyph: '♥', left: '82%', top: '18%', size: '18vh', color: 'rgba(222, 68, 59, 0.05)', rotate: '9deg' },
		{ glyph: '♦', left: '18%', top: '68%', size: '16vh', color: 'rgba(222, 68, 59, 0.05)', rotate: '-5deg' },
		{ glyph: '♣', left: '74%', top: '70%', size: '20vh', color: 'rgba(246, 240, 226, 0.04)', rotate: '14deg' },
		{ glyph: '♥', left: '45%', top: '8%', size: '12vh', color: 'rgba(222, 68, 59, 0.04)', rotate: '-20deg' },
		{ glyph: '♠', left: '42%', top: '80%', size: '12vh', color: 'rgba(246, 240, 226, 0.035)', rotate: '7deg' },
		{ glyph: '♣', left: '3%', top: '42%', size: '10vh', color: 'rgba(246, 240, 226, 0.03)', rotate: '-8deg' },
		{ glyph: '♦', left: '88%', top: '45%', size: '10vh', color: 'rgba(222, 68, 59, 0.04)', rotate: '16deg' },
	];

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
				color2: style.getPropertyValue('--bg-effect-color2').trim() || '#006bb4',
				color3: style.getPropertyValue('--bg-effect-color3').trim() || '#162325',
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
		const effect = effectsRegistry.get(currentEffectId);
		const ctx = canvas.getContext('2d');
		if (ctx) ctx.scale(dpr, dpr);
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
				// The effects tab applies tweaks as inline style vars (no theme
				// change) — live-switch when the active effect id changes.
				if (m.type === 'attributes' && m.attributeName === 'style') {
					if (readConfig().id !== currentEffectId) {
						switchEffect();
					}
					break;
				}
			}
		});
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
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

<div
	class="joker-watermark"
	class:visible={currentEffectId === 'joker'}
	aria-hidden="true"
>
	{#each watermarkSuits as suit (suit.glyph + suit.left + suit.top)}
		<span
			class="joker-suit"
			style="left: {suit.left}; top: {suit.top}; font-size: {suit.size}; color: {suit.color}; transform: rotate({suit.rotate});"
		>{suit.glyph}</span>
	{/each}
</div>

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
	.joker-watermark {
		position: fixed;
		inset: 0;
		pointer-events: none;
		z-index: 0;
		overflow: hidden;
		display: none;
	}
	.joker-watermark.visible {
		display: block;
	}
	.joker-suit {
		position: absolute;
		line-height: 1;
		user-select: none;
	}
</style>
