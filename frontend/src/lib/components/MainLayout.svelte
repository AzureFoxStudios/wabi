<!-- frontend/src/lib/components/MainLayout.svelte -->
<script lang="ts">
	import { layoutStore } from '$lib/layoutStore';
	import { get } from 'svelte/store';
	import Chat from '$lib/components/Chat.svelte';
	import ScreenShareViewer from '$lib/components/ScreenShareViewer.svelte';
	import ChannelSidebar from '$lib/components/ChannelSidebar.svelte';
	import RightPanel from '$lib/components/RightPanel.svelte';
	import CallModal from '$lib/components/CallModal.svelte';
	import AuthErrorBanner from '$lib/components/AuthErrorBanner.svelte';
	import { channelMessages, channelUnreadCounts, channels, currentUser, users, leaveVoiceChannel as leaveSocketVoiceChannel, type Channel, type User } from '$lib/socket';
	import { activeVoiceChannel, callMode, voiceChannelNotice, isMuted, isDeafened, toggleMute, toggleDeafen } from '$lib/calling';

	export let activeView: 'chat' | 'screen' = 'chat';

	$: mobileRightVisible = $layoutStore.isMobile && $layoutStore.rightPanelView !== 'none';
	$: showDesktopNotificationRail = !$layoutStore.isMobile && !$layoutStore.showRightPanel;
	$: totalUnreadDMs = Object.entries($channelUnreadCounts)
		.filter(([channelId, count]) => channelId.startsWith('dm-') && count > 0)
		.reduce((sum, [, count]) => sum + count, 0);
	$: unreadDMChannels = $channels
		.filter(channel => {
			if (channel.type !== 'dm' && channel.type !== 'group') return false;
			return ($channelUnreadCounts[channel.id] || 0) > 0;
		})
		.sort((a, b) => getLastMessageTimestamp(b.id) - getLastMessageTimestamp(a.id))
		.slice(0, 6);

	let resizingChannel = false;
	let resizingRight = false;

	layoutStore.isResizingChannel.subscribe(v => resizingChannel = v);
	layoutStore.isResizingRight.subscribe(v => resizingRight = v);

	function handleMouseMove(e: MouseEvent) {
		if (resizingChannel) {
			layoutStore.channelSidebarWidth.set(Math.max(0, Math.min(e.clientX, 400)));
		}
		if (resizingRight) {
			const rightEdge = window.innerWidth;
			const newWidth = Math.max(0, Math.min(rightEdge - e.clientX, 500));
			layoutStore.rightPanelWidth.set(newWidth);
		}
	}

	function stopResize() {
		if (resizingChannel) {
			const w = get(layoutStore.channelSidebarWidth);
			if (w < 30) layoutStore.channelSidebarWidth.set(0);
			else if (w < 170) layoutStore.channelSidebarWidth.set(60);
			else layoutStore.channelSidebarWidth.set(280);
		}
		if (resizingRight) {
			const w = get(layoutStore.rightPanelWidth);
			if (w < 30) {
				layoutStore.rightPanelWidth.set(0);
				layoutStore.rightPanelView.set('none');
			} else if (w < 200) {
				layoutStore.rightPanelWidth.set(250);
			}
		}
		layoutStore.isResizingChannel.set(false);
		layoutStore.isResizingRight.set(false);
	}

	function getLastMessageTimestamp(channelId: string): number {
		const messages = $channelMessages[channelId] || [];
		return messages.length > 0 ? messages[messages.length - 1].timestamp : 0;
	}

	function getChannelOtherUser(channel: Channel): User | null {
		if (channel.otherUser) return channel.otherUser;
		const myStableId = $currentUser?.dbUserId ? `user-${$currentUser.dbUserId}` : $currentUser?.id;
		const otherStableId = (channel.members || []).find((id: string) => id !== myStableId);
		if (!otherStableId) return null;
		if (otherStableId.startsWith('user-')) {
			const dbId = parseInt(otherStableId.substring(5), 10);
			return $users.find(u => u.dbUserId === dbId) || null;
		}
		return $users.find(u => u.id === otherStableId) || null;
	}

	function openUnreadDM(channel: Channel) {
		if (channel.type === 'group') {
			layoutStore.openGroupDM(channel.id, channel);
			return;
		}
		const other = getChannelOtherUser(channel);
		if (other) {
			layoutStore.openDM(channel.id, other);
		}
	}

	function formatUnreadBadge(count: number): string {
		if (count > 99) return '99+';
		return `${count}`;
	}

	function handleLeaveVoiceChannel() {
		const channel = get(activeVoiceChannel);
		if (!channel) return;
		void leaveSocketVoiceChannel(channel.id);
	}
