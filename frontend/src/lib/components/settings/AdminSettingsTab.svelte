<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { currentUser } from '$lib/socket';
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
			<h3 id="admin-launcher-title">Server administration</h3>
			<p>Manage your community in one workspace. Your personal preferences stay here in Settings.</p>
		</div>
		<button class="admin-open-dashboard-btn" type="button" onclick={() => dispatch('openDashboard', { section: 'overview' })}>
			Open administration
			<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
		</button>
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
	.admin-settings-launcher { display: grid; gap: 1.25rem; color: var(--text-primary); }
	.admin-launcher-heading h3 { margin: 0 0 0.5rem; font-size: 1.2rem; color: var(--text-heading); }
	.admin-launcher-heading p { margin: 0; max-width: 56ch; color: var(--text-secondary); line-height: 1.6; text-wrap: pretty; }
	.admin-open-dashboard-btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.75rem; justify-self: start; min-height: 44px; padding: 0.7rem 1rem; border: 1px solid var(--accent-primary); border-radius: var(--radius-md); background: var(--accent-primary); color: var(--text-on-accent, white); font: inherit; font-weight: 600; cursor: pointer; }
	.admin-open-dashboard-btn:hover { background: var(--accent-secondary); }
	.admin-destination-list { display: grid; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); overflow: hidden; }
	.admin-destination { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 76px; width: 100%; padding: 1rem; background: var(--surface-raised); border: 0; text-align: left; color: var(--text-primary); font: inherit; cursor: pointer; }
	.admin-destination + .admin-destination { border-top: 1px solid var(--border-subtle); }
	.admin-destination:hover { background: var(--surface-hover); }
	.admin-destination > span { display: grid; gap: 0.35rem; min-width: 0; }
	.admin-destination strong { font-weight: 600; color: var(--text-heading); }
	.admin-destination span span { color: var(--text-secondary); font-size: 0.875rem; line-height: 1.5; text-wrap: pretty; }
	.admin-destination svg, .admin-open-dashboard-btn svg { flex-shrink: 0; }
	button:focus-visible { outline: 2px solid var(--accent-secondary); outline-offset: -3px; }
</style>
