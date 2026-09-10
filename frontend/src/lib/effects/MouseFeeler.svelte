<script lang="ts">
	import { onMount } from 'svelte';
	import PointerShaderSurface from './PointerShaderSurface.svelte';
	import {
		DEFAULT_FEELER_SETTINGS,
		FEELER_SETTINGS_EVENT,
		normalizeFeelerSettings,
		readFeelerSettings,
		writeFeelerSettings,
		type FeelerSettings
	} from './mouseFeelerConfig';
	import {
		getLocalVisualEffect,
		LOCAL_VISUAL_EFFECTS_EVENT,
		type LocalVisualEffectRecord
	} from './localVisualEffects';

	let layer: HTMLDivElement;
	let settings: FeelerSettings = { ...DEFAULT_FEELER_SETTINGS };
	let localEffect: LocalVisualEffectRecord | null = null;
	let customImageUrl = '';
	let customTileSize = 96;
	let shaderSource = '';
	let shaderError = '';
	let shaderSurface: {
		setPointerState: (x: number, y: number, vx: number, vy: number) => void;
		pause: () => void;
	} | null = null;

	function clearLocalEffect(): void {
		if (customImageUrl) URL.revokeObjectURL(customImageUrl);
		customImageUrl = '';
		shaderSource = '';
		shaderError = '';
		localEffect = null;
	}

	async function loadSelectedLocalEffect(): Promise<void> {
		clearLocalEffect();
		if (settings.pattern !== 'local' || !settings.customEffectId) return;
		try {
			const effect = await getLocalVisualEffect(settings.customEffectId);
			if (!effect) return;
			localEffect = effect;
			if (effect.kind === 'image' && effect.imageBlob) {
				customImageUrl = URL.createObjectURL(effect.imageBlob);
				customTileSize = Math.max(32, Math.min(512, effect.tileSize || 96));
			} else if (effect.kind === 'shader' && effect.shaderSource) {
				shaderSource = effect.shaderSource;
			}
		} catch (error) {
			console.warn('[MouseFeeler] Failed to load local visual effect:', error);
		}
	}

	onMount(() => {
		settings = readFeelerSettings();
		void loadSelectedLocalEffect();

		const finePointer = window.matchMedia('(pointer: fine)');
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
		let frame = 0;
		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		let pendingX = window.innerWidth / 2;
		let pendingY = window.innerHeight / 2;
		let velocityX = 0;
		let velocityY = 0;
		let lastPointerX = pendingX;
		let lastPointerY = pendingY;
		let lastPointerTime = performance.now();

		const hide = () => {
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = null;
			}
			shaderSurface?.pause();
			if (!layer) return;
			layer.style.transitionDuration = `${settings.fadeMs}ms`;
			layer.style.opacity = '0';
		};

		const flush = () => {
			frame = 0;
			if (!layer || !settings.enabled || !finePointer.matches || reducedMotion.matches) {
				hide();
				return;
			}

			const left = pendingX - settings.radius;
			const top = pendingY - settings.radius;
			layer.style.transitionDuration = '0ms';
			layer.style.transform = `translate3d(${left}px, ${top}px, 0)`;
			layer.style.setProperty('--feeler-pattern-x', `${-left}px`);
			layer.style.setProperty('--feeler-pattern-y', `${-top}px`);
			layer.style.opacity = '1';
			shaderSurface?.setPointerState(pendingX, pendingY, velocityX, velocityY);
		};

		const handlePointerMove = (event: PointerEvent) => {
			if (!settings.enabled || !finePointer.matches || reducedMotion.matches) return;
			if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;

			const now = performance.now();
			const dt = Math.max(1, now - lastPointerTime);
			velocityX = Math.max(-5000, Math.min(5000, ((event.clientX - lastPointerX) / dt) * 1000));
			velocityY = Math.max(-5000, Math.min(5000, ((event.clientY - lastPointerY) / dt) * 1000));
			lastPointerX = event.clientX;
			lastPointerY = event.clientY;
			lastPointerTime = now;
			pendingX = event.clientX;
			pendingY = event.clientY;

			if (!frame) frame = requestAnimationFrame(flush);
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(hide, settings.idleDelayMs);
		};

		const handleSettings = (event: Event) => {
			const detail = (event as CustomEvent<Partial<FeelerSettings>>).detail;
			const previousCustom = settings.customEffectId;
			const previousPattern = settings.pattern;
			settings = normalizeFeelerSettings({ ...settings, ...(detail || {}) });
			writeFeelerSettings(settings);
			if (settings.pattern !== previousPattern || settings.customEffectId !== previousCustom) {
				void loadSelectedLocalEffect();
			}
			if (!settings.enabled) hide();
			else if (!frame) frame = requestAnimationFrame(flush);
		};

		const handleLibraryChanged = () => {
			if (settings.pattern === 'local' && settings.customEffectId) void loadSelectedLocalEffect();
		};
		const handleMotionChange = () => hide();

		window.addEventListener('pointermove', handlePointerMove, { passive: true });
		window.addEventListener('blur', hide);
		window.addEventListener(FEELER_SETTINGS_EVENT, handleSettings);
		window.addEventListener(LOCAL_VISUAL_EFFECTS_EVENT, handleLibraryChanged);
		document.documentElement.addEventListener('mouseleave', hide);
		finePointer.addEventListener('change', handleMotionChange);
		reducedMotion.addEventListener('change', handleMotionChange);

		return () => {
			window.removeEventListener('pointermove', handlePointerMove);
			window.removeEventListener('blur', hide);
			window.removeEventListener(FEELER_SETTINGS_EVENT, handleSettings);
			window.removeEventListener(LOCAL_VISUAL_EFFECTS_EVENT, handleLibraryChanged);
			document.documentElement.removeEventListener('mouseleave', hide);
			finePointer.removeEventListener('change', handleMotionChange);
			reducedMotion.removeEventListener('change', handleMotionChange);
			if (frame) cancelAnimationFrame(frame);
			if (idleTimer) clearTimeout(idleTimer);
			shaderSurface?.pause();
			clearLocalEffect();
		};
	});
