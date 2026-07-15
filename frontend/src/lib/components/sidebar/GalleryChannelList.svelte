<script lang="ts">
	import { longpress } from '$lib/actions/longpress';
	import type { Channel } from '$lib/socket';
	import { currentChannel, channelUnreadCounts } from '$lib/socket';
	import { formatBadge } from './channelSidebarHelpers';

	export let galleryChannels: Channel[];
	export let followedChannelIds: Set<string>;

	export let onChannelClick: (channelId: string) => void;
	export let onChannelButtonClick: (channelId: string, event: MouseEvent) => void;
	export let onChannelRightClick: (event: MouseEvent, channel: Channel) => void;
	export let onChannelLongPress: (event: TouchEvent, channel: Channel) => void;
	export let liveWhiteboardChannelIds: Set<string> = new Set();
</script>

<div class="section-heading-row">
	<button
		class="section-toggle"
		type="button"
		aria-expanded={true}
	>
		<span class="section-chevron" aria-hidden="true">
			<svg viewBox="0 0 24 24">
				<path d="M9 6l6 6-6 6"></path>
			</svg>
		</span>
		<span class="section-toggle-label">Gallery</span>
		<span class="section-count">{galleryChannels.length}</span>
	</button>
</div>
{#each galleryChannels as channel (channel.id)}
	<div
		class="channel-item"
		class:active={$currentChannel === channel.id}
		role="group"
		on:contextmenu={(e) => onChannelRightClick(e, channel)}
		use:longpress={{ onLongPress: (e) => onChannelLongPress(e, channel) }}
	>
		<button class="channel-btn" data-abbrev={channel.name.charAt(0).toUpperCase()} on:click={(event) => onChannelButtonClick(channel.id, event)} title="Alt-click to glimpse">
			<span class="hash gallery-icon" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<rect x="3" y="3" width="18" height="18" rx="2"/>
					<circle cx="8.5" cy="8.5" r="1.5"/>
					<path d="M21 15l-5-5L5 21"/>
				</svg>
			</span>
			{channel.name}
			{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
				<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
			{/if}
			{#if liveWhiteboardChannelIds.has(channel.id)}
				<span class="live-pill" title="Someone is on this whiteboard"><span class="live-dot"></span>LIVE</span>
			{/if}
		</button>
	</div>
{/each}
