<!--
	Click-to-load for media hosted elsewhere, in a message under experimental encryption
	(privacy/contentEgress.ts, linkEmbedPolicy.ts). Until the viewer chooses, only the link is drawn
	and nothing is requested from its host; the click is the explicit choice, and then the embed
	(the children) renders as it would anywhere else.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { remoteLoadHint, remoteLoadLabel } from '$lib/privacy/contentEgress';
	import Icon from '../ui/Icon.svelte';

	let { url, showLink = true, children }: { url: string; showLink?: boolean; children?: Snippet } = $props();

	let loaded = $state(false);
	let label = $derived(remoteLoadLabel(url));
	let hint = $derived(remoteLoadHint(url));
</script>

{#if loaded}
	{@render children?.()}
{:else}
	<div class="remote-media-gate">
		{#if showLink}
			<a href={url} target="_blank" rel="noopener noreferrer nofollow" class="plain-link-fallback remote-media-gate__link">{url}</a>
		{/if}
		<button type="button" class="w-btn w-btn--quiet w-btn--sm remote-media-gate__load" title={hint} onclick={() => (loaded = true)}>
			<Icon name="download" size={14} />
			{label}
		</button>
		<span class="remote-media-gate__hint">{hint}</span>
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
	}
	.remote-media-gate__hint {
		flex-basis: 100%;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
</style>
