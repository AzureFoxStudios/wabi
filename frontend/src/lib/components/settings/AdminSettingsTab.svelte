<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { currentUser, channels, users, connected } from '$lib/socket';
	import type { AdminSection } from '$lib/adminNavigation';

	const dispatch = createEventDispatcher<{ openDashboard: { section: AdminSection } }>();
	const canManageAdmin = $derived(['owner', 'admin'].includes($currentUser?.highestRole ?? ''));
	const destinations: Array<{ section: AdminSection; title: string; description: string }> = [
		{ section: 'users', title: 'People', description: 'Find members, manage roles, and help someone regain access.' },
		{ section: 'branding', title: 'Server identity', description: 'Update the name, icon, and banner people see for this server.' },
		{ section: 'roles', title: 'Roles', description: 'Review the server’s built-in permission levels.' },
		{ section: 'runtime', title: 'Server health', description: 'Inspect the running server and its diagnostics.' }
	];
</script>

{#if canManageAdmin}
	<section class="admin-settings-launcher" aria-labelledby="admin-launcher-title">
		<div class="admin-launcher-heading">
			<h3 id="admin-launcher-title">Server overview</h3>
			<p>{$connected ? 'Connected to your community.' : 'Offline — counts may reflect the last connection.'}</p>
		</div>
		<div class="admin-summary-grid">
            <div><strong>{$users.filter(user => ['active', 'away', 'busy'].includes(user.status)).length}</strong><span>Online in your roster</span></div>
            <div><strong>{$channels.length}</strong><span>Channels you can see</span></div>
            <div><strong>{$currentUser?.highestRole ?? 'Unknown'}</strong><span>Your role</span></div>
        </div>
		<div class="admin-destination-list">
			{#each destinations as destination (destination.section)}
				<button class="admin-destination" type="button" onclick={() => dispatch('openDashboard', { section: destination.section })}>
					<span><strong>{destination.title}</strong><span>{destination.description}</span></span>
					<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 5 7 7-7 7" /></svg>
				</button>
			{/each}
		</div>
	</section>
{/if}

<style>
	.admin-summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); border: var(--w-bw, 1px) solid var(--w-line); border-radius: calc(8px * var(--w-rs, 1)); overflow: hidden; }
	.admin-summary-grid > div { display: grid; gap: .3rem; padding: .9rem 1rem; border-right: var(--w-bw, 1px) solid var(--w-line); background: transparent; }
	.admin-summary-grid > div:last-child { border-right: 0; }
	.admin-summary-grid strong { font: 600 1.5rem/1.1 var(--w-mono); color: var(--w-text); font-variant-numeric: tabular-nums; }
	.admin-summary-grid span { color: var(--w-mute); font: 500 .68rem var(--w-mono); letter-spacing: .08em; text-transform: uppercase; }
	.admin-settings-launcher { display: grid; gap: 1.25rem; color: var(--w-text); }
	.admin-launcher-heading h3 { margin: 0 0 .4rem; font: 600 1.5rem/1.2 var(--w-serif); color: var(--w-text); }
	.admin-launcher-heading p { margin: 0; max-width: 56ch; color: var(--w-mute); line-height: 1.6; text-wrap: pretty; }
	.admin-destination-list { display: grid; border-top: var(--w-bw, 1px) solid var(--w-line); }
	.admin-destination { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 64px; width: 100%; padding: .85rem .25rem; background: transparent; border: 0; border-bottom: var(--w-bw, 1px) solid var(--w-line); text-align: left; color: inherit; cursor: pointer; }
	.admin-destination:hover { background: var(--w-accent-soft); }
	.admin-destination > span { display: grid; gap: .25rem; min-width: 0; }
	.admin-destination strong { font: 600 1rem var(--w-serif); color: var(--w-text); }
	.admin-destination span span { color: var(--w-mute); font-size: .85rem; line-height: 1.5; text-wrap: pretty; }
	.admin-destination svg { flex-shrink: 0; color: var(--w-deco); }
	button:focus-visible { outline: 2px solid var(--w-accent); outline-offset: -3px; }
</style>
