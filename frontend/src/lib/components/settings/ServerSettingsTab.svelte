<script lang="ts">
	import { _ } from '$lib/i18n';
	import {
		directionsAssistSettings,
		requestDirectionsGpsPermission,
		setDirectionsGpsEnabled
	} from '$lib/directionsAssist';
	import TailcatConnectionCard from './TailcatConnectionCard.svelte';

	let directionsGpsEnabled = $state($directionsAssistSettings.gpsEnabled);
	let directionsGpsStatus = $state('');

	async function toggleDirectionsGpsAssist(): Promise<void> {
		const next = !directionsGpsEnabled;
		if (next) {
			const granted = await requestDirectionsGpsPermission();
			if (!granted) {
				directionsGpsStatus = 'Location permission was denied or unavailable. Directions cards will stay target-only.';
				directionsGpsEnabled = false;
				return;
			}
			directionsGpsStatus = 'Location assist enabled. Your position is only used locally when you create directions.';
			directionsGpsEnabled = true;
			setDirectionsGpsEnabled(true);
			return;
		}
		directionsGpsEnabled = false;
		setDirectionsGpsEnabled(false);
		directionsGpsStatus = 'Location assist disabled.';
	}
</script>

<div class="settings-section">
	<h3>{$_('settings.sections.server_management')}</h3>
	<div class="settings-group-card">
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Directions GPS</span>
				<span class="setting-description">Use location only on this device for directions cards. Never uploaded.</span>
			</div>
			<button class="toggle-btn" class:active={directionsGpsEnabled} onclick={toggleDirectionsGpsAssist} role="switch" aria-checked={directionsGpsEnabled} aria-label="Directions GPS"></button>
		</div>
		{#if directionsGpsStatus}
			<div class="runtime-note">{directionsGpsStatus}</div>
		{/if}
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Business sync</span>
				<span class="setting-description">Planner stays on this device. Use Export / Import to move your work between devices. Server sync is unavailable.</span>
			</div>
		</div>
	</div>

	<TailcatConnectionCard />
</div>
