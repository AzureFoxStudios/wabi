<script lang="ts">
    import type { Snippet } from 'svelte';
    import { serverMembers } from '$lib/presenceIdentity';
    import { channels } from '$lib/channelStore';
    import { workspaceLink, type Role } from './bridge';
    import { ArtifactSession, download, editText } from './session';
    import './workspace.css';
    let { session, onlibrary, initialShare, children }: {session:ArtifactSession;onlibrary:()=>void;initialShare?:'snapshot'|'live';children:Snippet}=$props();
    const sessionState=session.state;
    let dialog:HTMLDialogElement;let error=$state('');let busy=$state(false);let reviewOpen=$state(false);let mode=$state<'snapshot'|'live'>(initialShare||'live');
    let recipient=$state('');let recipientRole=$state<Role>('editor');let grants=$state<Record<string,Role>>({});let channelId=$state('');let channelRole=$state<Role>('viewer');let accessRevision=$state(0);let openedInitial=false;
    let comment=$state('');let proposal=$state('');let suggestion=$state(false);let suggestionBase=$state(0);let reviewId=crypto.randomUUID();
    const editable=$derived(($sessionState.tick,session.editable));
    async function run(fn:()=>Promise<unknown>){busy=true;error='';try{await fn();}catch(e){error=e instanceof Error?e.message:String(e);}finally{busy=false;}}
    function showSharing(){const m=session.record.meta;mode=initialShare||m?.mode||'live';grants={...(m?.grants||{})};channelId=m?.channelId||'';channelRole=m?.channelRole||'viewer';accessRevision=m?.accessRevision||0;dialog.showModal();}
    $effect(()=>{if(initialShare&&dialog&&!openedInitial){openedInitial=true;showSharing();}});
    async function share(){await session.publish(mode);await session.access(grants,channelId||null,channelRole,mode,accessRevision||session.record.meta!.accessRevision);dialog.close();}
    function addRecipient(){if(!/^[1-9]\d*$/.test(recipient))return;grants={...grants,[recipient]:recipientRole};recipient='';}
    function recipientName(id:string){return $serverMembers.find(u=>String(u.dbUserId)===id)?.username||`Account ${id}`;}
    function prepareSuggestion(){suggestion=!suggestion;if(suggestion){proposal=session.body.toString();suggestionBase=session.record.meta?.sequence||0;}}
    async function addReview(){await session.review({action:'add',id:reviewId,kind:suggestion?'suggestion':'comment',body:comment,...(suggestion?{proposal,baseSequence:suggestionBase}:{})});reviewId=crypto.randomUUID();comment='';proposal='';suggestion=false;}
    function exportOriginal(){const original=session.record.original;if(original)download(original.name,original.blob);}
