<script lang="ts">
	import { displayEnhancementSettingsStore, setFriendNotificationsEnabled, setFriendNotificationsTrackedOnly } from '$lib/displayEnhancements';
	import { clearAllTrackedPersonStatusAlerts, trackedStatusAlertPersonCountStore } from '$lib/peopleTracker';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import type { AddonSectionId } from '../addonSettingsRegistry';

	export let localAddonControlMatches: (controlId: string) => boolean;
	export let isAddonSectionOpen: (section: AddonSectionId) => boolean;
	export let toggleAddonSection: (section: AddonSectionId) => void;
	export let addonSectionMatchCount: (section: AddonSectionId) => number;

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
<section class="addon-accordion-section">
	<button
		type="button"
		class="addon-accordion-trigger"
		aria-expanded={isAddonSectionOpen('notifications')}
		aria-controls="addon-section-notifications"
		on:click={() => toggleAddonSection('notifications')}
	>
		<span class="addon-accordion-trigger-main">
			<span class="addon-section-chevron" aria-hidden="true">
				<svg viewBox="0 0 24 24">
					<path d="M9 6l6 6-6 6"></path>
				</svg>
			</span>
			<span class="addon-accordion-label">{ADDON_SECTION_LABELS.notifications}</span>
		</span>
		<span class="addon-accordion-count">{addonSectionMatchCount('notifications')}</span>
	</button>
	{#if isAddonSectionOpen('notifications')}
	<div class="addon-accordion-body" id="addon-section-notifications">
		{#if localAddonControlMatches('friend_notifications')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">FriendNotifications</span>
					<span class="setting-description">Desktop notifications when people change presence status.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={friendNotificationsEnabled} on:click={toggleFriendNotificationsAddon}>
						{friendNotificationsEnabled ? 'ON' : 'OFF'}
					</button>
					<button
						class="toggle-btn"
						class:active={friendNotificationsTrackedOnly}
						on:click={toggleFriendNotificationsTrackedOnlyAddon}
						disabled={!friendNotificationsEnabled}
					>
						Status alerts list only: {friendNotificationsTrackedOnly ? 'ON' : 'OFF'}
					</button>
				</div>
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
			</div>
		{/if}
	</div>
	{/if}
</section>
{/if}
