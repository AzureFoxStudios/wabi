<script lang="ts">
  import {onMount,onDestroy} from 'svelte';
  import {captureScope,request,HttpError} from './client';
  import {newId} from './model';
  import {openWorkspace} from './navigation';
  import PageView from './PageView.svelte';
  import type {Presentation,PresentationView} from './presentation';
  let {id,notes={},embedded=false,onedit=()=>{}}=$props<{id:string;notes?:Record<string,string>;embedded?:boolean;onedit?:()=>void}>();
  const scope=captureScope();
  let session=$state<Presentation|null>(null),online=$state(false),following=$state(true),ownSlide=$state(''),error=$state(''),busy=$state(false),controllerActive=$state(false);
  let pointer=$state<{x:number;y:number}|null>(null),showNotes=$state(false),personQuery=$state(''),people=$state<{id:number;name:string}[]>([]);
  let stage:HTMLDivElement|undefined,disposed=false,revoked=false,timer:ReturnType<typeof setTimeout>,lastBeat=0,lastPointer=0,localPointer:{x:number;y:number}|null=null;
  const abort=new AbortController();
  const mayControl=$derived(session?.controllerId===scope.userId);
  const selected=$derived(session?.pages.find(p=>p.id===(following?session.slideId:ownSlide))||session?.pages[0]);
  const index=$derived(session&&selected?session.pages.findIndex(p=>p.id===selected.id):0);
  const started=Date.now();let elapsed=$state(0);
  function accept(view:PresentationView|null){if(disposed||!scope.current()||!view)return;if(view.presentation&&(!session||view.presentation.sequence>=session.sequence))session=view.presentation;online=view.controllerOnline;pointer=view.pointer||null;}
  async function poll(){
    if(disposed||!scope.current())return;
    try{
      const view=await request<PresentationView>(scope,`/presentations/${encodeURIComponent(id)}${session?`?since=${session.sequence}`:''}`,'GET',undefined,abort.signal);accept(view);error='';
      if(session&&!session.ended&&mayControl&&controllerActive&&Date.now()-lastBeat>4000){await beat();}
      elapsed=Math.floor((Date.now()-started)/1000);
    }catch(e){if(!disposed){error=e instanceof Error?e.message:String(e);online=false;if(e instanceof HttpError&&[401,403,404].includes(e.status)){session=null;controllerActive=false;revoked=true;return;}}}
    finally{if(!disposed&&!revoked)timer=setTimeout(poll,1200);}
  }
  async function beat(){if(!session)return;await request(scope,`/presentations/${id}/heartbeat`,'POST',{generation:session.generation,pointer:localPointer},abort.signal);lastBeat=Date.now();}
  onMount(()=>{controllerActive=embedded;void poll();});onDestroy(()=>{disposed=true;clearTimeout(timer);abort.abort();});
  async function control(change:Record<string,unknown>){
    if(!session||busy)return;busy=true;
    try{const view=await request<PresentationView>(scope,`/presentations/${id}/control`,'POST',{opId:newId(),generation:session.generation,sequence:session.sequence,...change},abort.signal);accept(view);error='';if(change.controllerId)controllerActive=false;}
    catch(e){if(!disposed)error=e instanceof Error?e.message:String(e);}finally{busy=false;}
  }
  async function resume(){controllerActive=true;try{await beat();online=true;}catch(e){error=String(e);controllerActive=false;}}
  function navigate(offset:number){if(!session)return;const next=session.pages[Math.max(0,Math.min(session.pages.length-1,index+offset))];if(!next)return;if(mayControl&&following&&controllerActive)void control({slideId:next.id});else{following=false;ownSlide=next.id;}}
  function independent(){following=false;ownSlide=selected?.id||'';}
  async function fullscreen(){try{if(!stage)return;if(document.fullscreenElement===stage)await document.exitFullscreen();else await stage.requestFullscreen();}catch(e){error='Fullscreen is unavailable in this window. The presentation remains usable.';}}
  async function search(){try{const r=await request<{people:typeof people}>(scope,`/people?q=${encodeURIComponent(personQuery)}`);if(!disposed)people=r?.people||[];}catch(e){error=String(e);}}
  async function handoff(person:{id:number;name:string}){if(!confirm(`Pass control to ${person.name}? Private speaker notes are not shared.`))return;await control({controllerId:person.id});people=[];}
  function move(event:PointerEvent){if(!mayControl||!controllerActive||!following||Date.now()-lastPointer<180)return;const rect=event.currentTarget instanceof HTMLElement?event.currentTarget.getBoundingClientRect():null;if(!rect)return;localPointer={x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height};lastPointer=Date.now();void beat().catch(()=>{});}
