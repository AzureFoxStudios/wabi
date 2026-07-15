<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { Emoji } from '$lib/socket';

	const dispatch = createEventDispatcher<{
		select: { emoji: Emoji };
	}>();

	export let emojis: Emoji[] = [];
	export let stickerMode = false;
	export let categories: string[] = ['all'];
	export let searchQuery = '';
	const PAGE_SIZE = 80;
	let renderLimit = PAGE_SIZE;

	$: visibleEmojis = emojis.slice(0, renderLimit);
	$: renderLimit = Math.min(Math.max(PAGE_SIZE, renderLimit), emojis.length || PAGE_SIZE);

	function handleScroll(event: Event) {
		const target = event.currentTarget as HTMLElement;
		const nearBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 160;
		if (nearBottom && renderLimit < emojis.length) {
			renderLimit = Math.min(emojis.length, renderLimit + PAGE_SIZE);
		}
	}

	export function resetPagination() {
		renderLimit = PAGE_SIZE;
	}
</script>

<div class="emoji-grid" class:sticker-grid={stickerMode} on:scroll={handleScroll}>
	{#if emojis.length === 0}
		<div class="no-emojis">
			{stickerMode ? 'No stickers found' : 'No emojis found'}
		</div>
	{:else}
		{#each visibleEmojis as emoji (emoji.id)}
			<button
				class="emoji-btn"
				class:sticker-btn={stickerMode}
				on:click={() => dispatch('select', { emoji })}
				title={`${emoji.displayName || emoji.name}${emoji.artist ? ` by ${emoji.artist}` : ''}`}
			>
				<img src={emoji.url} alt={emoji.name} class="emoji-img" class:sticker-img={stickerMode} loading="lazy" decoding="async" />
			</button>
		{/each}
		{#if renderLimit < emojis.length}
			<button class="emoji-load-more" on:click={() => (renderLimit = Math.min(emojis.length, renderLimit + PAGE_SIZE))}>
				Load more ({emojis.length - renderLimit} remaining)
			</button>
		{/if}
	{/if}
</div>

<style>
	.emoji-grid {
		flex: 1;
		min-width: 0;
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		gap: 0.25rem;
		padding: 0.5rem;
		overflow-y: auto;
		overflow-x: hidden;
		max-height: 280px;
	}

	.emoji-grid.sticker-grid {
		grid-template-columns: repeat(4, 1fr);
		gap: 0.5rem;
	}

	.emoji-btn {
		width: 32px;
		height: 32px;
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		transition: all 0.2s;
		padding: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.emoji-btn.sticker-btn {
		width: 68px;
		height: 68px;
	}

	.emoji-btn:hover {
		background: var(--surface-raised);
		transform: scale(1.2);
	}

	.emoji-img {
		width: 24px;
		height: 24px;
		object-fit: contain;
	}

	.emoji-img.sticker-img {
		width: 56px;
		height: 56px;
	}

	.no-emojis {
		grid-column: 1 / -1;
		text-align: center;
		padding: 2rem;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.emoji-load-more {
		grid-column: 1 / -1;
		border: none;
		background: var(--surface-raised);
		color: var(--text-secondary);
		border-radius: 8px;
		padding: 0.5rem 0.75rem;
		font-size: 0.78rem;
	}

	.emoji-load-more:hover {
		background: var(--surface-hover, var(--surface-base));
		color: var(--text-heading);
	}

	@media (max-width: 768px) {
		.emoji-grid {
			grid-template-columns: repeat(6, 1fr);
			gap: 0.375rem;
			padding: 0.5rem;
			max-height: 200px;
		}

		.emoji-grid.sticker-grid {
			grid-template-columns: repeat(3, 1fr);
		}

		.emoji-btn {
			width: 40px;
			height: 40px;
		}

		.emoji-btn.sticker-btn {
			width: 60px;
			height: 60px;
		}

		.emoji-img {
			width: 28px;
			height: 28px;
		}

		.emoji-img.sticker-img {
			width: 48px;
			height: 48px;
		}
	}

	@media (max-width: 400px) {
		.emoji-grid {
			grid-template-columns: repeat(5, 1fr);
		}

		.emoji-grid.sticker-grid {
			grid-template-columns: repeat(3, 1fr);
		}

		.emoji-btn {
			width: 36px;
			height: 36px;
		}

		.emoji-img {
			width: 24px;
			height: 24px;
		}
	}
</style>
