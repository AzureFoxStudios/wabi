<script lang="ts">
	import { onMount } from 'svelte';
	import { effectsRegistry } from './registry';
	import { themeStore } from '$lib/theme/themeStore';
	import { THEMES } from '$lib/theme/themes';
	import { getAuthToken } from '$lib/authSession';
	import { saveThemePreferences } from '$lib/theme/themeApi';
	import { saveThemeToLocalStorage } from '$lib/theme/themeManager';
	import type { EffectConfig } from './types';

	let selectedEffect = 'none';
	let effectColor = '#6366f1';
	let effectIntensity = 0;
	let effectSize = 1;
	let effectSpeed = 1;
	let applyGlobally = false;
	let saving = false;

	$: effects = effectsRegistry.list();

	function loadFromCurrentTheme() {
		const theme = THEMES[$themeStore.themeId];
		const ambient = theme?.ambient;
		if (ambient) {
			const style = getComputedStyle(document.documentElement);
			selectedEffect = ambient.effect || 'none';
			effectColor = ambient.color || style.getPropertyValue('--bg-effect-color').trim() || '#6366f1';
			effectIntensity = (ambient.intensity ?? parseFloat(style.getPropertyValue('--bg-effect-intensity'))) || 0;
			effectSize = (ambient.size ?? parseFloat(style.getPropertyValue('--bg-effect-size'))) || 1;
			effectSpeed = (ambient.speed ?? parseFloat(style.getPropertyValue('--bg-effect-speed'))) || 1;
		} else {
			selectedEffect = 'none';
			effectIntensity = 0;
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
		root.style.setProperty('--bg-effect-intensity', String(effectIntensity));
		root.style.setProperty('--bg-effect-size', String(effectSize));
		root.style.setProperty('--bg-effect-speed', String(effectSpeed));
	}

	async function save() {
		saving = true;
		try {
			const prefs: Record<string, unknown> = {
				theme_id: $themeStore.themeId,
				ambient: {
					effect: selectedEffect,
					color: effectColor,
					intensity: effectIntensity,
					size: effectSize,
					speed: effectSpeed,
					globalOverride: applyGlobally,
				},
			};
			if (getAuthToken()) {
				await saveThemePreferences(prefs);
			} else {
				saveThemeToLocalStorage($themeStore.themeId, prefs);
			}
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
					alert('Could not find an effect class in the module. Make sure it exports a class implementing AmbientEffect as default.');
					return;
				}
				const instance = new EffectClass();
				if (!instance.id || !instance.name || !instance.render) {
					alert('Invalid effect: missing required properties (id, name, render).');
					return;
				}
				effectsRegistry.register(instance);
				selectedEffect = instance.id;
				effectColor = instance.defaultConfig?.color || effectColor;
				effectIntensity = instance.defaultConfig?.intensity ?? effectIntensity;
				effectSize = instance.defaultConfig?.size ?? effectSize;
				effectSpeed = instance.defaultConfig?.speed ?? effectSpeed;
				applyEffect();
			} catch (err) {
				alert('Failed to import effect: ' + (err instanceof Error ? err.message : 'Unknown error'));
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
</style>
