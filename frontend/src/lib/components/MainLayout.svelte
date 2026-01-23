<!-- frontend/src/lib/components/MainLayout.svelte -->
<script lang="ts">
	import { fade } from 'svelte/transition';
	import { layoutStore } from '$lib/layoutStore';
	import Chat from '$lib/components/Chat.svelte';
	import ScreenShareViewer from '$lib/components/ScreenShareViewer.svelte';
	import ChannelSidebar from '$lib/components/ChannelSidebar.svelte';
	import DMListPanel from '$lib/components/DMListPanel.svelte';
	import DMPanel from '$lib/components/DMPanel.svelte';
	import CallModal from '$lib/components/CallModal.svelte';

	export let activeView: 'chat' | 'screen' = 'chat';

	let isResizingChannel = false;
	let isResizingUser = false;
	let isResizingDM = false;

	layoutStore.isResizingChannel.subscribe(v => isResizingChannel = v);
	layoutStore.isResizingUser.subscribe(v => isResizingUser = v);
	layoutStore.isResizingDM.subscribe(v => isResizingDM = v);

	function handleMouseMove(e: MouseEvent) {
		if (isResizingChannel) {
			layoutStore.channelSidebarWidth.set(Math.max(180, Math.min(e.clientX, 400)));
		} else if (isResizingUser) {
			layoutStore.userPanelWidth.set(Math.max(200, Math.min(window.innerWidth - e.clientX, 500)));
		} else if (isResizingDM) {
			layoutStore.dmPanelWidth.set(Math.max(300, Math.min(window.innerWidth - e.clientX, 600)));
		}
	}

	function stopResize() {
		layoutStore.isResizingChannel.set(false);
		layoutStore.isResizingUser.set(false);
		layoutStore.isResizingDM.set(false);
	}
</script>

<svelte:window on:mousemove={handleMouseMove} on:mouseup={stopResize} />

{#if $layoutStore.isMobile}
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

<div class="app-container" class:resizing={$layoutStore.isResizing}>
	<!-- Channel Sidebar (Left) -->
	<div 
		class="channel-sidebar-container" 
		style:width="{$layoutStore.channelSidebarWidth}px"
		class:mobile-visible={$layoutStore.showMobileChannels}
	>
		<ChannelSidebar on:close={() => layoutStore.showMobileChannels.set(false)} bind:activeView on:logout />
	</div>

	<!-- Main Content -->
	<div class="main-content">
		<div class:hidden={activeView !== 'chat'}><Chat on:logout /></div>
		<div class:hidden={activeView !== 'screen'}><ScreenShareViewer bind:activeView /></div>
	</div>
	
	<!-- User Panel (Right) -->
	<div 
		class="user-panel-container"
		class:visible={$layoutStore.showDMListPanel}
		style:width="{$layoutStore.showDMListPanel ? $layoutStore.userPanelWidth : 0}px"
		class:mobile-visible={$layoutStore.isMobile && $layoutStore.rightPanelView === 'users'}
	>
		<DMListPanel on:openDM={(e) => layoutStore.openDM(e.detail.channelId, e.detail.otherUser)} on:close={() => layoutStore.rightPanelView.set('none')} />
		{#if !$layoutStore.isMobile}
			<div class="resize-handle resize-handle-user" on:mousedown={() => layoutStore.isResizingUser.set(true)}></div>
		{/if}
	</div>
	
	<!-- DM Panel (Far Right) -->
	<div 
		class="dm-panel-container"
		class:visible={$layoutStore.showDMPanel}
		style:width="{$layoutStore.showDMPanel ? $layoutStore.dmPanelWidth : 0}px"
		class:mobile-visible={$layoutStore.isMobile && $layoutStore.rightPanelView === 'dm'}
	>
		<DMPanel
            dmChannelId={$layoutStore.dmChannelId}
            otherUser={$layoutStore.dmOtherUser}
            onClose={layoutStore.closeDM}
            onSelectDM={(channelId, user) => layoutStore.openDM(channelId, user)}
            on:back={layoutStore.handleDMPanelBack}
        />
		{#if !$layoutStore.isMobile}
			<div class="resize-handle resize-handle-dm" on:mousedown={() => layoutStore.isResizingDM.set(true)}></div>
		{/if}
	</div>
	
	<!-- Desktop-Only Buttons -->
	{#if !$layoutStore.isMobile}
		<button
			class="user-panel-toggle"
			class:open={$layoutStore.showDMListPanel || $layoutStore.showDMPanel}
			on:click={layoutStore.toggleDesktopUserPanel}
			title={$layoutStore.rightPanelView === 'dm-list' ? 'Hide messages panel' : 'Show messages panel'}
			style:right="{$layoutStore.toggleButtonRight}px"
		>
			{$layoutStore.showDMListPanel || $layoutStore.showDMPanel ? '→' : '←'}
		</button>
	{/if}
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
		overflow: hidden;
		position: relative;
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
	}

	/* Desktop Panel Styles */
	.user-panel-container,
	.dm-panel-container {
		flex-shrink: 0;
		position: relative;
		overflow: hidden;
		transition: width 0.2s ease-in-out;
		will-change: width;
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
	.resize-handle-user { left: -3px; }
	.resize-handle-dm { left: -3px; }
	
	.user-panel-toggle {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		width: 28px;
		height: 80px;
		background: var(--bg-secondary);
		border: none;
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
	
	@media (max-width: 768px) {
		.app-container { height: calc(100vh - 56px); }
		.user-panel-toggle, .resize-handle { display: none; }

		.channel-sidebar-container,
		.user-panel-container,
		.dm-panel-container {
			display: none; /* Hidden by default */
			position: fixed;
			top: 0;
			left: 0;
			width: 100% !important; /* Override inline style */
			height: calc(100vh - 56px);
			z-index: 1500;
			background: var(--bg-primary);
		}
		
		.channel-sidebar-container.mobile-visible,
		.user-panel-container.mobile-visible,
		.dm-panel-container.mobile-visible {
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
	}
</style>
