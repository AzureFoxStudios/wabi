<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { themeStore } from '$lib/theme/themeStore';

	const LOCAL_KEY = 'wabi-crt-distortion';

	let localDistortion = 0;
	let mounted = false;

	function clamp(value: number): number {
		return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
	}

	function readLocal(): number {
		if (typeof localStorage === 'undefined') return 0;
		const value = Number(localStorage.getItem(LOCAL_KEY));
		return clamp(value);
	}

	function storedDistortion(): number | null {
		const value = $themeStore.themeAmbient?.state?.crtDistortion;
		return typeof value === 'number' && Number.isFinite(value) ? clamp(value) : null;
	}

	$: strength = storedDistortion() ?? localDistortion;
	$: displacementScale = Math.pow(strength, 1.35) * 22;
	$: rgbShift = Math.pow(strength, 1.25) * 5;
	$: bloomBlur = Math.pow(strength, 1.6) * 0.55;
	$: bloomOpacity = Math.pow(strength, 1.25) * 0.16;

	$: if (mounted) {
		const root = document.documentElement;
		const active = strength > 0.002;
		root.classList.toggle('wabi-crt-active', active);
		root.style.setProperty('--crt-strength', String(strength));
		root.style.setProperty('--crt-contrast', String(1 + strength * 0.09));
		root.style.setProperty('--crt-saturation', String(1 + strength * 0.08));
		root.style.setProperty('--crt-brightness', String(1 - strength * 0.035));
		root.style.setProperty('--crt-scanline-alpha', String(strength * 0.24));
		root.style.setProperty('--crt-mask-alpha', String(strength * 0.13));
		root.style.setProperty('--crt-vignette-alpha', String(strength * 0.52));
		root.style.setProperty('--crt-glass-alpha', String(strength * 0.12));
		root.style.setProperty('--crt-roll-alpha', String(Math.pow(strength, 1.7) * 0.18));
		root.style.setProperty('--crt-flicker-alpha', String(Math.pow(strength, 1.4) * 0.12));
	}

	function handleStorage(event: StorageEvent): void {
		if (event.key === LOCAL_KEY) localDistortion = readLocal();
	}

	onMount(() => {
		localDistortion = readLocal();
		mounted = true;
		window.addEventListener('storage', handleStorage);
	});

	onDestroy(() => {
		if (typeof window !== 'undefined') window.removeEventListener('storage', handleStorage);
		if (typeof document !== 'undefined') {
			const root = document.documentElement;
			root.classList.remove('wabi-crt-active');
			for (const name of [
				'--crt-strength', '--crt-contrast', '--crt-saturation', '--crt-brightness',
				'--crt-scanline-alpha', '--crt-mask-alpha', '--crt-vignette-alpha',
				'--crt-glass-alpha', '--crt-roll-alpha', '--crt-flicker-alpha'
			]) root.style.removeProperty(name);
		}
	});
</script>

<!--
	The filter is deliberately applied to the document as one composed image.
	That means chat text, panels, popovers, video/background art and ambient
	shaders all share the same tube distortion instead of scanlines merely
	floating over an otherwise-perfect UI.
-->
<svg class="crt-filter-defs" aria-hidden="true" width="0" height="0">
	<defs>
		<filter id="wabi-crt-distort" x="-8%" y="-8%" width="116%" height="116%" color-interpolation-filters="sRGB">
			<feTurbulence
				type="fractalNoise"
				baseFrequency="0.002 0.075"
				numOctaves="2"
				seed="19"
				result="tubeNoise"
			>
				<animate
					attributeName="baseFrequency"
					values="0.002 0.065;0.0028 0.095;0.0017 0.078;0.002 0.065"
					dur="8.5s"
					repeatCount="indefinite"
				/>
			</feTurbulence>
			<!-- Mostly horizontal deflection, with a smaller vertical wobble. -->
			<feColorMatrix
				in="tubeNoise"
				type="matrix"
				values="1 0 0 0 0
				        0 0 0 0 0.5
				        0.16 0 0 0 0.42
				        0 0 0 1 0"
				result="tubeMap"
			/>
			<feDisplacementMap
				in="SourceGraphic"
				in2="tubeMap"
				scale={displacementScale}
				xChannelSelector="R"
				yChannelSelector="B"
				result="warped"
			/>

			<!-- Real channel separation instead of a generic colored shadow. -->
			<feColorMatrix in="warped" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
			<feColorMatrix in="warped" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green" />
			<feColorMatrix in="warped" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue" />
			<feOffset in="red" dx={-rgbShift} result="redShift" />
			<feOffset in="blue" dx={rgbShift} result="blueShift" />
			<feBlend in="redShift" in2="green" mode="screen" result="rg" />
			<feBlend in="rg" in2="blueShift" mode="screen" result="rgbSplit" />

			<!-- A restrained bloom grows with the same distortion control. -->
			<feGaussianBlur in="warped" stdDeviation={bloomBlur} result="bloom" />
			<feComponentTransfer in="bloom" result="faintBloom">
				<feFuncA type="linear" slope={bloomOpacity} />
			</feComponentTransfer>
			<feBlend in="rgbSplit" in2="faintBloom" mode="screen" />
		</filter>
	</defs>
