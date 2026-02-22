<!-- frontend/src/lib/components/MainLayout.svelte -->
<script lang="ts">
	import { fly } from 'svelte/transition';
	import { layoutStore } from '$lib/layoutStore';
	import { get } from 'svelte/store';
	import Chat from '$lib/components/Chat.svelte';
	import ModelViewportTab from '$lib/components/ModelViewportTab.svelte';
	import ChannelQuickTabs from '$lib/components/ChannelQuickTabs.svelte';
	import ChannelSidebar from '$lib/components/ChannelSidebar.svelte';
	import RightPanel from '$lib/components/RightPanel.svelte';
	import CallModal from '$lib/components/CallModal.svelte';
	import AuthErrorBanner from '$lib/components/AuthErrorBanner.svelte';
	import { channelMessages, channelUnreadCounts, channels, currentUser, users, getSocket, leaveVoiceChannel as leaveSocketVoiceChannel, type Channel, type User } from '$lib/socket';
	import { activeCalls, activeVoiceChannel, callConnectionDiagnostics, callMode, callTransportState, connectionState, isVideoOff, toggleVideo } from '$lib/calling';
	import { mobileTabQueue } from '$lib/mobileTabQueue';
	import { onDestroy, onMount } from 'svelte';

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
	let showVoiceDebugDetails = false;
	const { activeTabId } = mobileTabQueue;
	const MODEL_VIEWPORT_TAB_ID = 'model-viewport';
	const MODEL_VIEWPORT_TAB_TOKEN = mobileTabQueue.toAddonTabId(MODEL_VIEWPORT_TAB_ID);
	$: isModelViewportTabActive = $activeTabId === MODEL_VIEWPORT_TAB_TOKEN;

	layoutStore.isResizingChannel.subscribe(v => resizingChannel = v);
	layoutStore.isResizingRight.subscribe(v => resizingRight = v);

	onMount(() => {
		mobileTabQueue.registerAddonTab({
			id: MODEL_VIEWPORT_TAB_ID,
			label: '3D Viewport',
			shortLabel: '3D View'
		});
	});

	onDestroy(() => {
		mobileTabQueue.unregisterAddonTab(MODEL_VIEWPORT_TAB_ID);
	});

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

	async function handleToggleVideoFromStrip() {
		await toggleVideo(getSocket() || undefined);
	}

	function formatDiag(value: number | null, unit = ''): string {
		if (value == null || Number.isNaN(value)) return '--';
		return `${value}${unit}`;
	}

	$: if ($callMode !== 'channel' || !$activeVoiceChannel) {
		showVoiceDebugDetails = false;
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
		<div class="chat-stack">
			<ChannelQuickTabs />
			<div class="chat-surface">
				{#if isModelViewportTabActive}
					<ModelViewportTab />
				{:else}
					<Chat on:logout />
				{/if}
			</div>
		</div>
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

	{#if $layoutStore.isMobile && $callMode === 'channel' && $activeVoiceChannel}
		<div class="voice-channel-strip" role="status" aria-live="polite" transition:fly={{ y: 20, duration: 220 }}>
			<button
				class="voice-status-header"
				type="button"
				on:click={() => (showVoiceDebugDetails = !showVoiceDebugDetails)}
				aria-expanded={showVoiceDebugDetails}
				title="Toggle call diagnostics"
			>
				<span class="status-leading">
					<span class="dot"></span>
					<span class="voice-status-text">
						<strong>Voice Connected</strong>
						<small>{$activeVoiceChannel.name} / {$connectionState}</small>
					</span>
				</span>
				<span class="status-chevron">{showVoiceDebugDetails ? 'v' : '>'}</span>
			</button>

			{#if showVoiceDebugDetails}
				<div class="voice-debug-grid">
					<div class="debug-item"><span>Ping</span><strong>{formatDiag($callConnectionDiagnostics.pingMs, 'ms')}</strong></div>
					<div class="debug-item"><span>Jitter</span><strong>{formatDiag($callConnectionDiagnostics.jitterMs, 'ms')}</strong></div>
					<div class="debug-item"><span>Inbound Loss</span><strong>{formatDiag($callConnectionDiagnostics.inboundPacketLossPct, '%')}</strong></div>
					<div class="debug-item"><span>Outbound Loss</span><strong>{formatDiag($callConnectionDiagnostics.outboundPacketLossPct, '%')}</strong></div>
					<div class="debug-item"><span>Inbound Rate</span><strong>{formatDiag($callConnectionDiagnostics.inboundKbps, 'kbps')}</strong></div>
					<div class="debug-item"><span>Outbound Rate</span><strong>{formatDiag($callConnectionDiagnostics.outboundKbps, 'kbps')}</strong></div>
					<div class="debug-item"><span>Transport</span><strong>{$callTransportState.activeTransport.toUpperCase()}</strong></div>
					<div class="debug-item"><span>Participants</span><strong>{1 + $activeCalls.length}</strong></div>
				</div>
			{/if}

			<div class="voice-channel-meta">
				<span class="voice-channel-name-label">In voice:</span>
				<strong>{$activeVoiceChannel.name}</strong>
			</div>
			<div class="voice-channel-actions">
				<button class:active={!$isVideoOff} on:click={handleToggleVideoFromStrip} title={$isVideoOff ? 'Turn on camera' : 'Turn off camera'} aria-label={$isVideoOff ? 'Turn on camera' : 'Turn off camera'}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<path d="M23 7l-7 5 7 5V7z"></path>
						<rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
					</svg>
				</button>
				<button class="leave icon-only" on:click={handleLeaveVoiceChannel} title="Leave voice" aria-label="Leave voice">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
						<path d="M14 3h7v18h-7"></path>
						<path d="M10 17l5-5-5-5"></path>
						<path d="M15 12H3"></path>
					</svg>
				</button>
			</div>
		</div>
	{/if}

</div>
<CallModal />

<style>
	:global(body) {
		overflow: hidden;
	}

	:global(:root) {
		--dm-rail-top: calc(env(safe-area-inset-top, 0px) + 86px);
		--mobile-nav-height: calc(56px + env(safe-area-inset-bottom, 0px));
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
		min-height: 0;
	}

	.chat-stack {
		height: 100%;
		width: 100%;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.chat-surface {
		flex: 1;
		min-height: 0;
	}
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
		right: 0;
		top: var(--dm-rail-top);
		max-height: calc(100% - var(--dm-rail-top) - 84px);
		overflow-y: auto;
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
		border-right: none;
		border-radius: 12px 0 0 12px;
		background: var(--bg-secondary);
		cursor: pointer;
		overflow: hidden;
		animation: stub-slide-in 0.22s ease both;
	}

	.dm-notification-stub:hover {
		transform: translateX(-4px);
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
			height: calc(100vh - var(--mobile-nav-height));
			height: calc(100dvh - var(--mobile-nav-height));
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
			height: calc(100vh - var(--mobile-nav-height));
			height: calc(100dvh - var(--mobile-nav-height));
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
			height: calc(100vh - var(--mobile-nav-height));
			height: calc(100dvh - var(--mobile-nav-height));
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
			height: var(--mobile-nav-height);
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

	@media (max-width: 1280px) {
		:global(:root) {
			--dm-rail-top: calc(env(safe-area-inset-top, 0px) + 96px);
		}
	}

	.voice-channel-strip {
		position: absolute;
		left: 16px;
		bottom: 12px;
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		padding: 0.7rem;
		border-radius: 12px;
		min-width: 340px;
		background: rgba(0, 0, 0, 0.72);
		border: 1px solid rgba(var(--border-rgb), var(--opacity-medium));
		z-index: var(--z-toast);
		backdrop-filter: blur(8px);
	}

	.voice-status-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		background: transparent;
		border: none;
		color: var(--text-primary);
		padding: 0;
		cursor: pointer;
	}

	.status-leading {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.voice-status-text {
		display: inline-flex;
		flex-direction: column;
		line-height: 1.15;
		text-align: left;
	}

	.voice-status-text small {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.status-chevron {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.voice-debug-grid {
		width: 100%;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.45rem 0.7rem;
		padding: 0.5rem 0.55rem;
		border-radius: 9px;
		background: rgba(255, 255, 255, 0.06);
	}

	.debug-item {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-size: 0.72rem;
	}

	.debug-item span {
		color: var(--text-secondary);
	}

	.debug-item strong {
		color: var(--text-primary);
		font-size: 0.74rem;
	}

	.voice-channel-meta {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--text-primary);
		font-size: 0.85rem;
		width: 100%;
	}

	.voice-channel-name-label {
		color: var(--text-secondary);
		font-size: 0.8rem;
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
		width: 100%;
		flex-wrap: wrap;
	}

	.voice-channel-actions button {
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.18);
		color: var(--text-primary);
		border-radius: 999px;
		padding: 0.25rem 0.55rem;
		font-size: 0.75rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		flex: 1 1 auto;
	}

	.voice-channel-actions button svg {
		width: 14px;
		height: 14px;
		display: block;
	}

	.voice-channel-actions button.active {
		background: rgba(var(--accent-rgb), 0.32);
	}

	.voice-channel-actions button.leave {
		background: rgba(239, 68, 68, 0.2);
		border-color: rgba(239, 68, 68, 0.5);
		flex: 0 0 auto;
	}

	@media (max-width: 768px) {
		.voice-channel-strip {
			left: 8px;
			right: 8px;
			bottom: calc(var(--mobile-nav-height) + 8px);
			min-width: 0;
			width: auto;
			max-height: min(58dvh, 420px);
			overflow-y: auto;
			padding: 0.6rem;
			gap: 0.55rem;
		}

		.voice-debug-grid {
			grid-template-columns: 1fr;
		}

		.voice-channel-actions button {
			flex: 1 1 calc(50% - 0.2rem);
			min-height: 40px;
		}

		.voice-channel-actions button.leave {
			flex: 1 1 100%;
		}

	}

</style>
