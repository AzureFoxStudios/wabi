<script lang="ts">
    import { onDestroy } from 'svelte';
    import type { ArtifactSession } from '../session';
    import { request, type AudienceState } from '../bridge';
    import AudienceSlideView from '../AudienceSlide.svelte';
    import { audienceSlides } from './model';
    import { prepareEdition, verifyEdition, type ApprovedEdition } from './versionPreview';

    let { session, roomId }: { session: ArtifactSession; roomId: string } = $props();
    let dialog = $state<HTMLDialogElement>();
    let preview = $state<ApprovedEdition | null>(null);
    let destination = $state(''), busy = $state(false), error = $state(''), notice = $state('');
    let controller: AudienceState | null = null;
    let alive = true;
    onDestroy(() => { alive = false; });
    const aspect = () => Number(session.data.get('aspect') || 16 / 9);
    const current = () => { if (!alive || !session.scope.isCurrent()) throw new Error('The account, server, or workspace changed. No audience update was approved.'); };

    async function prepare() {
        if (busy) return;
        busy = true; error = ''; notice = '';
        try {
            current();
            await session.flush();
            controller = await request<AudienceState>(session.scope, `/presentations/${roomId}`);
            current();
            if (!controller.canControl || controller.ended) throw new Error('Only the current presenter can update this active presentation.');
            preview = prepareEdition(audienceSlides(session.data), aspect(), controller.slideId);
            destination = preview.destination;
            dialog?.showModal();
        } catch (e) { if (alive) error = e instanceof Error ? e.message : String(e); }
        finally { if (alive) busy = false; }
    }

    async function approve() {
        if (busy || !preview || !controller) return;
        const approved = preview, state = controller, target = destination;
        busy = true; error = '';
        try {
            current();
            verifyEdition(approved, audienceSlides(session.data), aspect(), target);
            // Persist/publish through the ordinary ACL-checked artifact path. Its response
            // may include remote edits, so check the approved DTO a second time afterward.
            await session.publish(session.record.meta?.mode || 'snapshot');
            current();
            verifyEdition(approved, audienceSlides(session.data), aspect(), target);
            const sourceSequence = session.record.meta?.sequence;
            if (sourceSequence === undefined) throw new Error('The deck was not acknowledged by the server.');
            await request<AudienceState>(session.scope, `/presentations/${roomId}`, {
                action: 'update', generation: state.generation, sequence: state.sequence,
                sourceSequence, slideId: target
            });
            current();
            dialog?.close(); preview = null; controller = null;
            notice = 'The audience now has the approved revision. Private notes were not included.';
        } catch (e) { if (alive) error = e instanceof Error ? e.message : String(e); }
        finally { if (alive) busy = false; }
    }
</script>

<button disabled={busy} onclick={() => void prepare()}>Update presented version…</button>
{#if notice}<span role="status">{notice}</span>{/if}
{#if error && !preview}<span role="alert">{error}</span>{/if}
<dialog class="workspace-dialog" bind:this={dialog} oncancel={event => { if (busy) event.preventDefault(); else { preview = null; controller = null; } }}>
    <h2>Review the next audience version</h2>
    <p>The current audience revision stays unchanged until you approve this preview. This also publishes the saved deck through its existing sharing rules; speaker notes remain private.</p>
    {#if preview}
        {#if preview.currentMissing}<p role="alert">The currently presented slide was removed or hidden. Choose where the audience should continue.</p>{/if}
        <label>Audience destination
            <select aria-label="Audience destination slide" bind:value={destination} disabled={busy}>
                <option value="" disabled>Choose a destination slide</option>
                {#each preview.slides as slide, index (slide.id)}<option value={slide.id}>{index + 1}. {slide.title || 'Untitled slide'}</option>{/each}
            </select>
        </label>
        <div class="edition-preview">
            {#each preview.slides as slide (slide.id)}<AudienceSlideView {slide} aspect={preview.aspect}/>{/each}
        </div>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="workspace-toolbar">
        <button disabled={busy} onclick={() => { dialog?.close(); preview = null; controller = null; }}>Cancel</button>
        <button disabled={busy} onclick={() => void prepare()}>Refresh preview</button>
        <button disabled={busy || !destination} onclick={() => void approve()}>Publish approved audience version</button>
    </div>
</dialog>
<style>
    .edition-preview { max-height: 52vh; overflow: auto; display: grid; gap: .75rem; padding: .75rem 0; }
    label { display: grid; gap: .4rem; }
    select { max-width: 100%; }
</style>
