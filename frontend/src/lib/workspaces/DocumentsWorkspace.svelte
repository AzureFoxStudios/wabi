<script lang="ts">
    import { onMount,onDestroy } from 'svelte';
    import DOMPurify from 'dompurify';
    import { marked } from 'marked';
    import ArtifactShell from './ArtifactShell.svelte';
    import ArtifactLibrary from './ArtifactLibrary.svelte';
    import CollaborativeText from './CollaborativeText.svelte';
    import { ArtifactSession,createArtifact,openArtifact,listLocal,download,Y,from64 } from './session';
    import { captureScope,targets,type Scope,type Target } from './bridge';
    import './workspace.css';
    let scope=$state<Scope|null>(null);let active=$state<ArtifactSession|null>(null);let error=$state('');let loading=$state(true);let initialShare=$state<'snapshot'|'live'|undefined>();let preview=$state(true);let tick=$state(0);let stop:()=>void=()=>{};let generation=0;let previousTarget:unknown;let previousTarget:unknown;
    const html=$derived.by(()=>{tick;if(!active)return '';const text=active.body.toString();if(active.record.format==='text'||active.record.format==='code')return DOMPurify.sanitize(`<pre>${text.replaceAll('&','&amp;').replaceAll('<','&lt;')}</pre>`);const rendered=active.record.format==='html'?text:marked.parse(text,{async:false});return DOMPurify.sanitize(rendered,{FORBID_TAGS:['img','iframe','video','audio','object','embed','style','form'],FORBID_ATTR:['style','srcset','target'],ALLOW_DATA_ATTR:false});});
    async function use(session:ArtifactSession){if(active&&active!==session){if(!(await active.close()))throw new Error('Save the current document or export recovery before closing it.');}stop();active=session;stop=session.state.subscribe(()=>tick++);}
    async function run(fn:()=>Promise<void>){error='';loading=true;try{await fn();}catch(e){error=e instanceof Error?e.message:String(e);}finally{loading=false;}}
    async function open(id:string){await run(async()=>{if(scope)await use(await openArtifact(scope,id,'document'));});}
    async function create(){await run(async()=>{if(scope)await use(await createArtifact(scope,'document','Untitled document',doc=>doc.getText('body').insert(0,''),'markdown'));});}
    async function library(){if(active&&!(await active.close())){error='Local save failed. Export the recovery copy before leaving.';return;}stop();active=null;initialShare=undefined;}
    async function importFile(file:File){await run(async()=>{
        if(!scope)return;if(file.size>12*1024*1024)throw new Error('Document file exceeds the 12 MB import limit.');
        const text=await file.text();let title=file.name,format=file.name.endsWith('.html')?'html':/\.md$/i.test(file.name)?'markdown':'text';
        if(file.name.endsWith('.wabi.json')){const value=JSON.parse(text);if(value.schema!==1||value.kind!=='document'||typeof value.update!=='string')throw new Error('Not a supported Wabi document backup.');const source=new Y.Doc();Y.applyUpdate(source,from64(value.update));title=source.getText('title').toString();format=value.format;const body=source.getText('body').toString();source.destroy();await use(await createArtifact(scope,'document',title,doc=>doc.getText('body').insert(0,body),format,undefined,{name:file.name,type:file.type,blob:file}));}
        else{if(text.length>1048576)throw new Error('Document text exceeds the current 1 MB editing limit.');await use(await createArtifact(scope,'document',title,doc=>doc.getText('body').insert(0,text),format,undefined,{name:file.name,type:file.type,blob:file}));}
    });}
    async function target(input:Target){const own=++generation;await run(async()=>{
        if(!scope)return;initialShare=input.shareMode;
        if(input.id){await use(await openArtifact(scope,input.id,'document'));return;}
        if(input.source){const source=input.source;const rows=await listLocal(scope,'document');if(own!==generation||!scope.isCurrent())return;
            const old=rows.find(row=>row.sourceKey===source.sourceKey);if(old){await use(await openArtifact(scope,old.id,'document'));return;}
            await use(await createArtifact(scope,'document',source.title,doc=>doc.getText('body').insert(0,source.content),source.format,source.sourceKey));
        }
    });}
    onMount(()=>{let unsub=()=>{};void run(async()=>{scope=await captureScope();unsub=targets.subscribe(value=>{if(value.documents&&value.documents!==previousTarget){previousTarget=value.documents;void target(value.documents);}});});return()=>unsub();});
    onDestroy(()=>{generation++;stop();if(active)void active.close();});
</script>
{#if scope&&active}
    {#key active.id}<ArtifactShell session={active} onlibrary={()=>void library()} {initialShare}>
        <div class="workspace-toolbar document-tools"><button onclick={()=>preview=!preview}>{preview?'Hide preview':'Show preview'}</button><button onclick={()=>{if(active)download(`${active.title}.${active.record.format==='markdown'?'md':'txt'}`,active.body.toString(),'text/plain;charset=utf-8');}}>Export text</button></div>
        <div class="workspace-editor-split"><section aria-label="Editor"><CollaborativeText session={active}/></section>{#if preview}<section class="workspace-prose" aria-label="Document preview">{@html html}</section>{/if}</div>
    </ArtifactShell>{/key}
{:else if scope}
    <section class="wabi-workspace"><ArtifactLibrary {scope} kind="document" label="Documents" onopen={id=>void open(id)} onnew={()=>void create()} onimport={file=>void importFile(file)} accept=".txt,.md,.markdown,.html,.htm,.wabi.json"/></section>
{/if}
{#if loading}<p class="workspace-home-note" role="status">Opening document…</p>{/if}
{#if error}<div class="workspace-home-note" role="alert">{error}{#if active}<button onclick={()=>download(`${active!.title}.wabi.json`,active!.recovery())}>Export recovery</button>{/if}</div>{/if}
<style>.document-tools{padding:.5rem}.workspace-editor-split{height:calc(100% - 48px)}</style>
