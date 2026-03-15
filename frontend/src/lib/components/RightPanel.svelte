<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { channels, channelMessages, currentUser, sendMessage, users } from '$lib/socket';
	import type { Channel, Message, User } from '$lib/socket-types';
	import { layoutStore } from '$lib/layoutStore';
	import UserListTab from './UserListTab.svelte';
	import DMTab from './DMTab.svelte';
	import AdminTab from './AdminTab.svelte';
	import MediaAlbumsTab from './MediaAlbumsTab.svelte';
	import KeepNotesView from './KeepNotesView.svelte';
	import MapWorkspace from './MapWorkspace.svelte';

	type PanelView = 'users' | 'dms' | 'media' | 'admin' | 'map';
	type QuickMode = 'notes' | 'dm';

	const dispatch = createEventDispatcher<{
		openSettings: { paymentSurface: 'connections' };
	}>();

	const QUICK_MIN_HEIGHT = 140;
	const QUICK_DEFAULT_HEIGHT = 220;
	const QUICK_MAX_RATIO = 0.62;
	const QUICK_COLLAPSED_BAR_HEIGHT = 0;
	const QUICK_COLLAPSE_THRESHOLD = 110;

	let topView: PanelView = 'users';
	let quickMode: QuickMode = 'notes';
	let quickPanelHeight = QUICK_DEFAULT_HEIGHT;
	let quickPanelCollapsed = false;
	let quickDmChannelId = '';
	let quickMessage = '';
	let isResizingQuick = false;
	let quickResizeStartY = 0;
	let quickResizeStartHeight = QUICK_DEFAULT_HEIGHT;
	let rightPanelElement: HTMLElement | null = null;
	let quickMessagesElement: HTMLDivElement | null = null;

	$: activeTab = $layoutStore.activeRightTab;
	$: canAccessAdminTab = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin' || $currentUser?.highestRole === 'mod';
	$: if (!canAccessAdminTab && activeTab === 'admin') {
		layoutStore.showUsersTab();
	}
	$: topView = activeTab;

	$: dmChannels = $channels.filter((ch) => ch.type === 'dm' || ch.type === 'group');
	$: if (!quickDmChannelId && dmChannels.length > 0) {
		quickDmChannelId = dmChannels[0].id;
	}
	$: if (quickDmChannelId && !dmChannels.some((ch) => ch.id === quickDmChannelId)) {
		quickDmChannelId = dmChannels[0]?.id || '';
	}
	$: quickDmChannel = dmChannels.find((ch) => ch.id === quickDmChannelId) || null;
	$: quickMessages = quickDmChannelId ? (($channelMessages[quickDmChannelId] || []) as Message[]) : [];
	$: quickRecentMessages = quickMessages.slice(-40);

	$: if (quickMessagesElement) {
		quickMessagesElement.scrollTop = quickMessagesElement.scrollHeight;
	}

	function switchTopView(value: PanelView): void {
		if (value === 'users') {
			layoutStore.showUsersTab();
			return;
		}
		if (value === 'dms') {
			layoutStore.showDMsTab();
			return;
		}
		if (value === 'media') {
			layoutStore.showMediaTab();
			return;
		}
		if (value === 'map') {
			layoutStore.showMapTab();
			return;
		}
		if (value === 'admin' && canAccessAdminTab) {
			layoutStore.showAdminTab();
		}
	}

	function handleTopViewChange(event: Event): void {
		const target = event.currentTarget as HTMLSelectElement | null;
		if (!target) return;
		switchTopView(target.value as PanelView);
	}

	function getOtherUser(channel: Channel): User | null {
		if (channel.otherUser) return channel.otherUser;
		const me = $currentUser;
		if (!me) return null;
		const myStableId = me.dbUserId ? `user-${me.dbUserId}` : me.id;
		const otherStableId = (channel.members || []).find((id) => id !== myStableId);
		if (!otherStableId) return null;
		if (otherStableId.startsWith('user-')) {
			const dbId = Number.parseInt(otherStableId.slice(5), 10);
			return $users.find((u) => u.dbUserId === dbId) || null;
		}
		return $users.find((u) => u.id === otherStableId) || null;
	}

	function getDmLabel(channel: Channel): string {
		if (channel.type === 'group') {
			return channel.name || 'Group DM';
		}
		const other = getOtherUser(channel);
		return other?.username || channel.name || 'Direct Message';
	}

	function getMessageText(message: Message): string {
		if (message.type === 'text') return message.text;
		if (message.type === 'gif') return '[GIF]';
		if (message.type === 'file') return '[File]';
		if (message.type === 'emoji') return '[Emoji]';
		if (message.type === 'role_gate') return '[Role message]';
		return '[Message]';
	}

	function formatTime(timestamp: number): string {
		return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}

	function handleQuickMessageKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			sendQuickMessage();
		}
	}

	function sendQuickMessage(): void {
		if (!quickDmChannelId) return;
		const trimmed = quickMessage.trim();
		if (!trimmed) return;
		sendMessage(quickDmChannelId, trimmed);
		quickMessage = '';
	}

	function handleQuickResizeStart(event: MouseEvent): void {
		event.preventDefault();
		isResizingQuick = true;
		quickResizeStartY = event.clientY;
		quickResizeStartHeight = quickPanelHeight;
		window.addEventListener('mousemove', handleQuickResizeMove);
		window.addEventListener('mouseup', handleQuickResizeStop);
	}

	function handleQuickResizeMove(event: MouseEvent): void {
		if (!isResizingQuick) return;
		const delta = quickResizeStartY - event.clientY;
		const maxHeight = rightPanelElement ? Math.floor(rightPanelElement.clientHeight * QUICK_MAX_RATIO) : 420;
		const nextHeight = quickResizeStartHeight + delta;
		if (nextHeight <= QUICK_COLLAPSE_THRESHOLD) {
			quickPanelCollapsed = true;
			return;
		}
		quickPanelCollapsed = false;
		quickPanelHeight = Math.max(QUICK_MIN_HEIGHT, Math.min(maxHeight, nextHeight));
	}

	function handleQuickResizeStop(): void {
		isResizingQuick = false;
		window.removeEventListener('mousemove', handleQuickResizeMove);
		window.removeEventListener('mouseup', handleQuickResizeStop);
	}

	function collapseQuickPanel(): void {
		quickPanelCollapsed = true;
	}

	function expandQuickPanel(): void {
		quickPanelCollapsed = false;
		if (quickPanelHeight < QUICK_MIN_HEIGHT) {
			quickPanelHeight = QUICK_DEFAULT_HEIGHT;
		}
	}
