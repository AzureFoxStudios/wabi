<script lang="ts">
	import { longpress } from '$lib/actions/longpress';
	import type { Channel } from '$lib/socket';
	import { currentChannel, channelUnreadCounts } from '$lib/socket';
	import { formatBadge } from './channelSidebarHelpers';

	export let wikiChannels: Channel[];

	export let onChannelButtonClick: (channelId: string, event: MouseEvent) => void;
	export let onChannelRightClick: (event: MouseEvent, channel: Channel) => void;
	export let onChannelLongPress: (event: TouchEvent, channel: Channel) => void;
	export let dropTargetClass: (channelId: string) => string = () => '';
	export let isChannelDragging: (channelId: string) => boolean = () => false;
	export let onChannelDragStart: (e: DragEvent, channelId: string) => void = () => {};
	export let onChannelDragOver: (e: DragEvent, channelId: string) => void = () => {};
	export let onChannelDragLeave: (channelId: string) => void = () => {};
	export let onChannelDrop: (e: DragEvent, channelId: string) => void = () => {};
	export let onChannelDragEnd: () => void = () => {};
</script>

{#each wikiChannels as channel (channel.id)}
	<div
		class="channel-item"
		class:active={$currentChannel === channel.id}
		class:drop-before={dropTargetClass(channel.id) === 'drop-before'}
		class:drop-after={dropTargetClass(channel.id) === 'drop-after'}
		class:is-dragging={isChannelDragging(channel.id)}
		role="group"
		draggable="true"
		on:contextmenu={(e) => onChannelRightClick(e, channel)}
		use:longpress={{ onLongPress: (e) => onChannelLongPress(e, channel) }}
		on:dragstart|stopPropagation={(e) => onChannelDragStart(e, channel.id)}
		on:dragover|stopPropagation={(e) => onChannelDragOver(e, channel.id)}
		on:dragleave|stopPropagation={() => onChannelDragLeave(channel.id)}
		on:drop|stopPropagation={(e) => onChannelDrop(e, channel.id)}
		on:dragend={onChannelDragEnd}
	>
		<button
			class="channel-btn"
			data-abbrev={channel.name.charAt(0).toUpperCase()}
			on:click={(event) => onChannelButtonClick(channel.id, event)}
			title="Alt-click to glimpse"
		>
			<span class="hash wiki-icon" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
					<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
					<path d="M8 7h8" />
					<path d="M8 11h6" />
				</svg>
			</span>
			{channel.name}
			{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
				<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
			{/if}
		</button>
	</div>
{/each}
