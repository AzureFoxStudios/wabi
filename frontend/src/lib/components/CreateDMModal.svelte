<!--
	New message (design contract §7.13, §8.10): a BaseModal md that picks one person and opens the
	conversation in center stage. Search field, people rows with identity stamps and presence words,
	a real empty state and an inline error where the action happened.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { users, serverMembers, currentUser, createDM, channels, joinChannel } from '$lib/socket';
	import type { Channel, User } from '$lib/socket';
	import { layoutStore } from '$lib/layoutStore';
	import { buildDmDirectoryUsers, getDmDirectoryKey } from '$lib/dmUserDirectory';
	import { buildDmPlaceholderChannel, findExistingDmChannel, getDmStableUserId } from '$lib/dmConversations';
	import { overlayStyle } from '$lib/overlayStyle';
	import { mediaUrl } from '$lib/mediaUrl';
	import { inkFor } from '$lib/theme/identity';
	import { _ } from '$lib/i18n';
	import BaseModal from './BaseModal.svelte';
	import ProfileName from './ProfileName.svelte';
	import ProfileMedia from './ProfileMedia.svelte';
	import Icon from './ui/Icon.svelte';
	import { presenceLabelKey, presenceOf, stampInitial } from './userPopoutModel';

	export let isOpen = false;

	let searchQuery = '';
	let pendingUserKey = '';
	let createError = '';

	// Mirrors the popout `disableAllBanners` profile-visibility kill switch
	// (localStorage `wabi:profile:visibility` -> disableAll).
	let disableAllBanners = false;

	onMount(() => {
		try {
			const raw = localStorage.getItem('wabi:profile:visibility');
			if (!raw) return;
			const v = JSON.parse(raw);
			if (typeof v.disableAll === 'boolean') disableAllBanners = v.disableAll;
		} catch {
			// ignore malformed local state
		}
	});

	$: filteredUsers = buildDmDirectoryUsers({
		onlineUsers: $users,
		serverMembers: $serverMembers,
		currentUser: $currentUser,
		searchQuery
	});

	function upsertLocalDmPlaceholder(channel: Channel): Channel {
		channels.update((allChannels) => {
			const existing = allChannels.find((candidate) => candidate.id === channel.id);
			if (existing) return allChannels.map((candidate) => (candidate.id === channel.id ? { ...candidate, ...channel } : candidate));
			return [...allChannels, channel];
		});
		return channel;
	}

	function openDmConversation(channel: Channel, user: User) {
		layoutStore.openCenterDm(channel.id, user);
		joinChannel(channel.id);
		closeModal();
	}

	async function handleUserClick(user: User) {
		const targetKey = getDmDirectoryKey(user);
		const selfKey = getDmStableUserId($currentUser);
		const userKey = getDmStableUserId(user);
		if (selfKey && userKey && selfKey === userKey) return;

		createError = '';
		const existing = findExistingDmChannel($channels || [], user);
		if (existing) {
			openDmConversation(existing, user);
			return;
		}

		pendingUserKey = targetKey;
		const result = await createDM(targetKey);
		if (pendingUserKey !== targetKey) return;

		const created =
			(result.ok ? result.channel : undefined) ||
			(result.channelId ? ($channels || []).find((channel) => channel.id === result.channelId) : null) ||
			findExistingDmChannel($channels || [], user) ||
			(result.channelId ? upsertLocalDmPlaceholder(buildDmPlaceholderChannel(result.channelId, user, $currentUser)) : null);

		pendingUserKey = '';
		if (created) {
			openDmConversation(created, user);
			return;
		}

		if (!result.ok) console.warn('[DM] Could not open conversation:', (result as { ok: false; error: string }).error);
		createError = result.ok
			? "The conversation was created, but the server didn't send it back. Look for it under DMs."
			: `Couldn't start a conversation with ${user.username}. Nothing was created.`;
	}

	function closeModal() {
		isOpen = false;
		searchQuery = '';
		pendingUserKey = '';
		createError = '';
	}
</script>

