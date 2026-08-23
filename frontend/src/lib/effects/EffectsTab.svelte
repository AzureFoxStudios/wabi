<script lang="ts">
	import { onMount } from 'svelte';
	import { effectsRegistry } from './registry';
	import { themeStore } from '$lib/theme/themeStore';
	import { THEMES } from '$lib/theme/themes';
	import { getAuthToken } from '$lib/authSession';
	import { saveThemePreferences } from '$lib/theme/themeApi';
	import { saveThemeToLocalStorage } from '$lib/theme/themeManager';
	import { showToast } from '$lib/toast';
	import type { EffectConfig } from './types';

	let selectedEffect = 'none';
	let effectColor = '#6366f1';
	let effectColor2 = '#006bb4';
	let effectColor3 = '#162325';
	let effectIntensity = 0;
	let effectSize = 1;
	let effectSpeed = 1;
	let applyGlobally = false;
	/** Effect-specific saved state (e.g. Joker title/blind/shop). */
	let jokerState: 'title' | 'blind' | 'shop' = 'title';
	let saving = false;

	$: effects = effectsRegistry.list();
	$: isJoker = selectedEffect === 'joker';
	// Speeds are RELATIVE to authentic in-game pace (1 = how the game reads).
	const BALATRO_PRESETS: Record<string, { speed: number; intensity: number; size: number; label: string }> = {
		title: { speed: 1.15, intensity: 0.7, size: 1, label: 'Title' },
		blind: { speed: 1.6, intensity: 1, size: 1.1, label: 'Blind' },
		shop: { speed: 0.8, intensity: 0.45, size: 0.9, label: 'Shop' },
	};

	function applyJokerState(next: 'title' | 'blind' | 'shop') {
		jokerState = next;
		const preset = BALATRO_PRESETS[next];
		effectSpeed = preset.speed;
		effectIntensity = preset.intensity;
		effectSize = preset.size;
		applyEffect();
	}

	$: if (!isJoker) {
		jokerState = 'title';
	}

	function loadFromCurrentTheme() {
		const theme = THEMES[$themeStore.themeId];
		const ambient = theme?.ambient;
		if (ambient) {
			const style = getComputedStyle(document.documentElement);
			selectedEffect = ambient.effect || 'none';
			effectColor = ambient.color || style.getPropertyValue('--bg-effect-color').trim() || '#6366f1';
			effectColor2 = ambient.color2 || style.getPropertyValue('--bg-effect-color2').trim() || '#006bb4';
			effectColor3 = ambient.color3 || style.getPropertyValue('--bg-effect-color3').trim() || '#162325';
			effectIntensity = (ambient.intensity ?? parseFloat(style.getPropertyValue('--bg-effect-intensity'))) || 0;
			effectSize = (ambient.size ?? parseFloat(style.getPropertyValue('--bg-effect-size'))) || 1;
			effectSpeed = (ambient.speed ?? parseFloat(style.getPropertyValue('--bg-effect-speed'))) || 1;
		} else {
			selectedEffect = 'none';
			effectIntensity = 0;
		}

		// Restore the user's saved effect override (if any) — this is what makes
		// tweaks and the Joker title/blind/shop state survive reloads.
		const saved = $themeStore.themeAmbient;
		if (saved && (saved.globalOverride || saved.effect === (theme?.ambient?.effect ?? selectedEffect))) {
			selectedEffect = saved.effect || selectedEffect;
			if (saved.color) effectColor = saved.color;
			if (saved.color2) effectColor2 = saved.color2;
			if (saved.color3) effectColor3 = saved.color3;
			effectIntensity = saved.intensity ?? effectIntensity;
			effectSize = saved.size ?? effectSize;
			effectSpeed = saved.speed ?? effectSpeed;
			if (saved.state && typeof saved.state.joker === 'string') {
				jokerState = saved.state.joker as 'title' | 'blind' | 'shop';
			}
			applyEffect();
		}
	}

	$: $themeStore.themeId, loadFromCurrentTheme();

	onMount(() => {
		loadFromCurrentTheme();
	});

	function applyEffect() {
		const root = document.documentElement;
		root.style.setProperty('--bg-effect-effect', selectedEffect);
		root.style.setProperty('--bg-effect-color', effectColor);
		root.style.setProperty('--bg-effect-color2', effectColor2);
		root.style.setProperty('--bg-effect-color3', effectColor3);
		root.style.setProperty('--bg-effect-intensity', String(effectIntensity));
		root.style.setProperty('--bg-effect-size', String(effectSize));
		root.style.setProperty('--bg-effect-speed', String(effectSpeed));
	}

	async function save() {
		saving = true;
		try {
			// Persist under `theme_ambient` — the backend whitelists this key and
			// it round-trips through themeStore so the state restores on reload.
			const ambient = {
				effect: selectedEffect,
				color: effectColor,
				color2: effectColor2,
				color3: effectColor3,
				intensity: effectIntensity,
				size: effectSize,
				speed: effectSpeed,
				globalOverride: applyGlobally,
				state: isJoker ? { joker: jokerState } : undefined,
			};
			themeStore.setThemeAmbient(ambient);
			const prefs: Record<string, unknown> = {
				theme_id: $themeStore.themeId,
				theme_ambient: ambient,
			};
			if (getAuthToken()) {
				await saveThemePreferences(prefs);
			} else {
				saveThemeToLocalStorage($themeStore.themeId, prefs);
			}
			showToast('Effect settings saved', 'info');
		} catch (err) {
			console.error('[EffectsTab] Save failed:', err);
			showToast('Failed to save effect settings', 'error');
		} finally {
			saving = false;
		}
	}

	function handleImport() {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.ts,.js,.mjs';
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				const code = await file.text();
				const blob = new Blob([code], { type: 'application/javascript' });
				const url = URL.createObjectURL(blob);
				const module = await import(/* @vite-ignore */ url);
				URL.revokeObjectURL(url);
				const EffectClass = module.default || Object.values(module)[0];
				if (!EffectClass || typeof EffectClass !== 'function') {
					showToast('Could not find an effect class in the module. Make sure it exports a class implementing AmbientEffect as default.', 'error');
					return;
				}
				const instance = new EffectClass();
				if (!instance.id || !instance.name || !instance.render) {
					showToast('Invalid effect: missing required properties (id, name, render).', 'error');
					return;
				}
				effectsRegistry.register(instance);
				selectedEffect = instance.id;
				effectColor = instance.defaultConfig?.color || effectColor;
				effectColor2 = instance.defaultConfig?.color2 || effectColor2;
				effectColor3 = instance.defaultConfig?.color3 || effectColor3;
				effectIntensity = instance.defaultConfig?.intensity ?? effectIntensity;
				effectSize = instance.defaultConfig?.size ?? effectSize;
				effectSpeed = instance.defaultConfig?.speed ?? effectSpeed;
				applyEffect();
			} catch (err) {
				showToast('Failed to import effect: ' + (err instanceof Error ? err.message : 'Unknown error'), 'error');
			}
		};
		input.click();
	}

	function handleEffectChange(e: Event) {
		const id = (e.currentTarget as HTMLSelectElement).value;
		selectedEffect = id;
		const effect = effectsRegistry.get(id);
		if (effect?.defaultConfig) {
			effectColor = effect.defaultConfig.color || effectColor;
			effectColor2 = effect.defaultConfig.color2 || effectColor2;
			effectColor3 = effect.defaultConfig.color3 || effectColor3;
			effectIntensity = effect.defaultConfig.intensity ?? effectIntensity;
			effectSize = effect.defaultConfig.size ?? effectSize;
			effectSpeed = effect.defaultConfig.speed ?? effectSpeed;
		}
		applyEffect();
	}
