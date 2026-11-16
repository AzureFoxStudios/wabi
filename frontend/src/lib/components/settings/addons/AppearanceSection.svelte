<script lang="ts">
	import { _ } from '$lib/i18n';
	import { nameStylesVisible, setNameStylesVisible } from '$lib/addons/nameStyles';
	import { THEMES } from '$lib/theme/themes';
	import {
		setTimedThemeModeDarkThemeId, setTimedThemeModeDayStartHour, setTimedThemeModeEnabled,
		setTimedThemeModeLightThemeId, setTimedThemeModeNightStartHour, timedThemeModeSettingsStore
	} from '$lib/timedThemeMode';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import AddonRow from './AddonRow.svelte';
	import Select from '../../ui/Select.svelte';

	export let localAddonControlMatches: (controlId: string) => boolean;

	const SECTION = ADDON_SECTION_LABELS.appearance;

	let timedThemeModeEnabled = false;
	let timedThemeDayStartHour = 7;
	let timedThemeNightStartHour = 19;
	let timedThemeLightThemeId = 'light';
	let timedThemeDarkThemeId = 'dark';

	$: timedThemeModeEnabled = $timedThemeModeSettingsStore.enabled;
	$: timedThemeDayStartHour = $timedThemeModeSettingsStore.dayStartHour;
	$: timedThemeNightStartHour = $timedThemeModeSettingsStore.nightStartHour;
	$: timedThemeLightThemeId = $timedThemeModeSettingsStore.lightThemeId;
	$: timedThemeDarkThemeId = $timedThemeModeSettingsStore.darkThemeId;

	function toggleTimedThemeModeAddon(): void {
		setTimedThemeModeEnabled(!timedThemeModeEnabled);
	}

	function updateTimedThemeDayStartHour(rawValue: string): void {
		const parsed = Number.parseInt(rawValue, 10);
		if (!Number.isFinite(parsed)) return;
		setTimedThemeModeDayStartHour(parsed);
	}

	function updateTimedThemeNightStartHour(rawValue: string): void {
		const parsed = Number.parseInt(rawValue, 10);
		if (!Number.isFinite(parsed)) return;
		setTimedThemeModeNightStartHour(parsed);
	}

	function updateTimedThemeLightTheme(themeId: string): void {
		setTimedThemeModeLightThemeId(themeId);
	}

	function updateTimedThemeDarkTheme(themeId: string): void {
		setTimedThemeModeDarkThemeId(themeId);
	}
</script>

{#if localAddonControlMatches('name_styles')}
	<AddonRow
		id="name_styles"
		label={$_('as.name_styles')}
		description={$_('as.name_styles_desc')}
		enabled={$nameStylesVisible}
		badge={SECTION}
		onToggle={() => setNameStylesVisible(!$nameStylesVisible)}
	/>
{/if}

{#if localAddonControlMatches('timed_theme_mode')}
	<AddonRow
		id="timed_theme_mode"
		label={$_('as.timed_label')}
		description={$_('as.timed_desc')}
		enabled={timedThemeModeEnabled}
		badge={SECTION}
		onToggle={toggleTimedThemeModeAddon}
	>
		{#snippet preferences()}
			{#if timedThemeModeEnabled}
				<div class="addon-grid">
					<label class="addon-field">
						<span class="w-label">{$_('as.day_starts')}</span>
						<input
							class="w-field"
							type="number"
							min="0"
							max="23"
							step="1"
							value={timedThemeDayStartHour}
							on:change={(event) => updateTimedThemeDayStartHour(event.currentTarget.value)}
						/>
					</label>
					<label class="addon-field">
						<span class="w-label">{$_('as.night_starts')}</span>
						<input
							class="w-field"
							type="number"
							min="0"
							max="23"
							step="1"
							value={timedThemeNightStartHour}
							on:change={(event) => updateTimedThemeNightStartHour(event.currentTarget.value)}
						/>
					</label>
					<div class="addon-field">
						<span class="w-label">{$_('as.day_theme')}</span>
						<Select ariaLabel={$_('as.day_theme')} options={Object.values(THEMES).map((theme) => ({ value: String(theme.id), label: String(theme.name) }))} bind:value={timedThemeLightThemeId} onchange={(value) => updateTimedThemeLightTheme(value)} />
					</div>
					<div class="addon-field">
						<span class="w-label">{$_('as.night_theme')}</span>
						<Select ariaLabel={$_('as.night_theme')} options={Object.values(THEMES).map((theme) => ({ value: String(theme.id), label: String(theme.name) }))} bind:value={timedThemeDarkThemeId} onchange={(value) => updateTimedThemeDarkTheme(value)} />
					</div>
				</div>
				<div class="addon-note">{$_('as.theme_note')}</div>
			{/if}
		{/snippet}
	</AddonRow>
{/if}
