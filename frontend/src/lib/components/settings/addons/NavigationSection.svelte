<script lang="ts">
	import {
		displayEnhancementSettingsStore,
		setBetterFriendListEnabled, setBetterNsfwTagEnabled,
		setHideMutedCategoriesEnabled, setReadAllNotificationsButtonEnabled,
		setServerCounterEnabled
	} from '$lib/displayEnhancements';
	import { brandName } from '$lib/branding';
	import { activeServerSettings, clearServerMutedChannelIds } from '$lib/serverSettings';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import AddonRow from './AddonRow.svelte';

	export let localAddonControlMatches: (controlId: string) => boolean;

	const SECTION = ADDON_SECTION_LABELS.navigation;

	let hideMutedCategoriesEnabled = false;
	let readAllNotificationsButtonEnabled = true;
	let serverCounterEnabled = true;
	let betterNsfwTagEnabled = true;
	let betterFriendListEnabled = true;
	let mutedChannelCount = 0;

	$: hideMutedCategoriesEnabled = $displayEnhancementSettingsStore.hideMutedCategoriesEnabled;
	$: readAllNotificationsButtonEnabled = $displayEnhancementSettingsStore.readAllNotificationsButtonEnabled;
	$: serverCounterEnabled = $displayEnhancementSettingsStore.serverCounterEnabled;
	$: betterNsfwTagEnabled = $displayEnhancementSettingsStore.betterNsfwTagEnabled;
	$: betterFriendListEnabled = $displayEnhancementSettingsStore.betterFriendListEnabled;
	$: mutedChannelCount = $activeServerSettings.mutedChannelIds.length;

	function toggleHideMutedCategoriesAddon(): void {
		setHideMutedCategoriesEnabled(!hideMutedCategoriesEnabled);
	}

	function clearMutedChannelsAddon(): void {
		if (!window.confirm('Clear all locally muted channels on this server?')) return;
		clearServerMutedChannelIds();
	}

	function toggleReadAllNotificationsButtonAddon(): void {
		setReadAllNotificationsButtonEnabled(!readAllNotificationsButtonEnabled);
	}

	function toggleServerCounterAddon(): void {
		setServerCounterEnabled(!serverCounterEnabled);
	}

	function toggleBetterNsfwTagAddon(): void {
		setBetterNsfwTagEnabled(!betterNsfwTagEnabled);
	}

	function toggleBetterFriendListAddon(): void {
		setBetterFriendListEnabled(!betterFriendListEnabled);
	}
</script>

{#if localAddonControlMatches('hide_muted_categories')}
	<AddonRow
		id="hide_muted_categories"
		label="HideMutedCategories"
		description={`${brandName} translation: hide locally muted channels from the sidebar channel list.`}
		enabled={hideMutedCategoriesEnabled}
		badge={SECTION}
		onToggle={toggleHideMutedCategoriesAddon}
	>
		{#snippet preferences()}
			<div class="runtime-note">Locally muted channels: {mutedChannelCount}</div>
			<div class="settings-row-actions">
				<button
					class="action-btn secondary"
					on:click={clearMutedChannelsAddon}
					disabled={mutedChannelCount === 0}
				>
					Clear Muted
				</button>
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('read_all_notifications_button')}
	<AddonRow
		id="read_all_notifications_button"
		label="ReadAllNotificationsButton"
		description="Show a clear-unread action in the channel sidebar."
		enabled={readAllNotificationsButtonEnabled}
		badge={SECTION}
		onToggle={toggleReadAllNotificationsButtonAddon}
	/>
{/if}

{#if localAddonControlMatches('server_counter')}
	<AddonRow
		id="server_counter"
		label="Server channel count"
		description="Optional chip above the channel list showing total channel count. Off by default — the section header already has a count."
		enabled={serverCounterEnabled}
		badge={SECTION}
		onToggle={toggleServerCounterAddon}
	/>
{/if}

{#if localAddonControlMatches('better_nsfw_tag')}
	<AddonRow
		id="better_nsfw_tag"
		label={`BetterNsfwTag (${brandName} translation)`}
		description="Highlight NSFW-like channels in the sidebar with a high-visibility warning tag."
		enabled={betterNsfwTagEnabled}
		badge={SECTION}
		onToggle={toggleBetterNsfwTagAddon}
	/>
{/if}

{#if localAddonControlMatches('better_friend_list')}
	<AddonRow
		id="better_friend_list"
		label="BetterFriendList"
		description="Enable search/filter/sort and summary counters in the right-panel user list."
		enabled={betterFriendListEnabled}
		badge={SECTION}
		onToggle={toggleBetterFriendListAddon}
	/>
{/if}
