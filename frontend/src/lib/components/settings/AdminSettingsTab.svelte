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
.admin-summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem}.admin-summary-grid>div{display:grid;gap:.5rem;padding:1rem;border:1px solid var(--border-subtle);border-radius:var(--radius-lg);background:var(--surface-raised)}.admin-summary-grid strong{font-size:1.4rem;color:var(--text-heading)}.admin-summary-grid span{color:var(--text-secondary)}
	.admin-settings-launcher { display: grid; gap: 1.25rem; color: var(--text-primary); }
	.admin-launcher-heading h3 { margin: 0 0 0.5rem; font-size: 1.2rem; color: var(--text-heading); }
	.admin-launcher-heading p { margin: 0; max-width: 56ch; color: var(--text-secondary); line-height: 1.6; text-wrap: pretty; }
	.admin-destination-list { display: grid; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); overflow: hidden; }
	.admin-destination { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 76px; width: 100%; padding: 1rem; background: var(--surface-raised); border: 0; text-align: left; color: var(--text-primary); font: inherit; cursor: pointer; }
	.admin-destination + .admin-destination { border-top: 1px solid var(--border-subtle); }
	.admin-destination:hover { background: var(--surface-hover); }
	.admin-destination > span { display: grid; gap: 0.35rem; min-width: 0; }
	.admin-destination strong { font-weight: 600; color: var(--text-heading); }
	.admin-destination span span { color: var(--text-secondary); font-size: 0.875rem; line-height: 1.5; text-wrap: pretty; }
	.admin-destination svg { flex-shrink: 0; }
	button:focus-visible { outline: 2px solid var(--accent-secondary); outline-offset: -3px; }
</style>
