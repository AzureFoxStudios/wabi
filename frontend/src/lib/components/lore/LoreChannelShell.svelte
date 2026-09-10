<script lang="ts">
	import { onMount } from 'svelte';
	import { currentChannel, currentUser, channels } from '$lib/socket';
	import { switchChannel } from '$lib/channelStore';
	import { activeServerUrl } from '$lib/serverUrl';
	import { getApiBase } from '$lib/api/utils';
	import { getStoredDbUserId, onAuthSessionCleared } from '$lib/authSession';
	import LoreProjectWorkspace from './LoreProjectWorkspace.svelte';

	let { channelKey, projectPicker = false }: { channelKey?: string; projectPicker?: boolean } = $props();
	let sessionEpoch = $state(0);
	let remembered = $state<string | null>(null);
	let projects = $derived($channels.filter(channel => (channel.type as string) === 'lore'));
	let requested = $derived(channelKey ?? $currentChannel);
	let chosen = $derived(projects.find(channel => channel.id === requested) ??
		(projectPicker ? projects.find(channel => channel.id === remembered) ?? projects[0] : undefined));
	let server = $derived.by(() => { void $activeServerUrl; return getApiBase(); });
	let account = $derived.by(() => { void $currentUser; return String(getStoredDbUserId(server) ?? ''); });
	let context = $derived(JSON.stringify([server, account, sessionEpoch, chosen?.id]));
	onMount(() => {
		try { remembered = localStorage.getItem('wabi:lastLoreChannelId'); } catch { /* Storage can be disabled. */ }
		return onAuthSessionCleared(() => { sessionEpoch++; });
	});
	function select(id: string) {
		remembered = id;
		try { localStorage.setItem('wabi:lastLoreChannelId', id); } catch { /* Session selection still works. */ }
		switchChannel(id);
	}
</script>

{#if chosen}
	{#key context}
		<LoreProjectWorkspace channelKey={chosen.id} projectName={chosen.name} serverUrl={server} accountId={account}
			roleName={$currentUser?.highestRole ?? ''} projects={projectPicker ? projects : []}
			onSelectProject={projectPicker ? select : undefined} />
	{/key}
{:else}
	<section class="lore-empty-project"><h2>No project selected</h2><p>Create a Project channel or choose an existing one from your channel list.</p><button onclick={() => window.dispatchEvent(new CustomEvent('wabi:create-channel', { detail: { type: 'lore' } }))}>New project channel</button></section>
{/if}

<style>
	.lore-empty-project { padding:40px; max-width:65ch; color:var(--text-primary); background:var(--bg-primary); border:1px solid var(--border-color); border-radius:12px; margin:24px; line-height:1.6; }
	.lore-empty-project h2 { font-size:22px; }
	.lore-empty-project button { padding:10px 16px; border:1px solid var(--accent-color, currentColor); border-radius:8px; color:inherit; background:var(--bg-secondary); font:inherit; cursor:pointer; }
</style>
