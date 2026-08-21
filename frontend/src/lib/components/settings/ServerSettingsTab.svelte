<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { _ } from '$lib/i18n';
	import {
		directionsAssistSettings,
		requestDirectionsGpsPermission,
		setDirectionsGpsEnabled
	} from '$lib/directionsAssist';
	import {
		getBusinessSyncMode,
		setBusinessSyncMode,
		sync as syncBusinessData,
		hasPendingRemoteBusinessUpdate,
		businessSyncAvailable
	} from '$lib/business/sync';

	const dispatch = createEventDispatcher<{
		clearServer: void;
	}>();

	let directionsGpsEnabled = $directionsAssistSettings.gpsEnabled;
	let directionsGpsStatus = '';
	let businessSyncMode: 'manual' | 'auto' = getBusinessSyncMode();
	let businessSyncInFlight = false;
	let businessSyncStatus = '';

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

	function toggleBusinessSyncMode() {
		businessSyncMode = businessSyncMode === 'manual' ? 'auto' : 'manual';
		setBusinessSyncMode(businessSyncMode);
		businessSyncStatus = businessSyncMode === 'manual'
			? 'Manual sync mode. Use "Sync Now" to pull/push.'
			: 'Auto sync mode. Background sync enabled.';
	}

	async function runBusinessSyncNow() {
		if (businessSyncInFlight) return;
		businessSyncInFlight = true;
		businessSyncStatus = 'Syncing now...';
		const ok = await syncBusinessData();
		businessSyncStatus = ok
			? hasPendingRemoteBusinessUpdate() ? 'Sync complete. Remote changes detected — reload to apply.' : 'Sync complete. No pending changes.'
			: 'Sync failed.';
		businessSyncInFlight = false;
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
			<button class="toggle-btn" class:active={directionsGpsEnabled} on:click={toggleDirectionsGpsAssist} aria-label="Directions GPS"></button>
		</div>
		{#if directionsGpsStatus}
			<div class="runtime-note">{directionsGpsStatus}</div>
		{/if}
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Business sync</span>
				<span class="setting-description">On = continuous auto sync. Off = manual only.</span>
			</div>
			<button class="toggle-btn" class:active={businessSyncMode === 'auto'} on:click={toggleBusinessSyncMode} aria-label="Business sync auto"></button>
		</div>
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Sync now</span>
				<span class="setting-description">Pull server state, then push local business updates.</span>
			</div>
			<button class="action-btn" on:click={runBusinessSyncNow} disabled={businessSyncInFlight}>
				{businessSyncInFlight ? 'Syncing…' : 'Sync'}
			</button>
		</div>
		{#if businessSyncStatus}
			<div class="runtime-note">{businessSyncStatus}</div>
		{/if}
		<div class="setting-item">
			<div class="setting-info">
				<span class="setting-label">Purge all server messages</span>
				<span class="setting-description">Deletes history for everyone. Cannot be undone.</span>
			</div>
			<button class="action-btn danger" on:click={() => dispatch('clearServer')}>
				{$_('settings.actions.clear_server')}
			</button>
		</div>
	</div>
</div>
