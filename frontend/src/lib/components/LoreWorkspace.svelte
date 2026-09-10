<script lang="ts">
	import { currentChannel, channels, currentUser } from '$lib/socket';
	import { switchChannel } from '$lib/channelStore';
	import { getApiBase } from '$lib/api/utils';
	import { activeServerUrl } from '$lib/serverUrl';
	import { getStoredDbUserId } from '$lib/authSession';
	import LoreRepositoryWorkspace from './LoreRepositoryWorkspace.svelte';
	import LoreLocalChanges from './lore/LoreLocalChanges.svelte';
	let mode = $state<'repository' | 'local'>('repository');
	let projects = $derived($channels.filter((channel) => (channel.type as string) === 'lore'));
	let project = $derived(projects.find((channel) => channel.id === $currentChannel) ?? projects[0]);
	let server = $derived.by(() => { void $activeServerUrl; return getApiBase(); });
	let account = $derived.by(() => { void $currentUser; return String(getStoredDbUserId(server) ?? ''); });
	let context = $derived(JSON.stringify([server, account, project?.id]));
</script>

<section class="project-workspace">
	<nav class="workspace-mode" aria-label="Project location">
		<button class:active={mode === 'repository'} aria-pressed={mode === 'repository'} onclick={() => mode = 'repository'}>Repository</button>
		<button class:active={mode === 'local'} aria-pressed={mode === 'local'} onclick={() => mode = 'local'}>Local changes</button>
		{#if mode === 'local' && projects.length}
			<label>Project
				<select value={project?.id} onchange={(event) => switchChannel(event.currentTarget.value)}>
					{#each projects as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
				</select>
			</label>
		{/if}
	</nav>
	<div class="workspace-body">
		{#if mode === 'repository'}
			<LoreRepositoryWorkspace />
		{:else if project && account}
			{#key context}
				<LoreLocalChanges channelId={project.id} projectName={project.name} serverUrl={server} accountId={account} />
			{/key}
		{:else}
			<p class="empty">Create or select a Project channel in Repository first.</p>
		{/if}
	</div>
</section>

<style>
	.project-workspace { height: 100%; min-height: 0; display: flex; flex-direction: column; }
	.workspace-mode { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; padding: 0.5rem 1rem; border-bottom: 1px solid var(--border-color); }
	.workspace-mode button { padding: 0.5rem 0.75rem; background: transparent; border: 0; border-bottom: 2px solid transparent; color: var(--text-secondary); cursor: pointer; }
	.workspace-mode button.active { color: var(--text-primary); border-bottom-color: var(--accent-color, currentColor); }
	.workspace-mode label { margin-left: auto; display: flex; align-items: center; gap: 0.5rem; font-size: 0.875rem; }
	.workspace-mode select { max-width: 20rem; color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border-color); padding: 0.4rem; }
	.workspace-body { flex: 1; min-height: 0; overflow: auto; }
	.empty { padding: 1rem; color: var(--text-secondary); }
</style>
