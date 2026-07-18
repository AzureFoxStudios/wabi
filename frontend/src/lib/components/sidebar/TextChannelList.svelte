<script lang="ts">
	import { longpress } from '$lib/actions/longpress';
	import type { Channel } from '$lib/socket';
	import { channelMessages, currentChannel, channelUnreadCounts, currentUser } from '$lib/socket';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { FOLLOW_ALERT_LEVEL_LABELS } from '$lib/following';
	import { formatBadge, formatGlimpseTime, summarizeGlimpseMessage } from './channelSidebarHelpers';
	import { isLikelyNsfwChannel } from '$lib/displayEnhancements';
	import { isLiveRetention } from '../../../../../shared/messageRetention.js';
	import { isServerChannelMuted } from '$lib/serverSettings';

	export let textChannels: Channel[];
	export let groupChannels: Channel[];
	export let threadChannelsByParent: Record<string, Channel[]>;
	export let followedChannelIds: Set<string>;
	export let followedChannelPreferences: Map<string, { alertLevel: string }>;

	let glimpseChannelId: string | null = null;
	let glimpsePopover: HTMLElement | null = null;

	$: glimpseChannelMessages = glimpseChannelId
		? ($channelMessages[glimpseChannelId] || []).slice(-4).reverse()
		: [];

	function isChannelLocallyMuted(channelId: string): boolean {
		return isServerChannelMuted(channelId);
	}

	function isNsfwTaggedChannel(channel: Channel): boolean {
		return isLikelyNsfwChannel(channel.name, channel.description);
	}

	function isChannelBookmarked(channel: Channel): boolean {
		const userId = $currentUser?.id;
		if (!userId) return false;
		return channel.pinnedBy?.includes(userId) ?? false;
	}

	function getFollowAlertLabel(channelId: string): string {
		return FOLLOW_ALERT_LEVEL_LABELS[followedChannelPreferences.get(channelId)?.alertLevel || 'off'];
	}

	export let onChannelClick: (channelId: string) => void;
	export let onChannelButtonClick: (channelId: string, event: MouseEvent) => void;
	export let onChannelRightClick: (event: MouseEvent, channel: Channel) => void;
	export let onChannelLongPress: (event: TouchEvent, channel: Channel) => void;
	export let onToggleChannelFollow: (channelId: string, event?: Event) => void;
	export let onCycleFollowAlert: (channelId: string, event?: Event) => void;
	export let onOpenChannelSettings: (channel: Channel) => void;
	export let onShowPinnedMessages: (channelId: string) => void;
	export let liveWhiteboardChannelIds: Set<string> = new Set();
</script>

