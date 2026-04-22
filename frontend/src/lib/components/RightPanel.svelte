<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { channels, channelMessages, currentUser, sendMessage, users } from '$lib/socket';
	import type { Channel, Message, User } from '$lib/socket-types';
	import { layoutStore } from '$lib/layoutStore';
	import UserListTab from './UserListTab.svelte';
	import DMTab from './DMTab.svelte';
	import AdminTab from './AdminTab.svelte';
	import MediaAlbumsTab from './MediaAlbumsTab.svelte';
	import QuickScratchpad from './QuickScratchpad.svelte';
	import MapWorkspace from './MapWorkspace.svelte';

	type PanelView = 'users' | 'dms' | 'media' | 'admin' | 'map';
	type QuickMode = 'notes' | 'dm';

	interface PanelOption {
		id: PanelView;
		label: string;
	}

	const dispatch = createEventDispatcher<{
		openSettings: { paymentSurface: 'connections' };
	}>();

	const QUICK_MIN_HEIGHT = 150;
	const QUICK_DEFAULT_HEIGHT = 240;
	const QUICK_MAX_RATIO = 0.56;
	const QUICK_COLLAPSED_BAR_HEIGHT = 44;
	const QUICK_COLLAPSE_THRESHOLD = 118;

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
	$: canAccessAdminTab =
		$currentUser?.highestRole === 'owner' ||
		$currentUser?.highestRole === 'admin' ||
		$currentUser?.highestRole === 'mod';
	$: if (!canAccessAdminTab && activeTab === 'admin') {
		layoutStore.showUsersTab();
	}

	$: panelOptions = [
		{ id: 'users', label: 'People' },
		{ id: 'dms', label: 'Messages' },
		{ id: 'map', label: 'Map' },
		{ id: 'media', label: 'Media' },
		{ id: 'admin', label: 'Admin' }
	].filter((option) => option.id !== 'admin' || canAccessAdminTab) as PanelOption[];
	$: activePanel = panelOptions.find((option) => option.id === activeTab) || panelOptions[0];

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
	$: quickConversationTitle = quickDmChannel ? getDmLabel(quickDmChannel) : 'Quick DM';

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
		<div class="panel-tabs" role="tablist" aria-label="Right panel views">
			{#each panelOptions as option}
				<button
					type="button"
					class="panel-tab"
					class:active={activeTab === option.id}
					on:click={() => switchTopView(option.id)}
					title={option.label}
					aria-label={option.label}
				>
					<span class="panel-tab-icon" aria-hidden="true">
						{#if option.id === 'users'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"></path>
								<circle cx="9" cy="7" r="4"></circle>
								<path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
								<path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
							</svg>
						{:else if option.id === 'dms'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-2.92-.39-4.15-1.08L3 20l1.15-4.77A8.5 8.5 0 1 1 21 11.5z"></path>
							</svg>
						{:else if option.id === 'map'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"></path>
								<path d="M9 4v14"></path>
								<path d="M15 6v14"></path>
							</svg>
						{:else if option.id === 'media'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<rect x="3" y="3" width="18" height="18" rx="2"></rect>
								<circle cx="8.5" cy="8.5" r="1.5"></circle>
								<path d="M21 15l-5-5L5 21"></path>
							</svg>
						{:else}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<circle cx="12" cy="12" r="3"></circle>
								<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
							</svg>
						{/if}
					</span>
				</button>
			{/each}
		</div>
		<div class="panel-active-label">{activePanel.label}</div>
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

	<div
		class="quick-resources"
		class:is-collapsed={quickPanelCollapsed}
		style={`height: ${quickPanelCollapsed ? QUICK_COLLAPSED_BAR_HEIGHT : quickPanelHeight}px;`}
	>
		{#if quickPanelCollapsed}
			<div class="quick-collapsed-bar">
				<div class="quick-mode-toggle" role="tablist" aria-label="Notes and quick DM">
					<button
						type="button"
						class:active={quickMode === 'notes'}
						aria-pressed={quickMode === 'notes'}
						on:click={() => (quickMode = 'notes')}
					>
						Notes
					</button>
					<button
						type="button"
						class:active={quickMode === 'dm'}
						aria-pressed={quickMode === 'dm'}
						on:click={() => (quickMode = 'dm')}
					>
						DM
					</button>
				</div>
				<button class="quick-collapse-btn" type="button" title="Expand bottom panel" on:click={expandQuickPanel}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="18 15 12 9 6 15"></polyline>
					</svg>
				</button>
			</div>
		{:else}
			<button
				class="quick-resize-handle"
				type="button"
				on:mousedown={handleQuickResizeStart}
				title="Resize bottom panel"
				aria-label="Resize bottom panel"
			></button>

			<div class="quick-header">
				<div class="quick-header-main">
					<div class="quick-mode-toggle" role="tablist" aria-label="Notes and quick DM">
						<button
							type="button"
							class:active={quickMode === 'notes'}
							aria-pressed={quickMode === 'notes'}
							on:click={() => (quickMode = 'notes')}
						>
							Notes
						</button>
						<button
							type="button"
							class:active={quickMode === 'dm'}
							aria-pressed={quickMode === 'dm'}
							on:click={() => (quickMode = 'dm')}
						>
							DM
						</button>
					</div>

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

				<button class="quick-collapse-btn" type="button" title="Collapse bottom panel" on:click={collapseQuickPanel}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="6 9 12 15 18 9"></polyline>
					</svg>
				</button>
			</div>

			<div class="quick-body">
				{#if quickMode === 'notes'}
					<QuickScratchpad />
				{:else if !quickDmChannelId}
					<div class="quick-empty">Open a DM or group thread to use quick replies here.</div>
				{:else}
					<div class="quick-dm-shell">
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
								placeholder={`Message ${quickConversationTitle}...`}
							/>
							<button class="quick-send-btn" type="button" on:click={sendQuickMessage}>Send</button>
						</div>
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
		min-height: 0;
		background:
			radial-gradient(circle at top right, color-mix(in srgb, var(--accent) 8%, transparent), transparent 34%),
			linear-gradient(180deg, color-mix(in srgb, var(--bg-secondary) 96%, transparent), var(--bg-primary));
	}

	.right-panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.7rem;
		padding: 0.55rem 0.7rem;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 86%, transparent);
		background: color-mix(in srgb, var(--bg-secondary) 94%, transparent);
	}

	.panel-tabs {
		display: flex;
		align-items: center;
		gap: 0.32rem;
		min-width: 0;
	}

	.panel-tab {
		width: 36px;
		height: 36px;
		border-radius: 12px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-secondary);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition:
			background 0.16s ease,
			border-color 0.16s ease,
			color 0.16s ease,
			transform 0.16s ease;
	}

	.panel-tab:hover {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		border-color: color-mix(in srgb, var(--accent) 18%, transparent);
		color: var(--text-primary);
		transform: translateY(-1px);
	}

	.panel-tab.active {
		background: color-mix(in srgb, var(--accent) 16%, var(--bg-tertiary) 84%);
		border-color: color-mix(in srgb, var(--accent) 32%, transparent);
		color: var(--text-primary);
	}

	.panel-tab-icon {
		width: 18px;
		height: 18px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.panel-tab-icon svg {
		width: 18px;
		height: 18px;
		display: block;
	}

	.panel-active-label {
		flex-shrink: 0;
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-tertiary);
	}

	.right-panel-content {
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
		overflow: hidden;
	}

	.quick-resources {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-top: 1px solid color-mix(in srgb, var(--border) 86%, transparent);
		background:
			radial-gradient(circle at bottom right, color-mix(in srgb, var(--accent) 7%, transparent), transparent 38%),
			color-mix(in srgb, var(--bg-secondary) 96%, transparent);
		overflow: hidden;
	}

	.quick-resize-handle {
		height: 8px;
		border: none;
		border-top: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
		border-bottom: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
		background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 22%, transparent), transparent);
		cursor: ns-resize;
		padding: 0;
		flex-shrink: 0;
	}

	.quick-header,
	.quick-collapsed-bar {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.65rem 0.7rem;
	}

	.quick-header {
		justify-content: space-between;
	}

	.quick-collapsed-bar {
		justify-content: space-between;
		height: 100%;
	}

	.quick-header-main {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		min-width: 0;
		flex: 1;
	}

	.quick-mode-toggle {
		display: inline-flex;
		align-items: center;
		padding: 0.16rem;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--border) 86%, transparent);
		background: color-mix(in srgb, var(--bg-tertiary) 86%, transparent);
	}

	.quick-mode-toggle button {
		height: 28px;
		padding: 0 0.72rem;
		border: none;
		border-radius: 999px;
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.72rem;
		font-weight: 700;
		cursor: pointer;
		transition:
			background 0.16s ease,
			color 0.16s ease;
	}

	.quick-mode-toggle button.active {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		color: var(--text-primary);
	}

	.quick-dm-select {
		flex: 1;
		min-width: 0;
		height: 34px;
		border-radius: 10px;
		border: 1px solid color-mix(in srgb, var(--border) 84%, transparent);
		background: color-mix(in srgb, var(--bg-tertiary) 90%, transparent);
		color: var(--text-primary);
		padding: 0 0.75rem;
		font-size: 0.79rem;
		font-weight: 600;
	}

	.quick-collapse-btn {
		width: 24px;
		height: 24px;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		margin-left: auto;
		padding: 0;
		border-radius: 999px;
		border: none;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		appearance: none;
		-webkit-appearance: none;
		transition:
			background 0.16s ease,
			color 0.16s ease;
	}

	.quick-collapse-btn:hover {
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--text-primary);
	}

	.quick-collapse-btn svg {
		width: 16px;
		height: 16px;
		display: block;
	}

	.quick-body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		border-top: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
	}

	.quick-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		padding: 0.95rem;
		color: var(--text-tertiary);
		font-size: 0.8rem;
		text-align: center;
	}

	.quick-dm-shell {
		height: 100%;
		display: grid;
		grid-template-rows: minmax(0, 1fr) auto;
	}

	.quick-dm-messages {
		min-height: 0;
		overflow-y: auto;
		padding: 0.65rem 0.7rem 0.35rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.quick-dm-message {
		padding: 0.52rem 0.6rem;
		border-radius: 12px;
		background: color-mix(in srgb, var(--bg-tertiary) 74%, transparent);
		border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
	}

	.quick-dm-meta {
		display: flex;
		justify-content: space-between;
		gap: 0.35rem;
		font-size: 0.7rem;
		color: var(--text-tertiary);
		margin-bottom: 0.2rem;
	}

	.quick-dm-author {
		font-weight: 700;
		color: var(--text-secondary);
	}

	.quick-dm-text {
		font-size: 0.8rem;
		color: var(--text-primary);
		line-height: 1.45;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.quick-dm-compose {
		padding: 0.7rem;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.55rem;
		border-top: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
		background: color-mix(in srgb, var(--bg-secondary) 94%, transparent);
	}

	.quick-dm-compose input {
		min-width: 0;
		height: 38px;
		border-radius: 10px;
		border: 1px solid color-mix(in srgb, var(--border) 86%, transparent);
		background: color-mix(in srgb, var(--bg-tertiary) 90%, transparent);
		color: var(--text-primary);
		padding: 0 0.8rem;
		font-size: 0.8rem;
	}

	.quick-send-btn {
		height: 38px;
		padding: 0 0.95rem;
		border-radius: 10px;
		border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
		background: color-mix(in srgb, var(--accent) 16%, transparent);
		color: var(--text-primary);
		font-size: 0.78rem;
		font-weight: 700;
		cursor: pointer;
	}

	.quick-send-btn:hover {
		background: color-mix(in srgb, var(--accent) 22%, transparent);
	}

	:global(html[data-clickable-send='true']) .quick-dm-compose .quick-send-btn {
		display: none;
	}

	:global(html[data-clickable-send='true']) .quick-dm-compose:focus-within .quick-send-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	:global(html[data-clickable-send='false']) .quick-dm-compose .quick-send-btn {
		display: none;
	}

	@media (max-width: 768px) {
		.right-panel-header {
			padding: 0.5rem 0.6rem;
		}

		.panel-tab {
			width: 34px;
			height: 34px;
			border-radius: 11px;
		}

		.panel-active-label {
			display: none;
		}

		.quick-header {
			padding: 0.6rem;
		}

		.quick-header-main {
			gap: 0.45rem;
		}

		.quick-collapsed-bar {
			padding: 0.5rem 0.6rem;
		}
	}
</style>
