<script lang="ts">
  import {onMount,onDestroy} from 'svelte';
  import {get} from 'svelte/store';
  import {currentChannel} from '$lib/channelStore';
  import {enableAddon,disableAddon,getEnabledAddons,saveEnabledAddonIds} from '$lib/addons/loader';
  import {workspaceAddonManifests} from '$lib/addons/workspaceEntries';
  import {workspaceTools} from './tools';
  import {captureScope,request} from './client';
  import {validateNativeFields} from './validate';
  import {listDrafts,downloadJson,deleteDraft} from './storage';
  import {openWorkspace,closeWorkspace} from './navigation';
  import {newId,safeKey,type Draft,type ArtifactKind,type Fields} from './model';
  const scope=captureScope();
  let drafts=$state<Draft[]>([]),shared=$state<{id:string;title:string;kind:ArtifactKind;mode:string;access:string}[]>([]),next=$state<string|null>(null);
  let presentations=$state<{id:string;title:string}[]>([]),error=$state(''),busy=$state(false),alive=true;
  let capabilities=$state<{sheets:boolean;present:boolean;documents:boolean;canConfigure:boolean}|null>(null);
  const latest=$derived([...new Map([...drafts].reverse().map(d=>[d.id,d])).values()].sort((a,b)=>b.updatedAt-a.updatedAt));
  onMount(()=>{void refresh();});onDestroy(()=>{alive=false;});
  const current=()=>alive&&scope.current();
  async function refresh(){
    busy=true;error='';
    try{const local=await listDrafts(scope.key);if(current())drafts=local;}catch(e){if(current())error=String(e);}
    if(scope.token)try{
      const [items,cap]=await Promise.all([request<{artifacts:typeof shared;next:string|null}>(scope,'/'),request<typeof capabilities>(scope,'/capabilities')]);
      if(current()){shared=items?.artifacts||[];next=items?.next||null;capabilities=cap;}
      if(cap?.present){const rooms=await request<{presentations:typeof presentations}>(scope,`/presentations?channel=${encodeURIComponent(get(currentChannel))}`);if(current())presentations=rooms?.presentations||[];}
    }catch(e){if(current())error='Local work is available. Server workspace: '+(e instanceof Error?e.message:String(e));}
    if(current())busy=false;
  }
  async function more(){if(!next)return;try{const r=await request<{artifacts:typeof shared;next:string|null}>(scope,`/?after=${encodeURIComponent(next)}`);if(current()&&r){shared=[...shared,...r.artifacts];next=r.next;}}catch(e){if(current())error=String(e);}}
  async function toggle(id:string,on:boolean){
    try{error='';if(on)await enableAddon(id);else await disableAddon(id);if(!current())return;await saveEnabledAddonIds(getEnabledAddons().map(a=>a.id));}
    catch(e){if(current())error=e instanceof Error?e.message:String(e);}
  }
  async function create(kind:ArtifactKind){try{if(kind==='document'){openWorkspace({kind,seed:{title:'Untitled document',text:'',format:'markdown'}});return;}const tool=get(workspaceTools)[kind==='sheet'?'sheets':'present'];if(!tool)throw new Error('Enable the addon first.');const seed=await tool.create();if(current())openWorkspace({kind,seed});}catch(e){if(current())error=String(e);}}
  async function configure(which:'sheets'|'present',enabled:boolean){if(!capabilities)return;try{const c=await request<typeof capabilities>(scope,'/capabilities','PUT',{opId:newId(),sheets:which==='sheets'?enabled:capabilities.sheets,present:which==='present'?enabled:capabilities.present});if(current())capabilities=c;}catch(e){if(current())error=String(e);}}
  async function importNative(event:Event){
    const input=event.currentTarget as HTMLInputElement,file=input.files?.[0];input.value='';if(!file)return;
    try{
      if(file.size>32*1024*1024)throw new Error('Native import exceeds 32 MiB.');
      const data=JSON.parse(await file.text());if(!current())return;
      const recovered=data.format==='wabi-recovery'?data.draft:null;
      const kind=recovered?.kind??data.kind,fields=recovered?.fields??data.fields;
      if(data.v!==1||!['wabi-artifact','wabi-recovery'].includes(data.format)||!['document','sheet','deck'].includes(kind))throw new Error('Not a supported Wabi export or recovery copy.');
      validateNativeFields(kind,fields);
      let privateNotes:Record<string,string>|undefined;
      if(recovered?.privateNotes){
        const notes=recovered.privateNotes;if(!notes||typeof notes!=='object'||Array.isArray(notes)||Object.keys(notes).length>1000||Object.entries(notes).some(([k,v])=>!safeKey(k)||typeof v!=='string'||v.length>100000))throw new Error('Invalid private recovery notes.');
        privateNotes=notes;
      }
      // Imported recovery is deliberately a NEW PRIVATE artifact. Untrusted file
      // metadata never restores server ACLs, authorship, revision, or ownership.
      openWorkspace({kind,seed:fields as Fields,privateNotes});
    }catch(e){if(current())error=e instanceof Error?e.message:String(e);}
  }
  async function trash(d:Draft){if(!confirm('Remove this device recovery copy? Shared content and other copies remain unchanged.'))return;try{await deleteDraft(scope.key,d.key);await refresh();}catch(e){error=String(e);}}