</script>
<div class="audience" aria-label="Presentation viewer">
  <header class="workspace-bar">
    {#if embedded}<button onclick={onedit}>Edit deck</button>{:else}<button onclick={()=>openWorkspace({kind:'library'})}>Library</button>{/if}
    <strong class="title">{session?.title||'Presentation'}</strong>
    <small aria-live="polite">{session?.ended?'Presentation ended':error?'Connection interrupted':online?'Presenter connected':'Presenter disconnected · last slide retained'}</small>
    {#if mayControl&&!controllerActive&&!session?.ended}<button onclick={resume}>Resume presenting</button>{/if}
    {#if mayControl&&controllerActive&&!session?.ended}<button onclick={()=>control({blank:!session?.blank})}>{session?.blank?'Show slide':'Blank screen'}</button><button onclick={()=>{if(confirm('End this presentation? Your voice call will continue.'))void control({end:true});}}>End presentation</button>{/if}
    <button onclick={fullscreen}>Fullscreen</button>
  </header>
  {#if error}<div class="workspace-message" role="alert">{error}</div>{/if}
  {#if session&&selected}
    <div class="audience-stage" bind:this={stage} role="region" aria-label="Slide display" tabindex="0" onkeydown={e=>{if(['ArrowRight','PageDown',' '].includes(e.key)){e.preventDefault();navigate(1);}else if(['ArrowLeft','PageUp'].includes(e.key)){e.preventDefault();navigate(-1);}}}>
      <div class="slide-frame" onpointermove={move} onpointerleave={()=>{localPointer=null;if(mayControl&&controllerActive)void beat().catch(()=>{});}}><PageView page={selected} blank={following&&session.blank} pointer={following?pointer:null} /></div>
    </div>
    <nav class="workspace-bar" aria-label="Slide navigation">
      <button onclick={()=>navigate(-1)} disabled={index===0||busy}>Previous</button><span>{index+1} / {session.pages.length}</span><button onclick={()=>navigate(1)} disabled={index===session.pages.length-1||busy}>Next</button>
      {#if following}<button onclick={independent}>Browse independently</button>{:else}<button onclick={()=>following=true}>Back to presenter</button>{/if}
      <select aria-label="Jump to slide" value={selected.id} onchange={e=>{if(mayControl&&following&&controllerActive)void control({slideId:e.currentTarget.value});else{following=false;ownSlide=e.currentTarget.value;}}}>{#each session.pages as p,i}<option value={p.id}>{i+1}. {p.title||'Slide'}</option>{/each}</select>
      {#if embedded&&mayControl}<small>{Math.floor(elapsed/60)}:{String(elapsed%60).padStart(2,'0')}</small><button onclick={()=>showNotes=!showNotes}>Private notes</button>{/if}
    </nav>
    {#if embedded&&mayControl&&showNotes}<div class="private-notes"><strong>Private · this device only</strong><p>{notes[selected.id]||'No speaker notes for this slide.'}</p></div>{/if}
    {#if mayControl&&controllerActive&&!session.ended}<details class="handoff"><summary>Pass presentation control</summary><label>Find a channel member<input bind:value={personQuery} /></label><button onclick={search}>Search</button>{#each people as p}<button onclick={()=>handoff(p)}>{p.name}</button>{/each}</details>{/if}
  {:else if !error}<div class="workspace-message" role="status">Loading the approved audience revision…</div>{/if}
</div>
<style>
.audience{height:100%;min-height:0;display:flex;flex-direction:column}.audience-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;padding:18px;background:var(--bg-tertiary,var(--surface-base));box-sizing:border-box}.slide-frame{width:min(100%,1100px);max-height:100%}.audience-stage:fullscreen{background:#10151c}.audience-stage:fullscreen .slide-frame{width:min(100vw,177.78vh)}.private-notes{padding:12px 20px;max-height:150px;overflow:auto;border-top:1px solid var(--border-color)}.private-notes p{white-space:pre-wrap}.handoff{padding:10px 16px}.handoff input{margin:8px}
</style>
