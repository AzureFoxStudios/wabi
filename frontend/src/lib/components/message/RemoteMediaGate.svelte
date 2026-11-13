<!--
	Click-to-load for media hosted elsewhere, in content kept on the device
	(privacy/contentEgress.ts, privacy/remoteMedia.ts). Until the member chooses, only the link is
	drawn and nothing is requested from its host; the click is the explicit choice, and then the
	embed (the children) renders as it would anywhere else, with focus moved to it.
-->
<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { remoteLoadHint, remoteLoadLabel } from '$lib/privacy/contentEgress';
	import Icon from '../ui/Icon.svelte';

	let {
		url,
		showLink = true,
		showHint = true,
		children
	}: {
		url: string;
		/** false when the link is already visible in the message text. */
		showLink?: boolean;
		/** false when the message shows one note for all its gates; the hint stays as the button's description. */
		showHint?: boolean;
		children?: Snippet;
	} = $props();

	let loaded = $state(false);
	let loadedRegion = $state<HTMLDivElement | null>(null);
	let label = $derived(remoteLoadLabel(url));
	let hint = $derived(remoteLoadHint(url));
	const uid = $props.id();
	const hintId = `remote-media-hint-${uid}`;

	async function load(): Promise<void> {
		loaded = true;
		await tick();
		// The button is gone; keep keyboard and screen-reader users where they were.
		const target = loadedRegion?.querySelector<HTMLElement>('video, audio, iframe, a, button, [tabindex]') ?? loadedRegion;
		target?.focus();
	}
</script>

{#if loaded}
	<div class="remote-media-gate__loaded" tabindex="-1" bind:this={loadedRegion}>
		{@render children?.()}
	</div>
{:else}
	<div class="remote-media-gate">
		{#if showLink}
			<a href={url} target="_blank" rel="noopener noreferrer nofollow" class="plain-link-fallback remote-media-gate__link">{url}</a>
		{/if}
		<button type="button" class="w-btn w-btn--quiet w-btn--sm remote-media-gate__load" title={hint} aria-describedby={hintId} onclick={load}>
			<Icon name="download" size={14} />
			{label}
		</button>
		<span id={hintId} class="remote-media-gate__hint" class:sr-only={!showHint}>{hint}</span>
	</div>
{/if}

<style>
	.remote-media-gate {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		margin-top: 4px;
		min-width: 0;
		max-width: 100%;
	}
	.remote-media-gate__link {
		min-width: 0;
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	.remote-media-gate__load {
		flex: none;
		max-width: 100%;
	}
	.remote-media-gate__hint {
		flex-basis: 100%;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	.remote-media-gate__loaded:focus {
		outline: none;
	}
	.remote-media-gate__loaded:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: 2px;
	}
</style>