{#each textChannels as channel (channel.id)}
	<div
		class="channel-item text-channel-item"
		class:active={$currentChannel === channel.id}
		class:has-timer={channel.autoDeleteAfter}
		class:followed={followedChannelIds.has(channel.id)}
		class:bookmarked={isChannelBookmarked(channel)}
		role="group"
		on:contextmenu={(e) => onChannelRightClick(e, channel)}
		use:longpress={{ onLongPress: (e) => onChannelLongPress(e, channel) }}
	>
		<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={(event) => onChannelButtonClick(channel.id, event)} title={channel.autoDeleteAfter ? `Auto-delete: ${channel.autoDeleteAfter}` : 'Alt-click to glimpse'}>
			<span class="hash">#</span>
			{channel.name}
			{#if isLiveRetention(channel.autoDeleteAfter)}
				<span class="live-tag" title="Live room — messages are session only and not saved">LIVE</span>
			{/if}
			{#if $displayEnhancementSettingsStore.betterNsfwTagEnabled && isNsfwTaggedChannel(channel)}
				<span class="nsfw-tag">NSFW</span>
			{/if}
			{#if isChannelLocallyMuted(channel.id)}
				<span class="muted-tag">Muted</span>
			{/if}
			{#if isChannelBookmarked(channel)}
				<span class="bookmark-tag" title="Bookmarked for the quick switcher">Saved</span>
			{/if}
			{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
				<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
			{/if}
			{#if liveWhiteboardChannelIds.has(channel.id)}
				<span class="live-pill" title="Someone is on this whiteboard"><span class="live-dot"></span>LIVE</span>
			{/if}
		</button>
		<div class="channel-actions text-channel-actions">
			<button
				class="follow-btn"
				class:active={followedChannelIds.has(channel.id)}
				on:click|stopPropagation={(event) => onToggleChannelFollow(channel.id, event)}
				title={followedChannelIds.has(channel.id) ? 'Unfollow channel' : 'Follow channel'}
			>
				{followedChannelIds.has(channel.id) ? '★' : '☆'}
			</button>
			<button class="pin-btn" on:click|stopPropagation={() => onShowPinnedMessages(channel.id)} title="View pinned messages">
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="2"></circle><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"></path><line x1="12" y1="15" x2="12" y2="21"></line></svg>
			</button>
			<button class="settings-btn" on:click|stopPropagation={() => onOpenChannelSettings(channel)} title="Channel settings">
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 0 0-4h-.09a1.65 1.65 0 0 0-1.51-1z"></path></svg>
			</button>
		</div>
		{#if glimpseChannelId === channel.id}
			<div class="channel-glimpse-popout" bind:this={glimpsePopover}>
				<div class="channel-glimpse-header">
					<div>
						<strong>#{channel.name}</strong>
						<small>{glimpseChannelMessages.length > 0 ? `${glimpseChannelMessages.length} recent loaded` : 'No recent messages loaded yet'}</small>
					</div>
					<button
						type="button"
						class="channel-glimpse-follow-btn"
						on:click|stopPropagation={(event) => onToggleChannelFollow(channel.id, event)}
						title={followedChannelIds.has(channel.id) ? 'Unfollow channel' : 'Follow channel'}
					>
						{followedChannelIds.has(channel.id) ? 'Following' : 'Follow'}
					</button>
				</div>
				{#if glimpseChannelMessages.length > 0}
					<div class="channel-glimpse-messages">
						{#each glimpseChannelMessages as message (message.id)}
							<div class="channel-glimpse-message">
								<div class="channel-glimpse-meta">
									<strong>{message.user}</strong>
									<span>{formatGlimpseTime(message.timestamp)}</span>
								</div>
								<p>{summarizeGlimpseMessage(message)}</p>
							</div>
						{/each}
					</div>
				{:else}
					<p class="channel-glimpse-empty">Open this channel once to cache its latest window for glance mode.</p>
				{/if}
				<div class="channel-glimpse-actions">
					<button type="button" class="channel-glimpse-alert-btn" on:click|stopPropagation={(event) => onCycleFollowAlert(channel.id, event)}>
						Alerts: {getFollowAlertLabel(channel.id)}
					</button>
					<button type="button" class="channel-glimpse-open-btn" on:click|stopPropagation={() => onChannelClick(channel.id)}>
						Open channel
					</button>
				</div>
			</div>
		{/if}
	</div>
	{#if (threadChannelsByParent[channel.id] || []).length > 0}
		<div class="thread-list">
			{#each threadChannelsByParent[channel.id] as thread (thread.id)}
				<button
					class="thread-btn"
					class:active={$currentChannel === thread.id}
					on:click={() => onChannelClick(thread.id)}
					title={thread.type === 'thread_private' ? 'Private thread' : 'Thread'}
				>
					<span class="thread-prefix">&gt;</span>
					<span class="thread-name">{thread.name}</span>
					{#if thread.type === 'thread_private'}
						<span class="thread-privacy">Private</span>
					{/if}
					{#if $channelUnreadCounts[thread.id] && $currentChannel !== thread.id}
						<span class="unread-badge">{formatBadge($channelUnreadCounts[thread.id])}</span>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
{/each}

{#if groupChannels.length > 0}
	<div class="section-header section-subheader">Group Chats</div>
	{#each groupChannels as channel (channel.id)}
		<div
			class="channel-item text-channel-item"
			class:active={$currentChannel === channel.id}
			class:has-timer={channel.autoDeleteAfter}
			class:followed={followedChannelIds.has(channel.id)}
			class:bookmarked={isChannelBookmarked(channel)}
			role="group"
			on:contextmenu={(e) => onChannelRightClick(e, channel)}
			use:longpress={{ onLongPress: (e) => onChannelLongPress(e, channel) }}
		>
			<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={(event) => onChannelButtonClick(channel.id, event)} title={channel.autoDeleteAfter ? `Auto-delete: ${channel.autoDeleteAfter}` : 'Alt-click to glimpse'}>
				<svg class="group-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
				{channel.name}
				{#if $displayEnhancementSettingsStore.betterNsfwTagEnabled && isNsfwTaggedChannel(channel)}
					<span class="nsfw-tag">NSFW</span>
				{/if}
				{#if isChannelLocallyMuted(channel.id)}
					<span class="muted-tag">Muted</span>
				{/if}
				{#if isChannelBookmarked(channel)}
					<span class="bookmark-tag" title="Bookmarked for the quick switcher">Saved</span>
				{/if}
				{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
					<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
				{/if}
				{#if liveWhiteboardChannelIds.has(channel.id)}
					<span class="live-pill" title="Someone is on this whiteboard"><span class="live-dot"></span>LIVE</span>
				{/if}
			</button>
			<div class="channel-actions text-channel-actions">
				<button
					class="follow-btn"
					class:active={followedChannelIds.has(channel.id)}
					on:click|stopPropagation={(event) => onToggleChannelFollow(channel.id, event)}
					title={followedChannelIds.has(channel.id) ? 'Unfollow group' : 'Follow group'}
				>
					{followedChannelIds.has(channel.id) ? '★' : '☆'}
				</button>
				<button class="pin-btn" on:click|stopPropagation={() => onShowPinnedMessages(channel.id)} title="View pinned messages">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="2"></circle><path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"></path><line x1="12" y1="15" x2="12" y2="21"></line></svg>
				</button>
				<button class="settings-btn" on:click|stopPropagation={() => onOpenChannelSettings(channel)} title="Channel settings">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 0 0-4h-.09a1.65 1.65 0 0 0-1.51-1z"></path></svg>
				</button>
			</div>
			{#if glimpseChannelId === channel.id}
				<div class="channel-glimpse-popout" bind:this={glimpsePopover}>
					<div class="channel-glimpse-header">
						<div>
							<strong>{channel.name}</strong>
							<small>{glimpseChannelMessages.length > 0 ? `${glimpseChannelMessages.length} recent loaded` : 'No recent messages loaded yet'}</small>
						</div>
						<button
							type="button"
							class="channel-glimpse-follow-btn"
							on:click|stopPropagation={(event) => onToggleChannelFollow(channel.id, event)}
							title={followedChannelIds.has(channel.id) ? 'Unfollow group' : 'Follow group'}
						>
							{followedChannelIds.has(channel.id) ? 'Following' : 'Follow'}
						</button>
					</div>
					{#if glimpseChannelMessages.length > 0}
						<div class="channel-glimpse-messages">
							{#each glimpseChannelMessages as message (message.id)}
								<div class="channel-glimpse-message">
									<div class="channel-glimpse-meta">
										<strong>{message.user}</strong>
										<span>{formatGlimpseTime(message.timestamp)}</span>
									</div>
									<p>{summarizeGlimpseMessage(message)}</p>
								</div>
							{/each}
						</div>
					{:else}
						<p class="channel-glimpse-empty">Open this group once to cache its latest window for glance mode.</p>
					{/if}
					<div class="channel-glimpse-actions">
						<button type="button" class="channel-glimpse-alert-btn" on:click|stopPropagation={(event) => onCycleFollowAlert(channel.id, event)}>
							Alerts: {getFollowAlertLabel(channel.id)}
						</button>
						<button type="button" class="channel-glimpse-open-btn" on:click|stopPropagation={() => onChannelClick(channel.id)}>
							Open group
						</button>
					</div>
				</div>
			{/if}
		</div>
	{/each}
{/if}