<BaseModal {isOpen} onClose={closeModal} size="md" padded title="New message" note="New conversations start encryption-pending" initialFocus=".cdm-search input" panelClass="cdm">
	<div class="w-field w-field--chrome cdm-search">
		<Icon name="search" size={16} />
		<input type="search" bind:value={searchQuery} placeholder="Search people" aria-label="Search people" autocomplete="off" />
	</div>

	{#if createError}
		<div class="w-notice cdm-notice" role="alert">
			<Icon name="alert" size={16} />
			<p class="w-notice__title">{createError}</p>
		</div>
	{/if}

	{#if filteredUsers.length === 0}
		<div class="w-empty cdm-empty">
			<Icon name="users" size={28} />
			<p class="w-empty__title">{searchQuery.trim() ? 'No one matches' : 'No one to message yet'}</p>
			<p class="w-empty__text">{searchQuery.trim() ? 'Try another name or handle.' : 'People appear here as soon as they join this community.'}</p>
		</div>
	{:else}
		<ul class="cdm-list" aria-label="People">
			{#each filteredUsers as user (getDmDirectoryKey(user))}
				{@const userKey = getDmDirectoryKey(user)}
				{@const presence = presenceOf(user.status)}
				<li>
					<button
						type="button"
						class="cdm-row"
						class:is-pending={pendingUserKey === userKey}
						style={$inkFor(user.color)}
						aria-busy={pendingUserKey === userKey}
						disabled={Boolean(pendingUserKey)}
						on:click={() => handleUserClick(user)}
					>
						<span class="cdm-av" data-presence={presence}>
							{#if user.profilePicture}
								<ProfileMedia src={mediaUrl(user.profilePicture)} decorative class="cdm-av__pic" />
							{:else}
								<span class="cdm-av__stamp" aria-hidden="true">{stampInitial(user.username)}</span>
							{/if}
							{#if user.overlayUrl && !disableAllBanners}
								<span class="avatar-overlay-badge" style={overlayStyle(user)} aria-hidden="true"></span>
							{/if}
							<span class="cdm-av__presence" aria-hidden="true"></span>
						</span>
						<span class="cdm-text">
							<span class="cdm-name"><ProfileName username={user.username} font={user.usernameFont} color={user.color} /></span>
							<span class="cdm-sub">{pendingUserKey === userKey ? 'Opening…' : user.handle ? `@${user.handle}` : $_(presenceLabelKey(presence))}</span>
						</span>
						<span class="cdm-state">{pendingUserKey === userKey ? '' : $_(presenceLabelKey(presence))}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</BaseModal>

<style>
	.cdm-search {
		margin-bottom: 12px;
	}
	.cdm-search input[type='search']::-webkit-search-cancel-button {
		-webkit-appearance: none;
		appearance: none;
	}
	:global(.cdm-notice) {
		margin-bottom: 12px;
	}
	.cdm-empty {
		padding: 32px 0 8px;
	}
	.cdm-list {
		display: grid;
		gap: 2px;
		margin: 0 -8px;
		padding: 0;
		list-style: none;
	}
	/* Person row (§7.11): 46px, 28px stamp + presence, name over a mono handle, presence word. */
	.cdm-row {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr) auto;
		align-items: center;
		column-gap: 12px;
		box-sizing: border-box;
		width: 100%;
		min-height: 46px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--w-text);
		font: var(--w-t-ui);
		text-align: left;
		cursor: pointer;
		transition: background-color var(--w-dur-1) var(--w-ease);
	}
	.cdm-row:hover:not(:disabled) {
		background: color-mix(in srgb, var(--w-raise) 70%, transparent);
	}
	.cdm-row:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: -2px;
	}
	.cdm-row:disabled {
		cursor: wait;
	}
	.cdm-row:disabled:not(.is-pending) {
		opacity: 0.55;
	}
	.cdm-row.is-pending {
		background: var(--w-raise);
	}
	:global(:root[data-char='contrast']) .cdm-row:hover:not(:disabled),
	:global(:root[data-char='contrast']) .cdm-row.is-pending {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--w-line-strong);
	}
	.cdm-av {
		position: relative;
		display: block;
		width: 28px;
		height: 28px;
		border-radius: var(--w-avr);
	}
	.cdm-av__stamp,
	.cdm-av :global(.cdm-av__pic) {
		display: grid;
		place-items: center;
		box-sizing: border-box;
		width: 28px;
		height: 28px;
		border-radius: var(--w-avr);
		object-fit: cover;
	}
	.cdm-av__stamp {
		background: var(--disc, var(--w-raise));
		color: var(--on, var(--w-text));
		font: 600 calc(12px * var(--w-fs)) / 1 var(--w-serif);
	}
	.cdm-av__presence {
		position: absolute;
		right: -2px;
		bottom: -2px;
		box-sizing: border-box;
		width: 10px;
		height: 10px;
		border-radius: var(--w-avr);
		background: var(--w-online);
		box-shadow: 0 0 0 2px var(--w-bg);
	}
	.cdm-av[data-presence='away'] .cdm-av__presence {
		background: var(--w-warn);
	}
	.cdm-av[data-presence='busy'] .cdm-av__presence {
		background: var(--w-danger);
	}
	.cdm-av[data-presence='offline'] .cdm-av__presence {
		background: var(--w-bg);
		box-shadow: inset 0 0 0 1.5px var(--w-faint), 0 0 0 2px var(--w-bg);
	}
	.cdm-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.cdm-name {
		display: flex;
		min-width: 0;
		font: var(--w-t-label);
	}
	.cdm-sub {
		overflow: hidden;
		color: var(--w-faint);
		font: var(--w-t-mono);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cdm-state {
		color: var(--w-faint);
		font: 400 calc(12px * var(--w-fs)) / calc(16px * var(--w-fs)) var(--w-sans);
		white-space: nowrap;
	}
	@media (pointer: coarse) {
		.cdm-row {
			min-height: 52px;
		}
	}
</style>