</script>

<div
	bind:this={layer}
	class="mouse-feeler"
	class:mouse-feeler--disabled={!settings.enabled}
	data-pattern={settings.pattern}
	data-local-kind={localEffect?.kind || ''}
	aria-hidden="true"
	style={`--feeler-radius: ${settings.radius}px; --feeler-diameter: ${settings.radius * 2}px; --feeler-strength: ${settings.intensity}; --feeler-texture-opacity: ${settings.textureOpacity};`}
>
	<div class="mouse-feeler__glow"></div>
	{#if shaderSource}
		<PointerShaderSurface
			bind:this={shaderSurface}
			source={shaderSource}
			radius={settings.radius}
			opacity={settings.textureOpacity}
			on:shadererror={(event) => shaderError = event.detail}
		/>
	{:else}
		<div
			class="mouse-feeler__texture"
			style={customImageUrl ? `background-image: url("${customImageUrl}"); background-size: ${customTileSize}px ${customTileSize}px;` : ''}
		></div>
	{/if}
</div>

{#if shaderError}
	<span class="sr-only" aria-live="polite">Pointer shader error: {shaderError}</span>
{/if}

<style>
	.mouse-feeler {
		--feeler-pattern-x: 0px;
		--feeler-pattern-y: 0px;
		position: fixed;
		left: 0;
		top: 0;
		width: var(--feeler-diameter);
		height: var(--feeler-diameter);
		z-index: 10000;
		pointer-events: none;
		opacity: 0;
		overflow: hidden;
		border-radius: 50%;
		transform: translate3d(-10000px, -10000px, 0);
		contain: layout paint style;
		transition-property: opacity;
		transition-timing-function: ease-out;
		will-change: transform, opacity;
	}

	.mouse-feeler--disabled {
		display: none;
	}

	.mouse-feeler__glow,
	.mouse-feeler__texture {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.mouse-feeler__glow {
		background: radial-gradient(
			circle at 50% 50%,
			rgb(255 255 255 / var(--feeler-strength)) 0%,
			rgb(255 255 255 / calc(var(--feeler-strength) * 0.5)) 35%,
			rgb(255 255 255 / calc(var(--feeler-strength) * 0.13)) 62%,
			transparent 100%
		);
		mix-blend-mode: screen;
	}

	.mouse-feeler__texture {
		opacity: var(--feeler-texture-opacity);
		mix-blend-mode: screen;
		background-repeat: repeat;
		-webkit-mask-image: radial-gradient(circle at 50% 50%, #000 0%, rgb(0 0 0 / 0.7) 42%, transparent 82%);
		mask-image: radial-gradient(circle at 50% 50%, #000 0%, rgb(0 0 0 / 0.7) 42%, transparent 82%);
	}

	.mouse-feeler[data-pattern='triangles'] .mouse-feeler__texture {
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='52' height='45' viewBox='0 0 52 45'%3E%3Cpath d='M26 4 48 41H4Z' fill='none' stroke='white' stroke-opacity='.24' stroke-width='1'/%3E%3C/svg%3E");
		background-size: 52px 45px;
		background-position: calc(var(--feeler-pattern-x) + 5px) calc(var(--feeler-pattern-y) + 8px);
	}

	.mouse-feeler[data-pattern='dots'] .mouse-feeler__texture {
		background-image: radial-gradient(circle, rgb(255 255 255 / 0.55) 0 1px, transparent 1.4px);
		background-size: 18px 18px;
		background-position: var(--feeler-pattern-x) var(--feeler-pattern-y);
	}

	.mouse-feeler[data-pattern='grid'] .mouse-feeler__texture {
		background-image:
			linear-gradient(rgb(255 255 255 / 0.22) 1px, transparent 1px),
			linear-gradient(90deg, rgb(255 255 255 / 0.22) 1px, transparent 1px);
		background-size: 28px 28px;
		background-position: var(--feeler-pattern-x) var(--feeler-pattern-y);
	}

	.mouse-feeler[data-pattern='sparkles'] .mouse-feeler__texture {
		background-image:
			radial-gradient(circle at 20% 30%, rgb(255 255 255 / 0.8) 0 1px, transparent 1.5px),
			radial-gradient(circle at 70% 65%, rgb(255 255 255 / 0.55) 0 1px, transparent 1.4px),
			radial-gradient(circle at 45% 85%, rgb(255 255 255 / 0.42) 0 0.8px, transparent 1.3px);
		background-size: 46px 46px, 63px 63px, 79px 79px;
		background-position:
			var(--feeler-pattern-x) var(--feeler-pattern-y),
			var(--feeler-pattern-x) var(--feeler-pattern-y),
			var(--feeler-pattern-x) var(--feeler-pattern-y);
	}

	.mouse-feeler[data-pattern='suits'] .mouse-feeler__texture {
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'%3E%3Cg fill='white' fill-opacity='.42' font-family='serif'%3E%3Ctext x='10' y='28' font-size='22'%3E%E2%99%A0%3C/text%3E%3Ctext x='58' y='22' font-size='17'%3E%E2%99%A5%3C/text%3E%3Ctext x='29' y='62' font-size='19'%3E%E2%99%A6%3C/text%3E%3Ctext x='68' y='80' font-size='23'%3E%E2%99%A3%3C/text%3E%3C/g%3E%3C/svg%3E");
		background-size: 96px 96px;
		background-position: var(--feeler-pattern-x) var(--feeler-pattern-y);
	}

	.mouse-feeler[data-pattern='local'][data-local-kind='image'] .mouse-feeler__texture {
		background-position: var(--feeler-pattern-x) var(--feeler-pattern-y);
	}

	.mouse-feeler[data-pattern='none'] .mouse-feeler__texture {
		display: none;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	@media (prefers-reduced-motion: reduce), (pointer: coarse) {
		.mouse-feeler {
			display: none;
		}
	}
</style>
