<script lang="ts">
    import { onMount } from 'svelte';
    import { listLocal } from './session';
    import { request, type Scope, type ArtifactKind, type Meta } from './bridge';
    let {scope,kind,label,onopen,onnew,onimport,accept}:{scope:Scope;kind:ArtifactKind;label:string;onopen:(id:string)=>void;onnew:()=>void;onimport:(file:File)=>void;accept:string}=$props();
    let local=$state<{id:string;title:string;updatedAt:number}[]>([]);let shared=$state<Meta[]>([]);let error=$state('');let loading=$state(false);let address=$state('');let fileInput:HTMLInputElement;
    async function refresh(){loading=true;error='';try{const rows=await listLocal(scope,kind);if(scope.isCurrent())local=rows;try{const data=await request<{artifacts:Meta[]}>(scope,'/artifacts');if(scope.isCurrent())shared=data.artifacts.filter(a=>a.kind===kind);}catch(e){error=e instanceof Error?e.message:String(e);}}catch(e){error=e instanceof Error?e.message:String(e);}finally{loading=false;}}
    function openAddress(){try{let id=address.trim();if(id.includes('://')){const url=new URL(id);if(new URL(scope.server).origin!==url.origin)throw new Error('Switch to the server in this link before opening its document.');id=url.searchParams.get('workspaceArtifact')||'';}if(!/^[0-9a-f-]{36}$/i.test(id))throw new Error('Paste a Wabi document link or document ID.');onopen(id);}catch(e){error=e instanceof Error?e.message:String(e);}}
    onMount(()=>{void refresh();});
</script>
<div class="workspace-library"><h1>{label}</h1><p>Work privately on this device. Share only when you choose.</p>
    <div class="workspace-toolbar"><button class="primary" onclick={onnew}>New {kind==='document'?'document':kind==='sheets'?'spreadsheet':'presentation'}</button><button onclick={()=>fileInput.click()}>Open file</button><button disabled={loading} onclick={refresh}>{loading?'Loading…':'Refresh library'}</button></div>
    <input class="workspace-file-input" type="file" {accept} bind:this={fileInput} onchange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)onimport(file);}} />
    <form class="open-id" onsubmit={event=>{event.preventDefault();openAddress();}}><input aria-label="Document link or ID" placeholder="Paste a Wabi document link or ID" bind:value={address}/><button type="submit">Open shared document</button></form>
    {#if error}<p role="status">{error}</p>{/if}
    <h2>On this device</h2><div class="files">{#each local as item(item.id)}<button onclick={()=>onopen(item.id)}><strong>{item.title}</strong><small>{new Date(item.updatedAt).toLocaleString()}</small></button>{:else}<p>No local {label.toLowerCase()} yet.</p>{/each}</div>
    <h2>Shared with you</h2><div class="files">{#each shared as item(item.id)}<button onclick={()=>onopen(item.id)}><strong>{item.title}</strong><small>{item.role} · {item.mode==='live'?'Collaborative':'Snapshot'}</small></button>{:else}<p>No accessible shared {label.toLowerCase()} on this server.</p>{/each}</div>
</div>
