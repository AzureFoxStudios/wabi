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
		hasPendingRemoteBusinessUpdate
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
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Local Directions Assist</span>
			<span class="setting-description">Opt in to use your current location locally when creating directions cards. This is never uploaded to the server.</span>
		</div>
		<button class="toggle-btn" class:active={directionsGpsEnabled} on:click={toggleDirectionsGpsAssist}>
			{directionsGpsEnabled ? 'ON' : 'OFF'}
		</button>
	</div>
	{#if directionsGpsStatus}
		<div class="runtime-note">{directionsGpsStatus}</div>
	{/if}
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Business Data Sync Mode</span>
			<span class="setting-description">Manual mode reduces background sync chatter. Auto mode continuously syncs business data.</span>
		</div>
		<button class="toggle-btn" class:active={businessSyncMode === 'auto'} on:click={toggleBusinessSyncMode}>
			{businessSyncMode === 'auto' ? 'AUTO' : 'MANUAL'}
		</button>
	</div>
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Sync Business Data Now</span>
			<span class="setting-description">Pull latest server state, then push your local business updates.</span>
		</div>
		<button class="action-btn" on:click={runBusinessSyncNow} disabled={businessSyncInFlight}>
			{businessSyncInFlight ? 'Syncing...' : 'Sync Now'}
		</button>
	</div>
	{#if businessSyncStatus}
		<div class="runtime-note">{businessSyncStatus}</div>
	{/if}
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Clear All Server Messages</span>
			<span class="setting-description">Delete all messages from the server for all users (cannot be undone)</span>
		</div>
		<button class="action-btn danger" on:click={() => dispatch('clearServer')}>
			{$_('settings.actions.clear_server')}
		</button>
	</div>
</div>
