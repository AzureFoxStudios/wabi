<script lang="ts">
	/** Attaches a MediaStream to a <video> element (srcObject needs a
	 * property assignment — Svelte attributes don't cover it). LiveKit screen
	 * publications may deliberately arrive here as zero-track placeholders so
	 * the UI can offer View without subscribing to any screen bytes. */
	import { hideLivekitScreenShare, viewLivekitScreenShare } from '$lib/callingLivekit';

	let { stream, muted = true, mirror = false }: { stream: MediaStream; muted?: boolean; mirror?: boolean } = $props();

	type TaggedShareStream = MediaStream & {
		__wabiLivekitShare?: true;
		__wabiLivekitShareOwnerId?: string;
		__wabiLivekitSharePending?: boolean;
		__wabiLivekitShareViewing?: boolean;
	};

	let el: HTMLVideoElement | undefined = $state();
	let tagged = $derived(stream as TaggedShareStream);
	let isLivekitShare = $derived(tagged.__wabiLivekitShare === true);
	let ownerId = $derived(tagged.__wabiLivekitShareOwnerId ?? '');
	let pending = $derived(isLivekitShare && tagged.__wabiLivekitSharePending === true);
	let viewing = $derived(isLivekitShare && tagged.__wabiLivekitShareViewing === true);

	$effect(() => {
		if (!el || pending) return;
		el.srcObject = stream;
		el.muted = muted;
		void el.play().catch(() => undefined);
	});
</script>

{#if pending}
	<div class="livekit-share-gate" aria-label="Remote screen share available">
		<div class="livekit-share-gate-icon" aria-hidden="true">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
				<rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
				<line x1="8" y1="21" x2="16" y2="21" />
				<line x1="12" y1="17" x2="12" y2="21" />
			</svg>
		</div>
		<strong>{viewing ? 'Connecting to screen…' : 'Screen share available'}</strong>
		<span>{viewing ? 'Waiting for the media subscription.' : 'Video and share audio are not being downloaded.'}</span>
		<button type="button" disabled={viewing || !ownerId} onclick={() => ownerId && viewLivekitScreenShare(ownerId)}>
			{viewing ? 'Connecting…' : 'View'}
		</button>
	</div>
{:else if isLivekitShare}
	<div class="livekit-share-view">
		<video bind:this={el} playsinline autoplay class:mirror></video>
		<button
			type="button"
			class="livekit-share-stop"
			onclick={() => ownerId && hideLivekitScreenShare(ownerId)}
			title="Stop receiving this screen share"
		>
			Stop viewing
		</button>
	</div>
{:else}
	<video bind:this={el} playsinline autoplay class:mirror></video>
{/if}

<style>
	.livekit-share-view {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: inherit;
	}

	.livekit-share-view video {
		width: 100%;
		height: 100%;
	}

	.livekit-share-stop {
		position: absolute;
		top: 0.55rem;
		right: 0.55rem;
		z-index: 2;
		border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, #101217 78%, transparent);
		color: white;
		padding: 0.35rem 0.65rem;
		font: inherit;
		font-size: 0.75rem;
		cursor: pointer;
		backdrop-filter: blur(10px);
	}

	.livekit-share-gate {
		box-sizing: border-box;
		width: 100%;
		height: 100%;
		min-height: 9rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		padding: 1rem;
		text-align: center;
		background: color-mix(in srgb, currentColor 4%, transparent);
		border: 1px dashed color-mix(in srgb, currentColor 18%, transparent);
		border-radius: inherit;
	}

	.livekit-share-gate-icon {
		width: 2rem;
		height: 2rem;
		opacity: 0.72;
	}

	.livekit-share-gate-icon svg {
		width: 100%;
		height: 100%;
	}

	.livekit-share-gate strong {
		font-size: 0.9rem;
	}

	.livekit-share-gate span {
		max-width: 24rem;
		font-size: 0.76rem;
		opacity: 0.68;
	}

	.livekit-share-gate button {
		margin-top: 0.2rem;
		border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
		border-radius: 0.55rem;
		background: color-mix(in srgb, currentColor 9%, transparent);
		color: inherit;
		padding: 0.45rem 0.9rem;
		font: inherit;
		font-weight: 650;
		cursor: pointer;
	}

	.livekit-share-gate button:disabled {
		cursor: progress;
		opacity: 0.6;
	}

	.mirror {
		transform: scaleX(-1);
	}
</style>
