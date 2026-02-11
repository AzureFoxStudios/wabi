<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { emojis, type Emoji } from '$lib/socket';
	import { GiphyFetch } from '@giphy/js-fetch-api';

	const dispatch = createEventDispatcher<{
		select: { emoji: Emoji };
		gif: string;
		close: void;
	}>();

	let pickerMode: 'emoji' | 'sticker' | 'gif' = 'emoji';
	let selectedCategory = 'all';
	let searchQuery = '';

	// GIF state
	let gifs: any[] = [];
	let gifLoading = false;
	let gf: GiphyFetch | null = null;
	let gifSearchQuery = '';

	if (import.meta.env.VITE_GIPHY_API_KEY) {
		gf = new GiphyFetch(import.meta.env.VITE_GIPHY_API_KEY);
	}

	// Filter emojis by current mode first
	$: modeEmojis = $emojis.filter(e => (e.type || 'emoji') === pickerMode);

	// Group emojis by category
	$: categories = ['all', ...new Set(modeEmojis.map(e => e.category))];

	$: filteredEmojis = modeEmojis.filter(emoji => {
		const matchesCategory = selectedCategory === 'all' || emoji.category === selectedCategory;
		const matchesSearch = searchQuery === '' ||
			emoji.name.toLowerCase().includes(searchQuery.toLowerCase());
		return matchesCategory && matchesSearch;
	});

	// Reset category when switching modes
	function setMode(mode: 'emoji' | 'sticker' | 'gif') {
		pickerMode = mode;
		selectedCategory = 'all';
		if (mode === 'gif' && gifs.length === 0) {
			loadTrendingGifs();
		}
	}

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

	// GIF functions
	async function loadTrendingGifs() {
		if (!gf) return;
		gifLoading = true;
		try {
			const { data } = await gf.trending({ limit: 20 });
			gifs = data;
		} catch (error) {
			console.error('Error fetching trending GIFs:', error);
			gifs = [];
		}
		gifLoading = false;
	}

	async function searchGifs() {
		if (!gf) return;
		if (!gifSearchQuery.trim()) {
			loadTrendingGifs();
			return;
		}
		gifLoading = true;
		try {
			const { data } = await gf.search(gifSearchQuery, { limit: 20 });
			gifs = data;
		} catch (error) {
			console.error('Error fetching GIFs:', error);
		}
		gifLoading = false;
	}

	function selectGif(gif: any) {
		dispatch('gif', gif.images.fixed_height.url);
	}
</script>

<div class="emoji-picker">
		<div class="emoji-header">
			{#if pickerMode === 'gif'}
				<input
					type="text"
					placeholder="Search GIFs..."
					bind:value={gifSearchQuery}
					on:input={searchGifs}
				/>
			{:else}
				<input
					type="text"
					placeholder="Search {pickerMode === 'sticker' ? 'stickers' : 'emojis'}..."
					bind:value={searchQuery}
				/>
			{/if}
			<button on:click={() => dispatch('close')} class="close-btn">✕</button>
		</div>

		<!-- Mode toggle tabs -->
		<div class="mode-tabs">
			<button
				class="mode-tab"
				class:active={pickerMode === 'emoji'}
				on:click={() => setMode('emoji')}
			>Emojis</button>
			<button
				class="mode-tab"
				class:active={pickerMode === 'sticker'}
				on:click={() => setMode('sticker')}
			>Stickers</button>
			<button
				class="mode-tab"
				class:active={pickerMode === 'gif'}
				on:click={() => setMode('gif')}
			>GIFs</button>
		</div>

		{#if pickerMode === 'gif'}
			<!-- GIF grid -->
			<div class="gif-grid">
				{#if gifLoading}
					<div class="no-emojis">Loading...</div>
				{:else if gifs.length === 0}
					<div class="no-emojis">No GIFs found</div>
				{:else}
					{#each gifs as gif (gif.id)}
						<button class="gif-item" on:click={() => selectGif(gif)}>
							<img src={gif.images.fixed_height_small.url} alt={gif.title} />
						</button>
					{/each}
				{/if}
			</div>
		{:else}
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

			<!-- Emoji/Sticker grid -->
			<div class="emoji-grid" class:sticker-grid={pickerMode === 'sticker'}>
				{#if filteredEmojis.length === 0}
					<div class="no-emojis">No {pickerMode === 'sticker' ? 'stickers' : 'emojis'} found</div>
				{:else}
					{#each filteredEmojis as emoji (emoji.id)}
						<button
							class="emoji-btn"
							class:sticker-btn={pickerMode === 'sticker'}
							on:click={() => handleEmojiClick(emoji)}
							title=":{emoji.name}:"
						>
							<img src={emoji.url} alt={emoji.name} class="emoji-img" class:sticker-img={pickerMode === 'sticker'} />
						</button>
					{/each}
				{/if}
			</div>
		{/if}
	</div>

<style>
	.emoji-picker {
		position: absolute;
		bottom: 56px;
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

	/* Mode toggle (Emojis / Stickers) */
	.mode-tabs {
		display: flex;
		padding: 0 0.5rem;
		gap: 0.25rem;
	}

	.mode-tab {
		flex: 1;
		padding: 0.375rem 0;
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	.mode-tab:hover {
		color: var(--text-primary);
	}

	.mode-tab.active {
		color: var(--color-primary);
		border-bottom-color: var(--color-primary);
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
		background: var(--bg-tertiary);
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

	/* GIF grid */
	.gif-grid {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 0.5rem;
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.5rem;
		align-content: start;
	}

	.gif-item {
		background: var(--bg-tertiary);
		padding: 0;
		border: none;
		border-radius: 6px;
		overflow: hidden;
		cursor: pointer;
		width: 100%;
		height: 120px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
	}

	.gif-item:hover {
		background: var(--bg-hover);
		transform: scale(1.02);
	}

	.gif-item img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
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

	/* ========== MOBILE STYLES ========== */
	@media (max-width: 768px) {
		.emoji-picker {
			position: fixed;
			bottom: 56px;
			left: 0.5rem;
			right: 0.5rem;
			width: auto;
			height: 50vh;
			max-height: 350px;
			border-radius: 12px;
		}

		.emoji-header {
			padding: 0.75rem;
		}

		.emoji-header input {
			font-size: 16px; /* Prevents iOS zoom */
			min-height: 44px;
		}

		.close-btn {
			min-width: 44px;
			min-height: 44px;
		}

		.mode-tabs {
			padding: 0 0.75rem;
		}

		.mode-tab {
			padding: 0.5rem 0;
			font-size: 0.875rem;
			min-height: 44px;
		}

		.category-tabs {
			padding: 0.375rem;
			gap: 0.125rem;
		}

		.category-tab {
			min-width: 44px;
			height: 44px;
			font-size: 1.25rem;
		}

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

	/* Extra small screens */
	@media (max-width: 400px) {
		.emoji-picker {
			bottom: 56px;
			left: 0.25rem;
			right: 0.25rem;
			height: 45vh;
		}

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
