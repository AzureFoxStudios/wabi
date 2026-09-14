<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import type { Emoji } from '$lib/socket';

	const dispatch = createEventDispatcher<{
		select: { emoji: Emoji };
		favorite: { emoji: Emoji };
	}>();

	export let emojis: Emoji[] = [];
	export let stickerMode = false;
	export let favoriteIds: string[] = [];
	export let emptyTitle = '';
	export let emptyHint = '';

	const PAGE_SIZE = 96;
	let renderLimit = PAGE_SIZE;

	$: visibleEmojis = emojis.slice(0, renderLimit);
	$: renderLimit = Math.min(Math.max(PAGE_SIZE, renderLimit), emojis.length || PAGE_SIZE);

	function labelFor(emoji: Emoji): string {
		return emoji.displayName?.trim() || emoji.name.replace(/[_-]+/g, ' ');
	}

	function handleScroll(event: Event) {
		const target = event.currentTarget as HTMLElement;
		const nearBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 180;
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
		<div class="emoji-empty">
			<div class="emoji-empty-icon" aria-hidden="true">{stickerMode ? '◇' : '☺'}</div>
			<strong>{emptyTitle || (stickerMode ? 'No stickers here yet' : 'No emoji here yet')}</strong>
			{#if emptyHint}<span>{emptyHint}</span>{/if}
		</div>
	{:else}
		{#each visibleEmojis as emoji (emoji.id)}
			<div class="emoji-cell" class:sticker-cell={stickerMode}>
				<button
					type="button"
					class="emoji-btn"
					class:sticker-btn={stickerMode}
					on:click={() => dispatch('select', { emoji })}
					title={`${labelFor(emoji)}${emoji.artist ? ` · ${emoji.artist}` : ''}`}
					aria-label={stickerMode ? `Send ${labelFor(emoji)} sticker` : `Use ${labelFor(emoji)} emoji`}
				>
					<img src={emoji.url} alt="" class="emoji-img" class:sticker-img={stickerMode} loading="lazy" decoding="async" />
					{#if stickerMode}
						<span class="sticker-label">{labelFor(emoji)}</span>
					{/if}
				</button>
				<button
					type="button"
					class="favorite-btn"
					class:active={favoriteIds.includes(emoji.id)}
					on:click|stopPropagation={() => dispatch('favorite', { emoji })}
					aria-label={favoriteIds.includes(emoji.id) ? `Remove ${labelFor(emoji)} from favorites` : `Add ${labelFor(emoji)} to favorites`}
					title={favoriteIds.includes(emoji.id) ? 'Remove from favorites' : 'Add to favorites'}
				>
					{favoriteIds.includes(emoji.id) ? '★' : '☆'}
				</button>
			</div>
		{/each}
		{#if renderLimit < emojis.length}
			<button class="emoji-load-more" type="button" on:click={() => (renderLimit = Math.min(emojis.length, renderLimit + PAGE_SIZE))}>
				Show {Math.min(PAGE_SIZE, emojis.length - renderLimit)} more
				<span>{emojis.length - renderLimit} remaining</span>
			</button>
		{/if}
	{/if}
</div>

<style>
	.emoji-grid {
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: grid;
		grid-template-columns: repeat(9, minmax(36px, 1fr));
		align-content: start;
		gap: 0.3rem;
		padding: 0.55rem 0.65rem 0.75rem;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior: contain;
	}

	.emoji-grid.sticker-grid {
		grid-template-columns: repeat(4, minmax(78px, 1fr));
		gap: 0.5rem;
	}

	.emoji-cell {
		position: relative;
		min-width: 0;
		aspect-ratio: 1;
		border-radius: 9px;
	}

	.emoji-cell.sticker-cell {
		aspect-ratio: auto;
		min-height: 92px;
	}

	.emoji-btn {
		width: 100%;
		height: 100%;
		min-height: 38px;
		padding: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid transparent;
		border-radius: 9px;
		background: transparent;
		color: var(--text-primary);
		cursor: pointer;
		transition: background-color 120ms ease, border-color 120ms ease;
	}

	.emoji-btn:hover,
	.emoji-btn:focus-visible {
		background: var(--surface-raised);
		border-color: var(--border-subtle);
		outline: none;
	}

	.emoji-btn:focus-visible {
		box-shadow: 0 0 0 2px var(--accent-primary-color);
	}

	.emoji-img {
		width: 27px;
		height: 27px;
		object-fit: contain;
		transition: transform 120ms ease;
	}

	.emoji-btn:hover .emoji-img,
	.emoji-btn:focus-visible .emoji-img {
		transform: scale(1.08);
	}

	.emoji-btn.sticker-btn {
		min-height: 92px;
		padding: 0.45rem 0.35rem 0.4rem;
		flex-direction: column;
		gap: 0.28rem;
	}

	.emoji-img.sticker-img {
		width: 58px;
		height: 58px;
	}

	.sticker-label {
		width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.68rem;
		line-height: 1.1;
		color: var(--text-secondary);
		text-align: center;
	}

	.favorite-btn {
		position: absolute;
		top: -3px;
		right: -3px;
		width: 20px;
		height: 20px;
		padding: 0;
		display: grid;
		place-items: center;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: var(--surface-modal);
		color: var(--text-muted);
		font-size: 0.72rem;
		line-height: 1;
		cursor: pointer;
		opacity: 0;
		transform: scale(0.86);
		transition: opacity 120ms ease, transform 120ms ease, color 120ms ease, background-color 120ms ease;
		z-index: 2;
	}

	.emoji-cell:hover .favorite-btn,
	.emoji-cell:focus-within .favorite-btn,
	.favorite-btn.active {
		opacity: 1;
		transform: scale(1);
	}

	.favorite-btn:hover,
	.favorite-btn:focus-visible,
	.favorite-btn.active {
		color: var(--accent-primary-color);
		background: var(--surface-raised);
		outline: none;
	}

	.favorite-btn:focus-visible {
		box-shadow: 0 0 0 2px var(--accent-primary-color);
	}

	.emoji-empty {
		grid-column: 1 / -1;
		min-height: 210px;
		padding: 2rem 1rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		text-align: center;
		color: var(--text-secondary);
	}

	.emoji-empty-icon {
		width: 42px;
		height: 42px;
		display: grid;
		place-items: center;
		margin-bottom: 0.25rem;
		border-radius: 12px;
		background: var(--surface-raised);
		color: var(--text-muted);
		font-size: 1.35rem;
	}

	.emoji-empty strong {
		color: var(--text-heading);
		font-size: 0.88rem;
	}

	.emoji-empty span {
		max-width: 27rem;
		font-size: 0.78rem;
		line-height: 1.4;
		text-wrap: balance;
	}

	.emoji-load-more {
		grid-column: 1 / -1;
		min-height: 38px;
		margin-top: 0.25rem;
		padding: 0.5rem 0.75rem;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		border: 1px solid var(--border-subtle);
		border-radius: 9px;
		background: var(--surface-raised);
		color: var(--text-heading);
		font-size: 0.78rem;
		cursor: pointer;
	}

	.emoji-load-more span {
		color: var(--text-muted);
		font-size: 0.7rem;
	}

	.emoji-load-more:hover {
		background: var(--surface-hover, var(--surface-base));
	}

	@media (hover: none) {
		.favorite-btn {
			opacity: 1;
			transform: scale(0.9);
		}
	}

	@media (max-width: 640px) {
		.emoji-grid {
			grid-template-columns: repeat(7, minmax(38px, 1fr));
			gap: 0.32rem;
			padding: 0.55rem;
		}

		.emoji-grid.sticker-grid {
			grid-template-columns: repeat(3, minmax(82px, 1fr));
		}

		.emoji-btn {
			min-height: 42px;
		}

		.emoji-img {
			width: 29px;
			height: 29px;
		}
	}

	@media (max-width: 400px) {
		.emoji-grid {
			grid-template-columns: repeat(6, minmax(38px, 1fr));
		}

		.emoji-grid.sticker-grid {
			grid-template-columns: repeat(3, minmax(74px, 1fr));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.emoji-btn,
		.emoji-img,
		.favorite-btn {
			transition: none;
		}
	}
</style>
