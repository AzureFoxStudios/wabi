<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { emojis } from '$lib/emoji-store';
	import type { Emoji } from '$lib/socket';
	import { _ } from '$lib/i18n';
	import GifPicker from './emoji/GifPicker.svelte';
	import EmojiGrid from './emoji/EmojiGrid.svelte';

	const dispatch = createEventDispatcher<{
		select: { emoji: Emoji };
		gif: string;
		close: void;
	}>();

	let pickerMode: 'emoji' | 'sticker' | 'gif' = 'emoji';
	let selectedSource: 'all' | 'default' | 'openmoji' | 'custom' = 'all';
	let selectedCategory = 'all';
	let searchQuery = '';

	$: modeEmojis = $emojis.filter(e => (e.type || 'emoji') === pickerMode);

	function getEmojiSource(emoji: Emoji): 'default' | 'openmoji' | 'custom' {
		if (emoji.source) return emoji.source;
		if (emoji.isCustom) return 'custom';
		return 'default';
	}

	$: sourceEmojis = modeEmojis.filter(emoji => {
		return selectedSource === 'all' || getEmojiSource(emoji) === selectedSource;
	});

	$: categories = ['all', ...new Set(sourceEmojis.map(e => e.category))];

	$: filteredEmojis = sourceEmojis.filter(emoji => {
		const matchesCategory = selectedCategory === 'all' || emoji.category === selectedCategory;
		const query = searchQuery.trim().toLowerCase();
		const matchesSearch = query === '' ||
			emoji.name.toLowerCase().includes(query) ||
			(emoji.displayName?.toLowerCase().includes(query) ?? false) ||
			(emoji.artist?.toLowerCase().includes(query) ?? false);
		return matchesCategory && matchesSearch;
	});

	function setMode(mode: 'emoji' | 'sticker' | 'gif') {
		pickerMode = mode;
		selectedSource = 'all';
		selectedCategory = 'all';
		emojiGridRef?.resetPagination();
		if (mode === 'gif') {
			gifPickerRef?.loadInitial();
		}
	}

	function setSource(source: 'all' | 'default' | 'openmoji' | 'custom') {
		selectedSource = source;
		selectedCategory = 'all';
		emojiGridRef?.resetPagination();
	}

	function formatLabel(value: string): string {
		if (value === 'all') return $_('emoji_picker.filters.all');
		return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');
	}

	let gifPickerRef: GifPicker;
	let emojiGridRef: EmojiGrid;
	let gifSearchQuery = '';
	function searchGifs() {}
	let emojiRenderLimit = 200;
	const EMOJI_PAGE_SIZE = 200;
</script>

<div class="emoji-picker">
	<div class="emoji-header">
		{#if pickerMode === 'gif'}
			<input
				type="text"
				placeholder={$_('emoji_picker.search_gifs_placeholder')}
				bind:value={gifSearchQuery}
				on:input={searchGifs}
			/>
		{:else}
			<input
				type="text"
				placeholder={pickerMode === 'sticker' ? $_('emoji_picker.search_stickers_placeholder') : $_('emoji_picker.search_emojis_placeholder')}
				bind:value={searchQuery}
				on:input={() => (emojiRenderLimit = EMOJI_PAGE_SIZE)}
			/>
		{/if}
		<button on:click={() => dispatch('close')} class="close-btn">{$_('common.close')}</button>
	</div>

	<!-- Mode toggle tabs -->
	<div class="mode-tabs">
		<button
			class="mode-tab"
			class:active={pickerMode === 'emoji'}
			on:click={() => setMode('emoji')}
		>{$_('emoji_picker.tabs.emojis')}</button>
		<button
			class="mode-tab"
			class:active={pickerMode === 'sticker'}
			on:click={() => setMode('sticker')}
		>{$_('emoji_picker.tabs.stickers')}</button>
		<button
			class="mode-tab"
			class:active={pickerMode === 'gif'}
			on:click={() => setMode('gif')}
		>{$_('emoji_picker.tabs.gifs')}</button>
	</div>

	{#if pickerMode === 'gif'}
		<GifPicker bind:this={gifPickerRef} on:select={(e) => dispatch('gif', e.detail)} />
	{:else}
		<div class="source-tabs">
			<button
				class="source-tab"
				class:active={selectedSource === 'all'}
				on:click={() => setSource('all')}
			>{$_('emoji_picker.filters.all')}</button>
			<button
				class="source-tab"
				class:active={selectedSource === 'default'}
				on:click={() => setSource('default')}
			>{$_('emoji_picker.filters.default')}</button>
			<button
				class="source-tab"
				class:active={selectedSource === 'openmoji'}
				on:click={() => setSource('openmoji')}
			>{$_('emoji_picker.filters.openmoji')}</button>
			<button
				class="source-tab"
				class:active={selectedSource === 'custom'}
				on:click={() => setSource('custom')}
			>{$_('emoji_picker.filters.custom')}</button>
		</div>

		<!-- Emoji/Sticker grid -->
		<EmojiGrid
			bind:this={emojiGridRef}
			emojis={filteredEmojis}
			stickerMode={pickerMode === 'sticker'}
			{categories}
			bind:searchQuery
			on:select={(e) => dispatch('select', e.detail)}
		/>
	{/if}
</div>

<style>
	.emoji-picker {
		position: absolute;
		bottom: 56px;
		right: 1rem;
		width: 400px;
		height: 400px;
		background: var(--surface-modal);
		border: none;
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		box-shadow: none;
		z-index: 100;
		overflow: hidden;
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
		width: auto;
	}

	.close-btn:hover {
		color: var(--text-heading);
		background: var(--surface-raised);
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
		color: var(--text-heading);
	}

	.mode-tab.active {
		color: var(--accent-primary-color);
		border-bottom-color: var(--accent-primary-color);
	}

	.source-tabs {
		display: flex;
		gap: 0.375rem;
		padding: 0.5rem;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--surface-raised);
	}

	.source-tab {
		flex: 1;
		padding: 0.375rem 0.5rem;
		border: 1px solid var(--border-subtle);
		background: var(--surface-base);
		color: var(--text-secondary);
		border-radius: 6px;
		font-size: 0.75rem;
		font-weight: 600;
		cursor: pointer;
	}

	.source-tab:hover {
		color: var(--text-heading);
	}

	.source-tab.active {
		border-color: var(--accent-primary-color);
		color: var(--accent-primary-color);
	}

	.category-tabs {
		display: flex;
		gap: 0.25rem;
		padding: 0.5rem;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--surface-raised);
		overflow-x: auto;
	}

	.category-tab {
		min-width: 56px;
		height: 40px;
		background: transparent;
		border: none;
		border-radius: 4px;
		font-size: 0.75rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0 0.5rem;
		white-space: nowrap;
	}

	.category-tab:hover {
		background: var(--surface-base);
	}

	.category-tab.active {
		background: var(--accent-primary-color);
	}

	@media (max-width: 640px) {
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

		.source-tabs {
			padding: 0.5rem;
			gap: 0.25rem;
		}

		.source-tab {
			min-height: 40px;
			font-size: 0.6875rem;
			padding: 0.25rem;
		}

		.category-tabs {
			padding: 0.375rem;
			gap: 0.125rem;
		}

		.category-tab {
			min-width: 56px;
			height: 44px;
			font-size: 0.6875rem;
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
	}
</style>