<script lang="ts">
	/**
	 * This device's sharing choices, shown under Settings › Privacy & security (§8.9, §9.4): the
	 * old Server page put an admin-sounding heading over personal options, so the page now says whose they
	 * are. Directions location, private access (desktop) and volunteer boosting stay on this device.
	 */
	import { isTauriRuntime } from '$lib/tauri-platform';
	import {
		directionsAssistSettings,
		requestDirectionsGpsPermission,
		setDirectionsGpsEnabled
	} from '$lib/directionsAssist';
	import VolunteerBoostCard from './VolunteerBoostCard.svelte';
	import TailcatConnectionCard from './TailcatConnectionCard.svelte';

	let directionsGpsEnabled = $state($directionsAssistSettings.gpsEnabled);
	let directionsGpsStatus = $state('');
	let directionsGpsBusy = $state(false);

	async function toggleDirectionsGpsAssist(): Promise<void> {
		if (directionsGpsBusy) return;
		const next = !directionsGpsEnabled;
		if (next) {
			directionsGpsBusy = true;
			try {
				const granted = await requestDirectionsGpsPermission();
				if (!granted) {
					directionsGpsStatus = 'Location access was not allowed, so directions cards show only the destination.';
					directionsGpsEnabled = false;
					return;
				}
				directionsGpsStatus = 'Your location is used on this device only when you make a directions card.';
				directionsGpsEnabled = true;
				setDirectionsGpsEnabled(true);
			} finally {
				directionsGpsBusy = false;
			}
			return;
		}
		directionsGpsEnabled = false;
		setDirectionsGpsEnabled(false);
		directionsGpsStatus = 'Directions cards no longer use your location.';
	}
</script>

<section class="settings-block" aria-labelledby="device-sharing-title">
	<h3 class="settings-block__title" id="device-sharing-title">This device</h3>
	<p class="settings-block__hint">Saved on this device · not shared. These choices don't change your account on other devices.</p>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="device-gps-label">Directions GPS</p>
				<p class="w-srow__hint" id="device-gps-hint">Use this device's location for directions cards. It is never uploaded.</p>
			</div>
			<div class="w-srow__control">
				<button
					type="button"
					class="w-switch"
					role="switch"
					aria-labelledby="device-gps-label"
					aria-describedby="device-gps-hint"
					aria-checked={directionsGpsEnabled}
					aria-busy={directionsGpsBusy}
					disabled={directionsGpsBusy}
					onclick={toggleDirectionsGpsAssist}
				></button>
			</div>
		</div>
	</div>
	{#if directionsGpsStatus}
		<p class="device-sharing__note" role="status">{directionsGpsStatus}</p>
	{/if}
</section>

{#if isTauriRuntime()}<TailcatConnectionCard />{/if}
<VolunteerBoostCard />

<style>
	.device-sharing__note {
		margin: 10px 0 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
</style>
