<script lang="ts">
	import { onMount } from 'svelte';

	type FeelerPattern = 'triangles' | 'dots' | 'grid' | 'sparkles' | 'none';
	type FeelerSettings = {
		enabled: boolean;
		pattern: FeelerPattern;
		radius: number;
		intensity: number;
		textureOpacity: number;
		idleDelayMs: number;
		fadeMs: number;
	};

	const STORAGE_KEY = 'wabi.mouse-feeler.v1';
	const SETTINGS_EVENT = 'wabi:mouse-feeler-settings';
	const DEFAULTS: FeelerSettings = {
		enabled: true,
		pattern: 'triangles',
		radius: 190,
		// Deliberately softer than the standalone prototype after visual testing.
		intensity: 0.05,
		textureOpacity: 0.16,
		idleDelayMs: 90,
		fadeMs: 520
	};

	let layer: HTMLDivElement;
	let settings: FeelerSettings = { ...DEFAULTS };

	function isPattern(value: unknown): value is FeelerPattern {
		return value === 'triangles' || value === 'dots' || value === 'grid' || value === 'sparkles' || value === 'none';
	}

	function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
		const parsed = typeof value === 'number' ? value : Number(value);
		return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
	}

	function normalize(input: Partial<FeelerSettings> | null | undefined): FeelerSettings {
		return {
			enabled: input?.enabled !== false,
			pattern: isPattern(input?.pattern) ? input.pattern : DEFAULTS.pattern,
			radius: clampNumber(input?.radius, DEFAULTS.radius, 80, 360),
			intensity: clampNumber(input?.intensity, DEFAULTS.intensity, 0, 0.15),
			textureOpacity: clampNumber(input?.textureOpacity, DEFAULTS.textureOpacity, 0, 0.4),
			idleDelayMs: clampNumber(input?.idleDelayMs, DEFAULTS.idleDelayMs, 30, 300),
			fadeMs: clampNumber(input?.fadeMs, DEFAULTS.fadeMs, 150, 1200)
		};
	}

	function readSettings(): FeelerSettings {
		try {
			const raw = window.localStorage.getItem(STORAGE_KEY);
			if (!raw) return { ...DEFAULTS };
			return normalize(JSON.parse(raw) as Partial<FeelerSettings>);
		} catch {
			return { ...DEFAULTS };
		}
	}

	function writeSettings(next: FeelerSettings): void {
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch {
			// Cosmetic preference persistence is best-effort only.
		}
	}

	onMount(() => {
		settings = readSettings();

		const finePointer = window.matchMedia('(pointer: fine)');
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
		let frame = 0;
		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		let pendingX = window.innerWidth / 2;
		let pendingY = window.innerHeight / 2;

		const hide = () => {
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = null;
			}
			if (layer) layer.style.opacity = '0';
		};

		const flush = () => {
			frame = 0;
			if (!layer || !settings.enabled || !finePointer.matches || reducedMotion.matches) {
				hide();
				return;
			}
			layer.style.setProperty('--feeler-x', `${pendingX}px`);
			layer.style.setProperty('--feeler-y', `${pendingY}px`);
			layer.style.opacity = '1';
		};

		const handlePointerMove = (event: PointerEvent) => {
			if (!settings.enabled || !finePointer.matches || reducedMotion.matches) return;
			if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;

			pendingX = event.clientX;
			pendingY = event.clientY;

			if (!frame) frame = requestAnimationFrame(flush);
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(hide, settings.idleDelayMs);
		};

		const handleSettings = (event: Event) => {
			const detail = (event as CustomEvent<Partial<FeelerSettings>>).detail;
			settings = normalize({ ...settings, ...(detail || {}) });
			writeSettings(settings);
			if (!settings.enabled) hide();
		};

		const handleMotionChange = () => hide();

		window.addEventListener('pointermove', handlePointerMove, { passive: true });
		window.addEventListener('blur', hide);
		window.addEventListener(SETTINGS_EVENT, handleSettings);
		document.documentElement.addEventListener('mouseleave', hide);
		finePointer.addEventListener('change', handleMotionChange);
		reducedMotion.addEventListener('change', handleMotionChange);

		return () => {
			window.removeEventListener('pointermove', handlePointerMove);
			window.removeEventListener('blur', hide);
			window.removeEventListener(SETTINGS_EVENT, handleSettings);
			document.documentElement.removeEventListener('mouseleave', hide);
			finePointer.removeEventListener('change', handleMotionChange);
			reducedMotion.removeEventListener('change', handleMotionChange);
			if (frame) cancelAnimationFrame(frame);
			if (idleTimer) clearTimeout(idleTimer);
		};
	});
