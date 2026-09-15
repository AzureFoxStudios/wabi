<script lang="ts">
	import { onMount } from 'svelte';
	import {
		applyFeelerSettings,
		BASIC_FEELER_PATTERNS,
		CONNECTED_WORLD_PATTERNS,
		DEFAULT_FEELER_SETTINGS,
		FEELER_DEMO_EVENT,
		FEELER_DEMO_STATE_EVENT,
		FEELER_ERROR_EVENT,
		FEELER_ERROR_REQUEST_EVENT,
		FEELER_SETTINGS_EVENT,
		FEELER_STORAGE_KEY,
		isConnectedWorldPattern,
		isFeelerPattern,
		isLittleWorldPattern,
		LITTLE_WORLD_PATTERNS,
		normalizeFeelerSettings,
		readFeelerSettings,
		type FeelerDemoRequest,
		type FeelerSettings
	} from './mouseFeelerConfig';
	import {
		downloadPointerShaderTemplate,
		importLocalImageEffect,
		importLocalShaderEffect,
		listLocalVisualEffects,
		LOCAL_VISUAL_EFFECTS_EVENT,
		removeLocalVisualEffect,
		type LocalVisualEffectRecord
	} from './localVisualEffects';

	type NumericSetting = { [K in keyof FeelerSettings]: FeelerSettings[K] extends number ? K : never }[keyof FeelerSettings];
	type Slider = { key: NumericSetting; label: string; min: number; max: number; step: number; unit: 'percent' | 'px' | 'ms' | 'scale'; description?: string };
	const standardSliders: Slider[] = [
		{ key: 'intensity', label: 'Glow strength', min: 0, max: 0.15, step: 0.01, unit: 'percent' },
		{ key: 'textureOpacity', label: 'Texture / effect strength', min: 0, max: 0.4, step: 0.02, unit: 'percent' },
		{ key: 'radius', label: 'Radius', min: 80, max: 360, step: 10, unit: 'px' },
		{ key: 'patternScale', label: 'Spacing / pattern scale', min: 0.5, max: 2, step: 0.05, unit: 'scale', description: 'Larger values spread out and enlarge the pattern.' },
		{ key: 'idleDelayMs', label: 'Idle delay', min: 30, max: 300, step: 10, unit: 'ms', description: 'How long the pointer stays lit after you stop moving.' },
		{ key: 'fadeMs', label: 'Fade duration', min: 150, max: 1200, step: 10, unit: 'ms' },
		{ key: 'trailMs', label: 'Trail duration', min: 0, max: 1200, step: 20, unit: 'ms', description: 'Set to zero to follow only the current pointer position.' },
		{ key: 'trailStrength', label: 'Trail strength', min: 0, max: 1, step: 0.05, unit: 'percent' }
	];
	const connectedSliders: Slider[] = [
		{ key: 'fieldDensity', label: 'Field density', min: 0.6, max: 1.5, step: 0.05, unit: 'scale' },
		{ key: 'materialDetail', label: 'Material detail', min: 0.5, max: 2, step: 0.05, unit: 'scale' },
		{ key: 'settleSpeed', label: 'Settle speed', min: 0.25, max: 4, step: 0.05, unit: 'scale', description: 'How quickly the world returns to rest.' },
		{ key: 'mazeCurve', label: 'Maze curve', min: 0, max: 1, step: 0.05, unit: 'percent' },
		{ key: 'response', label: 'Pointer response', min: 0, max: 1, step: 0.05, unit: 'percent', description: 'How strongly the world reacts to nearby movement.' }
	];
	const patternGroups = [
		{ label: 'Basics', patterns: BASIC_FEELER_PATTERNS },
		{ label: 'Little Worlds', patterns: LITTLE_WORLD_PATTERNS },
		{ label: 'Connected Worlds', patterns: CONNECTED_WORLD_PATTERNS }
	];

	let settings = $state<FeelerSettings>({ ...DEFAULT_FEELER_SETTINGS });
	let localEffects = $state<LocalVisualEffectRecord[]>([]);
	let importBusy = $state(false);
	let importMessage = $state('');
	let runtimeError = $state('');
	let demoRunning = $state(false);
	let reducedMotion = $state(false);
	let finePointer = $state(true);
	let imageInput: HTMLInputElement;
	let shaderInput: HTMLInputElement;
	let sampleArea: HTMLDivElement;
	let mounted = false;
	let libraryRequest = 0;

	const selection = $derived(settings.pattern === 'local' && settings.customEffectId ? `local:${settings.customEffectId}` : settings.pattern);
	const selectedPattern = $derived(patternGroups.flatMap((group) => [...group.patterns]).find((pattern) => pattern.id === settings.pattern));
	const family = $derived(isLittleWorldPattern(settings.pattern) ? 'Little Worlds' : isConnectedWorldPattern(settings.pattern) ? 'Connected Worlds' : settings.pattern === 'local' ? 'Your local effects' : 'Basics');
	const isMaterial = $derived(settings.pattern === 'water' || settings.pattern === 'sand');
	const isLocalShader = $derived(settings.pattern === 'local' && localEffects.some((effect) => effect.id === settings.customEffectId && effect.kind === 'shader'));
	const availableConnectedSliders = $derived(connectedSliders.filter((slider) =>
		(slider.key !== 'materialDetail' || isMaterial) &&
		(slider.key !== 'fieldDensity' || !isMaterial) &&
		(slider.key !== 'mazeCurve' || settings.pattern === 'maze')));

	function apply(patch: Partial<FeelerSettings>): void {
		settings = applyFeelerSettings(patch);
	}

	async function refreshLibrary(): Promise<void> {
		const request = ++libraryRequest;
		try {
			const effects = await listLocalVisualEffects();
			if (mounted && request === libraryRequest) localEffects = effects;
		} catch (error) {
			if (mounted && request === libraryRequest) {
				importMessage = error instanceof Error ? error.message : 'Could not load your local effects.';
			}
		}
	}

	onMount(() => {
		mounted = true;
		settings = readFeelerSettings();
		void refreshLibrary();
		const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
		const pointer = window.matchMedia('(pointer: fine)');
		const updatePointer = () => { finePointer = pointer.matches; };
		updatePointer();
		pointer.addEventListener('change', updatePointer);
		const updateMotion = () => { reducedMotion = motion.matches; };
		updateMotion();
		motion.addEventListener('change', updateMotion);
		const handleLibraryChanged = () => void refreshLibrary();
		const handleSettingsChanged = (event: Event) => {
			settings = normalizeFeelerSettings({ ...settings, ...(event as CustomEvent<Partial<FeelerSettings>>).detail });
		};
		const handleStorageChanged = (event: StorageEvent) => {
			if (event.key === null || event.key === FEELER_STORAGE_KEY) settings = readFeelerSettings();
		};
		const handleDemoState = (event: Event) => { demoRunning = (event as CustomEvent<{ running: boolean }>).detail?.running === true; };
		const handleError = (event: Event) => {
			const detail = (event as CustomEvent<unknown>).detail;
			runtimeError = typeof detail === 'string' ? detail : '';
		};
		window.addEventListener(LOCAL_VISUAL_EFFECTS_EVENT, handleLibraryChanged);
		window.addEventListener(FEELER_SETTINGS_EVENT, handleSettingsChanged);
		window.addEventListener('storage', handleStorageChanged);
		window.addEventListener(FEELER_DEMO_STATE_EVENT, handleDemoState);
		window.addEventListener(FEELER_ERROR_EVENT, handleError);
		window.dispatchEvent(new CustomEvent(FEELER_ERROR_REQUEST_EVENT));
		return () => {
			mounted = false;
			++libraryRequest;
			if (demoRunning) window.dispatchEvent(new CustomEvent<FeelerDemoRequest>(FEELER_DEMO_EVENT, { detail: { stop: true } }));
			motion.removeEventListener('change', updateMotion);
			pointer.removeEventListener('change', updatePointer);
			window.removeEventListener(LOCAL_VISUAL_EFFECTS_EVENT, handleLibraryChanged);
			window.removeEventListener(FEELER_SETTINGS_EVENT, handleSettingsChanged);
			window.removeEventListener('storage', handleStorageChanged);
			window.removeEventListener(FEELER_DEMO_STATE_EVENT, handleDemoState);
			window.removeEventListener(FEELER_ERROR_EVENT, handleError);
		};
	});

	function handlePatternChange(event: Event): void {
		const value = (event.currentTarget as HTMLSelectElement).value;
		runtimeError = '';
		if (value.startsWith('local:')) {
			apply({ pattern: 'local', customEffectId: value.slice('local:'.length) || null });
		} else if (isFeelerPattern(value)) {
			apply({ pattern: value, customEffectId: null });
		}
	}

	function sampleSweep(): void {
		if (demoRunning) {
			window.dispatchEvent(new CustomEvent<FeelerDemoRequest>(FEELER_DEMO_EVENT, { detail: { stop: true } }));
			return;
		}
		if (!sampleArea || !settings.enabled || reducedMotion || !finePointer) return;
		const { left, top, width, height } = sampleArea.getBoundingClientRect();
		window.dispatchEvent(new CustomEvent<FeelerDemoRequest>(FEELER_DEMO_EVENT, { detail: { bounds: { left, top, width, height } } }));
	}

	function reshuffle(): void {
		const random = crypto.getRandomValues(new Uint32Array(1))[0];
		apply({ seed: random === settings.seed ? (random + 1) >>> 0 : random });
	}

	function formatValue(value: number, unit: Slider['unit']): string {
		if (unit === 'percent') return `${Math.round(value * 100)}%`;
		if (unit === 'scale') return `${Number(value.toFixed(2))}×`;
		return `${Math.round(value)} ${unit}`;
	}

	async function importEffect(kind: 'image' | 'shader', file: File | undefined): Promise<void> {
		if (!file || importBusy) return;
		importBusy = true;
		importMessage = '';
		try {
			const effect = await (kind === 'image' ? importLocalImageEffect(file) : importLocalShaderEffect(file));
			await refreshLibrary();
			if (!mounted) return;
			runtimeError = '';
			apply({ pattern: 'local', customEffectId: effect.id });
			importMessage = `Imported ${effect.name}`;
		} catch (error) {
			if (mounted) importMessage = error instanceof Error ? error.message : `${kind === 'image' ? 'Image' : 'Shader'} import failed`;
		} finally {
			importBusy = false;
			if (imageInput) imageInput.value = '';
			if (shaderInput) shaderInput.value = '';
		}
	}

	async function removeEffect(effect: LocalVisualEffectRecord): Promise<void> {
		if (importBusy) return;
		importBusy = true;
		try {
			await removeLocalVisualEffect(effect.id);
			if (settings.customEffectId === effect.id) apply({ pattern: 'triangles', customEffectId: null });
			await refreshLibrary();
			importMessage = `Removed ${effect.name}`;
		} catch (error) {
			importMessage = error instanceof Error ? error.message : 'Could not remove effect';
		} finally {
			importBusy = false;
		}
	}
