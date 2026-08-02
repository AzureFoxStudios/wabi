<script lang="ts">
	import { longpress } from '$lib/actions/longpress';
	import type { Channel } from '$lib/socket';
	import { currentChannel, channelUnreadCounts } from '$lib/socket';
	import { formatBadge } from './channelSidebarHelpers';

	export let loreChannels: Channel[];

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

{#each loreChannels as channel (channel.id)}
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
			<span class="hash lore-icon" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 8v13H3V8" />
					<path d="M1 3h22v5H1z" />
					<path d="M10 12h4" />
				</svg>
			</span>
			{channel.name}
			{#if $channelUnreadCounts[channel.id] && $currentChannel !== channel.id}
				<span class="unread-badge">{formatBadge($channelUnreadCounts[channel.id])}</span>
			{/if}
		</button>
	</div>
{/each}