</script>
<section class="wabi-workspace" aria-label={`${session.record.kind} workspace`}>
    <header class="workspace-bar">
        <button onclick={()=>run(async()=>{await session.flush();onlibrary();})} disabled={busy}>Library</button>
        <input class="workspace-title" aria-label="Document title" value={($sessionState.tick,session.title)} maxlength="200" disabled={!editable} onchange={event=>{const value=event.currentTarget.value.trim();if(value)editText(session.doc.getText('title'),value,session.origin);}} />
        <span class="workspace-status" role="status">{$sessionState.status}</span>
        <button onclick={()=>download(`${session.title}.wabi.json`,session.recovery())}>Export backup</button>
        {#if session.record.original}<button onclick={exportOriginal}>Original file</button>{/if}
        {#if !$sessionState.meta||$sessionState.meta.role==='owner'}<button class="primary" onclick={showSharing}>Share…</button>{/if}
        {#if $sessionState.meta}
            <button onclick={()=>run(()=>navigator.clipboard.writeText(workspaceLink(session.scope.server,session.id,session.record.kind)))}>Copy link</button>
            <button onclick={()=>reviewOpen=!reviewOpen}>Review {$sessionState.reviews.filter(r=>r.state==='open').length||''}</button>
            {#if $sessionState.meta.mode==='snapshot'&&$sessionState.meta.role==='owner'}<button onclick={()=>run(()=>session.sync(true))}>Publish revision</button>{/if}
        {/if}
        <button onclick={()=>session.undo.undo()} disabled={!editable}>Undo</button><button onclick={()=>session.undo.redo()} disabled={!editable}>Redo</button>
    </header>
    {#if error||$sessionState.error}<div class="workspace-notice" role="alert">{error||$sessionState.error}<button onclick={()=>run(async()=>{await session.flush();await session.sync();session.startPolling();})}>Retry</button></div>{/if}
    <div class="workspace-privacy">{#if $sessionState.meta}{$sessionState.meta.mode==='live'?'Collaborative document':'Shared snapshot'} · {$sessionState.meta.role} · Server-readable{#else}Private · this device · opening and editing do not upload this file{/if}</div>
    <div class="workspace-body"><main class="workspace-content">{@render children()}</main>
        {#if reviewOpen}<aside class="workspace-reviews" aria-label="Reviews"><h2>Comments and suggestions</h2><button onclick={()=>reviewOpen=false}>Close review</button>
            {#if $sessionState.meta?.role!=='viewer'}
                <textarea aria-label="Review comment" bind:value={comment} maxlength="8192" placeholder="Discuss this document…"></textarea>
                {#if session.record.kind==='document'}<button onclick={prepareSuggestion}>{suggestion?'Cancel suggestion':'Suggest wording'}</button>{/if}
                {#if suggestion}<p>Proposed text stays separate until an editor accepts it. Changed source text requires a new review.</p><textarea aria-label="Proposed document text" bind:value={proposal} maxlength="1048576"></textarea>{/if}
                <button disabled={busy||(!comment.trim()&&!suggestion)} onclick={()=>run(addReview)}>Submit review</button>
            {/if}
            {#each $sessionState.reviews as item(item.id)}<article><strong>{item.authorName}</strong><small> · {item.kind} · {item.state}</small><p>{item.body}</p>{#if item.proposal!==null}<details><summary>Proposed wording</summary><pre>{item.proposal}</pre></details>{/if}
                {#if editable}<div class="workspace-toolbar">{#if item.kind==='suggestion'&&item.state==='open'}<button disabled={busy||$sessionState.meta?.mode!=='live'} onclick={()=>run(()=>session.review({action:'accept',id:item.id}))}>Apply</button><button onclick={()=>run(()=>session.review({action:'reject',id:item.id}))}>Reject</button>{/if}<button onclick={()=>run(()=>session.review({action:item.state==='resolved'?'reopen':'resolve',id:item.id}))}>{item.state==='resolved'?'Reopen':'Resolve'}</button></div>{/if}
            </article>{/each}
        </aside>{/if}
    </div>
</section>
<dialog bind:this={dialog} class="workspace-dialog"><form onsubmit={event=>{event.preventDefault();void run(share);}}>
    <h2>Share {session.title}</h2><p>Publishes to <strong>{session.scope.server}</strong>. The server operator can read this document. No public link is created.</p>
    <label>Working mode<select bind:value={mode}><option value="live">Collaborative — synchronize subsequent edits</option><option value="snapshot">Snapshot — publish revisions explicitly</option></select></label>
    <label>Person<select bind:value={recipient}><option value="">Choose an account</option>{#each $serverMembers.filter(u=>u.dbUserId) as user(user.dbUserId)}<option value={String(user.dbUserId)}>{user.username}</option>{/each}</select></label>
    <div class="workspace-toolbar"><input aria-label="Recipient account ID" inputmode="numeric" placeholder="Account ID" bind:value={recipient}/><select aria-label="Recipient permission" bind:value={recipientRole}><option value="viewer">Viewer</option><option value="commenter">Commenter</option><option value="editor">Editor</option></select><button type="button" onclick={addRecipient}>Add person</button></div>
    {#each Object.entries(grants) as [id,role](id)}<div class="workspace-toolbar"><span>{recipientName(id)} · {role}</span><button type="button" onclick={()=>{const next={...grants};delete next[id];grants=next;}}>Remove access</button></div>{/each}
    <label>Or share with a channel<select bind:value={channelId}><option value="">No channel grant</option>{#each $channels as channel(channel.id)}<option value={channel.id}>{channel.name}</option>{/each}</select></label>
    {#if channelId}<label>Channel permission<select bind:value={channelRole}><option value="viewer">Viewer</option><option value="commenter">Commenter</option><option value="editor">Editor</option></select></label><p>Private conversation channels are not supported for plaintext artifacts.</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="workspace-toolbar"><button type="button" disabled={busy} onclick={()=>dialog.close()}>Cancel</button><button type="submit" class="primary" disabled={busy}>{busy?'Saving…':'Publish and save sharing'}</button></div>
</form></dialog>
