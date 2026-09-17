<script lang="ts">
  import {get} from 'svelte/store';
  import {flushReaderDocument,readerDocumentSaveState,type ReaderLocalDocument} from '$lib/readerDocuments';
  import {readerSelection} from '$lib/readerWorkspace';
  import {captureScope} from './client';
  import {listDrafts} from './storage';
  import {openWorkspace} from './navigation';
  let {document=null}=$props<{document?:ReaderLocalDocument|null}>();
  let error=$state(''),busy=$state(false);
  async function share(mode:'snapshot'|'live'){
    if(!document)return;busy=true;error='';const source=document,scope=captureScope(),selection=get(readerSelection)?.id;
    try{
      await flushReaderDocument(source.documentId);
      if(get(readerDocumentSaveState)[source.documentId]==='error')throw new Error('Save or recover the local document before sharing.');
      const saved=(await listDrafts(scope.key)).find(d=>d.sourceId===source.documentId);
      if(!scope.current()||get(readerSelection)?.id!==selection)return;
      // Reopening a previously shared copy never overwrites it with an older Reader snapshot.
      if(saved)openWorkspace({kind:'document',id:saved.id,draftKey:saved.key,shareRequested:!saved.base,initialMode:mode});
      else openWorkspace({kind:'document',sourceId:source.documentId,seed:{title:source.title,text:source.content,format:source.format,...(source.language?{language:source.language}:{})},shareRequested:true,initialMode:mode});
    }catch(e){if(scope.current())error=e instanceof Error?e.message:String(e);}finally{busy=false;}
  }
</script>
{#if document}<button type="button" disabled={busy} onclick={()=>share('snapshot')}>Share…</button><button type="button" disabled={busy} onclick={()=>share('live')}>Collaborate</button>{/if}
<button type="button" onclick={()=>openWorkspace({kind:'library'})}>Workspace library</button>
{#if error}<span role="alert">{error}</span>{/if}
