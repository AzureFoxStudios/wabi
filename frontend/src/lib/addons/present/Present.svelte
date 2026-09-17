<script lang="ts">
  import {onDestroy,tick} from 'svelte';
  import {channels,currentChannel} from '$lib/channelStore';
  import {get} from 'svelte/store';
  import {readerSelection} from '$lib/readerWorkspace';
  import {request,type ArtifactSession} from '../../workspaceArtifacts/client';
  import {equal,newId,type Fields,type Json} from '../../workspaceArtifacts/model';
  import {saveOriginal,downloadBlob} from '../../workspaceArtifacts/storage';
  import {openWorkspace} from '../../workspaceArtifacts/navigation';
  import Audience from '../../workspaceArtifacts/Audience.svelte';
  import PageView from '../../workspaceArtifacts/PageView.svelte';
  import type {Page,PresentationView} from '../../workspaceArtifacts/presentation';
  import {slideIds,slide,key,asJson,audiencePages,fromMarkdown,normalizeImage,type Slide} from './model';
  const filesAbort=new AbortController();
  onDestroy(()=>filesAbort.abort());
  let {session,readonly=false,onfield=()=>{},onreview=()=>{}}=$props<{session:ArtifactSession;readonly?:boolean;onfield?:(field:string)=>void;onreview?:(field:string)=>void}>();
  const store=session.state;
  let active=$state(slideIds($store.draft.fields)[0]||''),error=$state(''),tab=$state<'edit'|'local'|'room'>('edit'),roomId=$state('');
  let approval=$state(false),target=$state(''),preview=$state<Page[]>([]),update=$state(false),busy=$state(false),confirmed=$state(false),replacementSlide=$state('');
  let importFields=$state<Fields|null>(null),importWarnings=$state<string[]>([]),originalId=$state(''),sourcePreview=$state(false);
  let history=$state<{before:Record<string,Json|undefined>;after:Record<string,Json|undefined>}[]>([]),future=$state<typeof history>([]);
  let localIndex=$state(0),localBlank=$state(false),localStage:HTMLDivElement|undefined,disposed=false;
  const fields=$derived($store.draft.fields),ids=$derived(slideIds(fields));
  const current=$derived.by(()=>{try{return slide(fields,active);}catch{return {title:'',body:'',layout:'body',image:null,hidden:false} as Slide;}});
  const currentPage=$derived<Page>({id:active,title:current.title,body:current.body,layout:current.layout,image:current.image||null,theme:fields.theme as Page['theme'],aspect:typeof fields.aspect==='number'?fields.aspect:16/9});
  const pages=$derived(audiencePages(fields));
  const targets=$derived($channels.filter(c=>!['dm','group','group_dm','category'].includes(c.type)));
  $effect(()=>{if(!ids.includes(active)&&ids.length)active=ids[0];onfield(key(active));});
  onDestroy(()=>disposed=true);
  function apply(set:Fields,remove:string[]=[],remember=true){
    if(readonly)return;
    if(remember){const before:Record<string,Json|undefined>={},after:Record<string,Json|undefined>={};for(const k of new Set([...Object.keys(set),...remove])){before[k]=fields[k]===undefined?undefined:structuredClone(fields[k]);after[k]=Object.hasOwn(set,k)?structuredClone(set[k]):undefined;}history=[...history.slice(-99),{before,after}];future=[];}
    session.editMany(set,remove);
  }
  function edit(patch:Partial<Slide>){apply({[key(active)]:asJson({...current,...patch})});}
  function undo(redo=false){const stack=redo?future:history,op=stack.at(-1);if(!op)return;const expected=redo?op.before:op.after,to=redo?op.after:op.before;if(Object.keys(expected).some(k=>!equal(fields[k],expected[k]))){error='Another editor changed this object. Undo did not overwrite their work.';return;}const set:Fields={},remove:string[]=[];for(const [k,v] of Object.entries(to)){if(v===undefined)remove.push(k);else set[k]=v;}apply(set,remove,false);if(redo){future=future.slice(0,-1);history=[...history,op];}else{history=history.slice(0,-1);future=[...future,op];}}
  function add(copy=false){if(ids.length>=300){error='This deck is limited to 300 slides';return;}const id=newId(),next=[...ids];next.splice(ids.indexOf(active)+1,0,id);apply({slides:next,[key(id)]:asJson(copy?{...current}:{title:'New slide',body:'',layout:'body',image:null,hidden:false})});if(copy&&$store.draft.privateNotes[active])session.note(id,$store.draft.privateNotes[active]);active=id;}
  function move(by:number){const next=[...ids],index=next.indexOf(active),destination=index+by;if(destination<0||destination>=next.length)return;[next[index],next[destination]]=[next[destination],next[index]];apply({slides:next});}
  function remove(){if(ids.length<=1)return;const index=ids.indexOf(active);apply({slides:ids.filter(id=>id!==active)},[key(active)]);active=ids[Math.max(0,index-1)];}
  async function image(event:Event){const input=event.currentTarget as HTMLInputElement,file=input.files?.[0];input.value='';if(!file)return;const id=active;try{const data=await normalizeImage(file);if(disposed||!session.scope.current()||id!==active)return;edit({image:data,layout:'image'});}catch(e){error=e instanceof Error?e.message:String(e);}}
  async function prepareRoom(replace=false){
    try{error='';await session.flush();preview=structuredClone(pages);if(!preview.length)throw new Error('No visible slides are available to present.');target=targets.find(c=>c.id===get(currentChannel))?.id||targets[0]?.id||'';update=replace;confirmed=false;replacementSlide=preview[0].id;approval=true;}
    catch(e){error=String(e);}
  }
  async function publishRoom(){
    if(!confirmed)return;busy=true;error='';
    try{
      if(update){
        const current=await request<PresentationView>(session.scope,`/presentations/${roomId}`);if(!current?.presentation)throw new Error('Presentation could not be reopened');
        const p=current.presentation;const slideId=preview.some(s=>s.id===p.slideId)?p.slideId:replacementSlide;
        await request(session.scope,`/presentations/${roomId}/revision`,'PUT',{opId:newId(),generation:p.generation,sequence:p.sequence,title:String(fields.title||''),pages:preview,slideId});
      }else{
        const id=newId();await request(session.scope,'/presentations','POST',{opId:newId(),id,channelId:target,title:String(fields.title||''),pages:preview});roomId=id;
      }
      if(!disposed&&session.scope.current()){approval=false;tab='room';}
    }catch(e){if(!disposed)error=e instanceof Error?e.message:String(e);}finally{busy=false;}
  }
  async function local(){try{await session.flush();preview=structuredClone(pages);if(!preview.length)throw new Error('No visible slides to present');localIndex=0;localBlank=false;tab='local';}catch(e){error=String(e);}}
  async function fullLocal(){try{await localStage?.requestFullscreen();}catch{error='Fullscreen is unavailable; the local presentation still works.';}}
  function convertReader(){const source=get(readerSelection);if(!source||source.contentType!=='text'){error='Open a text or Markdown document in Reader first.';return;}try{if(!['markdown','text'].includes(source.format))throw new Error('Reader conversion supports text and Markdown; HTML/code require explicit editing first.');importFields=fromMarkdown(source.content,source.title);importWarnings=['Proposed slide breaks are shown below. The Reader source remains unchanged.'];sourcePreview=true;}catch(e){error=String(e);}}
  async function importFile(event:Event){const input=event.currentTarget as HTMLInputElement,file=input.files?.[0];input.value='';if(!file)return;try{error='';const original=await saveOriginal(session.scope.key,file);const adapter=await import('./files');const result=await adapter.importDeck(file,filesAbort.signal);if(disposed||!session.scope.current())return;originalId=original;importFields=result.fields;importWarnings=result.warnings;sourcePreview=false;}catch(e){error=e instanceof Error?e.message:String(e);}}
  async function exportFile(format:'pptx'|'odp'|'html'){try{await session.flush();const adapter=await import('./files'),result=await adapter.exportDeck(fields,format,filesAbort.signal);if(!disposed&&session.scope.current()){downloadBlob(result.name,result.blob);importWarnings=result.warnings;}}catch(e){error=String(e);}}
  async function copyLink(){const url=new URL(session.scope.server);url.searchParams.set('wabiPresentation',roomId);try{await navigator.clipboard.writeText(url.href);}catch{error='Clipboard unavailable. Presentation ID: '+roomId;}}