</script>
<div class="workspace-bar"><button onclick={closeWorkspace}>Return to Reader</button><strong>Workspace library</strong><button onclick={refresh} disabled={busy}>Refresh</button></div>
<div class="workspace-list">
  <h1>Your work, on this device and this server</h1><p>Creating or importing does not upload anything. Share explicitly when the content is ready.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  <div class="cards">
    <section class="card"><strong>Documents</strong><p>Write locally, publish a revision, or collaborate with selected people.</p><button onclick={()=>create('document')}>New document</button></section>
    {#each [{id:'sheets',kind:'sheet',name:'Sheets',description:'Spreadsheets, formulas and workbook files.'},{id:'present',kind:'deck',name:'Present',description:'Create a deck and present it to a room.'}] as tool}
      <section class="card"><strong>{tool.name}</strong><p>{tool.description}</p>
        {#if workspaceAddonManifests[tool.id]}
          {#if $workspaceTools[tool.id]}<button onclick={()=>create(tool.kind as ArtifactKind)}>New {tool.kind==='deck'?'presentation':'sheet'}</button><button onclick={()=>toggle(tool.id,false)}>Disable on this device</button>{:else}<button onclick={()=>toggle(tool.id,true)}>Enable {tool.name} on this device</button>{/if}
        {:else}<small>Not included in this lean build. Use a build with the {tool.name} addon selected; no download installer is being implied.</small>{/if}
        {#if capabilities}<small>Server sharing: {capabilities[tool.id as 'sheets'|'present']?'enabled':'disabled'}</small>{/if}
      </section>
    {/each}
  </div>
  {#if capabilities?.canConfigure}<details><summary>Server workspace settings</summary><p>These switches allow server-side sharing. They do not install tools on members’ devices.</p><label><input type="checkbox" checked={capabilities.sheets} onchange={e=>configure('sheets',e.currentTarget.checked)} /> Allow shared spreadsheets</label><br /><label><input type="checkbox" checked={capabilities.present} onchange={e=>configure('present',e.currentTarget.checked)} /> Allow shared decks and presentations</label></details>{/if}
  <h2>Device drafts</h2>
  <label>Import native content<input type="file" accept=".json,application/json" onchange={importNative} /></label>
  {#if !latest.length}<p>No native workspace drafts here yet. Existing Reader documents remain available through Return to Reader.</p>{/if}
  {#each latest as d (d.id)}<button class="item" onclick={()=>openWorkspace({kind:d.kind,id:d.id,draftKey:d.key})}><span>{String(d.fields.title||'Untitled')}</span><small>{d.kind} · {d.base?'shared working copy':'private'} · {new Date(d.updatedAt).toLocaleDateString()}</small></button>{/each}
  {#if drafts.length}<details><summary>Recovery copies ({drafts.length})</summary><p>Separate windows keep separate recovery records. Export before removing a copy you may still need.</p>{#each drafts as d}<div class="workspace-bar"><span>{String(d.fields.title||'Untitled')} · {new Date(d.updatedAt).toLocaleString()}</span><button onclick={()=>downloadJson('wabi-private-recovery.json',{v:1,format:'wabi-recovery',draft:d})}>Private backup</button><button onclick={()=>trash(d)}>Remove this copy</button></div>{/each}</details>{/if}
  <h2>Shared with you</h2>{#if !scope.token}<p>Sign in to use server sharing. Local work does not require a connection.</p>{/if}
  {#each shared as item (item.id)}<button class="item" onclick={()=>openWorkspace({kind:item.kind,id:item.id})}><span>{item.title}</span><small>{item.kind} · {item.mode} · {item.access}</small></button>{/each}
  {#if next}<button onclick={more}>More shared work</button>{/if}
  {#if presentations.length}<h2>Presentations in the current channel</h2>{#each presentations as room}<button class="item" onclick={()=>openWorkspace({kind:'audience',id:room.id})}><span>{room.title}</span><span>Join presentation</span></button>{/each}{/if}
</div>
