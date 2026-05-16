<script lang="ts">
	import { pinnedChannels, currentChannel, channelMessages } from '$lib/socket';
	import { getChannelTypeIcon } from '$lib/channelTypes';

	export let collapsed = false;
	let headerHovered = false;

	function toggleCollapse() {
		collapsed = !collapsed;
	}

	function handleChannelClick(channelId: string) {
		currentChannel.set(channelId);
	}

	function getUnreadCount(channelId: string): number {
		const messages = $channelMessages[channelId] || [];
		return messages.length; // Simplified - can be enhanced with proper unread tracking
	}

</script>

<div class="pinned-sidebar" class:collapsed>
	<div class="pinned-header" role="group" on:mouseenter={() => headerHovered = true} on:mouseleave={() => headerHovered = false}>
		<h3><svg class="header-pin-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 3l14 9-4 1-3 7-3-7-4-1z"></path></svg> Pinned Channels</h3>
		<button class="collapse-btn" class:visible={headerHovered} on:click={toggleCollapse} title={collapsed ? 'Expand' : 'Collapse'}>
			{collapsed ? '\u25B6' : '\u25C0'}
		</button>
	</div>

	{#if !collapsed && $pinnedChannels.length > 0}
		<div class="pinned-list">
			{#each $pinnedChannels as channel}
				<button
					class="pinned-item"
					class:active={$currentChannel === channel.id}
					on:click={() => handleChannelClick(channel.id)}
					title={channel.name}
				>
					<span class="channel-icon">
						{getChannelTypeIcon(channel.type)}
					</span>
					<span class="channel-name">
						{channel.name}
					</span>
					{#if getUnreadCount(channel.id) > 0}
						<span class="unread-badge">
							{getUnreadCount(channel.id)}
						</span>
					{/if}
				</button>
			{/each}
		</div>
	{:else if !collapsed}
		<div class="empty-state">
			<p>No pinned channels yet</p>
			<small>Right-click channels to pin them</small>
		</div>
	{/if}
</div>

<style>
	.pinned-sidebar {
		background: var(--surface-app, #1e1e24);
		border-right: 1px solid var(--surface-base, #333);
		display: flex;
		flex-direction: column;
		width: 280px;
		transition: width 0.2s ease;
		overflow: hidden;
	}

	.pinned-sidebar.collapsed {
		width: 50px;
	}

	.pinned-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px;
		border-bottom: 1px solid var(--surface-base, #333);
		flex-shrink: 0;
	}

	.pinned-header h3 {
		font-size: 0.9rem;
		font-weight: 600;
		margin: 0;
		color: var(--text-inverse, #e0e0e0);
		white-space: nowrap;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.header-pin-icon {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
	}

	.collapse-btn {
		background: transparent;
		border: none;
		color: var(--text-muted, #a0a0a0);
		cursor: pointer;
		font-size: 0.8rem;
		padding: 4px;
		transition: opacity 0.2s, color 0.2s;
		opacity: 0;
	}

	.collapse-btn.visible {
		opacity: 1;
	}

	.collapse-btn:hover {
		color: var(--text-inverse, #e0e0e0);
	}

	.pinned-list {
		flex: 1;
		overflow-y: auto;
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.pinned-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		background: var(--surface-raised, #2a2a2e);
		border: 1px solid var(--surface-base, #333);
		border-radius: 6px;
		color: var(--text-muted, #a0a0a0);
		cursor: pointer;
		font-size: 0.9rem;
		transition: all 0.15s;
		white-space: nowrap;
		overflow: hidden;
		position: relative;
	}

	.pinned-item:hover {
		background: var(--surface-raised, #3a3a3e);
		color: var(--text-inverse, #e0e0e0);
		border-color: var(--surface-raised, #444);
	}

	.pinned-item.active {
		background: var(--color-info, var(--color-info, #6366f1));
		color: white;
		border-color: var(--color-info, var(--color-info, #6366f1));
	}

	.pinned-item.active .channel-icon {
		font-size: 1.1rem;
	}

	.channel-icon {
		flex-shrink: 0;
		font-size: 1rem;
	}

	.channel-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.unread-badge {
		background: var(--color-danger, #ef4444);
		color: white;
		border-radius: 10px;
		padding: 2px 6px;
		font-size: 0.75rem;
		font-weight: 600;
		flex-shrink: 0;
	}

	.empty-state {
		padding: 20px 12px;
		text-align: center;
		color: var(--text-muted, #808080);
		font-size: 0.85rem;
	}

	.empty-state p {
		margin: 0 0 8px 0;
		font-weight: 500;
	}

	.empty-state small {
		display: block;
		opacity: 0.7;
	}

	.pinned-sidebar.collapsed .pinned-header h3,
	.pinned-sidebar.collapsed .channel-name {
		display: none;
	}

	.pinned-sidebar.collapsed .pinned-item {
		justify-content: center;
		padding: 10px;
	}

	.pinned-sidebar.collapsed .empty-state {
		display: none;
	}
</style>
