<script lang="ts">
	import { displayEnhancementSettingsStore, setFriendNotificationsEnabled, setFriendNotificationsTrackedOnly } from '$lib/displayEnhancements';
	import { clearAllTrackedPersonStatusAlerts, trackedStatusAlertPersonCountStore } from '$lib/peopleTracker';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import { confirmAction } from '$lib/confirm';
	import AddonRow from './AddonRow.svelte';
	import Switch from '../../ui/Switch.svelte';

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

	async function clearFriendNotificationTrackedUsers(): Promise<void> {
		const confirmed = await confirmAction({
			title: 'Clear your status alerts list?',
			body: 'You stop getting alerts when these people come online or go away.',
			confirm: 'Clear list',
			danger: true
		});
		if (confirmed) clearAllTrackedPersonStatusAlerts();
	}
</script>

{#if localAddonControlMatches('friend_notifications')}
	<AddonRow
		id="friend_notifications"
		label="Status alerts"
		description="An alert when people you choose come online or go away."
		enabled={friendNotificationsEnabled}
		badge={SECTION}
		onToggle={toggleFriendNotificationsAddon}
	>
		{#snippet preferences()}
<div class="addon-option">
				<span class="addon-option__label" id="addon-opt-status-list">Only people on my list</span>
				<Switch labelledby="addon-opt-status-list" checked={friendNotificationsTrackedOnly} disabled={!friendNotificationsEnabled} onchange={toggleFriendNotificationsTrackedOnlyAddon} />
			</div>
			<div class="addon-note">
				{$trackedStatusAlertPersonCountStore === 1 ? '1 person' : `${$trackedStatusAlertPersonCountStore} people`} on your list. Right-click someone in People to add or remove them.
			</div>
			<div class="addon-actions">
				<button
					class="w-btn w-btn--sm"
					on:click={clearFriendNotificationTrackedUsers}
					disabled={$trackedStatusAlertPersonCountStore === 0}
				>
					Clear status alerts list
				</button>
			</div>
		{/snippet}
	</AddonRow>
{/if}
