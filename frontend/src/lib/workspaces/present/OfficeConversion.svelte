<!--
	Opening a PowerPoint or OpenDocument file in Present (design contract §8.8, §7.13, §7.16).
	A centred kit dialog that leads with what this server can do:

	- checking: the 2px line and one sentence; nothing has been sent;
	- not configured: an info notice first ("Conversion isn't set up on this server") and the way
	  forward (export a PDF and open that); no consent text for a step that cannot happen;
	- configured: the consent facts verbatim in meaning (the whole original is uploaded, it may
	  hold notes, hidden slides or embedded material, the operator can read it, the result is a
	  static preview, nothing reaches a channel until approved), then "Upload original for static
	  conversion". Cancel discards the result; it cannot retract bytes already sent.
-->
<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { request, type Scope } from '../bridge';
	import { to64, from64 } from '../session';
	import BaseModal from '$lib/components/BaseModal.svelte';
	import Notice from '$lib/components/ui/Notice.svelte';
	import LoadLine from '$lib/components/ui/LoadLine.svelte';
	let { scope, file, onconverted, oncancel }: {
		scope: Scope; file: File;
		onconverted: (pdf: File, warnings: string[], original: File) => Promise<void>;
		oncancel: () => void;
	} = $props();
	let maxBytes = $state((2 * 1024 * 1024 - 1024) / 4 * 3);
	let configured = $state(false), checking = $state(true), busy = $state(false), error = $state(''), errorDetail = $state<unknown>(null);
	let open = $state(true);
	const abort = new AbortController();
	let alive = true;
	const current = () => { abort.signal.throwIfAborted(); if (!alive || !scope.isCurrent()) throw new Error('The account or server changed. The conversion was not imported.'); };
	const mine = (e: unknown) => e instanceof Error && e.constructor === Error;
	onMount(() => {
		void request<{ configured: boolean; maxBytes: number }>(scope, '/conversion', undefined, undefined, abort.signal)
			.then(result => { current(); configured = result.configured === true; if (Number.isSafeInteger(result.maxBytes) && result.maxBytes > 0) maxBytes = Math.min(maxBytes, result.maxBytes); })
			.catch(e => { if (alive && !abort.signal.aborted) { errorDetail = e; error = mine(e) ? (e as Error).message : "Couldn't ask this server about conversion"; } })
			.finally(() => { if (alive) checking = false; });
	});
	onDestroy(() => { alive = false; abort.abort(); });
	function cancel() { abort.abort(); open = false; oncancel(); }
	async function convert() {
		if (busy || !configured) return;
		busy = true; error = '';
		try {
			current();
			const extension = file.name.split('.').pop()?.toLowerCase();
			if (!['pptx', 'odp'].includes(extension || '') || file.size > maxBytes) throw new Error(`Choose a PPTX or ODP under ${(maxBytes / (1024 * 1024)).toFixed(1)} MiB for this server. The original is retained.`);
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
		} catch (e) { if (alive && !abort.signal.aborted) { errorDetail = e; error = mine(e) ? (e as Error).message : "Couldn't convert this presentation"; } }
		finally { if (alive) busy = false; }
	}
</script>

<BaseModal isOpen={open} onClose={cancel} size="md" padded title="Convert a PowerPoint or OpenDocument presentation" note={file.name}>
	<div class="present-dialog">
		{#if checking}
			<LoadLine label="Checking this server" />
			<p class="present-dialog__truth" role="status">Checking whether this server can convert presentations. Nothing has been uploaded.</p>
		{:else if !configured && !error}
			<Notice tone="info" title="Conversion isn't set up on this server" text="Export a PDF from PowerPoint, Keynote or LibreOffice and open that in Present instead. Nothing was uploaded, and your file is unchanged." />
		{:else}
			{#if error}<Notice title={error} text="Your file is unchanged on this device." error={errorDetail} />{/if}
			{#if configured}
				<p class="present-dialog__truth">Conversion uploads the entire original to this Wabi server and its operator-configured converter. It may contain speaker notes, hidden slides, embedded material or other private information. <strong>The server operator can read the uploaded original.</strong></p>
				<p class="present-dialog__truth">The result is a static preview: no editable PowerPoint objects, animation, audio or video. Hidden slides and speaker-note pages are left out. Nothing is shared with a channel or an audience until you approve it separately.</p>
				{#if busy}<p class="present-dialog__truth" role="status">Converting and preparing the static preview… Cancel discards the result; it cannot retract bytes already sent to the server.</p>{/if}
			{/if}
		{/if}
	</div>
	<div slot="footer" class="w-dialog__foot">
		{#if !checking && !configured}
			<button type="button" class="w-btn w-btn--primary" onclick={cancel}>Close</button>
		{:else}
			<button type="button" class="w-btn w-btn--quiet" onclick={cancel}>Cancel conversion</button>
			<button type="button" class="w-btn w-btn--primary" disabled={checking || busy || !configured} onclick={() => void convert()}>Upload original for static conversion</button>
		{/if}
	</div>
</BaseModal>
