<script lang="ts">
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
		label="Name styles"
		description="Show styled names in messages, People and profiles on this device. Create and share your own design in Profile settings; Appearance also controls plates, artwork and motion."
		enabled={$nameStylesVisible}
		badge={SECTION}
		onToggle={() => setNameStylesVisible(!$nameStylesVisible)}
	/>
{/if}

{#if localAddonControlMatches('timed_theme_mode')}
	<AddonRow
		id="timed_theme_mode"
		label="Light and dark by time of day"
		description="Automatically switch between day and night themes using your local device time."
		enabled={timedThemeModeEnabled}
		badge={SECTION}
		onToggle={toggleTimedThemeModeAddon}
	>
		{#snippet preferences()}
			{#if timedThemeModeEnabled}
				<div class="addon-grid">
					<label class="addon-field">
						<span class="w-label">Day starts (hour)</span>
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
						<span class="w-label">Night starts (hour)</span>
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
						<span class="w-label">Day theme</span>
						<Select ariaLabel="Day theme" options={Object.values(THEMES).map((theme) => ({ value: String(theme.id), label: String(theme.name) }))} bind:value={timedThemeLightThemeId} onchange={(value) => updateTimedThemeLightTheme(value)} />
					</div>
					<div class="addon-field">
						<span class="w-label">Night theme</span>
						<Select ariaLabel="Night theme" options={Object.values(THEMES).map((theme) => ({ value: String(theme.id), label: String(theme.name) }))} bind:value={timedThemeDarkThemeId} onchange={(value) => updateTimedThemeDarkTheme(value)} />
					</div>
				</div>
				<div class="addon-note">The theme changes at these hours while the app is open.</div>
			{/if}
		{/snippet}
	</AddonRow>
{/if}
