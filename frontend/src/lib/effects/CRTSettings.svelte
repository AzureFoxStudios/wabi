<script lang="ts">
	import { _ } from '$lib/i18n';
	import { onMount } from 'svelte';
	import { themeStore } from '$lib/theme/themeStore';
	import { getAuthToken } from '$lib/authSession';
	import { saveThemePreferences } from '$lib/theme/themeApi';
	import { showToast } from '$lib/toast';
	import type { ThemeAmbientOverride } from '../../types/theme';

	const LOCAL_KEY = 'wabi-crt-distortion';

	let distortion = 0;
	let saving = false;

	function clamp(value: number): number {
		return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
	}

	function stateDistortion(): number | null {
		const value = $themeStore.themeAmbient?.state?.crtDistortion;
		return typeof value === 'number' && Number.isFinite(value) ? clamp(value) : null;
	}

	function currentAmbientSnapshot(): ThemeAmbientOverride {
		if ($themeStore.themeAmbient) return $themeStore.themeAmbient;
		const style = getComputedStyle(document.documentElement);
		const numberVar = (name: string, fallback: number) => {
			const value = Number.parseFloat(style.getPropertyValue(name));
			return Number.isFinite(value) ? value : fallback;
		};
		return {
			effect: style.getPropertyValue('--bg-effect-effect').trim() || 'none',
			color: style.getPropertyValue('--bg-effect-color').trim() || undefined,
			color2: style.getPropertyValue('--bg-effect-color2').trim() || undefined,
			color3: style.getPropertyValue('--bg-effect-color3').trim() || undefined,
			intensity: numberVar('--bg-effect-intensity', 0),
			size: numberVar('--bg-effect-size', 1),
			speed: numberVar('--bg-effect-speed', 1),
			globalOverride: false,
			state: {},
		};
	}

	function applyLive(): ThemeAmbientOverride {
		distortion = clamp(distortion);
		const ambient = currentAmbientSnapshot();
		const next: ThemeAmbientOverride = {
			...ambient,
			state: {
				...(ambient.state ?? {}),
				crtDistortion: distortion,
			},
		};
		themeStore.setThemeAmbient(next);
		if (!getAuthToken()) {
			try {
				localStorage.setItem(LOCAL_KEY, String(distortion));
			} catch {
				// Guest-local persistence is best-effort.
			}
		}
		return next;
	}

	function distortionLabel(value: number): string {
		if (value <= 0.002) return 'crt.off';
		if (value < 0.18) return 'crt.light';
		if (value < 0.42) return 'crt.arcade';
		if (value < 0.68) return 'crt.warped';
		if (value < 0.86) return 'crt.bad_sync';
		return 'crt.dying';
	}

	async function save(): Promise<void> {
		saving = true;
		try {
			const ambient = applyLive();
			if (getAuthToken()) {
				// The server stores CRT state beside the ambient preference, but the
				// renderer treats it as a global post-process independent of ambient.
				// save_theme replaces the stored theme object with submitted keys, so
				// send the complete theme snapshot rather than only screen state.
				await saveThemePreferences({
					theme_id: $themeStore.themeId,
					custom_theme: $themeStore.customTheme,
					uniform_font_enabled: $themeStore.uniformFontEnabled ? 1 : 0,
					uniform_font_family: $themeStore.uniformFontFamily,
					uniform_font_size: $themeStore.uniformFontSize,
					uniform_font_weight: $themeStore.uniformFontWeight,
					uniform_font_style: $themeStore.uniformFontStyle,
					theme_ambient: ambient,
				});
			}
			showToast($_('crt.toast_saved'), 'info');
		} catch (error) {
			console.error('[CRTSettings] Save failed:', error);
			showToast($_('crt.toast_failed'), 'error');
		} finally {
			saving = false;
		}
	}

	onMount(() => {
		const saved = stateDistortion();
		if (saved !== null) {
			distortion = saved;
			return;
		}
		if (!getAuthToken()) {
			try {
				distortion = clamp(Number(localStorage.getItem(LOCAL_KEY)));
			} catch {
				distortion = 0;
			}
		}
	});
</script>

<div class="settings-subsection crt-settings">
	<h4 class="subsection-label">{$_('crt.heading')}</h4>

	<div class="setting-item setting-item-stack">
		<div class="setting-info">
			<span class="setting-label">{$_('crt.distortion')}</span>
			<span class="setting-description">
				{$_('crt.desc', { values: { percent: Math.round(distortion * 100), label: $_(distortionLabel(distortion)) } })}
			</span>
		</div>
		<input
			type="range"
			min="0"
			max="1"
			step="0.01"
			bind:value={distortion}
			on:input={applyLive}
			class="volume-slider"
			aria-label={$_('crt.aria')}
		/>
		<div class="crt-scale" aria-hidden="true">
			<span>{$_('crt.clean')}</span>
			<span>{$_('crt.arcade_scale')}</span>
			<span>{$_('crt.warped_scale')}</span>
			<span>{$_('crt.dying')}</span>
		</div>
	</div>

	<div class="crt-note">
		{$_('crt.note')}
	</div>

	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">{$_('crt.save_effect')}</span>
			<span class="setting-description">{$_('crt.independent')}</span>
		</div>
		<button type="button" class="action-btn" on:click={save} disabled={saving}>
			{saving ? $_('donation_config.saving') : $_('crt.save')}
		</button>
	</div>
</div>

<style>
	.crt-settings {
		margin-top: 1rem;
	}
	.crt-scale {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		font-size: 0.68rem;
		color: var(--text-tertiary, #777);
		padding-top: 0.25rem;
	}
	.crt-note {
		margin: -0.2rem 0 0.85rem;
		padding: 0.65rem 0.75rem;
		border: 1px solid color-mix(in srgb, var(--border-subtle, #3a3a4a) 78%, transparent);
		border-radius: var(--radius-md, 8px);
		background: color-mix(in srgb, var(--surface-raised, #24243e) 55%, transparent);
		color: var(--text-secondary, #a0a0a0);
		font-size: 0.76rem;
		line-height: 1.45;
	}
</style>
