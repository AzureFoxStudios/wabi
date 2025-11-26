<script lang="ts">
	import { onDestroy } from 'svelte';
	import { initSocket, disconnect } from '$lib/socket';
	import Chat from '$lib/components/Chat.svelte';
	import Login from '$lib/components/Login.svelte';
	import ChannelSidebar from '$lib/components/ChannelSidebar.svelte';
	import UserPanel from '$lib/components/UserPanel.svelte';
	import ScreenShareViewer from '$lib/components/ScreenShareViewer.svelte';
	import CallModal from '$lib/components/CallModal.svelte';

	let username = '';
	let loggedIn = false;
	let activeView: 'chat' | 'screen' = 'chat';
	let showUserPanel = false;
	let channelSidebarWidth = 240;
	let userPanelWidth = 250;
	let isResizingChannel = false;
	let isResizingUser = false;

	function handleLogin(event: CustomEvent<string>) {
		username = event.detail;
		initSocket(username);
		loggedIn = true;
	}

	function startResizeChannel(e: MouseEvent) {
		isResizingChannel = true;
		e.preventDefault();
	}

	function startResizeUser(e: MouseEvent) {
		isResizingUser = true;
		e.preventDefault();
	}

	function handleMouseMove(e: MouseEvent) {
		if (isResizingChannel) {
			const newWidth = e.clientX;
			if (newWidth >= 180 && newWidth <= 400) {
				channelSidebarWidth = newWidth;
			}
		} else if (isResizingUser) {
			const newWidth = window.innerWidth - e.clientX;
			if (newWidth >= 200 && newWidth <= 500) {
				userPanelWidth = newWidth;
			}
		}
	}

	function stopResize() {
		isResizingChannel = false;
		isResizingUser = false;
	}

	onDestroy(() => {
		disconnect();
	});
</script>

<svelte:window on:mousemove={handleMouseMove} on:mouseup={stopResize} />

{#if !loggedIn}
	<Login on:login={handleLogin} />
{:else}
	<div class="app-container" class:resizing={isResizingChannel || isResizingUser}>
		<div class="channel-sidebar-container" style="width: {channelSidebarWidth}px;">
			<ChannelSidebar bind:activeView />
			<div class="resize-handle resize-handle-channel" on:mousedown={startResizeChannel}></div>
		</div>
		<div class="main-content">
			<div class:hidden={activeView !== 'chat'}>
				<Chat />
			</div>
			<div class:hidden={activeView !== 'screen'}>
				<ScreenShareViewer bind:activeView />
			</div>
		</div>
		{#if showUserPanel}
			<div class="user-panel-container" style="width: {userPanelWidth}px;">
				<div class="resize-handle resize-handle-user" on:mousedown={startResizeUser}></div>
				<UserPanel />
			</div>
		{/if}
		<button
			class="user-panel-toggle"
			class:open={showUserPanel}
			on:click={() => showUserPanel = !showUserPanel}
			title={showUserPanel ? 'Hide user panel' : 'Show user panel'}
			style={showUserPanel ? `right: ${userPanelWidth}px` : 'right: 0'}
		>
			{showUserPanel ? '→' : '←'}
		</button>
	</div>
	<!-- Call Modal (always rendered when logged in) -->
	<CallModal />
{/if}

<style>
	.app-container {
		display: flex;
		height: 100vh;
		overflow: hidden;
		position: relative;
	}

	.app-container.resizing {
		user-select: none;
		cursor: col-resize;
	}

	.channel-sidebar-container,
	.user-panel-container {
		position: relative;
		flex-shrink: 0;
	}

	.main-content {
		flex: 1;
		overflow: hidden;
		position: relative;
	}

	.main-content > div {
		height: 100%;
		width: 100%;
	}

	.hidden {
		display: none !important;
	}

	.resize-handle {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 6px;
		cursor: col-resize;
		background: transparent;
		z-index: 100;
		transition: background 0.2s;
	}

	.resize-handle:hover {
		background: var(--accent);
		opacity: 0.5;
	}

	.resize-handle-channel {
		right: -3px;
	}

	.resize-handle-user {
		left: -3px;
	}

	.user-panel-toggle {
		position: absolute;
		right: 0;
		top: 50%;
		transform: translateY(-50%);
		width: 32px;
		height: 80px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-right: none;
		border-radius: 0;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.2rem;
		color: var(--text-secondary);
		transition: all 0.3s ease;
		z-index: 10;
		opacity: 0.5;
	}

	.user-panel-toggle:hover {
		opacity: 1;
		background: var(--accent);
		color: white;
		width: 36px;
	}
</style>
