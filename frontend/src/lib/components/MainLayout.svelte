<!-- frontend/src/lib/components/MainLayout.svelte -->
<script lang="ts">
	import { layoutStore } from '$lib/layoutStore';
	import Chat from '$lib/components/Chat.svelte';
	import ScreenShareViewer from '$lib/components/ScreenShareViewer.svelte';
	import ChannelSidebar from '$lib/components/ChannelSidebar.svelte';
	import CallModal from '$lib/components/CallModal.svelte';
	import AuthErrorBanner from '$lib/components/AuthErrorBanner.svelte';
	import { users, currentUser, socket, createDM } from '$lib/socket';
	import { startCall, startScreenShare } from '$lib/calling';
	import type { User } from '$lib/socket';

	export let activeView: 'chat' | 'screen' = 'chat';

	$: mobileUsersVisible = $layoutStore.isMobile && ($layoutStore.rightPanelView === 'dm-list' || $layoutStore.rightPanelView === 'dm');

	function closeMobileUsers() {
		layoutStore.rightPanelView.set('none');
	}

	async function handleVoiceCall(user: User) {
		if (!$socket || user.id === $currentUser?.id) return;
		try { await startCall($socket, user.id, false); } catch { alert('Failed to start voice call.'); }
	}

	async function handleVideoCall(user: User) {
		if (!$socket || user.id === $currentUser?.id) return;
		try { await startCall($socket, user.id, true); } catch { alert('Failed to start video call.'); }
	}

	function handleDM(user: User) {
		if (user.id === $currentUser?.id) return;
		createDM(user.id);
		closeMobileUsers();
	}

	let isResizingChannel = false;

	layoutStore.isResizingChannel.subscribe(v => isResizingChannel = v);

	function handleMouseMove(e: MouseEvent) {
		if (isResizingChannel) {
			layoutStore.channelSidebarWidth.set(Math.max(180, Math.min(e.clientX, 400)));
		}
	}

	function stopResize() {
		layoutStore.isResizingChannel.set(false);
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
		<button class:active={$layoutStore.rightPanelView === 'dm-list' || $layoutStore.rightPanelView === 'dm'} on:click={layoutStore.toggleMobileUsers}>
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
	</div>

	<!-- Mobile User List Overlay -->
	{#if mobileUsersVisible}
		<div class="mobile-user-overlay">
			<div class="mobile-user-header">
				<h3>Users Online</h3>
				<button class="mobile-close-btn" on:click={closeMobileUsers}>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>
			<div class="mobile-user-list">
				{#each $users.filter(u => u.id !== $currentUser?.id) as user (user.id)}
					<div class="mobile-user-item">
						<div class="mobile-user-info">
							{#if user.profilePicture}
								<img src={user.profilePicture} alt={user.username} class="mobile-user-avatar" />
							{:else}
								<div class="mobile-user-avatar-placeholder" style="background-color: {user.color}">
									{user.username.charAt(0).toUpperCase()}
								</div>
							{/if}
							<span class="mobile-user-name">{user.username}</span>
						</div>
						<div class="mobile-user-actions">
							<button class="mobile-action-btn" on:click={() => handleDM(user)} title="Message">
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
							</button>
							<button class="mobile-action-btn" on:click={() => handleVoiceCall(user)} title="Voice call">
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
							</button>
							<button class="mobile-action-btn" on:click={() => handleVideoCall(user)} title="Video call">
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
							</button>
						</div>
					</div>
				{/each}
				{#if $users.filter(u => u.id !== $currentUser?.id).length === 0}
					<div class="mobile-user-empty">No other users online</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Main Content -->
	<div class="main-content">
		<div class:hidden={activeView !== 'chat'}><Chat on:logout /></div>
		<div class:hidden={activeView !== 'screen'}><ScreenShareViewer bind:activeView /></div>
	</div>
</div>
<CallModal />

<style>
	/* All the styles from +page.svelte are moved here */
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
		min-width: 0; /* Prevents flexbox overflow */
		position: relative;
	}

	.main-content > div { height: 100%; width: 100%; }
	.hidden { display: none !important; }

	.channel-sidebar-container {
		flex-shrink: 0;
		position: relative;
		border-right: 1px solid rgba(var(--border-rgb), var(--opacity-light));
	}

	.main-content {
		border-right: 1px solid rgba(var(--border-rgb), var(--opacity-light));
	}

	/* Desktop Panel Styles */
	.right-panel-container {
		flex-shrink: 0;
		position: relative;
		overflow: hidden;
		transition: width 0.2s ease-in-out;
		will-change: width;
		height: 100vh;
		height: 100dvh;
		background: var(--bg-secondary);
	}

	.resize-handle {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: col-resize;
		z-index: 100;
		transition: background 0.2s;
	}
	.resize-handle:hover { background: var(--accent); opacity: 0.5; }
	.resize-handle-channel { right: -3px; }
	.resize-handle-right { left: -3px; }
	
	.user-panel-toggle {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		width: 28px;
		height: 80px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 8px 0 0 8px;
		cursor: pointer;
		font-size: 1.2rem;
		color: var(--text-secondary);
		transition: all 0.3s ease;
		z-index: 999;
		opacity: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.user-panel-toggle:hover {
		opacity: 1;
		background: var(--accent);
		color: var(--text-primary);
	}

	.art-nav-button {
		position: absolute;
		top: 12px;
		right: 60px;
		width: 40px;
		height: 40px;
		background: var(--bg-secondary);
		border: 2px solid var(--border);
		border-radius: 8px;
		cursor: pointer;
		font-size: 1.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
		text-decoration: none;
		transition: all 0.3s ease;
		z-index: 500;
	}
	.art-nav-button:hover {
		background: var(--accent);
		border-color: var(--accent);
		transform: scale(1.1);
	}

	/* --- Mobile Styles --- */
	.mobile-bottom-nav { display: none; }
	.mobile-user-overlay { display: none; }
	
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

		.channel-sidebar-container,
		.right-panel-container {
			display: none; /* Hidden by default */
			position: fixed;
			top: 0;
			left: 0;
			width: 100% !important; /* Override inline style */
			height: calc(100vh - 56px);
			height: calc(100dvh - 56px);
			z-index: 1500;
			background: var(--bg-primary);
		}

		.channel-sidebar-container.mobile-visible,
		.right-panel-container.mobile-visible {
			display: block; /* Shown when active */
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
			z-index: 2000;
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
			font-size: 0.6rem;
			padding: 0.375rem 0.5rem;
			text-decoration: none;
			transition: color 0.15s;
		}
		.mobile-bottom-nav button:hover, .mobile-bottom-nav .nav-link:hover { color: var(--text-primary); }
		.mobile-bottom-nav button.active { color: var(--accent); }
		.mobile-bottom-nav svg { width: 20px; height: 20px; stroke: currentColor; fill: none; stroke-width: 2; }

		/* Mobile User List Overlay */
		.mobile-user-overlay {
			display: flex;
			flex-direction: column;
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: calc(100vh - 56px);
			height: calc(100dvh - 56px);
			z-index: 1500;
			background: var(--bg-primary);
		}

		.mobile-user-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0 1rem;
			height: 52px;
			flex-shrink: 0;
			background: var(--bg-secondary);
			border-bottom: 1px solid var(--border);
		}

		.mobile-user-header h3 {
			margin: 0;
			font-size: 1rem;
			font-weight: 600;
			color: var(--text-primary);
		}

		.mobile-close-btn {
			width: 36px;
			height: 36px;
			display: flex;
			align-items: center;
			justify-content: center;
			background: transparent;
			border: none;
			color: var(--text-secondary);
			border-radius: 6px;
			padding: 0;
		}

		.mobile-close-btn:hover {
			background: var(--bg-hover);
			color: var(--text-primary);
		}

		.mobile-user-list {
			flex: 1;
			overflow-y: auto;
			-webkit-overflow-scrolling: touch;
			padding: 0.5rem;
		}

		.mobile-user-item {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.75rem 0.5rem;
			border-radius: 8px;
			min-height: 56px;
		}

		.mobile-user-item:active {
			background: var(--bg-secondary);
		}

		.mobile-user-info {
			display: flex;
			align-items: center;
			gap: 0.75rem;
			min-width: 0;
			flex: 1;
		}

		.mobile-user-avatar,
		.mobile-user-avatar-placeholder {
			width: 36px;
			height: 36px;
			border-radius: 50%;
			flex-shrink: 0;
			object-fit: cover;
		}

		.mobile-user-avatar-placeholder {
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 0.875rem;
			font-weight: 600;
			color: white;
		}

		.mobile-user-name {
			font-size: 0.9375rem;
			color: var(--text-primary);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.mobile-user-actions {
			display: flex;
			gap: 0.25rem;
			flex-shrink: 0;
		}

		.mobile-action-btn {
			width: 44px;
			height: 44px;
			padding: 0;
			background: transparent;
			border: none;
			border-radius: 8px;
			cursor: pointer;
			display: flex;
			align-items: center;
			justify-content: center;
			color: var(--text-secondary);
		}

		.mobile-action-btn:active {
			background: var(--bg-hover);
			color: var(--accent-hex, var(--text-primary));
		}

		.mobile-action-btn svg {
			stroke: currentColor;
			fill: none;
		}

		.mobile-user-empty {
			text-align: center;
			color: var(--text-secondary);
			padding: 2rem 1rem;
			font-size: 0.875rem;
		}
	}
</style>
