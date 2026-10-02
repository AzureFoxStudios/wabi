<script lang="ts">
	import { channels, currentChannel } from '$lib/socket';
	import { switchChannel } from '$lib/channelStore';
	import ProjectAssistant from './ProjectAssistant.svelte';
	import SharedProjectBoard from './business/SharedProjectBoard.svelte';
	import WikiChannel from './WikiChannel.svelte';
	import LoreWorkspace from './LoreWorkspace.svelte';
    import ProjectConnections from './ProjectConnections.svelte';
    import { fetchPluginInventory } from '$lib/addonInventory';
    import { getServerUrl } from '$lib/serverUrl';
    import { pendingNav } from '$lib/pendingNav';
    import { onMount } from 'svelte';
	let { discussionActive = false, discussionAvailable = false, onDiscussionChange = () => {} }: {
		discussionActive?: boolean;
		discussionAvailable?: boolean;
		onDiscussionChange?: (active: boolean) => void;
	} = $props();

	type ProjectChannel = { id: string; name: string; type?: string | null };
	let remembered: string | null = $state(null);
	let tab: 'plan' | 'wiki' | 'files' | 'assistant' | 'connections' = $state('plan');
    let connectionsEnabled=$state(false);
    onMount(()=>{
        let disposed=false;
        const refresh=async()=>{
            const origin=getServerUrl();const inventory=await fetchPluginInventory();
            if(disposed || origin!==getServerUrl())return;
            connectionsEnabled=!!inventory?.some(a=>a.id==='project-workers' && a.enabled===true);
            if(!connectionsEnabled && tab==='connections')tab='plan';
        };
        void refresh();const poll=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},15000);
        return()=>{disposed=true;clearInterval(poll);};
    });
	let projects = $derived(($channels as ProjectChannel[]).filter(channel => channel.type === 'planning' || channel.type === 'lore'));
	let selected = $derived(projects.find(channel => channel.id === $currentChannel)
		?? projects.find(channel => channel.id === remembered) ?? projects[0]);
	$effect(() => { if ($pendingNav?.kind === 'lore_file' && selected?.id === $pendingNav.channelId) { tab = 'files'; onDiscussionChange(false); } });
	function choose(event: Event): void {
		const id = (event.currentTarget as HTMLSelectElement).value;
		remembered = id;
		switchChannel(id);
		if (projects.find(channel => channel.id === id)?.type !== 'lore' && tab === 'files') tab = 'plan';
	}
	function openView(view: 'plan' | 'wiki' | 'files' | 'assistant' | 'connections'): void {
		tab = view;
		onDiscussionChange(false);
	}
</script>