</script>

<div class="right-panel" bind:this={rightPanelElement}>
	<div class="right-panel-header">
		<select id="right-view-select" class="view-select" value={topView} on:change={handleTopViewChange}>
			<option value="users">Users</option>
			<option value="dms">DMs</option>
			<option value="map">Map</option>
			<option value="media">Media</option>
			{#if canAccessAdminTab}
				<option value="admin">Admin</option>
			{/if}
		</select>
	</div>

	<div class="right-panel-content">
		{#if activeTab === 'users'}
			<UserListTab />
		{:else if activeTab === 'dms'}
			<DMTab on:openSettings={(event) => dispatch('openSettings', event.detail)} />
		{:else if activeTab === 'map'}
			<MapWorkspace variant="compact" />
		{:else if activeTab === 'media'}
			<MediaAlbumsTab />
		{:else if activeTab === 'admin'}
			<AdminTab />
		{/if}
	</div>
	{#if quickPanelCollapsed}
		<button class="quick-reopen-floating-btn" type="button" title="Show quick panel" on:click={expandQuickPanel}>^</button>
	{/if}

	<div class="quick-resources" class:is-collapsed={quickPanelCollapsed} style={`height: ${quickPanelCollapsed ? QUICK_COLLAPSED_BAR_HEIGHT : quickPanelHeight}px;`}>
		{#if quickPanelCollapsed}
			<div class="quick-collapsed-bar">
				<div class="quick-controls">
					<select class="quick-mode-select" bind:value={quickMode}>
						<option value="notes">Notes</option>
						<option value="dm">DM</option>
					</select>
					{#if quickMode === 'dm'}
						<select class="quick-dm-select" bind:value={quickDmChannelId}>
							{#if dmChannels.length === 0}
								<option value="">No DM threads</option>
							{:else}
								{#each dmChannels as channel}
									<option value={channel.id}>{getDmLabel(channel)}</option>
								{/each}
							{/if}
						</select>
					{/if}
				</div>
				<button class="quick-collapse-btn" type="button" title="Expand quick panel" on:click={expandQuickPanel}>^</button>
			</div>
		{:else}
			<button class="quick-resize-handle" type="button" on:mousedown={handleQuickResizeStart} title="Resize quick resources" aria-label="Resize quick resources"></button>
			<div class="quick-header">
				<div class="quick-controls">
					<select class="quick-mode-select" bind:value={quickMode}>
						<option value="notes">Notes</option>
						<option value="dm">DM</option>
					</select>
					{#if quickMode === 'dm'}
						<select class="quick-dm-select" bind:value={quickDmChannelId}>
							{#if dmChannels.length === 0}
								<option value="">No DM threads</option>
							{:else}
								{#each dmChannels as channel}
									<option value={channel.id}>{getDmLabel(channel)}</option>
								{/each}
							{/if}
						</select>
					{/if}
				</div>
				<button class="quick-collapse-btn" type="button" title="Collapse quick panel" on:click={collapseQuickPanel}>v</button>
			</div>

			<div class="quick-body">
				{#if quickMode === 'notes'}
					<KeepNotesView />
				{:else if !quickDmChannelId}
					<div class="quick-empty">Open a DM to use quick DM here.</div>
				{:else}
					<div class="quick-dm-messages" bind:this={quickMessagesElement}>
						{#if quickRecentMessages.length === 0}
							<div class="quick-empty">No messages yet.</div>
						{:else}
							{#each quickRecentMessages as message}
								<div class="quick-dm-message">
									<div class="quick-dm-meta">
										<span class="quick-dm-author">{message.user}</span>
										<span class="quick-dm-time">{formatTime(message.timestamp)}</span>
									</div>
									<div class="quick-dm-text">{getMessageText(message)}</div>
								</div>
							{/each}
						{/if}
					</div>
					<div class="quick-dm-compose">
						<input
							type="text"
							bind:value={quickMessage}
							on:keydown={handleQuickMessageKeydown}
							placeholder="Send quick DM..."
						/>
						<button class="quick-send-btn" type="button" on:click={sendQuickMessage}>Send</button>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.right-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--bg-secondary);
		min-height: 0;
	}

	.right-panel-header {
		display: flex;
		align-items: center;
		padding: 0;
		min-height: var(--app-chrome-height);
		border-bottom: 1px solid var(--border);
		background: var(--bg-tertiary, var(--bg-secondary));
	}

	.view-select,
	.quick-mode-select,
	.quick-dm-select {
		min-width: 0;
		padding: 0.3rem 0.65rem;
		border-radius: 0;
		border: none;
		background: color-mix(in srgb, var(--bg-tertiary, var(--bg-secondary)) 82%, transparent);
		color: var(--text-primary);
		font-size: 0.98rem;
		font-weight: 600;
		line-height: 1.2;
		text-align: left;
	}

	.view-select {
		flex: 1;
		height: var(--app-chrome-height);
		width: 100%;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
	}

	.view-select option,
	.quick-mode-select option,
	.quick-dm-select option {
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.right-panel-content {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.quick-resources {
		position: relative;
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-top: 1px solid var(--border);
		background: var(--bg-secondary);
		overflow: hidden;
	}

	.quick-resources.is-collapsed {
		border-top: none;
		height: 0;
	}

	.quick-resize-handle {
		height: 8px;
		border: none;
		border-top: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border));
		border-bottom: 1px solid color-mix(in srgb, var(--accent) 12%, var(--border));
		background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 28%, transparent), transparent);
		cursor: ns-resize;
		padding: 0;
		flex-shrink: 0;
	}

	.quick-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0;
		border-bottom: 1px solid var(--border);
		min-height: 36px;
	}

	.quick-collapsed-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 100%;
		border-top: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
	}

	.quick-controls {
		display: flex;
		align-items: center;
		gap: 0;
		min-width: 0;
		flex: 1;
		justify-content: stretch;
		height: 100%;
	}

	.quick-mode-select {
		width: 108px;
		flex-shrink: 0;
		height: 36px;
		border-right: 1px solid var(--border);
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}

	.quick-dm-select {
		flex: 1;
		max-width: none;
		height: 36px;
		font-size: 0.84rem;
		font-weight: 500;
	}

	.quick-collapse-btn {
		height: 36px;
		min-width: 34px;
		padding: 0;
		border: none;
		border-left: 1px solid var(--border);
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.95rem;
		cursor: pointer;
	}

	.quick-collapse-btn:hover {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		color: var(--text-primary);
	}

	.quick-reopen-floating-btn {
		position: absolute;
		right: 0.45rem;
		bottom: 0.45rem;
		z-index: 4;
		width: 24px;
		height: 24px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-tertiary, var(--bg-secondary));
		color: var(--text-secondary);
		font-size: 0.72rem;
		font-weight: 700;
		cursor: pointer;
	}

	.quick-reopen-floating-btn:hover {
		color: var(--text-primary);
		border-color: var(--accent);
	}

	.quick-body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.quick-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		padding: 0.75rem;
		color: var(--text-tertiary);
		font-size: 0.82rem;
		text-align: center;
	}

	.quick-dm-messages {
		height: calc(100% - 40px);
		overflow-y: auto;
		padding: 0.2rem 0.35rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.quick-dm-message {
		padding: 0.22rem 0.32rem;
		border: none;
		border-radius: 0;
		background: transparent;
	}

	.quick-dm-meta {
		display: flex;
		justify-content: space-between;
		gap: 0.35rem;
		font-size: 0.72rem;
		color: var(--text-tertiary);
		margin-bottom: 0.15rem;
	}

	.quick-dm-author {
		font-weight: 700;
		color: var(--text-secondary);
	}

	.quick-dm-text {
		font-size: 0.8rem;
		color: var(--text-primary);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.quick-dm-compose {
		height: 40px;
		padding: 0;
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0;
		border-top: 1px solid var(--border);
	}

	.quick-dm-compose input {
		min-width: 0;
		border-radius: 0;
		border: none;
		background: transparent;
		color: var(--text-primary);
		padding: 0.3rem 0.55rem;
		font-size: 0.8rem;
	}

	.quick-dm-compose button {
		border-radius: 0;
		border: none;
		border-left: 1px solid var(--border);
		background: transparent;
		color: var(--text-primary);
		padding: 0.3rem 0.7rem;
		font-size: 0.78rem;
		font-weight: 700;
		cursor: pointer;
	}

	.quick-dm-compose button:hover {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
	}

	:global(html[data-clickable-send='true']) .quick-dm-compose .quick-send-btn {
		display: none;
	}

	:global(html[data-clickable-send='true']) .quick-dm-compose:focus-within .quick-send-btn {
		display: inline-flex;
	}

	:global(html[data-clickable-send='false']) .quick-dm-compose .quick-send-btn {
		display: none;
	}

	@media (max-width: 768px) {
		.right-panel-header {
			padding: 0;
		}

		.quick-dm-select {
			max-width: none;
		}
	}
</style>
