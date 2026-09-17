<script lang="ts">
  import {channels} from '$lib/channelStore';
  import {request,type ArtifactSession} from './client';
  import {newId,type Access} from './model';
  let {session,onclose,initialMode='snapshot'}=$props<{session:ArtifactSession;onclose:()=>void;initialMode?:'snapshot'|'live'}>();
  const store=session.state;
  const initial=$store.draft.base;
  let selectedChannel=$state(initial?.channelId||'');
  let channelAccess=$state<Access>(initial?.channelAccess||'viewer');
  let mode=$state<'snapshot'|'live'>(initial?.mode||initialMode);
  let grants=$state<Record<string,Access>>({...initial?.grants});
  let query=$state(''),error=$state(''),busy=$state(false),consent=$state(false);
  let people=$state<{id:number;name:string;handle?:string}[]>([]);
  let names=$state<Record<string,string>>({});
  const choices=$derived($channels.filter(c=>!['dm','group','group_dm','category'].includes(c.type)));
  let searchGeneration=0;
  async function search(){const generation=++searchGeneration;try{const response=await request<{people:typeof people}>(session.scope,`/people?q=${encodeURIComponent(query)}`);if(generation===searchGeneration&&session.scope.current())people=response?.people||[];}catch(e){if(generation===searchGeneration)error=String(e);}}
  function add(person:{id:number;name:string}){grants={...grants,[person.id]:'viewer'};names={...names,[person.id]:person.name};people=[];query='';}
  function remove(id:string){const next={...grants};delete next[id];grants=next;}
  async function save(){
    busy=true;error='';
    try{
      if(!consent)throw new Error('Confirm the server and recipients before sharing.');
      const base=$store.draft.base;
      if(base){
        await session.action('/permissions','PUT',{opId:newId(),revision:initial?.revision??base.revision,grants,channelId:selectedChannel||null,channelAccess});
        const next=$store.draft.base!;
        if(next.mode!==mode)await session.action('/mode','PUT',{opId:newId(),generation:next.generation,mode});
      }else await session.publish({mode,channelId:selectedChannel||null,channelAccess,grants});
      onclose();
    }catch(e){error=e instanceof Error?e.message:String(e);}finally{busy=false;}
  }
</script>
<aside class="workspace-pane" aria-label="Share and permissions">
  <div class="row"><h2>{initial?'Manage access':'Share this saved copy'}</h2><button onclick={onclose} aria-label="Close sharing">Close</button></div>
  <p>Shared content is readable by this server’s operator. Local speaker notes are never included.</p>
  <small>{session.scope.server}</small>
  <label>Sharing mode<select bind:value={mode}><option value="snapshot">Snapshot — publish future changes explicitly</option><option value="live">Collaborative — synchronize authorized edits</option></select></label>
  <label>Channel<select bind:value={selectedChannel}><option value="">Named people only</option>{#each choices as c}<option value={c.id}>#{c.name}</option>{/each}</select></label>
  {#if selectedChannel}<label>Channel members may<select bind:value={channelAccess}><option value="viewer">View</option><option value="commenter">Comment and suggest</option><option value="editor">Edit when collaboration is on</option></select></label>{/if}
  <label>Find a registered person<input bind:value={query} placeholder="Name or @handle" onkeydown={e=>{if(e.key==='Enter')void search();}} /></label>
  <button onclick={search} disabled={query.trim().length<2}>Search people</button>
  {#each people as person}<button class="item" onclick={()=>add(person)}>{person.name}{person.handle?` (@${person.handle})`:''}</button>{/each}
  {#each Object.entries(grants) as [id,role]}
    <div class="row"><span>{names[id]||`Account ${id}`}</span><select aria-label={`Permission for ${names[id]||id}`} value={role} onchange={e=>grants={...grants,[id]:e.currentTarget.value as Access}}><option value="viewer">View</option><option value="commenter">Comment</option><option value="editor">Edit</option></select><button onclick={()=>remove(id)}>Remove</button></div>
  {/each}
  <label class="check"><input type="checkbox" bind:checked={consent} />I approve sending this content to the server and granting the selected access.</label>
  {#if error}<p role="alert">{error}</p>{/if}
  <button disabled={busy||!consent} onclick={save}>{busy?'Saving…':initial?'Save access':'Share saved revision'}</button>
  {#if initial}<p>Removing access stops future access. It cannot erase copies somebody already downloaded.</p>{/if}
</aside>
