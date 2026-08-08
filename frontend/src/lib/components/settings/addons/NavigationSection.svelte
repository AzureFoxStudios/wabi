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
	import type { AddonSectionId } from '../addonSettingsRegistry';

	export let localAddonControlMatches: (controlId: string) => boolean;
	export let isAddonSectionOpen: (section: AddonSectionId) => boolean;
	export let toggleAddonSection: (section: AddonSectionId) => void;
	export let addonSectionMatchCount: (section: AddonSectionId) => number;

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

{#if localAddonControlMatches('hide_muted_categories') || localAddonControlMatches('read_all_notifications_button') || localAddonControlMatches('server_counter') || localAddonControlMatches('better_nsfw_tag') || localAddonControlMatches('better_friend_list')}
<section class="addon-accordion-section">
	<button
		type="button"
		class="addon-accordion-trigger"
		aria-expanded={isAddonSectionOpen('navigation')}
		aria-controls="addon-section-navigation"
		on:click={() => toggleAddonSection('navigation')}
	>
		<span class="addon-accordion-trigger-main">
			<span class="addon-section-chevron" aria-hidden="true">
				<svg viewBox="0 0 24 24">
					<path d="M9 6l6 6-6 6"></path>
				</svg>
			</span>
			<span class="addon-accordion-label">{ADDON_SECTION_LABELS.navigation}</span>
		</span>
		<span class="addon-accordion-count">{addonSectionMatchCount('navigation')}</span>
	</button>
	{#if isAddonSectionOpen('navigation')}
	<div class="addon-accordion-body" id="addon-section-navigation">
		{#if localAddonControlMatches('hide_muted_categories')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">HideMutedCategories</span>
					<span class="setting-description">{brandName} translation: hide locally muted channels from the sidebar channel list.</span>
				</div>
				<div class="runtime-note">Locally muted channels: {mutedChannelCount}</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={hideMutedCategoriesEnabled} on:click={toggleHideMutedCategoriesAddon}>
						{hideMutedCategoriesEnabled ? 'ON' : 'OFF'}
					</button>
					<button class="action-btn secondary" on:click={clearMutedChannelsAddon} disabled={mutedChannelCount === 0}>
						Clear Muted
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('read_all_notifications_button')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">ReadAllNotificationsButton</span>
					<span class="setting-description">Show a clear-unread action in the channel sidebar.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={readAllNotificationsButtonEnabled} on:click={toggleReadAllNotificationsButtonAddon}>
						{readAllNotificationsButtonEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('server_counter')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">Server channel count</span>
					<span class="setting-description">Optional chip above the channel list showing total channel count. Off by default — the section header already has a count.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={serverCounterEnabled} on:click={toggleServerCounterAddon}>
						{serverCounterEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('better_nsfw_tag')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">BetterNsfwTag ({brandName} translation)</span>
					<span class="setting-description">Highlight NSFW-like channels in the sidebar with a high-visibility warning tag.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={betterNsfwTagEnabled} on:click={toggleBetterNsfwTagAddon}>
						{betterNsfwTagEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('better_friend_list')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">BetterFriendList</span>
					<span class="setting-description">Enable search/filter/sort and summary counters in the right-panel user list.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={betterFriendListEnabled} on:click={toggleBetterFriendListAddon}>
						{betterFriendListEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}
	</div>
	{/if}
</section>
{/if}