</script>

<div class="settings-subsection">
	<h4 class="subsection-label">Background Effects</h4>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Effect</span>
			<span class="setting-description">Choose an animated background effect for this theme</span>
		</div>
		<select class="theme-select" value={selectedEffect} on:change={handleEffectChange}>
			<option value="none">None (CSS glows only)</option>
			{#each effects as effect}
				<option value={effect.id}>{effect.name}</option>
			{/each}
		</select>
	</div>

	{#if isJoker}
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Balatro state</span>
				<span class="setting-description">Title screen, blind select, or shop</span>
			</div>
			<div class="segmented-control">
				<button type="button" class="segment" class:active={jokerState === 'title'} on:click={() => applyJokerState('title')}>Title</button>
				<button type="button" class="segment" class:active={jokerState === 'blind'} on:click={() => applyJokerState('blind')}>Blind</button>
				<button type="button" class="segment" class:active={jokerState === 'shop'} on:click={() => applyJokerState('shop')}>Shop</button>
			</div>
		</div>
	{/if}

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Color</span>
			<span class="setting-description">Accent color for the effect</span>
		</div>
		<input
			type="color"
			bind:value={effectColor}
			on:change={applyEffect}
			class="color-picker"
		/>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Color 2</span>
			<span class="setting-description">Secondary color (Joker's blue)</span>
		</div>
		<input
			type="color"
			bind:value={effectColor2}
			on:change={applyEffect}
			class="color-picker"
		/>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Color 3</span>
			<span class="setting-description">Tertiary color (Joker's dark base)</span>
		</div>
		<input
			type="color"
			bind:value={effectColor3}
			on:change={applyEffect}
			class="color-picker"
		/>
	</div>

	<div class="setting-item setting-item-stack">
		<div class="setting-info">
			<span class="setting-label">Intensity</span>
			<span class="setting-description">{Math.round(effectIntensity * 100)}%</span>
		</div>
		<input
			type="range"
			min="0"
			max="1"
			step="0.05"
			bind:value={effectIntensity}
			on:input={applyEffect}
			class="volume-slider"
		/>
	</div>

	<div class="setting-item setting-item-stack">
		<div class="setting-info">
			<span class="setting-label">Size</span>
			<span class="setting-description">{effectSize.toFixed(1)}×</span>
		</div>
		<input
			type="range"
			min="0.5"
			max="2"
			step="0.1"
			bind:value={effectSize}
			on:input={applyEffect}
			class="volume-slider"
		/>
	</div>

	<div class="setting-item setting-item-stack">
		<div class="setting-info">
			<span class="setting-label">Speed</span>
			<span class="setting-description">{effectSpeed.toFixed(1)}×</span>
		</div>
		<input
			type="range"
			min="0.5"
			max="2"
			step="0.1"
			bind:value={effectSpeed}
			on:input={applyEffect}
			class="volume-slider"
		/>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Apply to all themes</span>
			<span class="setting-description">Use this effect configuration for every theme</span>
		</div>
		<button class="toggle-btn" class:active={applyGlobally} on:click={() => applyGlobally = !applyGlobally}>
			{applyGlobally ? 'ON' : 'OFF'}
		</button>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Save effect preferences</span>
			<span class="setting-description">Persist your effect settings for this theme</span>
		</div>
		<button class="action-btn" on:click={save} disabled={saving}>
			{saving ? 'Saving...' : 'Save'}
		</button>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Import Custom Effect</span>
			<span class="setting-description">Import a .ts or .js file that exports an AmbientEffect class</span>
		</div>
		<button type="button" class="action-btn" on:click={handleImport}>
			Import
		</button>
	</div>
</div>

<style>
	.color-picker {
		width: 40px;
		height: 40px;
		border: none;
		border-radius: var(--radius-md, 8px);
		cursor: pointer;
		padding: 0;
		background: none;
	}
	.color-picker::-webkit-color-swatch-wrapper {
		padding: 2px;
	}
	.color-picker::-webkit-color-swatch {
		border: 1px solid var(--border, #302b63);
		border-radius: var(--radius-sm, 4px);
	}
	.segmented-control {
		display: inline-flex;
		gap: 0.25rem;
		padding: 0.2rem;
		border-radius: var(--radius-md, 8px);
		background: color-mix(in srgb, var(--surface-raised, #24243e) 80%, transparent);
		border: 1px solid var(--border-subtle, #3a3a4a);
	}
	.segment {
		border: none;
		background: transparent;
		color: var(--text-secondary, #a0a0a0);
		padding: 0.35rem 0.7rem;
		border-radius: calc(var(--radius-md, 8px) - 0.2rem);
		cursor: pointer;
		font-size: 0.8rem;
		font-weight: 600;
		transition: background 0.15s, color 0.15s;
	}
	.segment.active {
		background: color-mix(in srgb, var(--accent, #7c6af5) 18%, transparent);
		color: var(--text-primary, #f0f0f0);
	}
	.segment:hover:not(.active) {
		color: var(--text-primary, #f0f0f0);
	}
</style>
