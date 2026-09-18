<script lang="ts">
	import { displayEnhancementSettingsStore, setFriendNotificationsEnabled, setFriendNotificationsTrackedOnly } from '$lib/displayEnhancements';
	import { clearAllTrackedPersonStatusAlerts, trackedStatusAlertPersonCountStore } from '$lib/peopleTracker';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import AddonRow from './AddonRow.svelte';

	export let localAddonControlMatches: (controlId: string) => boolean;

	const SECTION = ADDON_SECTION_LABELS.notifications;

	let friendNotificationsEnabled = false;
	let friendNotificationsTrackedOnly = true;

	$: friendNotificationsEnabled = $displayEnhancementSettingsStore.friendNotificationsEnabled;
	$: friendNotificationsTrackedOnly = $displayEnhancementSettingsStore.friendNotificationsTrackedOnly;

	function toggleFriendNotificationsAddon(): void {
		setFriendNotificationsEnabled(!friendNotificationsEnabled);
	}

	function toggleFriendNotificationsTrackedOnlyAddon(): void {
		setFriendNotificationsTrackedOnly(!friendNotificationsTrackedOnly);
	}

	function clearFriendNotificationTrackedUsers(): void {
		if (!window.confirm('Clear all tracked people for status alerts on this device?')) return;
		clearAllTrackedPersonStatusAlerts();
	}
</script>

{#if localAddonControlMatches('friend_notifications')}
	<AddonRow
		id="friend_notifications"
		label="FriendNotifications"
		description="Desktop notifications when people change presence status."
		enabled={friendNotificationsEnabled}
		badge={SECTION}
		onToggle={toggleFriendNotificationsAddon}
	>
		{#snippet preferences()}
			<label class="addon-pref-check">
				<input
					type="checkbox"
					checked={friendNotificationsTrackedOnly}
					on:change={toggleFriendNotificationsTrackedOnlyAddon}
					disabled={!friendNotificationsEnabled}
				/>
				<span>Status alerts list only</span>
			</label>
			<div class="runtime-note">
				Tracked people for status alerts: {$trackedStatusAlertPersonCountStore}. Use the People tab context menu to enable or disable alerts per person on each server.
			</div>
			<div class="settings-row-actions">
				<button
					class="action-btn secondary"
					on:click={clearFriendNotificationTrackedUsers}
					disabled={$trackedStatusAlertPersonCountStore === 0}
				>
					Clear Status Alerts List
				</button>
			</div>
		{/snippet}
	</AddonRow>
{/if}