</script>

<div
	bind:this={layer}
	class="mouse-feeler"
	class:mouse-feeler--disabled={!settings.enabled}
	data-pattern={settings.pattern}
	aria-hidden="true"
	style={`--feeler-radius: ${settings.radius}px; --feeler-strength: ${settings.intensity}; --feeler-texture-opacity: ${settings.textureOpacity}; --feeler-fade: ${settings.fadeMs}ms;`}
>
	<div class="mouse-feeler__glow"></div>
	<div class="mouse-feeler__texture"></div>
</div>

<style>
	.mouse-feeler {
		--feeler-x: 50vw;
		--feeler-y: 50vh;
		position: fixed;
		inset: 0;
		z-index: 10000;
		pointer-events: none;
		opacity: 0;
		contain: strict;
		transition: opacity var(--feeler-fade) ease-out;
		will-change: opacity;
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
			circle var(--feeler-radius) at var(--feeler-x) var(--feeler-y),
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
		-webkit-mask-image: radial-gradient(
			circle var(--feeler-radius) at var(--feeler-x) var(--feeler-y),
			#000 0%,
			rgb(0 0 0 / 0.7) 42%,
			transparent 82%
		);
		mask-image: radial-gradient(
			circle var(--feeler-radius) at var(--feeler-x) var(--feeler-y),
			#000 0%,
			rgb(0 0 0 / 0.7) 42%,
			transparent 82%
		);
	}

	/* Built-ins are deliberately CSS-only. A future custom/image pattern only
	   needs to provide background-image/background-size here; pointer tracking
	   and the radial reveal mask stay unchanged. */
	.mouse-feeler[data-pattern='triangles'] .mouse-feeler__texture {
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='52' height='45' viewBox='0 0 52 45'%3E%3Cpath d='M26 4 48 41H4Z' fill='none' stroke='white' stroke-opacity='.24' stroke-width='1'/%3E%3C/svg%3E");
		background-size: 52px 45px;
		background-position: 5px 8px;
	}

	.mouse-feeler[data-pattern='dots'] .mouse-feeler__texture {
		background-image: radial-gradient(circle, rgb(255 255 255 / 0.55) 0 1px, transparent 1.4px);
		background-size: 18px 18px;
	}

	.mouse-feeler[data-pattern='grid'] .mouse-feeler__texture {
		background-image:
			linear-gradient(rgb(255 255 255 / 0.22) 1px, transparent 1px),
			linear-gradient(90deg, rgb(255 255 255 / 0.22) 1px, transparent 1px);
		background-size: 28px 28px;
	}

	.mouse-feeler[data-pattern='sparkles'] .mouse-feeler__texture {
		background-image:
			radial-gradient(circle at 20% 30%, rgb(255 255 255 / 0.8) 0 1px, transparent 1.5px),
			radial-gradient(circle at 70% 65%, rgb(255 255 255 / 0.55) 0 1px, transparent 1.4px),
			radial-gradient(circle at 45% 85%, rgb(255 255 255 / 0.42) 0 0.8px, transparent 1.3px);
		background-size: 46px 46px, 63px 63px, 79px 79px;
	}

	.mouse-feeler[data-pattern='none'] .mouse-feeler__texture {
		display: none;
	}

	@media (prefers-reduced-motion: reduce), (pointer: coarse) {
		.mouse-feeler {
			display: none;
		}
	}
</style>
