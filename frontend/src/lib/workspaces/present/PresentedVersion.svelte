<!--
	"Update presented version…" for a deck with a live room (design contract §8.8, §7.13).
	The deck's Present menu calls `prepare()`; this component owns the review dialog. The audience
	stays on its approved revision until the presenter approves this preview, and the preview is
	checked against the deck again before and after publishing (versionPreview.ts). Speaker notes
	are never part of it. Failures go to the deck's notice (`onerror`), success is a toast.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { ArtifactSession } from '../session';
	import { request, type AudienceState } from '../bridge';
	import AudienceSlideView from '../AudienceSlide.svelte';
	import { audienceSlides } from './model';
	import { prepareEdition, verifyEdition, type ApprovedEdition } from './versionPreview';
	import BaseModal from '$lib/components/BaseModal.svelte';
	import Notice from '$lib/components/ui/Notice.svelte';
	import { toast } from '$lib/toast';

	let { session, roomId, onerror = () => {} }: { session: ArtifactSession; roomId: string; onerror?: (error: unknown, cause: string) => void } = $props();
	let open = $state(false);
	let preview = $state<ApprovedEdition | null>(null);
	let destination = $state(''), busy = $state(false), error = $state(''), errorDetail = $state<unknown>(null);
	let controller: AudienceState | null = null;
	let alive = true;
	onDestroy(() => { alive = false; });
	const aspect = () => Number(session.data.get('aspect') || 16 / 9);
	const current = () => { if (!alive || !session.scope.isCurrent()) throw new Error('The account, server, or workspace changed. No audience update was approved.'); };
	const mine = (e: unknown) => e instanceof Error && e.constructor === Error;

	/** Fetch the room, then open the review of the next audience version. */
	export async function prepare() {
		if (busy) return;
		busy = true; error = '';
		try {
			current();
			await session.flush();
			controller = await request<AudienceState>(session.scope, `/presentations/${roomId}`);
			current();
			if (!controller.canControl || controller.ended) throw new Error('Only the current presenter can update this active presentation.');
			preview = prepareEdition(audienceSlides(session.data), aspect(), controller.slideId);
			destination = preview.destination;
			open = true;
		} catch (e) {
			if (!alive) return;
			if (open) { errorDetail = e; error = mine(e) ? (e as Error).message : "Couldn't refresh the preview"; }
			else onerror(e, "Couldn't reach the presentation room");
		}
		finally { if (alive) busy = false; }
	}

	function close() {
		if (busy) return;
		open = false; preview = null; controller = null; error = '';
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
			open = false; preview = null; controller = null;
			toast('The audience now has the approved revision. Private notes were not included.', { tone: 'info', timeout: 7000 });
		} catch (e) { if (alive) { errorDetail = e; error = mine(e) ? (e as Error).message : "Couldn't publish the update"; } }
		finally { if (alive) busy = false; }
	}
</script>

<BaseModal isOpen={open} onClose={close} size="lg" padded title="Review the next audience version" note="The audience keeps its revision until you approve">
	<div class="present-dialog">
		<p class="present-dialog__truth">Approving publishes the saved deck through its existing sharing rules, then moves the audience to it. Speaker notes stay private.</p>
		{#if error}<Notice title={error} text="The audience is still on its approved revision." error={errorDetail} />{/if}
		{#if preview}
			{#if preview.currentMissing}<Notice tone="warn" title="The slide on screen was removed or hidden" text="Choose where the audience should continue." />{/if}
			<label class="present-field">
				<span class="w-label">Audience continues at</span>
				<span class="w-field">
					<select aria-label="Audience destination slide" bind:value={destination} disabled={busy}>
						<option value="" disabled>Choose a slide</option>
						{#each preview.slides as slide, index (slide.id)}<option value={slide.id}>{index + 1}. {slide.title || 'Untitled slide'}</option>{/each}
					</select>
				</span>
			</label>
			<p class="present-dialog__count">{preview.slides.length} {preview.slides.length === 1 ? 'slide' : 'slides'} in this version</p>
			<ol class="present-thumbs" aria-label="Slides in this version">
				{#each preview.slides as slide, index (slide.id)}
					<li class="present-thumbs__item" class:present-thumbs__item--current={slide.id === destination}>
						<span class="present-thumbs__frame" aria-hidden="true"><AudienceSlideView {slide} aspect={preview.aspect} /></span>
						<span class="present-thumbs__caption"><span class="present-thumbs__num">{index + 1}</span>{slide.title || 'Untitled slide'}</span>
					</li>
				{/each}
			</ol>
		{/if}
	</div>
	<div slot="footer" class="w-dialog__foot">
		<button type="button" class="w-btn w-btn--quiet" disabled={busy} onclick={close}>Cancel</button>
		<button type="button" class="w-btn" disabled={busy} onclick={() => void prepare()}>Refresh preview</button>
		<button type="button" class="w-btn w-btn--primary" disabled={busy || !destination} onclick={() => void approve()}>Publish approved audience version</button>
	</div>
</BaseModal>
