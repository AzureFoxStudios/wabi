<script lang="ts">
    import { onDestroy } from 'svelte';
    import { get } from 'svelte/store';
    import { channels, switchChannel } from '$lib/channelStore';
    import { currentUser } from '$lib/presenceIdentity';
    import { mobileTabQueue } from '$lib/mobileTabQueue';
    import { captureGroupAccess } from '$lib/groupAccess';
    import { stageComposerHandoff } from '$lib/composerHandoff';
    import { workspaceLink } from './bridge';
    import { linkAnchor } from './anchors';
    import type { ArtifactSession } from './session';

    let { session, anchor = null }: { session: ArtifactSession; anchor?: string | null } = $props();
    let dialog = $state<HTMLDialogElement>(), channelId = $state('');
    let reference = $state(''), busy = $state(false), error = $state(''), notice = $state('');
    let savedTask: { id: string; flush: () => Promise<boolean>; isCurrent: () => boolean } | null = null;
    let alive = true;
    const check = () => { if (!alive || !session.scope.isCurrent()) throw new Error('The account or server changed. No reference was sent.'); };
    onDestroy(() => { alive = false; });

    function referenceText(): string {
        check();
        const meta = session.record.meta;
        if (!meta) throw new Error('Share this artifact first. Creating a reference does not upload or grant access to a private file.');
        return `Wabi ${session.record.kind === 'document' ? 'document' : session.record.kind === 'sheets' ? 'spreadsheet' : 'presentation'} reference · observed revision ${meta.sequence}\n${workspaceLink(session.scope.server, session.id, session.record.kind, linkAnchor(anchor))}\nThis link follows the saved artifact and requires existing access.`;
    }
    function showDiscussion() {
        error = ''; notice = '';
        try { reference = referenceText(); channelId = ''; dialog?.showModal(); }
        catch (e) { error = e instanceof Error ? e.message : String(e); }
    }
    async function discuss() {
        if (busy) return;
        busy = true; error = '';
        try {
            check();
            const target = get(channels).find(channel => channel.id === channelId && channel.type === 'text');
            if (!target) throw new Error('Choose an available text channel.');
            const allowed = captureGroupAccess(target.id), scope = session.scope;
            await session.flush(); check();
            if (!allowed()) throw new Error('Channel access changed.');
            stageComposerHandoff(target.id, reference, () => scope.isCurrent() && allowed());
            dialog?.close();
            switchChannel(target.id);
            mobileTabQueue.setActiveChannel(target.id);
            notice = 'The reference is in the chat composer, not sent. Review it before sending.';
        } catch (e) { if (alive) error = e instanceof Error ? e.message : String(e); }
        finally { if (alive) busy = false; }
    }
    async function createTask() {
        if (busy) return;
        busy = true; error = ''; notice = '';
        try {
            check();
            const text = referenceText();
            await session.flush(); check();
            const store = await import('$lib/business/store');
            const storage = await import('$lib/business/deviceStorage');
            check();
            if (!savedTask) {
                const captured = storage.capturePlannerSession();
                if (!captured.isCurrent()) throw new Error('Planner account changed.');
                const user = get(currentUser);
                const todo = store.addTodo({ title: 'Review linked workspace selection', description: text, status: 'todo', priority: 'medium', createdBy: String(user?.dbUserId || user?.id || 'local'), visibility: 'private' });
                savedTask = { id: todo.id, flush: () => captured.session.flush(), isCurrent: captured.isCurrent };
            }
            if (!savedTask.isCurrent()) throw new Error('Planner account changed. The original task remains in its original account.');
            if (!(await savedTask.flush())) throw new Error('Task storage needs attention. Retry saves the same task; it does not create a duplicate.');
            check();
            notice = 'Private task saved in Planner. Only the access-controlled reference was included.';
        } catch (e) { if (alive) error = e instanceof Error ? e.message : String(e); }
        finally { if (alive) busy = false; }
    }
</script>
<button disabled={busy} onclick={showDiscussion}>Discuss in chat…</button>
<button disabled={busy} onclick={() => void createTask()}>Create private task</button>
{#if notice}<span role="status">{notice} {#if savedTask}<button onclick={() => mobileTabQueue.openAddonTab('planner')}>Open Planner</button>{/if}</span>{/if}
{#if error}<span role="alert">{error}</span>{/if}
<dialog class="workspace-dialog" bind:this={dialog} oncancel={event => { if (busy) event.preventDefault(); }}>
    <h2>Discuss an access-controlled reference</h2>
    <p>Only the reference below goes into your unsent chat draft. No selected text, cells, other tabs, notes, or extra permissions are included.</p>
    <pre>{reference}</pre>
    <label>Text channel<select aria-label="Reference discussion channel" bind:value={channelId} disabled={busy}><option value="" disabled>Choose a channel</option>{#each $channels.filter(channel => channel.type === 'text') as channel (channel.id)}<option value={channel.id}>{channel.name}</option>{/each}</select></label>
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="workspace-toolbar"><button disabled={busy} onclick={() => dialog?.close()}>Cancel</button><button disabled={busy || !channelId} onclick={() => void discuss()}>Open unsent chat draft</button></div>
</dialog>
<style>pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 35vh; overflow: auto; } label { display: grid; gap: .4rem; }</style>
