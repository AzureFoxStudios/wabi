<!--
	Server home (design contract §8.1, §9.6): reached from the community block in the sidebar.
	Its masthead matches the stage's (96, the shared rule at y = 96): row A is the serif title and
	the server tools, row B the Overview | People tabs with the --w-sig underline. DMs are not a
	tab here (one name, one way in: the sidebar's DMs row). Roles and kit only.
-->
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
	<header class="server-hub-mast">
		<div class="server-hub-top">
			<h2 id="server-hub-title" class="server-hub-title">{welcome ? 'Welcome' : 'Server home'}</h2>
			<div class="server-tools">
				<button type="button" class="w-btn w-btn--sm" on:click={() => dispatch('settings')}>Server settings</button>
				{#if canManage}<button type="button" class="w-btn w-btn--sm" on:click={() => dispatch('manage')}>Manage server</button>{/if}
				{#if welcome}<button type="button" class="w-btn w-btn--primary w-btn--sm" on:click={finishWelcome}>Explore server</button>{/if}
			</div>
		</div>
		{#if !welcome}
			<nav class="hub-tabs" aria-label={`${serverName} home views`}>
				<button type="button" class="hub-tab" class:active={hubView === 'overview'} aria-current={hubView === 'overview' ? 'page' : undefined} on:click={() => hubView = 'overview'}>Overview</button>
				<button type="button" class="hub-tab" class:active={hubView === 'people'} aria-current={hubView === 'people' ? 'page' : undefined} on:click={() => hubView = 'people'}>People</button>
			</nav>
		{/if}
	</header>
	<div class="server-hub-content">
		{#if welcome || hubView === 'overview'}
			<ReceptionBoard mode={welcome ? 'welcome' : 'desk'} on:openRoom={() => { finishWelcome(); dispatch('openRoom'); }} />
		{:else}
			<div class="hub-people"><UserListTab on:openSettings={() => dispatch('profileSettings')} /></div>
		{/if}
	</div>
</section>

<style>
	/* Server home (§8.1). Roles, type tokens and kit classes only. */
	.server-hub {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--w-bg);
		color: var(--w-text);
	}
	.server-hub.focused {
		position: fixed;
		inset: 0;
		z-index: 10010;
		height: 100dvh;
	}
	.server-hub-mast {
		flex: none;
		display: grid;
		grid-template-rows: var(--w-head-a) minmax(0, 1fr);
		box-sizing: border-box;
		height: var(--w-mast);
		padding: 0 var(--w-gutter, 32px);
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.server-hub-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-width: 0;
	}
	.server-hub-title {
		min-width: 0;
		margin: 0;
		overflow: hidden;
		color: var(--w-text);
		font: var(--w-t-title);
		letter-spacing: 0.005em;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.server-tools {
		display: flex;
		flex: none;
		gap: 8px;
	}
	.hub-tabs {
		display: flex;
		align-items: stretch;
		gap: 18px;
	}
	.hub-tab {
		position: relative;
		display: inline-flex;
		align-items: center;
		margin: 0;
		padding: 0 2px;
		border: 0;
		border-radius: 0;
		background: transparent;
		color: var(--w-mute);
		font: var(--w-t-label);
		cursor: pointer;
		transition: color var(--w-dur-1) var(--w-ease);
	}
	.hub-tab:hover,
	.hub-tab.active {
		color: var(--w-text);
	}
	/* The active tab: a 2px --w-sig underline sitting on the masthead rule. */
	.hub-tab.active::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		bottom: calc(-1 * var(--w-bw));
		height: 2px;
		border-radius: 2px 2px 0 0;
		background: var(--w-sig);
	}
	.hub-tab:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: -2px;
	}
	.server-hub-content {
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		padding: 24px var(--w-gutter, 32px) 40px;
	}
	.hub-people {
		min-height: 480px;
		max-width: 960px;
	}
	@media (max-width: 600px) {
		.server-hub-mast {
			height: auto;
			min-height: var(--w-mast);
			padding: env(safe-area-inset-top, 0px) 16px 0;
		}
		.server-hub-top {
			flex-wrap: wrap;
			padding-block: 8px;
		}
		.server-hub-content {
			padding: 16px;
		}
		.server-tools :global(.w-btn) {
			height: 44px;
		}
	}
</style>
