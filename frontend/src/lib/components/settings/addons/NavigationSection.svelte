<script lang="ts">
	import {
		displayEnhancementSettingsStore,
		setBetterFriendListEnabled, setBetterNsfwTagEnabled,
		setHideMutedCategoriesEnabled,
		setServerCounterEnabled
	} from '$lib/displayEnhancements';
	import { brandName } from '$lib/branding';
	import { activeServerSettings, clearServerMutedChannelIds } from '$lib/serverSettings';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import { confirmAction } from '$lib/confirm';
	import AddonRow from './AddonRow.svelte';

	export let localAddonControlMatches: (controlId: string) => boolean;

	const SECTION = ADDON_SECTION_LABELS.navigation;

	let hideMutedCategoriesEnabled = false;
	let serverCounterEnabled = true;
	let betterNsfwTagEnabled = true;
	let betterFriendListEnabled = true;
	let mutedChannelCount = 0;

	$: hideMutedCategoriesEnabled = $displayEnhancementSettingsStore.hideMutedCategoriesEnabled;
	$: serverCounterEnabled = $displayEnhancementSettingsStore.serverCounterEnabled;
	$: betterNsfwTagEnabled = $displayEnhancementSettingsStore.betterNsfwTagEnabled;
	$: betterFriendListEnabled = $displayEnhancementSettingsStore.betterFriendListEnabled;
	$: mutedChannelCount = $activeServerSettings.mutedChannelIds.length;

	function toggleHideMutedCategoriesAddon(): void {
		setHideMutedCategoriesEnabled(!hideMutedCategoriesEnabled);
	}

	async function clearMutedChannelsAddon(): Promise<void> {
		const confirmed = await confirmAction({
			title: 'Unmute every channel on this server?',
			body: 'Channels you muted on this device show and alert again.',
			confirm: 'Unmute all',
			danger: true
		});
		if (confirmed) clearServerMutedChannelIds();
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
		label="Hide muted channels"
		description="Leave channels you muted on this device out of the sidebar."
		enabled={hideMutedCategoriesEnabled}
		badge={SECTION}
		onToggle={toggleHideMutedCategoriesAddon}
	>
		{#snippet preferences()}
			<div class="addon-note">{mutedChannelCount === 0 ? 'No muted channels on this server.' : `${mutedChannelCount} muted ${mutedChannelCount === 1 ? 'channel' : 'channels'} on this server.`}</div>
			<div class="addon-actions">
				<button
					class="w-btn w-btn--sm"
					on:click={clearMutedChannelsAddon}
					disabled={mutedChannelCount === 0}
				>
					Unmute all
				</button>
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('server_counter')}
	<AddonRow
		id="server_counter"
		label="Server channel count"
		description="Shows how many channels there are above the channel list."
		enabled={serverCounterEnabled}
		badge={SECTION}
		onToggle={toggleServerCounterAddon}
	/>
{/if}

{#if localAddonControlMatches('better_nsfw_tag')}
	<AddonRow
		id="better_nsfw_tag"
		label="Mark adult channels"
		description="Adds a clear warning tag to channels marked for adults."
		enabled={betterNsfwTagEnabled}
		badge={SECTION}
		onToggle={toggleBetterNsfwTagAddon}
	/>
{/if}

{#if localAddonControlMatches('better_friend_list')}
	<AddonRow
		id="better_friend_list"
		label="People list tools"
		description="Adds search, filters and sorting to the People panel."
		enabled={betterFriendListEnabled}
		badge={SECTION}
		onToggle={toggleBetterFriendListAddon}
	/>
{/if}
