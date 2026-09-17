<script lang="ts">
  import {onMount,onDestroy,type Component} from 'svelte';
  import {get,writable} from 'svelte/store';
  import {ArtifactSession,captureScope,type SessionState} from './client';
  import {changes,type Fields,type Json} from './model';
  import {openWorkspace,type Selection} from './navigation';
  import {downloadJson,loadOriginal,downloadBlob} from './storage';
  import {workspaceTools,registerCloser} from './tools';
  import DocumentEditor from './DocumentEditor.svelte';
  import SharePanel from './SharePanel.svelte';
  import ReviewPanel from './ReviewPanel.svelte';
  let {selection}=$props<{selection:Selection}>();
  let session=$state<ArtifactSession|null>(null),Editor=$state<Component<any>|null>(null);
  let error=$state(''),loading=$state(true),panel=$state<'share'|'review'|null>(selection.shareRequested?'share':null),field=$state('text');
  const empty=writable<SessionState>({draft:{v:1,key:'',scope:'',writer:'',id:'',kind:'document',base:null,fields:{},conflicts:[],updatedAt:0,privateNotes:{}},access:'viewer',save:'saved',network:'local',error:null});
  const store=$derived(session?.state||empty);
  let unregister:(()=>void)|undefined,disposed=false;
  async function initialize(){
    try{
      let kind=selection.kind;if(kind!=='document'&&kind!=='sheet'&&kind!=='deck')throw new Error('Unknown editor');
      const s=await ArtifactSession.open(captureScope(),selection.id,kind,selection.seed,selection.draftKey);
      if(disposed||!s.scope.current()){s.abortOnUnmount();return;}
      session=s;kind=get(s.state).draft.kind;if(selection.sourceId||selection.originalId)await s.annotate(selection.sourceId,selection.originalId);
      if(selection.privateNotes)await s.restorePrivateNotes(selection.privateNotes);
      if(kind==='document')Editor=DocumentEditor;
      else {
        const tool=get(workspaceTools)[kind==='sheet'?'sheets':'present'];
        if(!tool)throw new Error('Enable this addon in the workspace library before opening its editor. Your saved work is unchanged.');
        const loaded=await tool.load();if(disposed||!s.scope.current())return;Editor=loaded.default;
        unregister=registerCloser(tool.id,async()=>{await s.close();if(!disposed){Editor=null;openWorkspace({kind:'library'});}});
      }
    }catch(e){error=e instanceof Error?e.message:String(e);}finally{if(!disposed)loading=false;}
  }
  onMount(()=>{void initialize();const warn=(event:BeforeUnloadEvent)=>{if(session&&get(session.state).save!=='saved'){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);});
  onDestroy(()=>{disposed=true;unregister?.();session?.abortOnUnmount();});
  async function leave(){try{if(session)await session.flush();openWorkspace({kind:'library'});}catch(e){error=String(e);}}
  async function privateCopy(){if(!session)return;try{await session.flush();const s=get(session.state);openWorkspace({kind:s.draft.kind,seed:structuredClone(s.draft.fields),sourceId:s.draft.id,privateNotes:structuredClone(s.draft.privateNotes)});}catch(e){error=String(e);}}
  async function original(){if(!session)return;try{const d=get(session.state).draft;if(!d.originalId)return;const f=await loadOriginal(session.scope.key,d.originalId);if(!session.scope.current())return;if(!f)throw new Error('Original file is not available on this device.');downloadBlob(f.name,f.blob);}catch(e){error=String(e);}}
  async function copyLink(){if(!session)return;const d=get(session.state).draft;const url=new URL(session.scope.server);url.searchParams.set('wabiArtifact',d.id);try{await navigator.clipboard.writeText(url.href);}catch{error='Clipboard unavailable. Artifact ID: '+d.id;}}
  function showField(key:string){field=key;}
</script>
{#if loading}<div class="workspace-message" role="status">Opening saved workspace…</div>{/if}
{#if error}<div class="workspace-message" role="alert">{error}<button onclick={leave}>Workspace library</button></div>{/if}
{#if session}
  {@const readonly=Boolean($store.draft.base&&$store.access!=='owner'&&($store.access!=='editor'||$store.draft.base.mode==='snapshot'))}
  <header class="workspace-bar">
    <button onclick={leave}>Library</button>
    <input class="title" aria-label="Artifact title" value={String($store.draft.fields.title||'')} readonly={readonly} maxlength="250" oninput={e=>session?.edit('title',e.currentTarget.value)} />
    <small aria-live="polite">{$store.save==='saving'?'Saving on this device…':$store.save==='error'?'Local save failed':'Saved on this device'}<br />{!$store.draft.base?'Private · this device':$store.draft.conflicts.length?'Conflict needs review':$store.draft.resumeRequired?'Review required':$store.network==='synced'&&changes($store.draft.base,$store.draft.fields).length===0?'Synced to this server':$store.network==='offline'?'Offline · changes remain here':$store.network==='blocked'?'Sharing unavailable':$store.draft.base.mode==='snapshot'?'Unpublished local revision':'Waiting to sync'}</small>
    {#if !$store.draft.base||$store.access==='owner'}<button onclick={()=>panel=panel==='share'?null:'share'}>{$store.draft.base?'Manage access':'Share…'}</button>{/if}
    {#if $store.draft.base?.mode==='snapshot'&&$store.access==='owner'}<button onclick={()=>session?.sync(true)}>Publish revision</button>{/if}
    {#if $store.draft.base}<button onclick={copyLink}>Copy link</button><button onclick={()=>panel=panel==='review'?null:'review'}>Review</button>{/if}
    <button onclick={privateCopy}>Private copy</button>
    <button onclick={()=>downloadJson('wabi-content.json',{v:1,format:'wabi-artifact',kind:$store.draft.kind,fields:$store.draft.fields})}>Export native</button>
    <button onclick={()=>downloadJson('wabi-private-recovery.json',{v:1,format:'wabi-recovery',draft:$store.draft})}>Private backup</button>
    {#if $store.draft.originalId}<button onclick={original}>Original file</button>{/if}
  </header>
  {#if $store.error}<div class="workspace-message" role="alert">{$store.error}<button onclick={()=>session?.retry()}>Retry</button></div>{/if}
  {#if $store.draft.resumeRequired}<div class="workspace-message">Access or collaboration mode changed. Your local edits are preserved.<button onclick={()=>session?.resume().catch(e=>error=String(e))}>Review accepted · resume</button></div>{/if}
  {#if $store.draft.conflicts.length}
    <details class="workspace-conflict" open><summary>{$store.draft.conflicts.length} conflicting field(s) — neither version was discarded</summary>
      {#each $store.draft.conflicts as c (c.key)}<article><strong>{c.key}</strong><div class="versions"><div><small>Your version</small><pre>{JSON.stringify(c.mine,null,2)??'(deleted)'}</pre><button onclick={()=>session?.resolve(c.key,'mine')}>Keep mine</button></div><div><small>Shared version</small><pre>{JSON.stringify(c.theirs,null,2)??'(deleted)'}</pre><button onclick={()=>session?.resolve(c.key,'theirs')}>Use shared</button></div></div></article>{/each}
    </details>
  {/if}
  <div class="workspace-main" class:has-pane={Boolean(panel)}>
    <div class="workspace-content">{#if Editor}<Editor {session} {readonly} onfield={showField} onreview={(key:string)=>{field=key;panel='review';}} />{/if}</div>
    {#if panel==='share'}<SharePanel {session} initialMode={selection.initialMode} onclose={()=>panel=null} />{:else if panel==='review'}<ReviewPanel {session} {field} onclose={()=>panel=null} />{/if}
  </div>
{/if}
