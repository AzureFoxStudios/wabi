<script lang="ts">
    import { onMount, type Component } from 'svelte';
    import { notebookOwner } from '$lib/notes/scope';
    import { hydrateWorkspaceAddons, setWorkspaceAddonEnabled, workspaceAddonEnabled } from './addonState';
    import { captureScope, request, type Tool } from './bridge';
    import './workspace.css';
    let { tool }: { tool: Tool } = $props();
    let WorkspaceComponent = $state<Component | null>(null);
    let ready = $state(false), available = $state(true), loading = $state(false), error = $state('');
    let capabilities = $state<{documents:boolean;sheets:boolean;present:boolean;admin:boolean;officeConversion:boolean}|null>(null);
    let requestGeneration = 0;
    const enabled = $derived(tool === 'sheets' || tool === 'present' ? $workspaceAddonEnabled[tool] : true);
    const scopeKey = $derived($notebookOwner.owner?.scopeId || 'waiting-for-account');
    async function load(selected:Tool, generation:number) {
        WorkspaceComponent=null;loading=true;error='';available=true;
        try {
            if(selected==='sheets'||selected==='present') {
                const entry=selected==='sheets'?await import('@wabi/workspace-sheets'):await import('@wabi/workspace-present');
                if(generation!==requestGeneration)return;available=entry.available;
                if(!entry.available||!enabled)return;
                const module=await entry.loadWorkspace();if(generation===requestGeneration)WorkspaceComponent=module.default;
            } else {
                const module=selected==='documents'?await import('./DocumentsWorkspace.svelte'):await import('./AudienceWorkspace.svelte');
                if(generation===requestGeneration)WorkspaceComponent=module.default;
            }
        } catch(e){if(generation===requestGeneration)error=e instanceof Error?e.message:String(e);}
        finally{if(generation===requestGeneration)loading=false;}
    }
    $effect(()=>{const selected=tool;const permitted=enabled;const identity=scopeKey;if(ready){permitted;identity;void load(selected,++requestGeneration);}});
    async function enable(){if(tool!=='sheets'&&tool!=='present')return;try{error='';await setWorkspaceAddonEnabled(tool,true);}catch(e){error=e instanceof Error?e.message:String(e);}}
    async function disable(){if(tool!=='sheets'&&tool!=='present')return;try{await setWorkspaceAddonEnabled(tool,false);}catch(e){error=e instanceof Error?e.message:String(e);}}
    async function serverSettings(){try{error='';const scope=await captureScope();capabilities=await request(scope,'/capabilities');}catch(e){error=e instanceof Error?e.message:String(e);}}
    async function saveServerSettings(){if(!capabilities?.admin)return;try{error='';const scope=await captureScope();capabilities=await request(scope,'/capabilities',{sheets:capabilities.sheets,present:capabilities.present},'PUT');}catch(e){error=e instanceof Error?e.message:String(e);}}
    onMount(()=>{let live=true;void hydrateWorkspaceAddons().catch(e=>error=e.message).finally(()=>{if(live)ready=true;});return()=>{live=false;requestGeneration++;};});
</script>
<section class="workspace-host">
    <div class="workspace-host-controls">
        {#if (tool==='sheets'||tool==='present')&&available&&enabled}<button onclick={()=>void disable()}>Disable {tool==='sheets'?'Sheets':'Present'} on this device</button>{/if}
        <button onclick={()=>void serverSettings()}>Workspace server settings</button>
    </div>
    {#if capabilities}<div class="workspace-host-settings"><span>Shared Documents are available. Office workspaces use the same account and permission service.</span>
        {#if capabilities.admin}<label><input type="checkbox" bind:checked={capabilities.sheets}/> Allow shared spreadsheets</label><label><input type="checkbox" bind:checked={capabilities.present}/> Allow shared decks and presentations</label><button onclick={()=>void saveServerSettings()}>Save server settings</button>
        {:else}<span>Shared Sheets: {capabilities.sheets?'enabled':'disabled'} · Present: {capabilities.present?'enabled':'disabled'}</span>{/if}
        <button onclick={()=>capabilities=null}>Close settings</button>
    </div>{/if}
    {#if error}<p class="workspace-home-note" role="alert">{error}</p>{/if}
    {#if !available}<div class="workspace-home-note"><h2>{tool==='sheets'?'Sheets':'Present'} is not included in this build</h2><p>This minimal build excludes the authoring engine. Use the separately built workspace edition to enable it. Your existing files are retained; no automatic download or remote code import takes place.</p></div>
    {:else if !enabled}<div class="workspace-home-note"><h2>Enable {tool==='sheets'?'Sheets':'Present'}</h2><p>This addon is off on this device. Enabling it does not share files or enable the other office addon. Its editor loads only while you open the workspace.</p><button onclick={()=>void enable()}>Enable addon</button></div>
    {:else if WorkspaceComponent}{#key `${tool}:${scopeKey}`}<div class="workspace-host-body"><WorkspaceComponent/></div>{/key}
    {:else if loading||!ready}<p class="workspace-home-note" role="status">Opening workspace…</p>{/if}
</section>
<style>.workspace-host{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--surface-base,#161826);color:var(--text-primary,#eef0f8)}.workspace-host-controls,.workspace-host-settings{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;padding:.45rem .7rem;border-bottom:1px solid var(--border-subtle,#35384c);font:12px system-ui}.workspace-host button{background:var(--surface-raised,#25293f);color:inherit;border:1px solid var(--border-subtle,#484c66);border-radius:5px;padding:.4rem .6rem;cursor:pointer}.workspace-host-body{flex:1;min-height:0}.workspace-host-settings{font-size:14px}.workspace-host-settings label{display:flex;gap:.4rem}</style>