</script>

{#snippet sliderControl(slider: Slider)}
	<div class="setting-item setting-item-stack">
		<div class="setting-info">
			<label class="setting-label" for={`feeler-${slider.key}`}>{slider.label}</label>
			<span class="setting-description slider-value">{formatValue(settings[slider.key], slider.unit)}</span>
			{#if slider.description}<span class="setting-description">{slider.description}</span>{/if}
		</div>
		<input id={`feeler-${slider.key}`} type="range" min={slider.min} max={slider.max} step={slider.step}
			value={settings[slider.key]} oninput={(event) => apply({ [slider.key]: Number(event.currentTarget.value) })}
			class="volume-slider" disabled={!settings.enabled || (settings.pattern === 'none' && ['textureOpacity', 'patternScale'].includes(slider.key)) || (isLocalShader && ['patternScale', 'trailStrength'].includes(slider.key)) || (slider.key === 'trailStrength' && settings.trailMs === 0)} />
	</div>
{/snippet}

<div class="feeler-settings">
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Mouse feeler</span>
			<span class="setting-description">Reveal a world around your moving pointer. Saved on this device across all themes and backgrounds.</span>
		</div>
		<button type="button" class="toggle-btn" class:active={settings.enabled} onclick={() => apply({ enabled: !settings.enabled })}
			role="switch" aria-checked={settings.enabled} aria-label="Enable pointer effects">{settings.enabled ? 'ON' : 'OFF'}</button>
	</div>

	<div class="setting-item pattern-row">
		<div class="setting-info">
			<label class="setting-label" for="feeler-pattern">Pattern</label>
			<span class="setting-description">Basics, scattered Little Worlds and reactive Connected Worlds.</span>
		</div>
		<select id="feeler-pattern" class="theme-select" value={selection} onchange={handlePatternChange} disabled={!settings.enabled}>
			{#each patternGroups as group (group.label)}
				<optgroup label={group.label}>
					{#each group.patterns as pattern (pattern.id)}<option value={pattern.id}>{pattern.name}</option>{/each}
				</optgroup>
			{/each}
			{#if settings.pattern === 'local' && !localEffects.some((effect) => effect.id === settings.customEffectId)}
				<option value={selection} disabled>Unavailable local effect</option>
			{/if}
			{#if localEffects.length}
				<optgroup label="Your local effects">
					{#each localEffects as effect (effect.id)}<option value={`local:${effect.id}`}>{effect.name} ({effect.kind})</option>{/each}
				</optgroup>
			{/if}
		</select>
	</div>

	<div class="sample-card">
		<div class="sample-heading">
			<div class="setting-info"><span class="family-label">{family}</span><span class="setting-label">{selectedPattern?.name ?? localEffects.find((effect) => effect.id === settings.customEffectId)?.name ?? 'Local effect'}</span></div>
			<button type="button" class="action-btn" data-pointer-demo-control onclick={sampleSweep} disabled={!settings.enabled || reducedMotion || !finePointer} aria-pressed={demoRunning}>{demoRunning ? 'Stop sample sweep' : 'Draw a sample sweep'}</button>
		</div>
		<p class="setting-description">{selectedPattern?.description ?? 'Your imported image or shader follows the pointer.'}</p>
		<div bind:this={sampleArea} class="sample-area" aria-label="Pointer effect sample area">
			<span>{!settings.enabled ? 'Enable pointer effects to try a pattern.' : reducedMotion ? 'Pointer motion is paused by your reduced-motion preference.' : !finePointer ? 'Pointer effects need a mouse or other precise pointer.' : demoRunning ? 'Drawing a sample sweep…' : 'Move your pointer here, or draw a sample sweep.'}</span>
		</div>
		{#if runtimeError}<p class="effect-error" role="alert">{runtimeError}</p>{/if}
	</div>

	{#if isLocalShader}<p class="setting-description shader-controls-note">This shader defines its own pattern size and use of history. Trail duration still controls how much history it receives.</p>{/if}
	<div class="controls-grid">{#each standardSliders as slider (slider.key)}{@render sliderControl(slider)}{/each}</div>

	{#if isLittleWorldPattern(settings.pattern) || isConnectedWorldPattern(settings.pattern)}
		<div class="setting-item seed-row">
			<div class="setting-info"><label class="setting-label" for="feeler-seed">Layout seed</label><span class="setting-description">Keep a favorite arrangement or reshuffle for new clusters and discoveries.</span></div>
			<div class="seed-actions">
				<input id="feeler-seed" class="seed-input theme-select" type="number" min="0" max="4294967295" step="1" value={settings.seed} onchange={(event) => apply({ seed: Number(event.currentTarget.value) })} disabled={!settings.enabled} />
				<button type="button" class="action-btn" onclick={reshuffle} disabled={!settings.enabled}>Reshuffle</button>
			</div>
		</div>
	{/if}

	{#if isConnectedWorldPattern(settings.pattern)}
		<fieldset class="world-controls"><legend>World behavior</legend><div class="controls-grid">{#each availableConnectedSliders as slider (slider.key)}{@render sliderControl(slider)}{/each}</div></fieldset>
	{/if}

	<div class="local-effects-card">
		<div class="setting-info"><span class="setting-label">Your effects</span><span class="setting-description">Import an image texture or pointer shader from your computer. Your library stays on this device.</span></div>
		<div class="local-effects-actions">
			<button type="button" class="action-btn" disabled={importBusy} onclick={() => imageInput?.click()}>Import image</button>
			<button type="button" class="action-btn" disabled={importBusy} onclick={() => shaderInput?.click()}>Import shader</button>
			<button type="button" class="action-btn" onclick={downloadPointerShaderTemplate}>Shader template</button>
		</div>
		<input bind:this={imageInput} class="file-input" type="file" aria-label="Import pointer image" accept=".png,.webp,.jpg,.jpeg,.gif,.svg,image/png,image/webp,image/jpeg,image/gif,image/svg+xml" onchange={(event) => void importEffect('image', event.currentTarget.files?.[0])} />
		<input bind:this={shaderInput} class="file-input" type="file" aria-label="Import pointer shader" accept=".frag,.glsl,text/plain" onchange={(event) => void importEffect('shader', event.currentTarget.files?.[0])} />
		{#if importMessage}<div class="import-message" role="status">{importMessage}</div>{/if}
		{#if localEffects.length}
			<div class="local-effect-list">
				{#each localEffects as effect (effect.id)}
					<div class="local-effect-row">
						<div><strong>{effect.name}</strong><span>{effect.kind === 'image' ? 'Image texture' : 'Pointer shader'}</span></div>
						<div class="local-effect-row-actions">
							<button type="button" class="action-btn" disabled={importBusy} aria-label={`Use ${effect.name}`} aria-pressed={settings.pattern === 'local' && settings.customEffectId === effect.id} onclick={() => { runtimeError = ''; apply({ pattern: 'local', customEffectId: effect.id }); }}>Use</button>
							<button type="button" class="action-btn danger" disabled={importBusy} aria-label={`Remove ${effect.name}`} onclick={() => void removeEffect(effect)}>Remove</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.feeler-settings { min-width: 0; }
	.feeler-settings :is(button, select, input[type='number']) { min-height: 40px; }
	.feeler-settings :is(button, select, input):focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 3px; }
	.setting-info { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
	.pattern-row { align-items: flex-start; }
	.pattern-row select { max-width: 100%; }
	.controls-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 1.25rem; }
	.slider-value, .seed-input { font-variant-numeric: tabular-nums; }
	.shader-controls-note { margin: 1rem 0 0.25rem; text-wrap: pretty; }
	.sample-card, .local-effects-card { margin-top: 0.75rem; padding: 1rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--surface-raised) 60%, transparent); }
	.sample-heading, .seed-actions { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
	.family-label { color: var(--text-muted); font-size: var(--font-size-xs, 0.75rem); }
	.sample-card p { margin: 0.5rem 0 0.75rem; text-wrap: pretty; }
	.sample-area { display: grid; place-items: center; min-height: 180px; padding: 1rem; border: 1px dashed var(--border-subtle); border-radius: var(--radius-md); background: color-mix(in srgb, var(--surface-sunken) 45%, transparent); }
	.sample-area span { max-width: 28ch; color: var(--text-muted); font-size: var(--font-size-sm); text-align: center; pointer-events: none; }
	.seed-row { flex-wrap: wrap; }
	.seed-input { width: 10rem; max-width: 100%; }
	.world-controls { min-width: 0; margin: 0.75rem 0 0; padding: 0.5rem 1rem; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); }
	.world-controls legend { padding: 0 0.4rem; color: var(--text-secondary); font-size: var(--font-size-sm); }
	.local-effects-actions, .local-effect-row-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem; }
	.file-input { display: none; }
	.import-message, .effect-error { margin-top: 0.6rem; font-size: var(--font-size-sm); color: var(--text-secondary); overflow-wrap: anywhere; }
	.effect-error { color: var(--status-error, var(--text-heading)); }
	.local-effect-list { display: flex; flex-direction: column; gap: 0.45rem; margin-top: 0.8rem; }
	.local-effect-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding-top: 0.55rem; border-top: 1px solid var(--border-subtle); }
	.local-effect-row > div:first-child { display: flex; flex-direction: column; min-width: 0; }
	.local-effect-row strong { font-size: var(--font-size-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.local-effect-row span { font-size: var(--font-size-xs, 0.75rem); color: var(--text-secondary); }
	.local-effect-row-actions { margin-top: 0; flex-shrink: 0; }
	.action-btn.danger { color: var(--status-error, var(--text-heading)); }
	@media (max-width: 600px) {
		.controls-grid { grid-template-columns: minmax(0, 1fr); }
		.pattern-row { flex-direction: column; gap: 0.5rem; }
		.pattern-row select { width: 100%; }
		.sample-heading { align-items: flex-start; }
		.local-effect-row { flex-wrap: wrap; }
		.feeler-settings :is(button, select, input[type='number']) { min-height: 44px; }
	}
</style>
