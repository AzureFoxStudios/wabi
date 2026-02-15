<script lang="ts">
	import { onMount } from 'svelte';
	import { pluginRegistry } from '$lib/plugins/registry';

	let plugins: any[] = [];
	let syncing: Record<string, boolean> = {};

	const unsubscribe = pluginRegistry.plugins.subscribe((items) => {
		plugins = items;
	});

	onMount(() => {
		void pluginRegistry.hydrateFromServer();
		return () => unsubscribe();
	});

	async function togglePlugin(pluginId: string, enabled: boolean) {
		syncing = { ...syncing, [pluginId]: true };
		if (enabled) {
			await pluginRegistry.enablePlugin(pluginId);
		} else {
			await pluginRegistry.disablePlugin(pluginId);
		}
		syncing = { ...syncing, [pluginId]: false };
	}

	async function reloadPlugin(pluginId: string) {
		syncing = { ...syncing, [pluginId]: true };
		await pluginRegistry.reloadPlugin(pluginId);
		syncing = { ...syncing, [pluginId]: false };
	}
</script>

<section class="plugin-admin-page">
	<header>
		<h1>Plugin Controls</h1>
		<p>Manage installed plugin status and request backend/frontend reloads.</p>
	</header>

	{#if plugins.length === 0}
		<div class="empty-state">No plugins discovered from backend metadata.</div>
	{:else}
		<ul class="plugin-list">
			{#each plugins as plugin (plugin.id)}
				<li class="plugin-card">
					<div class="plugin-meta">
						<h2>{plugin.manifest.name}</h2>
						<p>{plugin.manifest.description}</p>
						<div class="details">
							<span>v{plugin.manifest.version}</span>
							<span>by {plugin.manifest.author}</span>
							<span class="badge badge-{plugin.status}">{plugin.status}</span>
						</div>
						{#if plugin.loadError}
							<div class="error">{plugin.loadError}</div>
						{/if}
					</div>
					<div class="controls">
						<button on:click={() => togglePlugin(plugin.id, !plugin.enabled)} disabled={!!syncing[plugin.id]}>
							{plugin.enabled ? 'Disable' : 'Enable'}
						</button>
						<button on:click={() => reloadPlugin(plugin.id)} disabled={!!syncing[plugin.id]}>Reload</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.plugin-admin-page {
		max-width: 900px;
		margin: 0 auto;
		padding: 2rem 1rem;
	}
	.plugin-list {
		list-style: none;
		display: grid;
		gap: 1rem;
		padding: 0;
	}
	.plugin-card {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem;
		border: 1px solid rgba(var(--border-rgb), var(--opacity-light));
		border-radius: 0.75rem;
	}
	.details { display: flex; gap: .75rem; font-size: .85rem; opacity: .85; flex-wrap: wrap; }
	.badge { padding: .15rem .5rem; border-radius: 999px; text-transform: capitalize; }
	.badge-enabled { background: rgba(40, 180, 99, .25); }
	.badge-disabled { background: rgba(120, 120, 120, .25); }
	.badge-loading { background: rgba(255, 193, 7, .25); }
	.badge-error { background: rgba(220, 53, 69, .25); }
	.controls { display: flex; gap: .5rem; align-items: center; }
	.error { color: #ef4444; font-size: .85rem; margin-top: .25rem; }
</style>
