<script lang="ts">
	import { onMount } from 'svelte';
	import PointerShaderSurface from './PointerShaderSurface.svelte';
	import PointerPatternSurface from './PointerPatternSurface.svelte';
	import ReactivePointerSurface from './ReactivePointerSurface.svelte';
	import { PointerTrail, type PointerSample } from './pointerTrail';
	import { PointerDemoSweep, visibleDemoBounds } from './pointerDemo';
	import { pointerTrailLifetime, type PointerWorldOptions } from './pointerWorlds';
	import {
		DEFAULT_FEELER_SETTINGS, FEELER_SETTINGS_EVENT, FEELER_STORAGE_KEY,
		FEELER_DEMO_EVENT, FEELER_DEMO_STATE_EVENT, FEELER_ERROR_EVENT, FEELER_ERROR_REQUEST_EVENT,
		isConnectedWorldPattern, normalizeFeelerSettings, readFeelerSettings, type FeelerSettings
	} from './mouseFeelerConfig';
	import { getLocalVisualEffect, LOCAL_VISUAL_EFFECTS_EVENT } from './localVisualEffects';

	let layer: HTMLDivElement;
	let settings = $state<FeelerSettings>({ ...DEFAULT_FEELER_SETTINGS });
	let customImageUrl = $state('');
	let tileWidth = $state(96), tileHeight = $state(96);
	let shaderSource = $state(''), effectError = $state('');
	let shaderSurface = $state.raw<{ setPointerState: (x: number, y: number, vx: number, vy: number, trail?: readonly PointerSample[]) => void; pause: () => void }>();
	let patternSurface = $state.raw<{ draw: (now: number) => boolean; clear: () => void }>();
	let connectedSurface = $state.raw<{ draw: (now: number) => boolean; clear: () => void; refreshColors: () => void }>();
	const trail = new PointerTrail();
	const shaderPoints: PointerSample[] = [];
	const worldOptions = $derived(isConnectedWorldPattern(settings.pattern) ? { ...settings, pattern: settings.pattern } as PointerWorldOptions : null);
	let loadGeneration = 0, disposed = false;

	function reportError(message: string): void {
		effectError = message;
		window.dispatchEvent(new CustomEvent(FEELER_ERROR_EVENT, { detail: message }));
	}
	function clearLocalEffect(): void {
		if (customImageUrl) URL.revokeObjectURL(customImageUrl);
		customImageUrl = ''; shaderSource = '';
	}
	async function loadSelectedLocalEffect(): Promise<void> {
		const generation = ++loadGeneration;
		clearLocalEffect(); reportError('');
		if (settings.pattern !== 'local' || !settings.customEffectId) return;
		const id = settings.customEffectId;
		try {
			const effect = await getLocalVisualEffect(id);
			// Fence stale reads before allocating URLs or replacing a newer selection.
			if (disposed || generation !== loadGeneration || settings.pattern !== 'local' || settings.customEffectId !== id) return;
			if (!effect) { reportError('This local effect is missing. Import it again or choose another effect.'); return; }
			if (effect.kind === 'image' && effect.imageBlob) {
				tileWidth = Math.max(1, Math.min(512, effect.tileWidth || effect.tileSize || 96));
				tileHeight = Math.max(1, Math.min(512, effect.tileHeight || effect.tileSize || 96));
				customImageUrl = URL.createObjectURL(effect.imageBlob);
			} else if (effect.kind === 'shader' && effect.shaderSource) shaderSource = effect.shaderSource;
			else reportError('This local effect has no usable image or shader. Import it again.');
		} catch (error) {
			if (!disposed && generation === loadGeneration) reportError(error instanceof Error ? error.message : 'Could not load the local effect.');
		}
	}

	onMount(() => {
		disposed = false;
		settings = readFeelerSettings(); void loadSelectedLocalEffect();
		const finePointer = window.matchMedia('(pointer: fine)');
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
		let frame = 0, active = false, lastShaderTime = -Infinity, fromDemo = false, colorsDirty = true;
		const allowed = () => settings.enabled && finePointer.matches && !reducedMotion.matches && !document.hidden;
		const lifetime = () => worldOptions ? pointerTrailLifetime(worldOptions) : Math.max(settings.trailMs, settings.idleDelayMs + settings.fadeMs);
		const demo = new PointerDemoSweep((x, y, now) => {
			if (!allowed()) { hide(); return; }
			feed(x, y, now);
		}, (running) => window.dispatchEvent(new CustomEvent(FEELER_DEMO_STATE_EVENT, { detail: { running } })));

		function hide(): void {
			demo.cancel();
			if (frame) cancelAnimationFrame(frame);
			frame = 0; active = false; lastShaderTime = -Infinity; fromDemo = false;
			trail.clear(); shaderSurface?.pause(); patternSurface?.clear(); connectedSurface?.clear();
			if (layer) layer.style.opacity = '0';
		}
		function draw(): void {
			frame = 0;
			if (!active || !allowed() || !layer) { hide(); return; }
			// RAF schedules the frame; its timestamp can precede the latest real input.
			const now = performance.now(), age = Math.max(0, now - trail.current.t);
			const alpha = Math.max(0, 1 - Math.max(0, age - settings.idleDelayMs) / settings.fadeMs);
			layer.style.transform = `translate3d(${trail.current.x - settings.radius}px,${trail.current.y - settings.radius}px,0)`;
			layer.style.opacity = String(alpha);
			if (colorsDirty) { connectedSurface?.refreshColors(); colorsDirty = false; }
			if (worldOptions) connectedSurface?.draw(now);
			else if (!shaderSource) patternSurface?.draw(now);
			if (shaderSource) {
				if (age < settings.idleDelayMs && trail.current.t !== lastShaderTime) {
					trail.read(now, Math.max(1, settings.trailMs), shaderPoints);
					shaderSurface?.setPointerState(trail.current.x, trail.current.y, trail.vx, trail.vy, settings.trailMs > 0 ? shaderPoints : []);
					if (shaderSurface) lastShaderTime = trail.current.t;
				} else if (age >= settings.idleDelayMs) shaderSurface?.pause();
			}
			if (age < Math.max(lifetime(), settings.idleDelayMs + settings.fadeMs)) frame = requestAnimationFrame(draw);
			else { active = false; shaderSurface?.pause(); patternSurface?.clear(); connectedSurface?.clear(); }
		}
		function feed(x: number, y: number, now: number): void {
			if (!allowed() || !trail.push(x, y, now, lifetime())) return;
			active = true;
			if (!frame) frame = requestAnimationFrame(draw);
		}
		const handlePointerMove = (event: PointerEvent) => {
			if (!allowed() || (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen')) return;
			if (demo.running && event.target instanceof Element && event.target.closest('[data-pointer-demo-control]')) return;
			if (fromDemo) { demo.cancel(); trail.clear(); fromDemo = false; lastShaderTime = -Infinity; }
			feed(event.clientX, event.clientY, performance.now());
		};
		const updateSettings = (next: FeelerSettings) => {
			const reload = next.pattern !== settings.pattern || next.customEffectId !== settings.customEffectId;
			settings = next;
			if (reload) { hide(); void loadSelectedLocalEffect(); }
			if (!allowed()) hide();
			// Changes may update an existing stroke, but never manufacture activity.
		};
		const handleSettings = (event: Event) => updateSettings(normalizeFeelerSettings({ ...settings, ...((event as CustomEvent).detail || {}) }));
		const handleStorage = (event: StorageEvent) => { if (event.key === FEELER_STORAGE_KEY || event.key === null) updateSettings(readFeelerSettings()); };
		const handleLibraryChanged = () => { if (settings.pattern === 'local') void loadSelectedLocalEffect(); };
		const handleDemo = (event: Event) => {
			const detail = (event as CustomEvent).detail;
			if (detail?.stop) { hide(); return; }
			if (!allowed()) return;
			const bounds = visibleDemoBounds(detail?.bounds, window.innerWidth, window.innerHeight);
			if (!bounds) return;
			hide(); fromDemo = true; demo.start(bounds);
		};
		const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && fromDemo) hide(); };
		const handleErrorRequest = () => reportError(effectError);
		const handleVisibility = () => { if (document.hidden) hide(); };
		const observer = new MutationObserver(() => { colorsDirty = true; });
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
		window.addEventListener('pointermove', handlePointerMove, { passive: true });
		window.addEventListener('blur', hide);
		window.addEventListener('resize', hide, { passive: true });
		window.addEventListener('keydown', handleKey);
		window.addEventListener('storage', handleStorage);
		window.addEventListener(FEELER_SETTINGS_EVENT, handleSettings);
		window.addEventListener(FEELER_DEMO_EVENT, handleDemo);
		window.addEventListener(FEELER_ERROR_REQUEST_EVENT, handleErrorRequest);
		window.addEventListener(LOCAL_VISUAL_EFFECTS_EVENT, handleLibraryChanged);
		document.documentElement.addEventListener('mouseleave', hide);
		document.addEventListener('visibilitychange', handleVisibility);
		finePointer.addEventListener('change', hide);
		reducedMotion.addEventListener('change', hide);
		return () => {
			disposed = true; ++loadGeneration; hide(); observer.disconnect();
			window.removeEventListener('pointermove', handlePointerMove);
			window.removeEventListener('blur', hide);
			window.removeEventListener('resize', hide);
			window.removeEventListener('keydown', handleKey);
			window.removeEventListener('storage', handleStorage);
			window.removeEventListener(FEELER_SETTINGS_EVENT, handleSettings);
			window.removeEventListener(FEELER_DEMO_EVENT, handleDemo);
			window.removeEventListener(FEELER_ERROR_REQUEST_EVENT, handleErrorRequest);
			window.removeEventListener(LOCAL_VISUAL_EFFECTS_EVENT, handleLibraryChanged);
			document.documentElement.removeEventListener('mouseleave', hide);
			document.removeEventListener('visibilitychange', handleVisibility);
			finePointer.removeEventListener('change', hide);
			reducedMotion.removeEventListener('change', hide);
			clearLocalEffect();
		};
	});
