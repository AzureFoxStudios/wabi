<script lang="ts">
	import type { AdminRoleDefinition } from '$lib/adminRoleCatalog';
	let { roleDefinitions, loading = false, error = '', onRetry }: {
		roleDefinitions: AdminRoleDefinition[];
		loading?: boolean;
		error?: string;
		onRetry: () => void;
	} = $props();
</script>

<section class="admin-section role-reference" aria-label="Server roles" aria-busy={loading}>
	<h4>Server roles</h4>
	<p class="role-introduction">Roles control server access. Assign a member’s role in the Users section.</p>
	{#if error}
		<div class="role-feedback" role="alert"><p>{error}</p><button class="admin-btn" onclick={onRetry}>Try again</button></div>
	{:else if loading && roleDefinitions.length === 0}
		<p class="role-feedback" role="status">Loading server roles…</p>
	{:else if roleDefinitions.length === 0}
		<div class="role-feedback" role="status">
			<p>This server did not provide a role catalog. Existing member roles still apply; update the server to view them here.</p>
			<button class="admin-btn" onclick={onRetry}>Reload roles</button>
		</div>
	{:else}
		<ol class="role-catalog">
			{#each roleDefinitions as role (role.roleName)}
				<li><strong>{role.displayName}</strong>{#if role.description}<p>{role.description}</p>{/if}</li>
			{/each}
		</ol>
		<p class="role-note">Built-in role names are fixed. This catalog shows the available roles, not how many are currently assigned.</p>
	{/if}
</section>

<style>
	.role-reference { min-width: 0; }
	.role-reference h4 { text-wrap: balance; }
	.role-reference p { margin: 0; text-wrap: pretty; overflow-wrap: anywhere; }
	.role-introduction, .role-note { color: var(--text-secondary); line-height: 1.55; }
	.role-introduction { margin-bottom: var(--space-4) !important; }
	.role-catalog { list-style: none; margin: 0; padding: 0; }
	.role-catalog li { display: grid; gap: var(--space-1); padding: var(--space-3) 0; border-bottom: 1px solid var(--border-subtle); }
	.role-catalog li:first-child { padding-top: 0; }
	.role-catalog strong { color: var(--text-heading); font-weight: 600; }
	.role-catalog p { color: var(--text-secondary); line-height: 1.5; }
	.role-note { margin-top: var(--space-4) !important; font-size: var(--font-size-sm); }
	.role-feedback { display: grid; justify-items: start; gap: var(--space-3); color: var(--text-secondary); line-height: 1.55; }
	.role-feedback .admin-btn { min-width: 44px; min-height: 44px; }
</style>
