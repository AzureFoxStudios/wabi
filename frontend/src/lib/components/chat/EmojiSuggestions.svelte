<script lang="ts">
	import type { Emoji } from '$lib/socket-types';

	export let suggestions: Emoji[] = [];
	export let selectedIndex = 0;
	export let container: HTMLElement | null = null;
	export let onApply: (index: number) => void | Promise<void>;
</script>

<div class="emoji-suggestions" bind:this={container}>
	{#each suggestions as emoji, index (emoji.id)}
		<button type="button" class="emoji-suggestion" class:selected={index === selectedIndex} on:mousedown|preventDefault={() => void onApply(index)}>
			<img src={emoji.url} alt="" loading="lazy" decoding="async" />
			<span>:{emoji.name}:</span>
		</button>
	{/each}
</div>

<style>
	.emoji-suggestions {
		position: absolute;
		left: 0.5rem;
		bottom: calc(100% + 0.35rem);
		z-index: 110;
		min-width: 220px;
		max-width: min(360px, calc(100vw - 1rem));
		max-height: 230px;
		overflow-y: auto;
		padding: 0.3rem;
		border: 1px solid var(--border-subtle, rgba(255,255,255,.14));
		border-radius: 10px;
		background: var(--surface-modal, var(--surface-raised));
		box-shadow: 0 12px 30px rgba(0,0,0,.22);
	}
	.emoji-suggestion {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		width: 100%;
		padding: 0.4rem 0.5rem;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-primary, inherit);
		text-align: left;
		cursor: pointer;
	}
	.emoji-suggestion.selected,
	.emoji-suggestion:hover { background: var(--surface-hover, var(--surface-raised)); }
	.emoji-suggestion img { width: 24px; height: 24px; object-fit: contain; flex: 0 0 24px; }
	.emoji-suggestion span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
