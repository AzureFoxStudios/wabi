<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	const dispatch = createEventDispatcher<{
		select: string;
	}>();

	let gifs: any[] = [];
	let gifLoading = false;
	let gf: { trending: (args: { limit: number }) => Promise<{ data: any[] }>; search: (query: string, args: { limit: number }) => Promise<{ data: any[] }> } | null = null;
	let giphyInitPromise: Promise<void> | null = null;
	let gifSearchQuery = '';
	let giphyStatus: 'unknown' | 'ready' | 'missing' | 'error' = 'unknown';
	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	const GIF_PAGE_SIZE = 12;

	async function ensureGiphyClient(): Promise<void> {
		if (gf || giphyInitPromise) return;
		if (!import.meta.env.VITE_GIPHY_API_KEY) {
			giphyStatus = 'missing';
			return;
		}
		giphyInitPromise = import('@giphy/js-fetch-api')
			.then((mod) => {
				gf = new mod.GiphyFetch(import.meta.env.VITE_GIPHY_API_KEY);
				giphyStatus = 'ready';
			})
			.catch((error) => {
				giphyStatus = 'error';
			console.error('Failed to load GIPHY SDK:', error);
			})
			.finally(() => {
				giphyInitPromise = null;
			});
		await giphyInitPromise;
	}

	async function loadTrendingGifs() {
		await ensureGiphyClient();
		if (!gf) return;
		gifLoading = true;
		try {
			const { data } = await gf.trending({ limit: GIF_PAGE_SIZE });
			gifs = data;
		} catch (error) {
			giphyStatus = 'error';
			console.error('Error fetching trending GIFs:', error);
			gifs = [];
		}
		gifLoading = false;
	}

	async function searchGifs() {
		if (searchTimer) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => void searchGifsNow(), 250);
	}

	async function searchGifsNow() {
		await ensureGiphyClient();
		if (!gf) return;
		if (!gifSearchQuery.trim()) {
			loadTrendingGifs();
			return;
		}
		gifLoading = true;
		try {
			const { data } = await gf.search(gifSearchQuery, { limit: GIF_PAGE_SIZE });
			gifs = data;
		} catch (error) {
			giphyStatus = 'error';
			console.error('Error fetching GIFs:', error);
		}
		gifLoading = false;
	}

	function selectGif(gif: any) {
		dispatch('select', gif.images.fixed_height.url);
	}

	export function loadInitial() {
		if (gifs.length === 0) loadTrendingGifs();
	}
</script>

<div class="gif-picker">
	<div class="gif-search-label"><strong>GIF search</strong><span>Search GIPHY, then scroll the results below.</span></div>
	<input
		type="text"
		placeholder="Search GIFs..."
		bind:value={gifSearchQuery}
		on:input={searchGifs}
	/>
	<div class="gif-grid">
		{#if giphyStatus === 'missing'}
			<div class="no-gifs">GIF search is not configured on this server.</div>
		{:else if giphyStatus === 'error'}
			<div class="no-gifs">GIF search is temporarily unavailable.</div>
		{:else if gifLoading}
			<div class="no-gifs">Loading...</div>
		{:else if gifs.length === 0}
			<div class="no-gifs">No GIFs found</div>
		{:else}
			{#each gifs as gif (gif.id)}
				<button class="gif-item" on:click={() => selectGif(gif)}>
					<img src={gif.images.fixed_height_small.url} alt={gif.title} loading="lazy" decoding="async" />
				</button>
			{/each}
		{/if}
	</div>
</div>

<style>
	.gif-picker {
		display: flex;
		flex-direction: column;
		flex: 1;
	}

	.gif-picker input {
		margin: 0.5rem;
	}

	.gif-search-label {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.55rem 0.65rem 0.1rem;
		color: var(--text-secondary);
		font-size: 0.72rem;
	}
	.gif-search-label strong { color: var(--text-heading); font-size: 0.82rem; }

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
		background: var(--surface-raised);
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
		background: var(--surface-hover);
		transform: scale(1.02);
	}

	.gif-item img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.no-gifs {
		grid-column: 1 / -1;
		text-align: center;
		padding: 2rem;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}
</style>