</script>
<div class="present-tool">
  <div class="workspace-bar">
    <button onclick={()=>tab='edit'} aria-pressed={tab==='edit'}>Edit deck</button><button onclick={local}>Present locally</button><button onclick={()=>prepareRoom(false)}>Present to channel</button>
    {#if roomId}<button onclick={()=>tab='room'}>Return to room</button><button onclick={()=>prepareRoom(true)}>Update presented revision</button><button onclick={copyLink}>Copy presentation link</button>{/if}
    <button onclick={convertReader}>Make from Reader</button>
    <details><summary>Import / export</summary><label>Open slides<input type="file" accept=".pptx,.odp,.pdf,.png,.jpg,.jpeg,.webp,.md,.txt" onchange={importFile} /></label><div class="workspace-bar"><button onclick={()=>exportFile('pptx')}>Export PPTX</button><button onclick={()=>exportFile('odp')}>Export ODP</button><button onclick={()=>exportFile('html')}>Export audience HTML / print PDF</button></div></details>
  </div>
  {#if error}<div class="workspace-message" role="alert">{error}</div>{/if}
  {#if approval}
    <section class="present-approval"><h2>{update?'Update audience revision':'Publish this audience rendition'}</h2><p>Only these {preview.length} visible slides are sent. Hidden slides, speaker notes, editing history, and source workbooks are excluded. The server operator can read the slides.</p>
      {#if !update}<label>Channel<select bind:value={target}>{#each targets as c}<option value={c.id}>#{c.name}</option>{/each}</select></label>{:else}<label>Fallback slide if the current slide was removed<select bind:value={replacementSlide}>{#each preview as p,i}<option value={p.id}>{i+1}. {p.title}</option>{/each}</select></label>{/if}
      <div class="approval-slides">{#each preview as p}<div><PageView page={p} /></div>{/each}</div>
      <label><input type="checkbox" bind:checked={confirmed} /> I approve this audience content and its server destination.</label><div class="workspace-bar"><button onclick={publishRoom} disabled={!confirmed||busy||(!update&&!target)}>{busy?'Publishing…':update?'Update revision':'Start presentation'}</button><button onclick={()=>approval=false}>Cancel</button></div>
    </section>
  {:else if importFields}
    <section class="present-approval"><h2>Review the imported deck</h2>{#each importWarnings as warning}<p>{warning}</p>{/each}<div class="approval-slides">{#each audiencePages(importFields) as p}<div><PageView page={p} /></div>{/each}</div><div class="workspace-bar"><button onclick={()=>openWorkspace({kind:'deck',seed:importFields!,...(sourcePreview?{}:{originalId})})}>Create private working copy</button><button onclick={()=>importFields=null}>Cancel</button></div></section>
  {:else}
    <div class:hidden={tab!=='edit'} class="deck-editor">
      <aside class="slide-list" aria-label="Slides">
        {#each ids as id,i}<button aria-pressed={active===id} onclick={()=>active=id}>{i+1}. {slide(fields,id).title||'Untitled slide'}{slide(fields,id).hidden?' (hidden)':''}</button>{/each}
        <button onclick={()=>add()} disabled={readonly}>+ Slide</button><button onclick={()=>add(true)} disabled={readonly}>Duplicate</button><button onclick={()=>move(-1)} disabled={readonly}>Move up</button><button onclick={()=>move(1)} disabled={readonly}>Move down</button><button onclick={remove} disabled={readonly||ids.length<=1}>Delete slide</button>
      </aside>
      <div class="slide-editor-main">
        <div class="workspace-bar"><button onclick={()=>undo()} disabled={readonly||!history.length}>Undo</button><button onclick={()=>undo(true)} disabled={readonly||!future.length}>Redo</button><label>Layout<select value={current.layout} disabled={readonly} onchange={e=>edit({layout:e.currentTarget.value as Slide['layout']})}><option value="title">Title</option><option value="body">Title and text</option><option value="image">Image</option><option value="split">Image with text</option></select></label><label>Theme<select value={String(fields.theme||'paper')} disabled={readonly} onchange={e=>apply({theme:e.currentTarget.value})}><option value="paper">Paper</option><option value="night">Night</option><option value="sage">Sage</option></select></label><label>Aspect<select value={String(fields.aspect||16/9)} disabled={readonly} onchange={e=>apply({aspect:Number(e.currentTarget.value)})}><option value={16/9}>16:9</option><option value={4/3}>4:3</option><option value={1}>Square</option></select></label><button onclick={()=>onreview(key(active))}>Discuss slide</button></div>
        <div class="canvas-preview"><PageView page={currentPage} /></div>
        <div class="slide-inputs"><label>Slide title<input aria-label="Slide title" value={current.title} readonly={readonly} maxlength="1000" oninput={e=>edit({title:e.currentTarget.value})} /></label><label>Body text<textarea aria-label="Slide body" rows="6" value={current.body} readonly={readonly} maxlength="24000" oninput={e=>edit({body:e.currentTarget.value})}></textarea></label>
          <label>Image<input type="file" accept="image/png,image/jpeg,image/webp" disabled={readonly} onchange={image} /></label>{#if current.image}<button onclick={()=>edit({image:null,layout:'body'})} disabled={readonly}>Remove image</button>{/if}
          <label><input type="checkbox" checked={Boolean(current.hidden)} disabled={readonly} onchange={e=>edit({hidden:e.currentTarget.checked})} /> Exclude this slide from presentations</label>
          <label>Private speaker notes<textarea aria-label="Private speaker notes" rows="4" value={$store.draft.privateNotes[active]||''} oninput={e=>session.note(active,e.currentTarget.value)}></textarea></label><small>Private notes are stored only on this device and only included in explicitly downloaded private backups.</small>
        </div>
      </div>
    </div>
    {#if roomId}<div class="room-view" class:hidden={tab!=='room'}><Audience id={roomId} notes={$store.draft.privateNotes} embedded onedit={()=>tab='edit'} /></div>{/if}
    {#if tab==='local'&&preview[localIndex]}<div class="local-presentation"><div class="workspace-bar"><button onclick={()=>localIndex=Math.max(0,localIndex-1)} disabled={localIndex===0}>Previous</button><span>{localIndex+1}/{preview.length}</span><button onclick={()=>localIndex=Math.min(preview.length-1,localIndex+1)} disabled={localIndex===preview.length-1}>Next</button><button onclick={()=>localBlank=!localBlank}>Blank / show</button><button onclick={fullLocal}>Fullscreen</button><button onclick={()=>tab='edit'}>End local presentation</button></div><div class="local-stage" bind:this={localStage}><PageView page={preview[localIndex]} blank={localBlank} /></div><details class="local-notes"><summary>Private notes</summary><p>{$store.draft.privateNotes[preview[localIndex].id]||'No notes'}</p></details></div>{/if}
    {#if importWarnings.length}<details class="workspace-message"><summary>Compatibility report</summary>{#each importWarnings as warning}<p>{warning}</p>{/each}</details>{/if}
  {/if}
</div>
<svelte:window onkeydown={e=>{if(tab!=='local'||e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement)return;if(['ArrowRight','PageDown',' '].includes(e.key)){e.preventDefault();localIndex=Math.min(preview.length-1,localIndex+1);}if(['ArrowLeft','PageUp'].includes(e.key)){e.preventDefault();localIndex=Math.max(0,localIndex-1);}}} />
<style>
.present-tool{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden}.deck-editor{display:flex;flex:1;min-height:0;overflow:hidden}.slide-list{width:170px;flex-shrink:0;overflow:auto;padding:10px;border-inline-end:1px solid var(--border-color)}.slide-list button{display:block;width:100%;margin:6px 0;text-align:start}.slide-list button[aria-pressed=true]{outline:2px solid var(--accent,var(--text-primary))}.slide-editor-main{flex:1;min-width:0;overflow:auto}.canvas-preview{max-width:860px;padding:22px;margin:auto}.slide-inputs{max-width:900px;padding:16px 24px;margin:auto;box-sizing:border-box}.slide-inputs label{display:block;margin:12px 0}.slide-inputs :is(input:not([type=checkbox]),textarea){display:block;width:100%;box-sizing:border-box}.slide-inputs textarea{background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;padding:12px;line-height:1.5}.slide-inputs small{line-height:1.5;color:var(--text-secondary)}.present-approval{padding:20px;overflow:auto}.approval-slides{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin:20px 0}.approval-slides>div{max-width:480px}.room-view,.local-presentation{flex:1;min-height:0;display:flex;flex-direction:column}.local-stage{padding:20px;overflow:auto;flex:1}.local-stage:fullscreen{display:flex;align-items:center;background:#10151c;padding:0}.local-notes{padding:12px 20px}.local-notes p{white-space:pre-wrap}.hidden{display:none!important}@media(max-width:700px){.slide-list{width:105px;padding:5px}.canvas-preview{padding:12px}.slide-inputs{padding:12px}.present-tool .workspace-bar{gap:5px}}
</style>
