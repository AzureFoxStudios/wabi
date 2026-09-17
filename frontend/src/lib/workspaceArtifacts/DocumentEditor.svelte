<script lang="ts">
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import type { ArtifactSession } from './client';
  let {session,readonly=false,onfield=()=>{}}=$props<{session:ArtifactSession;readonly?:boolean;onfield?:(field:string)=>void}>();
  const store=session.state;
  let preview=$state(false);
  let composing=$state(false);
  let text=$state(String($store.draft.fields.text||''));
  $effect(()=>{const next=String($store.draft.fields.text||'');if(!composing&&text!==next)text=next;});
  const rendered=$derived.by(()=>{
    const fields=$store.draft.fields;
    const raw=String(fields.text||'');
    if(fields.format==='text'||fields.format==='code')return null;
    const html=fields.format==='html'?raw:String(marked.parse(raw,{async:false}));
    // Shared prose cannot silently fetch tracking pixels or run source-provided styling.
    return DOMPurify.sanitize(html,{FORBID_TAGS:['img','style','iframe','object','embed','video','audio','svg','math'],FORBID_ATTR:['style','class','srcset']});
  });
  function changed(event:Event){text=(event.target as HTMLTextAreaElement).value;if(!composing&&!readonly)session.edit('text',text);}
</script>
<div class="document-tool">
  <div class="workspace-bar">
    <button onclick={()=>preview=!preview}>{preview?'Edit text':'Reading view'}</button>
    <span>{$store.draft.fields.format||'markdown'} · {text.length.toLocaleString()} characters</span>
    <button onclick={()=>onfield('text')}>Comment or suggest</button>
  </div>
  <div class="document-body">
    {#if preview||readonly}
      {#if rendered===null}<pre class="workspace-prose">{text}</pre>{:else}<div class="workspace-prose">{@html rendered}</div>{/if}
    {:else}
      <textarea class="workspace-editor" aria-label="Shared document content" value={text} oninput={changed}
        oncompositionstart={()=>composing=true} oncompositionend={e=>{composing=false;changed(e);}} onfocus={()=>onfield('text')} spellcheck={$store.draft.fields.format!=='code'}></textarea>
    {/if}
  </div>
</div>
<style>.document-tool{display:flex;flex-direction:column;height:100%;min-height:0}.document-body{flex:1;min-height:0;overflow:auto}</style>
