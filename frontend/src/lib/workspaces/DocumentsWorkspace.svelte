<script lang="ts">
    import {onMount,onDestroy} from 'svelte';
    import DOMPurify from 'dompurify';
    import {marked} from 'marked';
    import ArtifactShell from './ArtifactShell.svelte';
    import ArtifactLibrary from './ArtifactLibrary.svelte';
    import CollaborativeText from './CollaborativeText.svelte';
    import {ArtifactSession,createArtifact,openArtifact,listLocal,download,Y,from64} from './session';
    import {captureScope,targets,type Scope,type Target} from './bridge';
    import './workspace.css';
    let scope=$state<Scope|null>(null),active=$state<ArtifactSession|null>(null);
    let error=$state(''),loading=$state(true),initialShare=$state<'snapshot'|'live'|undefined>();
    let preview=$state(true),tick=$state(0),selectionAnchor=$state<string|null>(null),focusAnchor=$state<string|null>(null);
    let stop=()=>{},unsubscribe=()=>{},generation=0,alive=true,previousTarget:unknown;
    const html=$derived.by(()=>{
        tick;if(!active)return '';const text=active.body.toString();
        const rendered=active.record.format==='text'||active.record.format==='code'?`<pre>${text.replaceAll('&','&amp;').replaceAll('<','&lt;')}</pre>`:active.record.format==='html'?text:marked.parse(text,{async:false});
        return DOMPurify.sanitize(rendered,{FORBID_TAGS:['img','iframe','video','audio','object','embed','style','form'],FORBID_ATTR:['style','srcset','target'],ALLOW_DATA_ATTR:false});
    });
    const current=(own:number,owner:Scope)=>alive&&own===generation&&owner.isCurrent();
    async function adopt(candidate:ArtifactSession,own:number,owner:Scope){
        if(!current(own,owner)){await candidate.close();return;}
        if(candidate===active){await candidate.close();return;}
        const old=active;
        if(old&&!(await old.close())){await candidate.close();throw new Error('Save the current document or export recovery before switching.');}
        if(!current(own,owner)){await candidate.close();return;}
        stop();active=candidate;selectionAnchor=null;stop=candidate.state.subscribe(()=>tick++);
    }
    async function run(fn:(owner:Scope,own:number)=>Promise<void>){
        const owner=scope;if(!owner)return;const own=++generation;loading=true;error='';
        try{await fn(owner,own);}catch(e){if(current(own,owner))error=e instanceof Error?e.message:String(e);}
        finally{if(current(own,owner))loading=false;}
    }
    async function open(id:string){await run(async(owner,own)=>{initialShare=undefined;focusAnchor=null;await adopt(await openArtifact(owner,id,'document'),own,owner);});}
    async function create(){await run(async(owner,own)=>{initialShare=undefined;focusAnchor=null;await adopt(await createArtifact(owner,'document','Untitled document',()=>{},'markdown'),own,owner);});}
    async function library(){await run(async(owner,own)=>{const old=active;if(old&&!(await old.close()))throw new Error('Local save failed. Export recovery before leaving.');if(current(own,owner)){stop();active=null;initialShare=undefined;selectionAnchor=null;focusAnchor=null;}});}
    async function importFile(file:File){await run(async(owner,own)=>{
        if(file.size>12*1024*1024)throw new Error('Document file exceeds the 12 MB import limit.');
        const raw=await file.text();if(!current(own,owner))return;
        let title=file.name,format=/\.html?$/i.test(file.name)?'html':/\.md$/i.test(file.name)?'markdown':'text',body=raw;
        if(file.name.endsWith('.wabi.json')){
            const value=JSON.parse(raw);
            if(value.schema!==1||value.kind!=='document'||typeof value.update!=='string'||!['text','markdown','html','code'].includes(value.format))throw new Error('Not a supported Wabi document backup.');
            const source=new Y.Doc();try{Y.applyUpdate(source,from64(value.update));title=source.getText('title').toString();body=source.getText('body').toString();format=value.format;}finally{source.destroy();}
        }
        if(body.length>1048576)throw new Error('Document text exceeds the 1 MB editing limit.');
        initialShare=undefined;focusAnchor=null;
        await adopt(await createArtifact(owner,'document',title,doc=>doc.getText('body').insert(0,body),format,undefined,{name:file.name,type:file.type,blob:file}),own,owner);
    });}
    async function target(input:Target){await run(async(owner,own)=>{
        initialShare=input.shareMode;focusAnchor=input.anchor||null;
        if(input.id){await adopt(await openArtifact(owner,input.id,'document'),own,owner);return;}
        if(input.source){
            const source=input.source,rows=await listLocal(owner,'document');if(!current(own,owner))return;
            const old=rows.find(row=>row.sourceKey===source.sourceKey);
            const candidate=old?await openArtifact(owner,old.id,'document'):await createArtifact(owner,'document',source.title,doc=>doc.getText('body').insert(0,source.content),source.format,source.sourceKey);
            await adopt(candidate,own,owner);
        }
    });}
    async function useCopy(copy:ArtifactSession){const owner=scope;if(!owner){await copy.close();return;}await adopt(copy,++generation,owner);initialShare=undefined;focusAnchor=null;}
    onMount(()=>{void(async()=>{
        try{const owner=await captureScope();if(!alive||!owner.isCurrent())return;scope=owner;loading=false;
            unsubscribe=targets.subscribe(value=>{if(value.documents&&value.documents!==previousTarget){previousTarget=value.documents;void target(value.documents);}});
        }catch(e){if(alive){loading=false;error=e instanceof Error?e.message:String(e);}}
    })();});
    onDestroy(()=>{alive=false;generation++;unsubscribe();stop();if(active)void active.close();});
</script>
{#if scope&&active}
    {#key active.id}<ArtifactShell session={active} onlibrary={library} {initialShare} {selectionAnchor} onanchor={anchor=>focusAnchor=anchor} oncopy={useCopy}>
        <div class="workspace-toolbar document-tools"><button onclick={()=>preview=!preview}>{preview?'Hide preview':'Show preview'}</button><button onclick={()=>{if(active)download(`${active.title}.${active.record.format==='markdown'?'md':'txt'}`,active.body.toString(),'text/plain;charset=utf-8');}}>Export text</button></div>
        <div class="workspace-editor-split"><section aria-label="Editor"><CollaborativeText session={active} onselection={anchor=>selectionAnchor=anchor} {focusAnchor}/></section>{#if preview}<section class="workspace-prose" aria-label="Document preview">{@html html}</section>{/if}</div>
    </ArtifactShell>{/key}
{:else if scope}<section class="wabi-workspace"><ArtifactLibrary {scope} kind="document" label="Documents" onopen={open} onnew={create} onimport={importFile} accept=".txt,.md,.markdown,.html,.htm,.wabi.json"/></section>{/if}
{#if loading}<p class="workspace-home-note" role="status">Opening document…</p>{/if}
{#if error}<div class="workspace-home-note" role="alert">{error}{#if active}<button onclick={()=>download(`${active!.title}.wabi.json`,active!.recovery())}>Export recovery</button>{/if}</div>{/if}
<style>.document-tools{padding:.5rem}.workspace-editor-split{height:calc(100% - 48px)}</style>
