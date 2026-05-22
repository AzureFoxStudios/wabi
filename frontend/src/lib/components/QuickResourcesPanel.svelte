<script lang="ts">
	import { onDestroy } from 'svelte';
	import { channels, channelMessages, currentUser, sendMessage, users } from '$lib/socket';
	import type { Channel, Message, User } from '$lib/socket-types';
	import WorkspacePanelHost from './WorkspacePanelHost.svelte';

	export let parentHeight = 600;

	type QuickMode = 'notes' | 'dm';

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
	let quickMessagesElement: HTMLDivElement | null = null;

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

	onDestroy(() => {
		stopQuickResize();
	});

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
		if (channel.type === 'group') return channel.name || 'Group DM';
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

	function startQuickResize(event: MouseEvent): void {
		event.preventDefault();
		isResizingQuick = true;
		quickResizeStartY = event.clientY;
		quickResizeStartHeight = quickPanelHeight;
		window.addEventListener('mousemove', handleQuickResizeMove);
		window.addEventListener('mouseup', stopQuickResize);
	}

	function handleQuickResizeMove(event: MouseEvent): void {
		if (!isResizingQuick) return;
		const delta = quickResizeStartY - event.clientY;
		const maxHeight = Math.floor(parentHeight * QUICK_MAX_RATIO);
		const nextHeight = quickResizeStartHeight + delta;
		if (nextHeight <= QUICK_COLLAPSE_THRESHOLD) {
			quickPanelCollapsed = true;
			return;
		}
		quickPanelCollapsed = false;
		quickPanelHeight = Math.max(QUICK_MIN_HEIGHT, Math.min(maxHeight, nextHeight));
	}

	function stopQuickResize(): void {
		isResizingQuick = false;
		window.removeEventListener('mousemove', handleQuickResizeMove);
		window.removeEventListener('mouseup', stopQuickResize);
	}

	function collapseQuickPanel(): void {
		quickPanelCollapsed = true;
	}

	function expandQuickPanel(): void {
		quickPanelCollapsed = false;
		if (quickPanelHeight < QUICK_MIN_HEIGHT) quickPanelHeight = QUICK_DEFAULT_HEIGHT;
	}
</script>

<div
	class="quick-resources"
	class:is-collapsed={quickPanelCollapsed}
	style={`height: ${quickPanelCollapsed ? QUICK_COLLAPSED_BAR_HEIGHT : quickPanelHeight}px;`}
>
	{#if quickPanelCollapsed}
		<div class="quick-collapsed-bar">
			<div class="quick-mode-toggle" role="tablist" aria-label="Notes and quick DM">
				<button type="button" class:active={quickMode === 'notes'} aria-pressed={quickMode === 'notes'} on:click={() => (quickMode = 'notes')}>Notes</button>
				<button type="button" class:active={quickMode === 'dm'} aria-pressed={quickMode === 'dm'} on:click={() => (quickMode = 'dm')}>DM</button>
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
			on:mousedown={startQuickResize}
			title="Resize bottom panel"
			aria-label="Resize bottom panel"
		></button>

		<div class="quick-header">
			<div class="quick-header-main">
				<div class="quick-mode-toggle" role="tablist" aria-label="Notes and quick DM">
					<button type="button" class:active={quickMode === 'notes'} aria-pressed={quickMode === 'notes'} on:click={() => (quickMode = 'notes')}>Notes</button>
					<button type="button" class:active={quickMode === 'dm'} aria-pressed={quickMode === 'dm'} on:click={() => (quickMode = 'dm')}>DM</button>
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
				<WorkspacePanelHost panel={{ id: 'notes', label: 'Notes', icon: 'notes', component: 'notes', defaultDock: 'bottom', mobileMode: 'sheet', source: 'core' }} />
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

<style>
	.quick-resources {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 86%, transparent);
		background:
			radial-gradient(circle at bottom right, rgba(var(--accent-rgb), 0.12), transparent 38%),
			linear-gradient(180deg, color-mix(in srgb, var(--surface-base) 94%, transparent), color-mix(in srgb, var(--surface-raised) 82%, transparent));
		overflow: hidden;
	}

	:global(.mobile-workspace) .quick-resources {
		display: none;
	}

	.quick-resize-handle {
		height: 8px;
		border: none;
		background: transparent;
		cursor: ns-resize;
		padding: 0;
		flex-shrink: 0;
	}

	.quick-header,
	.quick-collapsed-bar {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.55rem 0.65rem;
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
		border: 1px solid color-mix(in srgb, var(--border-subtle) 86%, transparent);
		background: color-mix(in srgb, var(--surface-base) 86%, transparent);
	}

	.quick-mode-toggle button {
		height: 28px;
		padding: 0 0.7rem;
		border: none;
		border-radius: 999px;
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.72rem;
		font-weight: 700;
		cursor: pointer;
	}

	.quick-mode-toggle button.active {
		background: rgba(var(--accent-rgb), 0.18);
		color: var(--text-heading);
	}

	.quick-dm-select {
		flex: 1;
		min-width: 0;
		height: 32px;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 84%, transparent);
		background: color-mix(in srgb, var(--surface-raised) 90%, transparent);
		color: var(--text-heading);
		padding: 0 0.5rem;
		font-size: 0.76rem;
		font-weight: 650;
	}

	.quick-collapse-btn {
		width: 30px;
		height: 30px;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		border: none;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.quick-collapse-btn:hover {
		border-color: rgba(var(--accent-rgb), 0.32);
		background: rgba(var(--accent-rgb), 0.12);
		color: var(--text-heading);
	}

	.quick-collapse-btn svg {
		width: 16px;
		height: 16px;
	}

	.quick-body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 76%, transparent);
	}

	.quick-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		padding: 0.95rem;
		color: var(--text-muted);
		font-size: 0.8rem;
		text-align: center;
	}

	.quick-dm-shell {
		height: 100%;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.quick-dm-messages {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.quick-dm-message {
		padding: 0.45rem 0.55rem;
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-base) 78%, transparent);
		border: 1px solid color-mix(in srgb, var(--border-subtle) 72%, transparent);
	}

	.quick-dm-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.2rem;
		font-size: 0.68rem;
		color: var(--text-muted);
	}

	.quick-dm-author {
		color: var(--text-heading);
		font-weight: 750;
	}

	.quick-dm-text {
		color: var(--text-secondary);
		font-size: 0.78rem;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.quick-dm-compose {
		display: flex;
		gap: 0.45rem;
		padding: 0.55rem;
		border-top: 1px solid color-mix(in srgb, var(--border-subtle) 76%, transparent);
	}

	.quick-dm-compose input {
		flex: 1;
		min-width: 0;
		height: 34px;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--border-subtle) 82%, transparent);
		background: color-mix(in srgb, var(--surface-app) 90%, transparent);
		color: var(--text-heading);
		padding: 0 0.65rem;
	}

	.quick-send-btn {
		height: 34px;
		border: none;
		border-radius: 8px;
		background: var(--accent-primary);
		color: white;
		font-weight: 800;
		padding: 0 0.7rem;
		cursor: pointer;
	}
</style>
