<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { initSocket, disconnect, currentUser, connected } from '$lib/socket';
	import Chat from '$lib/components/Chat.svelte';
	import Login from '$lib/components/Login.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import ChannelSidebar from '$lib/components/ChannelSidebar.svelte';
	import ScreenShareViewer from '$lib/components/ScreenShareViewer.svelte';
	import DrawingBoard from '$lib/components/DrawingBoard.svelte';
	import CallModal from '$lib/components/CallModal.svelte';

	let username = '';
	let loggedIn = false;
	let activeView: 'chat' | 'draw' | 'screen' = 'chat';

	function handleLogin(event: CustomEvent<string>) {
		username = event.detail;
		initSocket(username);
		loggedIn = true;
	}

	onDestroy(() => {
		disconnect();
	});
</script>

{#if !loggedIn}
	<Login on:login={handleLogin} />
{:else}
	<div class="app-container">
		<Sidebar bind:activeView />
		{#if activeView === 'chat'}
			<ChannelSidebar />
		{/if}
		<div class="main-content">
			{#if activeView === 'chat'}
				<Chat />
			{:else if activeView === 'draw'}
				<DrawingBoard />
			{:else if activeView === 'screen'}
				<ScreenShareViewer />
			{/if}
		</div>
	</div>
	<!-- Call Modal (always rendered when logged in) -->
	<CallModal />
{/if}

<style>
	.app-container {
		display: flex;
		height: 100vh;
		overflow: hidden;
	}

	.main-content {
		flex: 1;
		overflow: hidden;
	}
</style>
