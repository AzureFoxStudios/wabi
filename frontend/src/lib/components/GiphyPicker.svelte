<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { GiphyFetch } from '@giphy/js-fetch-api';

	const dispatch = createEventDispatcher<{
		select: string;
		close: void;
	}>();

	let searchQuery = '';
	let gifs: any[] = [];
	let loading = false;

	// Use a public API key for demo purposes
	// In production, use environment variable
	const gf = new GiphyFetch(import.meta.env.VITE_GIPHY_API_KEY || 'sXpGFDGZs0Dv1mmNFvYaGUvYwKX0PWIh');

	async function searchGifs() {
		if (!searchQuery.trim()) {
			loadTrending();
			return;
		}

		loading = true;
		try {
			const { data } = await gf.search(searchQuery, { limit: 20 });
			gifs = data;
		} catch (error) {
			console.error('Error fetching GIFs:', error);
		}
		loading = false;
	}

	async function loadTrending() {
		loading = true;
		try {
			const { data } = await gf.trending({ limit: 20 });
			gifs = data;
			console.log('Loaded GIFs:', gifs.length, gifs);
		} catch (error) {
			console.error('Error fetching trending GIFs:', error);
			gifs = [];
		}
		loading = false;
	}

	function selectGif(gif: any) {
		dispatch('select', gif.images.fixed_height.url);
	}

	onMount(() => {
		loadTrending();
	});
</script>

<div class="giphy-picker">
	<div class="giphy-header">
		<input
			type="text"
			bind:value={searchQuery}
			on:input={searchGifs}
			placeholder="Search GIFs..."
		/>
		<button on:click={() => dispatch('close')} class="close-btn">✕</button>
	</div>

	<div class="gif-grid">
		{#if loading}
			<div class="loading">Loading...</div>
		{:else if gifs.length === 0}
			<div class="no-results">No GIFs found</div>
		{:else}
			{#each gifs as gif (gif.id)}
				<button class="gif-item" on:click={() => selectGif(gif)}>
					<img src={gif.images.fixed_height_small.url} alt={gif.title} />
				</button>
			{/each}
		{/if}
	</div>
</div>

<style>
	.giphy-picker {
		position: absolute;
		bottom: 70px;
		right: 1rem;
		width: 500px;
		height: 400px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 12px;
		display: flex;
		flex-direction: column;
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
		z-index: 100;
		overflow: hidden;
	}

	.giphy-header {
		padding: 0.75rem;
		border-bottom: 1px solid var(--border);
		display: flex;
		gap: 0.5rem;
		flex-shrink: 0;
		background: var(--bg-secondary);
	}

	.giphy-header input {
		flex: 1;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-tertiary);
		color: var(--text-primary);
		font-size: 0.9rem;
		transition: all 0.2s;
	}

	.giphy-header input:focus {
		outline: none;
		border-color: var(--accent);
		background: var(--bg-primary);
	}

	.giphy-header input::placeholder {
		color: var(--text-secondary);
	}

	.close-btn {
		background: transparent;
		color: var(--text-secondary);
		border: none;
		padding: 0.5rem;
		width: 40px;
		height: 40px;
		cursor: pointer;
		border-radius: 6px;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.2s;
		flex-shrink: 0;
	}

	.close-btn:hover {
		color: var(--text-primary);
		background: var(--bg-tertiary);
	}

	.gif-grid {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 1rem;
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.75rem;
		align-content: start;
	}

	.gif-item {
		background: var(--bg-tertiary);
		padding: 0;
		border: none;
		border-radius: 8px;
		overflow: hidden;
		cursor: pointer;
		width: 100%;
		height: 150px;
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
		transition: transform 0.2s;
	}

	.gif-item:hover img {
		transform: scale(1.05);
	}

	.loading,
	.no-results {
		grid-column: 1 / -1;
		text-align: center;
		padding: 2rem;
		color: var(--text-secondary);
	}

	/* ========== MOBILE STYLES ========== */
	@media (max-width: 768px) {
		.giphy-picker {
			position: fixed;
			bottom: 56px;
			left: 0.5rem;
			right: 0.5rem;
			width: auto;
			height: 50vh;
			max-height: 400px;
			border-radius: 12px;
		}

		.giphy-header {
			padding: 0.75rem;
		}

		.giphy-header input {
			font-size: 16px; /* Prevents iOS zoom */
			min-height: 44px;
		}

		.close-btn {
			min-width: 44px;
			min-height: 44px;
		}

		.gif-grid {
			padding: 0.75rem;
			gap: 0.75rem;
			grid-template-columns: repeat(2, 1fr);
		}

		.gif-item {
			border-radius: 8px;
			height: 120px;
		}

		.gif-item img {
			border-radius: 8px;
		}
	}

	/* Extra small screens */
	@media (max-width: 400px) {
		.giphy-picker {
			bottom: 56px;
			left: 0.25rem;
			right: 0.25rem;
			height: 45vh;
		}

		.gif-grid {
			grid-template-columns: 1fr;
			padding: 0.5rem;
			gap: 0.5rem;
		}

		.gif-item {
			height: 150px;
		}
	}
</style>
