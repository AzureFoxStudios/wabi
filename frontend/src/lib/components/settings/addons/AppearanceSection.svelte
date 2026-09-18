<script lang="ts">
	import { THEMES } from '$lib/theme/themes';
	import {
		setTimedThemeModeDarkThemeId, setTimedThemeModeDayStartHour, setTimedThemeModeEnabled,
		setTimedThemeModeLightThemeId, setTimedThemeModeNightStartHour, timedThemeModeSettingsStore
	} from '$lib/timedThemeMode';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import AddonRow from './AddonRow.svelte';

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

{#if localAddonControlMatches('timed_theme_mode')}
	<AddonRow
		id="timed_theme_mode"
		label="TimedLightDarkMode"
		description="Automatically switch between day and night themes using your local device time."
		enabled={timedThemeModeEnabled}
		badge={SECTION}
		onToggle={toggleTimedThemeModeAddon}
	>
		{#snippet preferences()}
			{#if timedThemeModeEnabled}
				<div class="timed-theme-grid">
					<label class="timed-theme-field">
						<span>Day starts (hour)</span>
						<input
							class="theme-select"
							type="number"
							min="0"
							max="23"
							step="1"
							value={timedThemeDayStartHour}
							on:change={(event) => updateTimedThemeDayStartHour(event.currentTarget.value)}
						/>
					</label>
					<label class="timed-theme-field">
						<span>Night starts (hour)</span>
						<input
							class="theme-select"
							type="number"
							min="0"
							max="23"
							step="1"
							value={timedThemeNightStartHour}
							on:change={(event) => updateTimedThemeNightStartHour(event.currentTarget.value)}
						/>
					</label>
					<label class="timed-theme-field">
						<span>Day theme</span>
						<select
							class="theme-select"
							bind:value={timedThemeLightThemeId}
							on:change={(event) => updateTimedThemeLightTheme(event.currentTarget.value)}
						>
							{#each Object.values(THEMES) as theme}
								<option value={theme.id}>{theme.name}</option>
							{/each}
						</select>
					</label>
					<label class="timed-theme-field">
						<span>Night theme</span>
						<select
							class="theme-select"
							bind:value={timedThemeDarkThemeId}
							on:change={(event) => updateTimedThemeDarkTheme(event.currentTarget.value)}
						>
							{#each Object.values(THEMES) as theme}
								<option value={theme.id}>{theme.name}</option>
							{/each}
						</select>
					</label>
				</div>
				<div class="runtime-note">The app checks and applies scheduled theme changes automatically in the background.</div>
			{/if}
		{/snippet}
	</AddonRow>
{/if}