</svg>

<div class="crt-overlay" aria-hidden="true">
	<div class="crt-vignette"></div>
	<div class="crt-scanlines"></div>
	<div class="crt-phosphor"></div>
	<div class="crt-sync-roll"></div>
	<div class="crt-glass"></div>
</div>

<style>
	.crt-filter-defs {
		position: fixed;
		left: -9999px;
		top: -9999px;
		pointer-events: none;
	}

	:global(html.wabi-crt-active body) {
		filter:
			url(#wabi-crt-distort)
			contrast(var(--crt-contrast, 1))
			saturate(var(--crt-saturation, 1))
			brightness(var(--crt-brightness, 1));
	}

	.crt-overlay {
		position: fixed;
		inset: 0;
		z-index: 2147483000;
		pointer-events: none;
		display: none;
		overflow: hidden;
	}
	:global(html.wabi-crt-active) .crt-overlay {
		display: block;
		animation: crt-flicker 5.7s steps(1, end) infinite;
	}

	.crt-vignette,
	.crt-scanlines,
	.crt-phosphor,
	.crt-sync-roll,
	.crt-glass {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.crt-vignette {
		background: radial-gradient(ellipse at center, transparent 48%, rgb(0 0 0 / var(--crt-vignette-alpha, 0)) 100%);
	}

	.crt-scanlines {
		background: repeating-linear-gradient(
			to bottom,
			transparent 0,
			transparent 2px,
			rgb(0 0 0 / var(--crt-scanline-alpha, 0)) 3px,
			transparent 4px
		);
		animation: crt-scan-roll 7s linear infinite;
	}

	.crt-phosphor {
		background: repeating-linear-gradient(
			90deg,
			rgb(255 40 40 / var(--crt-mask-alpha, 0)) 0,
			rgb(255 40 40 / var(--crt-mask-alpha, 0)) 1px,
			rgb(60 255 100 / var(--crt-mask-alpha, 0)) 1px,
			rgb(60 255 100 / var(--crt-mask-alpha, 0)) 2px,
			rgb(80 120 255 / var(--crt-mask-alpha, 0)) 2px,
			rgb(80 120 255 / var(--crt-mask-alpha, 0)) 3px
		);
		mix-blend-mode: overlay;
	}

	.crt-sync-roll {
		top: -18vh;
		bottom: auto;
		height: 14vh;
		background: linear-gradient(
			to bottom,
			transparent,
			rgb(255 255 255 / var(--crt-roll-alpha, 0)) 48%,
			transparent
		);
		mix-blend-mode: soft-light;
		filter: blur(5px);
		animation: crt-sync-roll 9.5s linear infinite;
	}

	.crt-glass {
		background:
			linear-gradient(110deg, rgb(255 255 255 / var(--crt-glass-alpha, 0)), transparent 18%, transparent 72%, rgb(120 170 255 / calc(var(--crt-glass-alpha, 0) * 0.45))),
			radial-gradient(ellipse at 50% 45%, transparent 65%, rgb(0 0 0 / calc(var(--crt-vignette-alpha, 0) * 0.35)) 100%);
		mix-blend-mode: soft-light;
	}

	@keyframes crt-scan-roll {
		from { transform: translateY(0); }
		to { transform: translateY(4px); }
	}

	@keyframes crt-sync-roll {
		from { transform: translateY(0); }
		to { transform: translateY(138vh); }
	}

	@keyframes crt-flicker {
		0%, 93%, 100% { opacity: 1; }
		94% { opacity: calc(1 - var(--crt-flicker-alpha, 0)); }
		94.5% { opacity: 1; }
		97.2% { opacity: calc(1 - var(--crt-flicker-alpha, 0) * 0.55); }
		97.8% { opacity: 1; }
	}

	@media (prefers-reduced-motion: reduce) {
		.crt-overlay,
		.crt-scanlines,
		.crt-sync-roll {
			animation: none !important;
		}
	}
</style>
