<script lang="ts">
	import { _ } from '$lib/i18n';
	import { onMount } from 'svelte';
	import { effectsRegistry } from './registry';
	import CRTSettings from './CRTSettings.svelte';
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
			// Preserve screen-level state (CRT, future post-processes) while
			// replacing the background-effect portion of the preference.
			const ambient = {
				effect: selectedEffect,
				color: effectColor,
				color2: effectColor2,
				color3: effectColor3,
				intensity: effectIntensity,
				size: effectSize,
				speed: effectSpeed,
				globalOverride: applyGlobally,
				state: {
					...($themeStore.themeAmbient?.state ?? {}),
					...(isJoker ? { joker: jokerState } : {}),
				},
			};
			themeStore.setThemeAmbient(ambient);
			const prefs: Record<string, unknown> = {
				theme_id: $themeStore.themeId,
				custom_theme: $themeStore.customTheme,
				uniform_font_enabled: $themeStore.uniformFontEnabled ? 1 : 0,
				uniform_font_family: $themeStore.uniformFontFamily,
				uniform_font_size: $themeStore.uniformFontSize,
				uniform_font_weight: $themeStore.uniformFontWeight,
				uniform_font_style: $themeStore.uniformFontStyle,
				theme_ambient: ambient,
			};
			if (getAuthToken()) {
				await saveThemePreferences(prefs);
			} else {
				saveThemeToLocalStorage($themeStore.themeId, prefs);
			}
			showToast($_('et.saved'), 'info');
		} catch (err) {
			console.error('[EffectsTab] Save failed:', err);
			showToast($_('et.save_failed'), 'error');
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
					showToast($_('et.no_class'), 'error');
					return;
				}
				const instance = new EffectClass();
				if (!instance.id || !instance.name || !instance.render) {
					showToast($_('et.invalid'), 'error');
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
				showToast($_('et.import_failed', { values: { reason: err instanceof Error ? err.message : $_('et.unknown_error') } }), 'error');
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
	<h4 class="subsection-label">{$_('et.title')}</h4>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">{$_('et.effect')}</span>
			<span class="setting-description">{$_('et.effect_desc')}</span>
		</div>
		<select class="theme-select" value={selectedEffect} on:change={handleEffectChange}>
			<option value="none">{$_('et.none')}</option>
			{#each effects as effect}
				<option value={effect.id}>{effect.name}</option>
			{/each}
		</select>
	</div>

	{#if isJoker}
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">{$_('et.balatro_state')}</span>
				<span class="setting-description">{$_('et.balatro_desc')}</span>
			</div>
			<div class="segmented-control">
				<button type="button" class="segment" class:active={jokerState === 'title'} on:click={() => applyJokerState('title')}>{$_('reader_doc.title_label')}</button>
				<button type="button" class="segment" class:active={jokerState === 'blind'} on:click={() => applyJokerState('blind')}>{$_('et.state_blind')}</button>
				<button type="button" class="segment" class:active={jokerState === 'shop'} on:click={() => applyJokerState('shop')}>{$_('et.state_shop')}</button>
			</div>
		</div>
	{/if}

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">{$_('project_modal.color')}</span>
			<span class="setting-description">{$_('et.color_desc')}</span>
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
			<span class="setting-label">{$_('et.color2')}</span>
			<span class="setting-description">{$_('et.color2_desc')}</span>
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
			<span class="setting-label">{$_('et.color3')}</span>
			<span class="setting-description">{$_('et.color3_desc')}</span>
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
			<span class="setting-label">{$_('et.intensity')}</span>
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
			<span class="setting-label">{$_('messages.viewer.details_size')}</span>
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
			<span class="setting-label">{$_('mv.speed')}</span>
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
			<span class="setting-label">{$_('et.apply_all')}</span>
			<span class="setting-description">{$_('et.apply_all_desc')}</span>
		</div>
		<button class="toggle-btn" class:active={applyGlobally} on:click={() => applyGlobally = !applyGlobally}>
			{applyGlobally ? $_('payment_access_panel.on') : $_('payment_access_panel.off')}
		</button>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">{$_('et.save_prefs')}</span>
			<span class="setting-description">{$_('et.save_prefs_desc')}</span>
		</div>
		<button class="action-btn" on:click={save} disabled={saving}>
			{saving ? $_('donation_config.saving') : $_('common.save')}
		</button>
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">{$_('et.import_custom')}</span>
			<span class="setting-description">{$_('et.import_desc')}</span>
		</div>
		<button type="button" class="action-btn" on:click={handleImport}>
			{$_('et.import')}
		</button>
	</div>
</div>

<CRTSettings />

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