</script>

<div class="pointer-effects-overlay" class:disabled={!settings.enabled} aria-hidden="true" data-pattern={settings.pattern}>
	<div bind:this={layer} class="mouse-feeler" style={`--feeler-diameter:${settings.radius * 2}px;--feeler-strength:${settings.intensity}`}>
		<div class="mouse-feeler__glow"></div>
		{#if shaderSource}
			<PointerShaderSurface bind:this={shaderSurface} source={shaderSource} radius={settings.radius} opacity={settings.textureOpacity} onshadererror={reportError} />
		{/if}
	</div>
	{#if worldOptions}
		<ReactivePointerSurface bind:this={connectedSurface} options={worldOptions} {trail} onerror={reportError} />
	{:else if !shaderSource}
		<PointerPatternSurface bind:this={patternSurface} options={settings} {trail} imageUrl={customImageUrl} {tileWidth} {tileHeight} onerror={reportError} />
	{/if}
</div>
{#if effectError}<span class="sr-only" aria-live="polite">Pointer effect: {effectError}</span>{/if}
<style>
	.pointer-effects-overlay { position: fixed; inset: 0; z-index: 10000; pointer-events: none; overflow: hidden; contain: strict; }
	.disabled { display: none; }
	.mouse-feeler { position: absolute; left: 0; top: 0; width: var(--feeler-diameter); height: var(--feeler-diameter); opacity: 0; overflow: hidden; border-radius: 50%; pointer-events: none; contain: layout paint style; }
	.mouse-feeler__glow { position: absolute; inset: 0; pointer-events: none; background: radial-gradient(circle at 50% 50%, rgb(255 255 255 / var(--feeler-strength)) 0%, rgb(255 255 255 / calc(var(--feeler-strength) * .5)) 35%, rgb(255 255 255 / calc(var(--feeler-strength) * .13)) 62%, transparent 100%); mix-blend-mode: screen; }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
	@media (prefers-reduced-motion: reduce), (pointer: coarse) { .pointer-effects-overlay { display: none; } }
</style>
