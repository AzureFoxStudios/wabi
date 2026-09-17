<script lang="ts">
  import {newId,type Json} from './model';
  import type {ArtifactSession} from './client';
  let {session,field='text',onclose}=$props<{session:ArtifactSession;field?:string;onclose:()=>void}>();
  const store=session.state;
  let body=$state(''),suggest=$state(false),proposal=$state(''),error=$state(''),busy=$state(false);
  const mayReview=$derived($store.access!=='viewer');
  const mayAccept=$derived($store.access==='owner'||$store.access==='editor');
  async function submit(){
    busy=true;error='';
    try{
      const base=$store.draft.base;if(!base)throw new Error('Share this document before posting a review.');
      let value:Json|null=null;
      if(suggest){
        // Prose suggestions replace only the specifically versioned text field.
        if($store.draft.kind!=='document'||field!=='text')throw new Error('Use a comment for this object; prose suggestions target document text.');
        value=proposal;
      }
      await session.action('/reviews','POST',{opId:newId(),id:newId(),body,field:Object.hasOwn(base.fields,field)?field:null,proposal:value,baseFieldVersion:base.versions[field]||0,isSuggestion:suggest});
      body='';proposal='';suggest=false;
    }catch(e){error=e instanceof Error?e.message:String(e);}finally{busy=false;}
  }
  async function status(id:string,status:string){try{error='';await session.action(`/reviews/${id}`,'PUT',{opId:newId(),status});}catch(e){error=e instanceof Error?e.message:String(e);}}
</script>
<aside class="workspace-pane" aria-label="Comments and suggestions">
  <div class="row"><h2>Review</h2><button onclick={onclose}>Close</button></div>
  <small>Target: {field}</small>
  {#if !$store.draft.base}<p>Comments become shared when the document is published. Your existing Reader-local comments remain in the original copy.</p>{:else}
    {#each $store.draft.base.reviews as review (review.id)}
      <article>
        <small>Account {review.authorId} · {new Date(review.at).toLocaleString()} · {review.status}</small>
        <p>{review.body}</p><small>{review.field||'Whole document'}{review.field&&!Object.hasOwn($store.draft.fields,review.field)?' · target removed':''}</small>
        {#if review.isSuggestion}<details><summary>Proposed text</summary><pre>{String(review.proposal??'')}</pre></details>{/if}
        {#if review.status==='open'}
          {#if review.isSuggestion&&mayAccept}<button onclick={()=>status(review.id,'accepted')}>Apply suggestion</button>{/if}
          {#if mayAccept||review.authorId===session.scope.userId}<button onclick={()=>status(review.id,review.isSuggestion?'rejected':'resolved')}>{review.isSuggestion?'Reject':'Resolve'}</button>{/if}
        {:else if !review.isSuggestion&&(mayAccept||review.authorId===session.scope.userId)}<button onclick={()=>status(review.id,'open')}>Reopen</button>{/if}
      </article>
    {/each}
    {#if mayReview}
      <label>Comment<textarea rows="4" bind:value={body} maxlength="16000"></textarea></label>
      {#if $store.draft.kind==='document'&&field==='text'}<label class="check"><input type="checkbox" bind:checked={suggest} onchange={()=>{if(suggest)proposal=String($store.draft.fields.text||'');}} />Suggest revised wording</label>{/if}
      {#if suggest}<label>Proposed text<textarea rows="10" bind:value={proposal}></textarea></label><p>Applying this suggestion checks its original text revision. It cannot silently overwrite newer writing.</p>{/if}
      <button onclick={submit} disabled={busy||!body.trim()}>Post review</button>
    {/if}
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</aside>
