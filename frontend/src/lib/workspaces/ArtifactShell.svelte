<script lang="ts">
    import {onDestroy,type Snippet} from 'svelte';
    import {serverMembers} from '$lib/presenceIdentity';
    import {channels} from '$lib/channelStore';
    import {workspaceLink,openWorkspace,type Role,type Review} from './bridge';
    import {ArtifactSession,download,editText,makePrivateCopy,type PrivateDraft} from './session';
    import {describeAnchor,linkAnchor} from './anchors';
    import './workspace.css';
    let {session,onlibrary,initialShare,children,selectionAnchor=null,onanchor,oncopy}:{session:ArtifactSession;onlibrary:()=>void|Promise<void>;initialShare?:'snapshot'|'live';children:Snippet;selectionAnchor?:string|null;onanchor?:(anchor:string)=>void;oncopy?:(copy:ArtifactSession)=>void|Promise<void>}=$props();
    const sessionState=session.state;
    let dialog=$state<HTMLDialogElement>(),error=$state(''),notice=$state(''),busy=$state(false),reviewOpen=$state(false),recoveryOpen=$state(false);
    let mode=$state<'snapshot'|'live'>(initialShare||'live'),recipient=$state(''),recipientRole=$state<Role>('editor');
    let grants=$state<Record<string,Role>>({}),channelId=$state(''),channelRole=$state<Role>('viewer'),accessRevision=$state(0);
    let openedInitial=false,alive=true;
    let comment=$state(''),proposal=$state(''),suggestion=$state(false),suggestionBase=$state(0),reviewAnchor=$state<string|null>(null),replyTo=$state<string|null>(null);
    let reviewId:string=crypto.randomUUID();let draftId=$state('review:'+crypto.randomUUID());
    const editable=$derived(!$sessionState.meta||['owner','editor'].includes($sessionState.meta.role));
    const title=$derived.by(()=>{$sessionState.tick;return session.title;});
    const references=$derived.by(()=>{$sessionState.tick;return Object.fromEntries($sessionState.reviews.map(item=>[item.id,describeAnchor(session.doc,item.anchor)]));});
    const stagedReviews=$derived(Object.entries($sessionState.drafts).filter(([,draft])=>draft.kind==='review'));
    const selectedReference=$derived.by(()=>{$sessionState.tick;return describeAnchor(session.doc,selectionAnchor);});
    async function run(fn:()=>Promise<unknown>){
        if(busy)return;busy=true;error='';notice='';
        try{await fn();}catch(e){if(alive)error=e instanceof Error?e.message:String(e);}finally{if(alive)busy=false;}
    }
    function showSharing(){
        const meta=session.record.meta;mode=initialShare||meta?.mode||'live';grants={...(meta?.grants||{})};channelId=meta?.channelId||'';channelRole=meta?.channelRole||'viewer';accessRevision=meta?.accessRevision||0;dialog?.showModal();
    }
    $effect(()=>{if(initialShare&&dialog&&!openedInitial){openedInitial=true;showSharing();}});
    async function share(){await session.publish(mode);await session.access(grants,channelId||null,channelRole,mode,accessRevision||session.record.meta!.accessRevision);if(alive)dialog?.close();}
    function addRecipient(){if(!/^[1-9]\d*$/.test(recipient))return;grants={...grants,[recipient]:recipientRole};recipient='';}
    function recipientName(id:string){return $serverMembers.find(user=>String(user.dbUserId)===id)?.username||`Account ${id}`;}
    function stageReview(){
        try{session.stageDraft(draftId,{kind:'review',text:comment,context:{proposal,suggestion,suggestionBase,reviewId,anchor:reviewAnchor,parentId:replyTo},updatedAt:Date.now()});}
        catch(e){error=e instanceof Error?e.message:String(e);}
    }
    function changeComment(value:string){if(!comment&&!proposal&&!replyTo)reviewAnchor=selectionAnchor;comment=value;stageReview();}
    function prepareSuggestion(){suggestion=!suggestion;replyTo=null;if(suggestion){proposal=session.body.toString();suggestionBase=session.record.meta?.sequence||0;reviewAnchor=selectionAnchor;}else proposal='';stageReview();}
    function resetComposer(){reviewId=crypto.randomUUID();draftId='review:'+crypto.randomUUID();comment='';proposal='';suggestion=false;reviewAnchor=null;replyTo=null;}
    async function addReview(){
        await session.flush();
        await session.review({action:'add',id:reviewId,kind:suggestion?'suggestion':'comment',body:comment,anchor:reviewAnchor,...(replyTo?{parentId:replyTo}:{}),...(suggestion?{proposal,baseSequence:suggestionBase}:{})});
        session.stageDraft(draftId,null);await session.flush();if(alive)resetComposer();
    }
    function restoreReview(id:string,draft:PrivateDraft){
        if(comment||proposal){error='Submit or clear the current composer first. Both saved drafts are retained.';return;}
        draftId=id;comment=draft.text;proposal=typeof draft.context.proposal==='string'?draft.context.proposal:'';suggestion=draft.context.suggestion===true;
        suggestionBase=Number(draft.context.suggestionBase)||0;reviewId=typeof draft.context.reviewId==='string'?draft.context.reviewId:crypto.randomUUID();reviewAnchor=typeof draft.context.anchor==='string'?draft.context.anchor:null;replyTo=typeof draft.context.parentId==='string'?draft.context.parentId:null;reviewOpen=true;recoveryOpen=false;
    }
    function reply(item:Review){if(comment||proposal){error='Submit or clear the current draft before replying.';return;}replyTo=item.id;reviewAnchor=item.anchor;reviewOpen=true;stageReview();}
    async function clearComposer(){session.stageDraft(draftId,null);await session.flush();resetComposer();}
    function backup(){
        const value=JSON.parse(session.recovery());if(comment||proposal)value.visibleReviewRecovery={comment,proposal,suggestion,suggestionBase,reviewId,anchor:reviewAnchor,parentId:replyTo};
        download(`${session.title}.wabi.json`,JSON.stringify(value,null,2));
    }
    async function privateCopy(){
        const copy=await makePrivateCopy(session);
        if(!alive||!session.scope.isCurrent()){await copy.close();return;}
        if(oncopy)await oncopy(copy);else{const id=copy.id,kind=copy.record.kind;await copy.close();openWorkspace(kind==='document'?'documents':kind,{id});}
    }
    async function copyReference(){
        if(!session.record.meta)throw new Error('Share the document before copying an access-controlled reference.');
        await navigator.clipboard.writeText(workspaceLink(session.scope.server,session.id,session.record.kind,linkAnchor(selectionAnchor)));
        if(alive)notice='Reference copied. It grants no additional access and contains no selected text.';
    }
    function exportOriginal(){const original=session.record.original;if(original)download(original.name,original.blob);}
    onDestroy(()=>{alive=false;});