<section class="project-workspace" class:discussion-active={discussionActive} aria-label="Project workspace">
	{#if selected}
		<header class="project-hero">
			<div class="project-identity">
				<div class="project-mark" aria-hidden="true">
					<svg viewBox="0 0 32 32" fill="none"><path d="M7 9.5h18M7 16h18M7 22.5h12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="24.5" cy="22.5" r="2.5" fill="currentColor"/></svg>
				</div>
				<div class="project-title-block">
					<p class="project-eyebrow"><span class="project-presence"></span> Shared project space</p>
					<h1>{selected.name}</h1>
					<p class="project-subtitle">The work and the knowledge behind it, together.</p>
				</div>
			</div>
			<label class="project-picker"><span>Switch project</span>
				<select value={selected.id} onchange={choose} aria-label="Choose project">
					{#each projects as project (project.id)}<option value={project.id}>{project.name}</option>{/each}
				</select>
			</label>
		</header>
		<div class="project-nav-row">
			<nav class="project-tabs" aria-label="Project views">
				<button type="button" class:active={!discussionActive && tab === 'plan'} aria-current={!discussionActive && tab === 'plan' ? 'page' : undefined} onclick={() => openView('plan')}><span aria-hidden="true">▦</span> Board</button>
				<button type="button" class:active={!discussionActive && tab === 'wiki'} aria-current={!discussionActive && tab === 'wiki' ? 'page' : undefined} onclick={() => openView('wiki')}><span aria-hidden="true">▤</span> Wiki</button>
				<button type="button" class:active={!discussionActive && tab === 'assistant'} aria-current={!discussionActive && tab === 'assistant' ? 'page' : undefined} onclick={() => openView('assistant')}><span aria-hidden="true">✧</span> Assistant</button>
                {#if connectionsEnabled}<button type="button" class:active={!discussionActive && tab==='connections'} aria-current={!discussionActive && tab==='connections'?'page':undefined} onclick={()=>openView('connections')}><span aria-hidden="true">◈</span> Connections</button>{/if}
				{#if selected.type === 'lore'}<button type="button" class:active={!discussionActive && tab === 'files'} aria-current={!discussionActive && tab === 'files' ? 'page' : undefined} onclick={() => openView('files')}><span aria-hidden="true">◇</span> Files</button>{/if}
				{#if discussionAvailable}<button type="button" class:active={discussionActive} aria-current={discussionActive ? 'page' : undefined} onclick={() => onDiscussionChange(true)}><span aria-hidden="true">◌</span> Discussion</button>{/if}
			</nav>

		</div>
		{#if discussionActive}<div class="discussion-intro"><strong>Project discussion</strong><span>Messages shared with the people in this project.</span></div>{/if}
		{#if !discussionActive}<div class="project-content">
			{#key selected.id}
				{#if tab === 'plan'}<SharedProjectBoard channelId={selected.id} />
				{:else if tab === 'assistant'}<ProjectAssistant channelId={selected.id} />
                {:else if tab === 'connections' && connectionsEnabled}<ProjectConnections channelId={selected.id} />
				{:else if tab === 'wiki'}<WikiChannel channelId={selected.id} draftSurface="project" />
				{:else if selected.type === 'lore'}<LoreWorkspace />
				{:else}<SharedProjectBoard channelId={selected.id} />{/if}
			{/key}
		</div>{/if}
	{:else}
		<div class="project-empty"><h1>No project yet</h1><p>Create a Planning channel to share cards and wiki pages with your team and authorized agents.</p><button type="button" onclick={() => window.dispatchEvent(new CustomEvent('wabi:create-channel', { detail: { type: 'planning' } }))}>Create project</button></div>
	{/if}
</section>

<style>
	.project-workspace { flex:1; width:100%; height:100%; min-height:0; min-width:0; display:flex; flex-direction:column; color:var(--text-primary); background:var(--surface-base); }
	.project-workspace.discussion-active { flex:none; height:auto; }
	.project-hero { position:relative; overflow:hidden; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:1rem 2rem; padding:1.35rem clamp(1rem, 3vw, 2.25rem); padding-right:4rem; border-bottom:1px solid var(--border-subtle); background:radial-gradient(circle at 92% 2%, color-mix(in srgb, var(--accent-primary, #9b6bff) 20%, transparent), transparent 42%), linear-gradient(125deg, color-mix(in srgb, var(--surface-raised) 76%, var(--surface-base)), var(--surface-base)); }
	.project-hero::after { content:''; position:absolute; width:16rem; height:16rem; border:1px solid color-mix(in srgb, var(--accent-primary, #9b6bff) 12%, transparent); border-radius:50%; right:-5rem; top:-11rem; pointer-events:none; }
	.project-identity { display:flex; align-items:center; gap:1rem; min-width:0; }
	.project-mark { flex:none; display:grid; place-items:center; width:3.2rem; height:3.2rem; border-radius:1rem; color:var(--accent-primary, #b69cff); background:color-mix(in srgb, var(--accent-primary, #9b6bff) 16%, var(--surface-base)); border:1px solid color-mix(in srgb, var(--accent-primary, #9b6bff) 27%, transparent); box-shadow:0 10px 28px color-mix(in srgb, var(--accent-primary, #9b6bff) 12%, transparent); }
	.project-mark svg { width:1.75rem; height:1.75rem; }
	.project-title-block { min-width:0; }
	.project-eyebrow { display:flex; align-items:center; gap:.42rem; margin:0 0 .28rem; color:var(--text-secondary); font-size:.68rem; font-weight:750; text-transform:uppercase; letter-spacing:.14em; }
	.project-presence { width:.42rem; height:.42rem; border-radius:50%; background:#62d6a8; box-shadow:0 0 0 3px #62d6a825; }
	.project-title-block h1 { margin:0; overflow:hidden; text-overflow:ellipsis; font-size:clamp(1.45rem, 2.4vw, 2rem); font-weight:760; line-height:1.15; letter-spacing:-.035em; }
	.project-subtitle { margin:.32rem 0 0; color:var(--text-secondary); font-size:.82rem; }
	.project-picker { position:relative; z-index:1; display:grid; gap:.35rem; min-width:11rem; font-size:.72rem; font-weight:650; color:var(--text-secondary); }
	.project-picker select { width:100%; max-width:16rem; padding:.56rem .7rem; border:1px solid var(--border-default); border-radius:.7rem; background:var(--surface-raised); color:var(--text-primary); font:inherit; font-size:.82rem; }
	.project-nav-row { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.45rem 4rem 0 clamp(1rem, 3vw, 2.25rem); border-bottom:1px solid var(--border-subtle); }
	.project-tabs { display:flex; align-items:center; gap:.25rem; min-width:0; overflow-x:auto; }
	.project-tabs button { position:relative; display:inline-flex; align-items:center; gap:.5rem; min-height:2.7rem; padding:.55rem .85rem .75rem; border:0; background:transparent; color:var(--text-secondary); font:inherit; font-size:.85rem; font-weight:630; white-space:nowrap; cursor:pointer; }
	.project-tabs button span { font-size:1rem; opacity:.7; }
	.project-tabs button:hover, .project-tabs button.active { color:var(--text-primary); }
	.project-tabs button.active::after { content:''; position:absolute; bottom:0; left:.65rem; right:.65rem; height:2px; border-radius:3px; background:var(--accent-primary, #9b6bff); box-shadow:0 0 12px color-mix(in srgb, var(--accent-primary, #9b6bff) 65%, transparent); }
	.project-sync-note { display:flex; align-items:center; gap:.4rem; color:var(--text-muted, var(--text-secondary)); font-size:.72rem; white-space:nowrap; }
	.project-sync-note span { color:#62d6a8; font-size:.5rem; }
	.project-content { flex:1; width:100%; min-height:0; min-width:0; }
	.project-content :global(.wiki-channel) { width:100%; min-width:0; }
	.discussion-intro { display:flex; align-items:baseline; gap:.75rem; padding:.8rem clamp(1rem, 3vw, 2.25rem); border-bottom:1px solid var(--border-subtle); background:color-mix(in srgb, var(--surface-raised) 45%, var(--surface-base)); }
	.discussion-intro strong { font-size:.84rem; }
	.discussion-intro span { color:var(--text-secondary); font-size:.76rem; }
	.project-empty { max-width:40rem; margin:2rem auto; padding:1.25rem; }
	.project-empty button { padding:.6rem .9rem; border:1px solid var(--border-default); border-radius:.5rem; background:var(--surface-raised); color:var(--text-primary); cursor:pointer; }
	@media (max-width:700px) { .project-hero { align-items:flex-start; padding:1rem; } .project-mark { width:2.6rem; height:2.6rem; border-radius:.8rem; } .project-picker { width:100%; } .project-picker select { max-width:none; } .project-nav-row { padding-inline:.65rem; } .project-sync-note { display:none; } .discussion-intro { align-items:flex-start; flex-direction:column; gap:.15rem; padding-inline:1rem; } }
</style>
