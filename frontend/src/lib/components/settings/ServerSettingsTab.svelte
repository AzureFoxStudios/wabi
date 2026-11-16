<script lang="ts">
	import { _ } from '$lib/i18n';
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
					directionsGpsStatus = $_('device_sharing.gps_denied');
					directionsGpsEnabled = false;
					return;
				}
				directionsGpsStatus = $_('device_sharing.gps_on');
				directionsGpsEnabled = true;
				setDirectionsGpsEnabled(true);
			} finally {
				directionsGpsBusy = false;
			}
			return;
		}
		directionsGpsEnabled = false;
		setDirectionsGpsEnabled(false);
		directionsGpsStatus = $_('device_sharing.gps_off');
	}
</script>

<section class="settings-block" aria-labelledby="device-sharing-title">
	<h3 class="settings-block__title" id="device-sharing-title">{$_('settings.groups.this_device')}</h3>
	<p class="settings-block__hint">{$_('device_sharing.hint')}</p>
	<div class="w-srows">
		<div class="w-srow">
			<div class="w-srow__text">
				<p class="w-srow__label" id="device-gps-label">{$_('device_sharing.directions_gps')}</p>
				<p class="w-srow__hint" id="device-gps-hint">{$_('device_sharing.gps_hint')}</p>
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
