<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { emojis, type Emoji } from '$lib/socket';

	const dispatch = createEventDispatcher<{
		select: { emoji: Emoji };
		close: void;
	}>();

	let selectedCategory = 'all';
	let searchQuery = '';

	// Group emojis by category
	$: categories = ['all', ...new Set($emojis.map(e => e.category))];

	$: filteredEmojis = $emojis.filter(emoji => {
		const matchesCategory = selectedCategory === 'all' || emoji.category === selectedCategory;
		const matchesSearch = searchQuery === '' ||
			emoji.name.toLowerCase().includes(searchQuery.toLowerCase());
		return matchesCategory && matchesSearch;
	});

	function handleEmojiClick(emoji: Emoji) {
		dispatch('select', { emoji });
	}

	function getCategoryIcon(category: string): string {
		switch (category) {
			case 'all': return '🌟';
			case 'smileys': return '😀';
			case 'gestures': return '👋';
			case 'hearts': return '❤️';
			case 'symbols': return '⭐';
			case 'objects': return '🎁';
			default: return '📁';
		}
	}
</script>

<div class="emoji-picker">
		<div class="emoji-header">
			<input
				type="text"
				placeholder="Search emojis..."
				bind:value={searchQuery}
			/>
			<button on:click={() => dispatch('close')} class="close-btn">✕</button>
		</div>

		<!-- Category tabs -->
		<div class="category-tabs">
			{#each categories as category}
				<button
					class="category-tab"
					class:active={selectedCategory === category}
					on:click={() => selectedCategory = category}
					title={category}
				>
					{getCategoryIcon(category)}
				</button>
			{/each}
		</div>

		<!-- Emoji grid -->
		<div class="emoji-grid">
			{#if filteredEmojis.length === 0}
				<div class="no-emojis">No emojis found</div>
			{:else}
				{#each filteredEmojis as emoji (emoji.id)}
					<button
						class="emoji-btn"
						on:click={() => handleEmojiClick(emoji)}
						title=":{emoji.name}:"
					>
						<img src={emoji.url} alt={emoji.name} class="emoji-img" />
					</button>
				{/each}
			{/if}
		</div>
	</div>

<style>
	.emoji-picker {
		position: absolute;
		bottom: 70px;
		right: 1rem;
		width: 400px;
		height: 400px;
		background: var(--modal-bg);
		border: none;
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		box-shadow: none;
		z-index: 100;
	}

	.emoji-header {
		padding: 1rem;
		border-bottom: none;
		display: flex;
		gap: 0.5rem;
	}

	.emoji-header input {
		flex: 1;
	}

	.close-btn {
		background: transparent;
		color: var(--text-secondary);
		padding: 0.5rem;
		width: 40px;
	}

	.close-btn:hover {
		color: var(--text-primary);
		background: var(--bg-tertiary);
	}

	.category-tabs {
		display: flex;
		gap: 0.25rem;
		padding: 0.5rem;
		border-bottom: 1px solid var(--border);
		background: var(--bg-tertiary);
		overflow-x: auto;
	}

	.category-tab {
		min-width: 40px;
		height: 40px;
		background: transparent;
		border: none;
		border-radius: 4px;
		font-size: 1.25rem;
		cursor: pointer;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.category-tab:hover {
		background: var(--bg-secondary);
	}

	.category-tab.active {
		background: var(--color-primary);
	}

	.emoji-grid {
		flex: 1;
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		gap: 0.25rem;
		padding: 0.5rem;
		overflow-y: auto;
		max-height: 280px;
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

	.emoji-btn:hover {
		background: var(--bg-tertiary);
		transform: scale(1.2);
	}

	.emoji-img {
		width: 24px;
		height: 24px;
		object-fit: contain;
	}

	.no-emojis {
		grid-column: 1 / -1;
		text-align: center;
		padding: 2rem;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	/* Scrollbar styling */
	.emoji-grid::-webkit-scrollbar {
		width: 8px;
	}

	.emoji-grid::-webkit-scrollbar-track {
		background: var(--bg-tertiary);
	}

	.emoji-grid::-webkit-scrollbar-thumb {
		background: var(--color-primary);
		border-radius: 4px;
	}

	.emoji-grid::-webkit-scrollbar-thumb:hover {
		background: var(--color-primary-hover);
	}
</style>