</script>
<section class="wabi-workspace" aria-label={`${session.record.kind} workspace`}>
    <header class="workspace-bar">
        <button onclick={()=>run(async()=>{await session.flush();if(alive)await onlibrary();})} disabled={busy}>Library</button>
        <input class="workspace-title" aria-label="Document title" value={title} maxlength="200" disabled={!editable} oninput={event=>{const value=event.currentTarget.value;if(value.trim())editText(session.doc.getText('title'),value,session.origin);}}/>
        <span class="workspace-status" role="status">{$sessionState.status}</span>
        <button onclick={backup}>Export backup</button>
        {#if session.record.original}<button onclick={exportOriginal}>Original file</button>{/if}
        <button disabled={busy} onclick={()=>run(privateCopy)}>Make private copy</button>
        {#if !$sessionState.meta||$sessionState.meta.role==='owner'}<button class="primary" onclick={showSharing}>Share…</button>{/if}
        {#if $sessionState.meta}
            <button onclick={()=>run(()=>navigator.clipboard.writeText(workspaceLink(session.scope.server,session.id,session.record.kind)))}>Copy link</button>
            <button onclick={()=>reviewOpen=!reviewOpen}>Review {$sessionState.reviews.filter(item=>item.state==='open').length||''}</button>
            {#if selectionAnchor}<button onclick={()=>{reviewAnchor=selectionAnchor;reviewOpen=true;}}>Comment on selection</button><button onclick={()=>run(copyReference)}>Copy selection link</button>{/if}
            {#if $sessionState.meta.mode==='snapshot'&&$sessionState.meta.role==='owner'}<button disabled={busy} onclick={()=>run(()=>session.sync(true))}>Publish revision</button>{/if}
        {/if}
        {#if Object.keys($sessionState.drafts).length}<button onclick={()=>recoveryOpen=!recoveryOpen}>Private drafts {Object.keys($sessionState.drafts).length}</button>{/if}
        <button onclick={()=>session.undo.undo()} disabled={!editable||busy}>Undo</button><button onclick={()=>session.undo.redo()} disabled={!editable||busy}>Redo</button>
    </header>
    {#if error||$sessionState.error}<div class="workspace-notice" role="alert">{error||$sessionState.error}<button disabled={busy} onclick={()=>run(async()=>{await session.flush();await session.sync();session.startPolling();})}>Retry</button><button onclick={backup}>Export recovery</button></div>{/if}
    {#if notice}<p class="workspace-notice" role="status">{notice}</p>{/if}
    <div class="workspace-privacy">{#if $sessionState.meta}{$sessionState.meta.mode==='live'?'Collaborative document':'Shared snapshot'} · {$sessionState.meta.role} · Server-readable{:else}Private · this device · opening and editing do not upload this file{/if}{#if selectionAnchor} · {selectedReference.label}{/if}</div>
    {#if recoveryOpen}<section class="workspace-notice" aria-label="Private draft recovery"><div><strong>Unsubmitted work on this device</strong><p>These buffers are private. Restoring one does not publish it.</p>
        {#each stagedReviews as [id,draft](id)}<p><span>{draft.text.slice(0,140)||'Unsubmitted suggestion'}</span> <button onclick={()=>restoreReview(id,draft)}>Restore review</button></p>{/each}
        {#if Object.values($sessionState.drafts).some(draft=>draft.kind==='cell')}<p>Cell drafts can be restored from the spreadsheet’s recovery controls. Export backup retains every buffer.</p>{/if}
        <button onclick={backup}>Export all recovery data</button><button onclick={()=>recoveryOpen=false}>Close recovery</button>
    </div></section>{/if}
    <div class="workspace-body"><main class="workspace-content">{@render children()}</main>
        {#if reviewOpen}<aside class="workspace-reviews" aria-label="Reviews"><h2>Comments and suggestions</h2><button onclick={()=>reviewOpen=false}>Close review</button>
            {#if $sessionState.meta?.role!=='viewer'}
                {#if replyTo}<p>Reply to {recipientName(String($sessionState.reviews.find(item=>item.id===replyTo)?.authorUserId||''))}<button onclick={()=>{replyTo=null;stageReview();}}>New thread instead</button></p>{/if}
                {#if reviewAnchor}<p>Attached to {describeAnchor(session.doc,reviewAnchor).label}<button disabled={!!replyTo} onclick={()=>{reviewAnchor=null;stageReview();}}>Use whole document</button></p>{/if}
                <textarea aria-label="Review comment" value={comment} oninput={event=>changeComment(event.currentTarget.value)} maxlength="8192" placeholder="Discuss this document…"></textarea>
                {#if session.record.kind==='document'}<button onclick={prepareSuggestion}>{suggestion?'Cancel suggestion':'Suggest wording'}</button>{/if}
                {#if suggestion}<p>The proposed text stays separate. Applying it requires an unchanged source or a new review.</p><textarea aria-label="Proposed document text" value={proposal} oninput={event=>{proposal=event.currentTarget.value;stageReview();}} maxlength="1048576"></textarea>{/if}
                <button disabled={busy||(!comment.trim()&&!suggestion)} onclick={()=>run(addReview)}>Submit review</button>
                {#if comment||proposal}<button disabled={busy} onclick={()=>run(clearComposer)}>Discard this review draft</button><small>Saved privately until submitted.</small>{/if}
            {/if}
            {#each $sessionState.reviews as item(item.id)}<article><strong>{item.authorName}</strong><small> · {item.kind} · {item.state}{item.parentId?' · reply':''}</small>
                {#if item.anchor}<p><button disabled={!onanchor||references[item.id]?.missing} onclick={()=>onanchor?.(item.anchor!)}>{references[item.id]?.label||'Reference'}{references[item.id]?.missing?' — content removed':''}</button></p>{#if references[item.id]?.quote}<blockquote>{references[item.id].quote}</blockquote>{/if}{/if}
                <p>{item.body}</p>{#if item.proposal!==null}<details><summary>Proposed wording</summary><pre>{item.proposal}</pre></details>{/if}
                {#if $sessionState.meta?.role!=='viewer'}<button onclick={()=>reply(item)}>Reply</button>{/if}
                {#if editable}<div class="workspace-toolbar">{#if item.kind==='suggestion'&&item.state==='open'}<button disabled={busy||$sessionState.meta?.mode!=='live'} onclick={()=>run(()=>session.review({action:'accept',id:item.id}))}>Apply</button><button disabled={busy} onclick={()=>run(()=>session.review({action:'reject',id:item.id}))}>Reject</button>{/if}<button disabled={busy} onclick={()=>run(()=>session.review({action:item.state==='resolved'?'reopen':'resolve',id:item.id}))}>{item.state==='resolved'?'Reopen':'Resolve'}</button></div>{/if}
            </article>{/each}
        </aside>{/if}
    </div>
</section>
<dialog bind:this={dialog} class="workspace-dialog" aria-label="Document sharing"><form onsubmit={event=>{event.preventDefault();void run(share);}}>
    <h2>Share {title}</h2><p>Publishes to <strong>{session.scope.server}</strong>. The server operator can read this document. No public link is created.</p>
    <label>Working mode<select aria-label="Working mode" bind:value={mode}><option value="live">Collaborative — synchronize subsequent edits</option><option value="snapshot">Snapshot — publish revisions explicitly</option></select></label>
    <label>Person<select aria-label="Person" bind:value={recipient}><option value="">Choose an account</option>{#each $serverMembers.filter(user=>user.dbUserId) as user(user.dbUserId)}<option value={String(user.dbUserId)}>{user.username}</option>{/each}</select></label>
    <div class="workspace-toolbar"><input aria-label="Recipient account ID" inputmode="numeric" placeholder="Account ID" bind:value={recipient}/><select aria-label="Recipient permission" bind:value={recipientRole}><option value="viewer">Viewer</option><option value="commenter">Commenter</option><option value="editor">Editor</option></select><button type="button" onclick={addRecipient}>Add person</button></div>
    {#each Object.entries(grants) as [id,role](id)}<div class="workspace-toolbar"><span>{recipientName(id)} · {role}</span><button type="button" onclick={()=>{const next={...grants};delete next[id];grants=next;}}>Remove access</button></div>{/each}
    <label>Or share with a channel<select aria-label="Sharing channel" bind:value={channelId}><option value="">No channel grant</option>{#each $channels as channel(channel.id)}<option value={channel.id}>{channel.name}</option>{/each}</select></label>
    {#if channelId}<label>Channel permission<select aria-label="Channel permission" bind:value={channelRole}><option value="viewer">Viewer</option><option value="commenter">Commenter</option><option value="editor">Editor</option></select></label><p>Private conversation channels are not supported for plaintext artifacts.</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="workspace-toolbar"><button type="button" disabled={busy} onclick={()=>dialog?.close()}>Cancel</button><button type="submit" class="primary" disabled={busy}>{busy?'Saving…':'Publish and save sharing'}</button></div>
</form></dialog>
<style>.workspace-dialog form{display:block;min-width:0}.workspace-dialog select{width:100%}.workspace-dialog .workspace-toolbar select{width:auto}</style>
