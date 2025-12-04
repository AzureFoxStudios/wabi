<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { emojis, type Emoji } from '$lib/socket';

	export let isOpen = false;
	export let x = 0;
	export let y = 0;

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
		dispatch('close');
	}

	function handleClickOutside(event: MouseEvent) {
		const target = event.target as HTMLElement;
		const picker = document.querySelector('.emoji-picker');
		if (picker && !picker.contains(target)) {
			dispatch('close');
		}
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

<svelte:window on:click={isOpen ? handleClickOutside : undefined} />

{#if isOpen}
	<div class="emoji-picker" style="left: {x}px; top: {y}px;" on:click|stopPropagation>
		<!-- Search bar -->
		<div class="search-bar">
			<input
				type="text"
				placeholder="Search emojis..."
				bind:value={searchQuery}
				class="search-input"
			/>
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
{/if}

<style>
	.emoji-picker {
		position: fixed;
		width: 320px;
		max-height: 400px;
		background: var(--bg-secondary);
		border: 2px solid var(--color-primary);
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
		z-index: 1000;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.search-bar {
		padding: 0.75rem;
		border-bottom: 1px solid var(--border);
	}

	.search-input {
		width: 100%;
		padding: 0.5rem;
		background: var(--bg-tertiary);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.search-input:focus {
		outline: none;
		border-color: var(--color-primary);
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
