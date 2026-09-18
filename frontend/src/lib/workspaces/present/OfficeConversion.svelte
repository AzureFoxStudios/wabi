<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { request, type Scope } from '../bridge';
    import { to64, from64, download } from '../session';
    let { scope, file, onconverted, oncancel }: {
        scope: Scope; file: File;
        onconverted: (pdf: File, warnings: string[], original: File) => Promise<void>;
        oncancel: () => void;
    } = $props();
    let configured = $state(false), checking = $state(true), busy = $state(false), error = $state('');
    let dialog = $state<HTMLDialogElement>();
    const abort = new AbortController();
    let alive = true;
    const current = () => { abort.signal.throwIfAborted(); if (!alive || !scope.isCurrent()) throw new Error('The account or server changed. The conversion was not imported.'); };
    onMount(() => {
        dialog?.showModal();
        void request<{ configured: boolean }>(scope, '/conversion', undefined, undefined, abort.signal)
            .then(result => { current(); configured = result.configured === true; })
            .catch(e => { if (alive && !abort.signal.aborted) error = e instanceof Error ? e.message : String(e); })
            .finally(() => { if (alive) checking = false; });
    });
    onDestroy(() => { alive = false; abort.abort(); });
    function cancel() { abort.abort(); dialog?.close(); oncancel(); }
    async function convert() {
        if (busy || !configured) return;
        busy = true; error = '';
        try {
            current();
            const extension = file.name.split('.').pop()?.toLowerCase();
            if (!['pptx', 'odp'].includes(extension || '') || file.size > 12 * 1024 * 1024) throw new Error('Choose a PPTX or ODP file under 12 MB.');
            const bytes = new Uint8Array(await file.arrayBuffer()); current();
            const result = await request<{ pdf: string; warnings: string[] }>(scope, '/conversion', {
                extension, data: to64(bytes), consent: true
            }, undefined, abort.signal);
            current();
            const pdf = from64(result.pdf);
            if (pdf.byteLength > 12 * 1024 * 1024 || new TextDecoder().decode(pdf.subarray(0, 5)) !== '%PDF-') throw new Error('The converter returned an invalid PDF.');
            const converted = new File([pdf as BlobPart], file.name.replace(/\.(pptx|odp)$/i, '.pdf'), { type: 'application/pdf' });
            const warnings = Array.isArray(result.warnings) ? result.warnings.filter((text): text is string => typeof text === 'string').map(text => text.slice(0, 2000)).slice(0, 10) : [];
            await onconverted(converted, warnings, file);
        } catch (e) { if (alive && !abort.signal.aborted) error = e instanceof Error ? e.message : String(e); }
        finally { if (alive) busy = false; }
    }
</script>
<dialog class="workspace-dialog" bind:this={dialog} oncancel={event => { event.preventDefault(); cancel(); }}>
    <h2>Convert a PowerPoint or OpenDocument presentation</h2>
    <p><strong>{file.name}</strong> remains unchanged on your device.</p>
    <p>Conversion uploads the entire original to this Wabi server and its operator-configured converter. That original may contain speaker notes, hidden slides, embedded material, or other private information. The server operator can read the uploaded original.</p>
    <p>The result is a static preview: no editable PowerPoint objects, animation, audio, or video. Hidden slides and speaker-note pages are excluded from the converted audience pages. Nothing is shared with a channel or an audience until you approve it separately.</p>
    {#if checking}<p role="status">Checking the server’s optional converter…</p>
    {:else if !configured}<p role="status">Office conversion is not configured here. Export a PDF in the source application and import it instead. No original file has been uploaded.</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    {#if busy}<p role="status">Converting and preparing the static preview… Cancel discards the result; it cannot retract bytes already sent to the server.</p>{/if}
    <div class="workspace-toolbar">
        <button onclick={() => download(file.name, file)}>Keep original file</button>
        <button onclick={cancel}>Cancel conversion</button>
        <button disabled={checking || busy || !configured} onclick={() => void convert()}>Upload original for static conversion</button>
    </div>
</dialog>
