<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { currentUser } from '$lib/socket';
	import { currentSavedServer } from '$lib/savedServers';
	import { getServerUrl } from '$lib/serverUrl';
	import ReceptionBoard from './ReceptionBoard.svelte';
	export let welcome = false;

	const dispatch = createEventDispatcher<{ back: void; browse: void; openRoom: void; messages: void; members: void; settings: void; manage: void; complete: void }>();
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
		<div class="server-hub-top"><h2 id="server-hub-title">{welcome ? 'Welcome' : 'Reference Desk'}</h2><button type="button" on:click={() => welcome ? finishWelcome() : dispatch('back')}>{welcome ? 'Explore Reference Desk' : 'Back to where I was'}</button></div>
		<ReceptionBoard mode={welcome ? 'welcome' : 'desk'} on:openRoom={() => { finishWelcome(); dispatch('openRoom'); }} />
		<nav class="server-hub-actions" aria-label={`${serverName} navigation`}>
			<button type="button" class="server-hub-primary" on:click={() => { finishWelcome(); dispatch('browse'); }}>{welcome ? 'Explore first' : 'Browse channels'}</button>
			<button type="button" on:click={() => { finishWelcome(); dispatch('messages'); }}>Messages</button>
			<button type="button" on:click={() => { finishWelcome(); dispatch('members'); }}>Members</button>
			<button type="button" on:click={() => { finishWelcome(); dispatch('settings'); }}>Server settings</button>
			{#if canManage}<button type="button" on:click={() => { finishWelcome(); dispatch('manage'); }}>Manage server</button>{/if}
		</nav>
	</div>
</section>

<style>
	.server-hub { height: 100%; overflow: auto; color: var(--text-primary); }
	.server-hub.focused { position: fixed; inset: 0; z-index: 10010; height: 100dvh; background: var(--surface-app); }
	.server-hub-content { max-width: 1140px; margin-inline: auto; padding: clamp(16px, 3vw, 36px); }
	.server-hub-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 24px}
	.server-hub-top h2{margin:0;font-size:.9rem;color:var(--text-secondary)}
	.server-hub-top button{border:0;background:none;color:var(--accent-primary);font:inherit;cursor:pointer}
	.server-hub-actions { display: flex; flex-wrap: wrap; gap: 10px; padding:0 24px 24px; }
	.server-hub-actions button { min-height: 44px; padding: 9px 16px; border: 1px solid color-mix(in srgb, var(--text-muted) 22%, transparent); border-radius: var(--radius-md, 8px); background: var(--surface-base); color: var(--text-heading); font: inherit; cursor: pointer; transition: background-color 130ms ease, border-color 130ms ease; }
	.server-hub-actions button:hover { background: var(--surface-raised); border-color: var(--accent-primary); }
	.server-hub-actions button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
	.server-hub-actions .server-hub-primary { background: var(--accent-primary); color: white; border-color: transparent; }
	.server-hub-actions .server-hub-primary:hover { background: var(--accent-secondary); border-color: transparent; }
</style>