</script>

<svelte:window on:mousemove={handleMouseMove} on:mouseup={stopResize} />

<AuthErrorBanner />

{#if $layoutStore.isMobile && !$layoutStore.isInCall}
	<!-- Mobile Bottom Navigation Bar -->
	<nav class="mobile-bottom-nav">
		<button class:active={!$layoutStore.showMobileChannels && $layoutStore.rightPanelView === 'none'} on:click={() => { layoutStore.showMobileChannels.set(false); layoutStore.rightPanelView.set('none'); }}>
			<svg width="24" height="24" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
			<span>Chat</span>
		</button>
		<button class:active={$layoutStore.showMobileChannels} on:click={layoutStore.toggleMobileChannels}>
			<svg width="24" height="24" viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
			<span>Channels</span>
		</button>
		<button class:active={$layoutStore.rightPanelView !== 'none'} on:click={layoutStore.toggleMobileUsers}>
			<svg width="24" height="24" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
			<span>Users</span>
		</button>
		<a href="/business" class="nav-link">
			<svg width="24" height="24" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
			<span>Hub</span>
		</a>
	</nav>
{/if}

<div class="app-container" class:resizing={$layoutStore.isResizing} class:in-call={$layoutStore.isMobile && $layoutStore.isInCall}>
	<!-- Channel Sidebar (Left) -->
	<div
		class="channel-sidebar-container"
		style:width="{$layoutStore.channelSidebarWidth}px"
		class:mobile-visible={$layoutStore.showMobileChannels}
	>
		<ChannelSidebar on:close={() => layoutStore.showMobileChannels.set(false)} bind:activeView on:logout />
		<!-- Channel resize handle -->
		<div
			class="resize-handle resize-handle-channel"
			on:mousedown|preventDefault={() => layoutStore.isResizingChannel.set(true)}
		></div>
	</div>

	<!-- Mobile Right Panel Overlay -->
	{#if mobileRightVisible}
		<div class="mobile-right-overlay">
			<RightPanel />
		</div>
	{/if}

	<!-- Main Content -->
	<div class="main-content">
		<div class:hidden={activeView !== 'chat'}><Chat on:logout /></div>
		<div class:hidden={activeView !== 'screen'}><ScreenShareViewer bind:activeView /></div>
	</div>

	<!-- Desktop Right Panel -->
	{#if $layoutStore.showRightPanel}
		<div
			class="right-panel-container"
			style:width="{$layoutStore.rightPanelWidth}px"
		>
			<!-- Right panel resize handle -->
			<div
				class="resize-handle resize-handle-right"
				on:mousedown|preventDefault={() => layoutStore.isResizingRight.set(true)}
			></div>
			<RightPanel />
		</div>
	{/if}

	<!-- Desktop toggle button (visible when panel is closed) -->
	{#if !$layoutStore.isMobile && !$layoutStore.showRightPanel}
		<button
			class="user-panel-toggle"
			class:has-unread={totalUnreadDMs > 0}
			data-unread={totalUnreadDMs > 99 ? '99+' : totalUnreadDMs}
			on:click={layoutStore.toggleRightPanel}
			title="Open side panel"
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<polyline points="15 18 9 12 15 6"/>
			</svg>
		</button>

		{#if showDesktopNotificationRail && unreadDMChannels.length > 0}
			<div class="dm-notification-rail" aria-label="Unread direct messages">
				{#each unreadDMChannels as channel, index (channel.id)}
					<button
						class="dm-notification-stub"
						style={`animation-delay: ${index * 0.04}s`}
						on:click={() => openUnreadDM(channel)}
						title={channel.type === 'group' ? `Open ${channel.name}` : `Open DM with ${getChannelOtherUser(channel)?.username || 'user'}`}
					>
						{#if channel.type === 'group'}
							{#if channel.avatar}
								<img src={channel.avatar} alt={channel.name} class="dm-stub-avatar" />
							{:else}
								<div class="dm-stub-avatar dm-stub-fallback">{channel.name.charAt(0).toUpperCase()}</div>
							{/if}
						{:else}
							{@const other = getChannelOtherUser(channel)}
							{#if other?.profilePicture}
								<img src={other.profilePicture} alt={other.username} class="dm-stub-avatar" />
							{:else}
								<div class="dm-stub-avatar dm-stub-fallback" style="background-color: {other?.roleColor || other?.color || 'var(--text-secondary)'}">
									{other?.username?.charAt(0).toUpperCase() || '?'}
								</div>
							{/if}
						{/if}
						<span class="dm-stub-count">{formatUnreadBadge($channelUnreadCounts[channel.id] || 0)}</span>
					</button>
				{/each}
			</div>
		{/if}
	{/if}

	{#if $callMode === 'channel' && $activeVoiceChannel}
		<div class="voice-channel-strip" role="status" aria-live="polite">
			<div class="voice-channel-meta">
				<span class="dot"></span>
				<span>In voice: <strong>{$activeVoiceChannel.name}</strong></span>
			</div>
			<div class="voice-channel-actions">
				<button class:active={$isMuted} on:click={toggleMute} title={$isMuted ? 'Unmute' : 'Mute'}>{$isMuted ? 'Unmute' : 'Mute'}</button>
				<button class:active={$isDeafened} on:click={toggleDeafen} title={$isDeafened ? 'Undeafen' : 'Deafen'}>{$isDeafened ? 'Undeafen' : 'Deafen'}</button>
				<button class="leave" on:click={handleLeaveVoiceChannel}>Leave</button>
			</div>
		</div>
	{/if}

	{#if $voiceChannelNotice}
		<div class="voice-toast" role="status">{$voiceChannelNotice.text}</div>
	{/if}
</div>
<CallModal />

<style>
	:global(body) {
		overflow: hidden;
	}
	.app-container {
		display: flex;
		height: 100vh;
		height: 100dvh;
		overflow: hidden;
		position: relative;
	}

	.app-container.in-call {
		height: 100vh;
		height: 100dvh;
	}

	.app-container.resizing {
		cursor: col-resize;
		user-select: none;
	}

	.main-content {
		flex: 1;
		min-width: 0;
		position: relative;
	}

	.main-content > div { height: 100%; width: 100%; }
	.hidden { display: none !important; }

	.channel-sidebar-container {
		flex-shrink: 0;
		position: relative;
		border-right: 1px solid rgba(var(--border-rgb), var(--opacity-light));
	}

	/* Hide border when sidebar is collapsed */
	.channel-sidebar-container[style*="width: 0px"],
	.channel-sidebar-container[style*="width:0px"] {
		border-right: none;
	}

	/* Desktop Right Panel */
	.right-panel-container {
		flex-shrink: 0;
		position: relative;
		height: 100vh;
		height: 100dvh;
		background: var(--bg-secondary);
		border-left: 1px solid rgba(var(--border-rgb), var(--opacity-light));
	}

	/* Resize handles */
	.resize-handle {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: col-resize;
		z-index: var(--z-sticky);
		transition: background 0.2s;
	}
	.resize-handle:hover { background: var(--accent); opacity: 0.5; }
	.resize-handle-channel { right: -3px; }
	.resize-handle-right { left: -3px; }

	/* Toggle button on right edge */
	.user-panel-toggle {
		position: absolute;
		top: 50%;
		right: 0;
		transform: translateY(-50%);
		width: 24px;
		height: 64px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-right: none;
		border-radius: var(--radius-md) 0 0 var(--radius-md);
		cursor: pointer;
		color: var(--text-secondary);
		transition: all 0.2s ease;
		z-index: var(--z-sticky);
		opacity: 0.3;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.user-panel-toggle.has-unread::after {
		content: attr(data-unread);
		position: absolute;
		top: 6px;
		left: 4px;
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		border-radius: 999px;
		background: #ef4444;
		color: #fff;
		font-size: 0.68rem;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		line-height: 1;
	}

	.dm-notification-rail {
		position: absolute;
		right: 32px;
		top: 16px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		z-index: var(--z-sticky);
		opacity: 0;
		transform: translateX(22px);
		pointer-events: none;
		transition: opacity 0.2s ease, transform 0.2s ease;
	}

	.app-container:hover .dm-notification-rail,
	.dm-notification-rail:hover {
		opacity: 1;
		transform: translateX(0);
		pointer-events: auto;
	}

	.dm-notification-stub {
		position: relative;
		width: 40px;
		height: 40px;
		padding: 0;
		border: 1px solid rgba(var(--border-rgb), var(--opacity-light));
		border-radius: 12px;
		background: rgba(var(--bg-secondary-rgb), 0.85);
		backdrop-filter: blur(8px);
		cursor: pointer;
		overflow: hidden;
		animation: stub-slide-in 0.22s ease both;
	}

	.dm-notification-stub:hover {
		transform: translateX(-3px);
		border-color: var(--accent);
	}

	.dm-stub-avatar {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.dm-stub-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		color: #fff;
		background: var(--text-secondary);
	}

	.dm-stub-count {
		position: absolute;
		top: -4px;
		right: -4px;
		min-width: 18px;
		height: 18px;
		padding: 0 4px;
		border-radius: 999px;
		background: #ef4444;
		color: #fff;
		font-size: 0.65rem;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 2px solid var(--bg-primary);
	}

	@keyframes stub-slide-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	.user-panel-toggle:hover {
		opacity: 1;
		background: var(--accent);
		color: white;
	}

	/* --- Mobile Styles --- */
	.mobile-bottom-nav { display: none; }
	.mobile-right-overlay { display: none; }

	@media (max-width: 768px) {
		.app-container {
			height: calc(100vh - 56px);
			height: calc(100dvh - 56px);
		}
		.app-container.in-call {
			height: 100vh;
			height: 100dvh;
		}
		.user-panel-toggle, .resize-handle { display: none; }
		.dm-notification-rail { display: none; }

		.channel-sidebar-container,
		.right-panel-container {
			display: none;
			position: fixed;
			top: 0;
			left: 0;
			width: 100% !important;
			height: calc(100vh - 56px);
			height: calc(100dvh - 56px);
			z-index: var(--z-modal);
			background: var(--bg-primary);
		}

		.channel-sidebar-container.mobile-visible {
			display: block;
		}

		.mobile-right-overlay {
			display: flex;
			flex-direction: column;
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: calc(100vh - 56px);
			height: calc(100dvh - 56px);
			z-index: var(--z-modal);
			background: var(--bg-primary);
		}

		.mobile-bottom-nav {
			display: flex;
			justify-content: space-around;
			align-items: center;
			position: fixed;
			bottom: 0;
			left: 0;
			right: 0;
			height: 56px;
			background: var(--bg-tertiary);
			border-top: 1px solid var(--border);
			z-index: var(--z-toast);
			padding: 0;
			padding-bottom: env(safe-area-inset-bottom, 0);
		}
		.mobile-bottom-nav button, .mobile-bottom-nav .nav-link {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 0.125rem;
			background: transparent;
			border: none;
			color: var(--text-secondary);
			font-size: 0.65rem;
			padding: 0.375rem 0.5rem;
			text-decoration: none;
			transition: color 0.15s;
		}
		.mobile-bottom-nav button:hover, .mobile-bottom-nav .nav-link:hover { color: var(--text-primary); }
		.mobile-bottom-nav button.active { color: var(--accent); }
		.mobile-bottom-nav svg { width: 20px; height: 20px; stroke: currentColor; fill: none; stroke-width: 2; }
	}

	.voice-channel-strip {
		position: absolute;
		left: 50%;
		bottom: 12px;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0.75rem;
		border-radius: 999px;
		background: rgba(0, 0, 0, 0.6);
		border: 1px solid rgba(var(--border-rgb), var(--opacity-medium));
		z-index: var(--z-toast);
		backdrop-filter: blur(8px);
	}

	.voice-channel-meta {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-primary);
		font-size: 0.85rem;
	}

	.voice-channel-meta .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #22c55e;
		box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.2);
	}

	.voice-channel-actions {
		display: flex;
		gap: 0.4rem;
	}

	.voice-channel-actions button {
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.18);
		color: var(--text-primary);
		border-radius: 999px;
		padding: 0.25rem 0.55rem;
		font-size: 0.75rem;
	}

	.voice-channel-actions button.active {
		background: rgba(var(--accent-rgb), 0.32);
	}

	.voice-channel-actions button.leave {
		background: rgba(239, 68, 68, 0.2);
		border-color: rgba(239, 68, 68, 0.5);
	}

	.voice-toast {
		position: absolute;
		right: 16px;
		bottom: 16px;
		padding: 0.5rem 0.7rem;
		border-radius: 8px;
		background: rgba(0, 0, 0, 0.72);
		color: var(--text-primary);
		font-size: 0.8rem;
		z-index: var(--z-toast);
	}

</style>
