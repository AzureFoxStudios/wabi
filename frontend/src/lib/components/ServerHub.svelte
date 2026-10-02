<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { currentUser } from '$lib/socket';
	import { currentSavedServer } from '$lib/savedServers';
	import { getServerUrl } from '$lib/serverUrl';
	import ReceptionBoard from './ReceptionBoard.svelte';
	import UserListTab from './UserListTab.svelte';
	let hubView: 'overview' | 'people' = 'overview';
	export let welcome = false;

	const dispatch = createEventDispatcher<{ back: void; browse: void; openRoom: void; messages: void; members: void; settings: void; profileSettings: void; manage: void; complete: void }>();
	$: serverName = $currentSavedServer?.effectiveName || (() => {
		try { return new URL(getServerUrl()).hostname; } catch { return 'This server'; }
	})();
	function finishWelcome(): void { if (welcome) { welcome = false; dispatch('complete'); } }
	function handleWelcomeKeydown(event: KeyboardEvent): void { if (welcome && event.key === 'Escape') finishWelcome(); }
	$: canManage = ['owner', 'admin', 'mod'].includes($currentUser?.highestRole || '');
</script>

<svelte:window on:keydown={handleWelcomeKeydown} />

<section class="server-hub" class:focused={welcome && $currentSavedServer?.frontendMetadata?.deskFocusedWelcome === true} aria-labelledby="server-hub-title">
	<div class="server-hub-content">
		<header class="server-hub-top">
			<h2 id="server-hub-title">{welcome ? 'Welcome' : 'Server home'}</h2>
			<div class="server-tools">
				<button type="button" on:click={() => dispatch('settings')}>Server settings</button>
				{#if canManage}<button type="button" on:click={() => dispatch('manage')}>Manage server</button>{/if}
				{#if welcome}<button type="button" on:click={finishWelcome}>Explore server</button>{/if}
			</div>
		</header>
		{#if !welcome}
			<nav class="hub-tabs" aria-label={`${serverName} home views`}>
				<button type="button" on:click={() => dispatch('messages')}>Messages &amp; friends</button>
				<button type="button" class:active={hubView === 'overview'} aria-current={hubView === 'overview' ? 'page' : undefined} on:click={() => hubView = 'overview'}>Overview</button>
				<button type="button" class:active={hubView === 'people'} aria-current={hubView === 'people' ? 'page' : undefined} on:click={() => hubView = 'people'}>People</button>
			</nav>
		{/if}
		{#if welcome || hubView === 'overview'}
			<ReceptionBoard mode={welcome ? 'welcome' : 'desk'} on:openRoom={() => { finishWelcome(); dispatch('openRoom'); }} />
		{:else}
			<div class="hub-people"><UserListTab on:openSettings={() => dispatch('profileSettings')} /></div>
		{/if}
	</div>
</section>

<style>
	.server-hub { height: 100%; overflow: auto; color: var(--text-primary); }
	.server-hub.focused { position: fixed; inset: 0; z-index: 10010; height: 100dvh; background: var(--surface-app); }
	.server-hub-content { padding: clamp(16px, 2vw, 28px) clamp(16px, 2vw, 28px) 32px; padding-inline-end: max(56px, 2vw); }
	.server-hub-top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
	.server-hub-top h2 { margin: 0; font-size: 1rem; color: var(--text-secondary); }
	.server-tools, .hub-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
	.server-tools button, .hub-tabs button { min-height: 44px; padding: 10px 14px; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--surface-base); color: var(--text-primary); font: inherit; cursor: pointer; }
	.hub-tabs { margin-bottom: 20px; border-bottom: 1px solid var(--border-default); }
	.hub-tabs button { border: 0; border-bottom: 3px solid transparent; border-radius: 0; background: transparent; }
	.hub-tabs button.active { border-bottom-color: var(--accent-primary); color: var(--text-heading); }
	button:hover { background: var(--surface-raised); }
	button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
	.hub-people { min-height: 480px; max-width: 960px; }
	@media (max-width: 600px) { .server-hub-content { padding: 16px; } }
</style>
