<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { emojis } from '$lib/emoji-store';
	import type { Emoji } from '$lib/socket';
	import { _ } from '$lib/i18n';
	import {
		ESSENTIAL_EMOJI_GROUPS,
		filterEmojiLibrary,
		getBuiltInStickerGroups,
		getCommunityGroups,
		getEssentialEmojiCount,
		type EmojiLibraryCollection,
		type EmojiLibraryGroupOption
	} from '$lib/emoji-library';
	import GifPicker from './emoji/GifPicker.svelte';
	import EmojiGrid from './emoji/EmojiGrid.svelte';

	const dispatch = createEventDispatcher<{
		select: { emoji: Emoji };
		gif: string;
		close: void;
	}>();

	const PREFS_KEY = 'wabi.emojiPicker.preferences.v2';
	const MAX_RECENT = 30;

	interface PickerPreferences {
		recentIds: string[];
		favoriteIds: string[];
		emojiCollection?: EmojiLibraryCollection;
		stickerCollection?: EmojiLibraryCollection;
	}

	interface CollectionOption {
		id: EmojiLibraryCollection;
		label: string;
		count?: number;
		tone?: 'primary' | 'quiet';
	}

	let pickerMode: 'emoji' | 'sticker' | 'gif' = 'emoji';
	let emojiCollection: EmojiLibraryCollection = 'essentials';
	let stickerCollection: EmojiLibraryCollection = 'built-in';
	let selectedGroup = 'all';
	let searchQuery = '';
	let recentIds: string[] = [];
	let favoriteIds: string[] = [];
	let gifPickerRef: GifPicker;
	let emojiGridRef: EmojiGrid;

	$: emojiCatalog = $emojis.filter((emoji) => (emoji.type || 'emoji') === 'emoji');
	$: stickerCatalog = $emojis.filter((emoji) => (emoji.type || 'emoji') === 'sticker');
	$: customEmojiCount = emojiCatalog.filter((emoji) => emoji.isCustom || emoji.source === 'custom').length;
	$: customStickerCount = stickerCatalog.filter((emoji) => emoji.isCustom || emoji.source === 'custom').length;
	$: essentialCount = getEssentialEmojiCount(emojiCatalog);
	$: builtInStickerCount = stickerCatalog.filter((emoji) => !emoji.isCustom && emoji.source !== 'custom').length;
	$: activeCollection = pickerMode === 'sticker' ? stickerCollection : emojiCollection;
	$: activeMode = pickerMode === 'sticker' ? 'sticker' : 'emoji';
	$: communityGroups = getCommunityGroups($emojis, activeMode);
	$: builtInStickerGroups = getBuiltInStickerGroups(stickerCatalog);
	$: groupOptions = resolveGroupOptions();
	$: if (selectedGroup !== 'all' && !groupOptions.some((option) => option.id === selectedGroup)) selectedGroup = 'all';
	$: filteredEmojis = pickerMode === 'gif'
		? []
		: filterEmojiLibrary($emojis, {
			mode: activeMode,
			collection: activeCollection,
			query: searchQuery,
			recentIds,
			favoriteIds,
			group: selectedGroup === 'all' ? undefined : selectedGroup
		});
	$: collectionOptions = resolveCollectionOptions();
	$: resultLabel = resolveResultLabel();
	$: emptyCopy = resolveEmptyCopy();

	onMount(() => {
		try {
			const raw = localStorage.getItem(PREFS_KEY);
			if (!raw) return;
			const parsed = JSON.parse(raw) as Partial<PickerPreferences>;
			if (Array.isArray(parsed.recentIds)) recentIds = parsed.recentIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_RECENT);
			if (Array.isArray(parsed.favoriteIds)) favoriteIds = parsed.favoriteIds.filter((id): id is string => typeof id === 'string');
			if (parsed.emojiCollection && ['essentials', 'recent', 'favorites', 'community', 'library'].includes(parsed.emojiCollection)) {
				emojiCollection = parsed.emojiCollection;
			}
			if (parsed.stickerCollection && ['built-in', 'recent', 'favorites', 'community', 'all'].includes(parsed.stickerCollection)) {
				stickerCollection = parsed.stickerCollection;
			}
		} catch (error) {
			console.warn('[emoji-picker] Failed to restore local picker preferences:', error);
		}
	});

	function savePreferences(): void {
		if (typeof localStorage === 'undefined') return;
		const value: PickerPreferences = { recentIds, favoriteIds, emojiCollection, stickerCollection };
		try {
			localStorage.setItem(PREFS_KEY, JSON.stringify(value));
		} catch (error) {
			console.warn('[emoji-picker] Failed to save local picker preferences:', error);
		}
	}

	function resolveCollectionOptions(): CollectionOption[] {
		if (pickerMode === 'sticker') {
			return [
				{ id: 'built-in', label: 'Starter pack', count: builtInStickerCount, tone: 'primary' },
				{ id: 'recent', label: 'Recent', count: recentIds.filter((id) => stickerCatalog.some((emoji) => emoji.id === id)).length },
				{ id: 'favorites', label: 'Favorites', count: favoriteIds.filter((id) => stickerCatalog.some((emoji) => emoji.id === id)).length },
				{ id: 'community', label: 'Community', count: customStickerCount },
				{ id: 'all', label: 'All stickers', count: stickerCatalog.length, tone: 'quiet' }
			];
		}
		return [
			{ id: 'essentials', label: 'Essentials', count: essentialCount, tone: 'primary' },
			{ id: 'recent', label: 'Recent', count: recentIds.filter((id) => emojiCatalog.some((emoji) => emoji.id === id)).length },
			{ id: 'favorites', label: 'Favorites', count: favoriteIds.filter((id) => emojiCatalog.some((emoji) => emoji.id === id)).length },
			{ id: 'community', label: 'Community', count: customEmojiCount },
			{ id: 'library', label: 'Full library', count: emojiCatalog.filter((emoji) => !emoji.isCustom && emoji.source !== 'custom').length, tone: 'quiet' }
		];
	}

	function resolveGroupOptions(): EmojiLibraryGroupOption[] {
		if (searchQuery.trim()) return [];
		if (pickerMode === 'emoji' && activeCollection === 'essentials') {
			return ESSENTIAL_EMOJI_GROUPS.map(({ id, label }) => ({ id, label }));
		}
		if (pickerMode === 'sticker' && activeCollection === 'built-in') return builtInStickerGroups;
		if (activeCollection === 'community') return communityGroups;
		return [];
	}

	function setMode(mode: 'emoji' | 'sticker' | 'gif') {
		pickerMode = mode;
		searchQuery = '';
		selectedGroup = 'all';
		emojiGridRef?.resetPagination();
		if (mode === 'gif') gifPickerRef?.loadInitial();
	}

	function setCollection(collection: EmojiLibraryCollection) {
		if (pickerMode === 'sticker') stickerCollection = collection;
		else emojiCollection = collection;
		searchQuery = '';
		selectedGroup = 'all';
		emojiGridRef?.resetPagination();
		savePreferences();
	}

	function setGroup(group: string) {
		selectedGroup = group;
		emojiGridRef?.resetPagination();
	}

	function clearSearch() {
		searchQuery = '';
		emojiGridRef?.resetPagination();
	}

	function handleSelect(emoji: Emoji) {
		recentIds = [emoji.id, ...recentIds.filter((id) => id !== emoji.id)].slice(0, MAX_RECENT);
		savePreferences();
		dispatch('select', { emoji });
	}

	function toggleFavorite(emoji: Emoji) {
		favoriteIds = favoriteIds.includes(emoji.id)
			? favoriteIds.filter((id) => id !== emoji.id)
			: [emoji.id, ...favoriteIds];
		savePreferences();
	}

	function resolveResultLabel(): string {
		if (searchQuery.trim()) return `${filteredEmojis.length.toLocaleString()} search ${filteredEmojis.length === 1 ? 'result' : 'results'} across all ${activeMode === 'sticker' ? 'stickers' : 'emoji'}`;
		if (activeCollection === 'essentials') return `${filteredEmojis.length} everyday reactions — the full catalog stays out of your way`;
		if (activeCollection === 'library') return `${filteredEmojis.length.toLocaleString()} bundled emoji — search is the fastest way to reach the obscure stuff`;
		if (activeCollection === 'built-in') return `${filteredEmojis.length} built-in stickers organized as a starter reaction pack`;
		if (activeCollection === 'community') return `${filteredEmojis.length} from this community${selectedGroup !== 'all' ? ` · ${selectedGroup}` : ''}`;
		if (activeCollection === 'recent') return 'Stored only on this device';
		if (activeCollection === 'favorites') return 'Your pinned reactions · stored only on this device';
		return `${filteredEmojis.length} stickers available`;
	}

	function resolveEmptyCopy(): { title: string; hint: string } {
		if (searchQuery.trim()) {
			return { title: 'Nothing matched that search', hint: 'Try a feeling, object, shortcode, artist, or a simpler word.' };
		}
		if (activeCollection === 'recent') return { title: 'No recent reactions yet', hint: 'Things you use will appear here automatically.' };
		if (activeCollection === 'favorites') return { title: 'No favorites yet', hint: 'Use the star on any emoji or sticker to pin it here.' };
		if (activeCollection === 'community') return { title: `No community ${activeMode === 'sticker' ? 'stickers' : 'emoji'} here yet`, hint: 'Admins can upload packs and organize them into folders from Emoji & Sticker settings.' };
		return { title: `No ${activeMode === 'sticker' ? 'stickers' : 'emoji'} found`, hint: 'Try another section or search the full library.' };
	}

	function formatGroupLabel(group: EmojiLibraryGroupOption): string {
		return group.label;
	}
</script>

<div class="emoji-picker" role="dialog" aria-label="Emoji, sticker and GIF picker">
	<div class="picker-titlebar">
		<div class="picker-title">
			<strong>Reactions</strong>
			<span>Fast first, huge library when you need it.</span>
		</div>
		<button type="button" on:click={() => dispatch('close')} class="close-btn" aria-label={$_('common.close')} title={$_('common.close')}>×</button>
	</div>

	<div class="mode-tabs" role="tablist" aria-label="Reaction type">
		<button type="button" role="tab" aria-selected={pickerMode === 'emoji'} class="mode-tab" class:active={pickerMode === 'emoji'} on:click={() => setMode('emoji')}>{$_('emoji_picker.tabs.emojis')}</button>
		<button type="button" role="tab" aria-selected={pickerMode === 'sticker'} class="mode-tab" class:active={pickerMode === 'sticker'} on:click={() => setMode('sticker')}>{$_('emoji_picker.tabs.stickers')}</button>
		<button type="button" role="tab" aria-selected={pickerMode === 'gif'} class="mode-tab" class:active={pickerMode === 'gif'} on:click={() => setMode('gif')}>{$_('emoji_picker.tabs.gifs')}</button>
	</div>

	{#if pickerMode === 'gif'}
		<div class="gif-pane">
			<GifPicker bind:this={gifPickerRef} on:select={(e) => dispatch('gif', e.detail)} />
		</div>
	{:else}
		<div class="search-row">
			<div class="search-box">
				<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/></svg>
				<input
					type="search"
					placeholder={pickerMode === 'sticker' ? 'Search every sticker…' : 'Search every emoji…'}
					bind:value={searchQuery}
					on:input={() => emojiGridRef?.resetPagination()}
					aria-label={pickerMode === 'sticker' ? 'Search stickers' : 'Search emoji'}
				/>
				{#if searchQuery}
					<button type="button" class="clear-search" on:click={clearSearch} aria-label="Clear search">×</button>
				{/if}
			</div>
		</div>

		<div class="collection-tabs" aria-label="Emoji collections">
			{#each collectionOptions as option (option.id)}
				<button
					type="button"
					class="collection-tab"
					class:active={activeCollection === option.id && !searchQuery.trim()}
					class:primary={option.tone === 'primary'}
					class:quiet={option.tone === 'quiet'}
					on:click={() => setCollection(option.id)}
				>
					<span>{option.label}</span>
					{#if option.count !== undefined}<small>{option.count.toLocaleString()}</small>{/if}
				</button>
			{/each}
		</div>

		<div class="library-meta">
			<span>{resultLabel}</span>
			{#if searchQuery.trim()}<span class="search-scope">Global search</span>{/if}
		</div>

		{#if groupOptions.length > 0}
			<div class="group-tabs" aria-label="Folders and groups">
				<button type="button" class="group-tab" class:active={selectedGroup === 'all'} on:click={() => setGroup('all')}>All</button>
				{#each groupOptions as group (group.id)}
					<button type="button" class="group-tab" class:active={selectedGroup === group.id} on:click={() => setGroup(group.id)}>{formatGroupLabel(group)}</button>
				{/each}
			</div>
		{/if}

		<EmojiGrid
			bind:this={emojiGridRef}
			emojis={filteredEmojis}
			stickerMode={pickerMode === 'sticker'}
			{favoriteIds}
			emptyTitle={emptyCopy.title}
			emptyHint={emptyCopy.hint}
			on:select={(e) => handleSelect(e.detail.emoji)}
			on:favorite={(e) => toggleFavorite(e.detail.emoji)}
		/>
	{/if}
</div>

<style>
	.emoji-picker {
		position: absolute;
		bottom: 56px;
		right: 1rem;
		width: min(480px, calc(100vw - 2rem));
		height: 520px;
		max-height: min(72vh, 620px);
		background: var(--surface-modal);
		border: 1px solid var(--border-subtle);
		border-radius: 14px;
		display: flex;
		flex-direction: column;
		box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28), 0 4px 16px rgba(0, 0, 0, 0.18);
		z-index: 100;
		overflow: hidden;
		color: var(--text-primary);
	}

	.picker-titlebar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.72rem 0.78rem 0.52rem 0.9rem;
	}

	.picker-title {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.08rem;
	}

	.picker-title strong {
		font-size: 0.94rem;
		font-weight: 700;
		color: var(--text-heading);
	}

	.picker-title span {
		font-size: 0.7rem;
		color: var(--text-muted);
	}

	.close-btn,
	.clear-search {
		border: none;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.close-btn {
		width: 32px;
		height: 32px;
		padding: 0;
		border-radius: 8px;
		font-size: 1.25rem;
		line-height: 1;
	}

	.close-btn:hover,
	.close-btn:focus-visible,
	.clear-search:hover,
	.clear-search:focus-visible {
		background: var(--surface-raised);
		color: var(--text-heading);
		outline: none;
	}

	.mode-tabs {
		display: flex;
		gap: 0.25rem;
		padding: 0 0.75rem 0.55rem;
		border-bottom: 1px solid var(--border-subtle);
	}

	.mode-tab {
		min-height: 34px;
		padding: 0.35rem 0.8rem;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.8rem;
		font-weight: 650;
		cursor: pointer;
	}

	.mode-tab:hover {
		background: var(--surface-raised);
		color: var(--text-heading);
	}

	.mode-tab.active {
		background: color-mix(in srgb, var(--accent-primary-color) 13%, transparent);
		color: var(--accent-primary-color);
	}

	.search-row {
		padding: 0.62rem 0.72rem 0.45rem;
	}

	.search-box {
		display: flex;
		align-items: center;
		gap: 0.42rem;
		min-height: 38px;
		padding: 0 0.45rem 0 0.62rem;
		border: 1px solid var(--border-subtle);
		border-radius: 10px;
		background: var(--surface-base);
	}

	.search-box:focus-within {
		border-color: color-mix(in srgb, var(--accent-primary-color) 70%, var(--border-subtle));
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-primary-color) 16%, transparent);
	}

	.search-box svg {
		width: 16px;
		height: 16px;
		flex: none;
		color: var(--text-muted);
	}

	.search-box input {
		flex: 1;
		min-width: 0;
		min-height: 36px;
		padding: 0;
		border: none;
		outline: none;
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		font-size: 0.82rem;
	}

	.search-box input::placeholder {
		color: var(--text-muted);
	}

	.clear-search {
		width: 28px;
		height: 28px;
		padding: 0;
		border-radius: 7px;
		font-size: 1rem;
	}

	.collection-tabs,
	.group-tabs {
		display: flex;
		gap: 0.35rem;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: none;
	}

	.collection-tabs::-webkit-scrollbar,
	.group-tabs::-webkit-scrollbar {
		display: none;
	}

	.collection-tabs {
		padding: 0 0.72rem 0.5rem;
	}

	.collection-tab {
		flex: 0 0 auto;
		min-height: 32px;
		padding: 0.3rem 0.58rem;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: var(--surface-base);
		color: var(--text-secondary);
		font-size: 0.74rem;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
	}

	.collection-tab small {
		padding: 0.08rem 0.28rem;
		border-radius: 999px;
		background: var(--surface-raised);
		color: var(--text-muted);
		font-size: 0.62rem;
		font-variant-numeric: tabular-nums;
	}

	.collection-tab:hover {
		border-color: var(--border-strong);
		color: var(--text-heading);
	}

	.collection-tab.active {
		border-color: color-mix(in srgb, var(--accent-primary-color) 52%, var(--border-subtle));
		background: color-mix(in srgb, var(--accent-primary-color) 11%, var(--surface-base));
		color: var(--accent-primary-color);
	}

	.collection-tab.quiet:not(.active) {
		border-style: dashed;
	}

	.library-meta {
		min-height: 28px;
		padding: 0.35rem 0.78rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		border-top: 1px solid var(--border-subtle);
		border-bottom: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--surface-raised) 58%, transparent);
		color: var(--text-muted);
		font-size: 0.67rem;
	}

	.search-scope {
		flex: none;
		padding: 0.12rem 0.35rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent-primary-color) 12%, transparent);
		color: var(--accent-primary-color);
		font-weight: 650;
	}

	.group-tabs {
		padding: 0.48rem 0.72rem 0.1rem;
	}

	.group-tab {
		flex: 0 0 auto;
		min-height: 29px;
		padding: 0.28rem 0.58rem;
		border: none;
		border-radius: 7px;
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
		white-space: nowrap;
	}

	.group-tab:hover {
		background: var(--surface-raised);
		color: var(--text-heading);
	}

	.group-tab.active {
		background: var(--surface-raised);
		color: var(--text-heading);
		box-shadow: inset 0 0 0 1px var(--border-subtle);
	}

	.gif-pane {
		flex: 1;
		min-height: 0;
		display: flex;
	}

	:global(.reaction-picker-anchor) .emoji-picker {
		width: min(440px, calc(100vw - 24px));
		height: min(500px, calc(100vh - 88px));
		max-height: calc(100vh - 88px);
	}

	@media (max-width: 640px) {
		.emoji-picker {
			position: fixed;
			bottom: 56px;
			left: 0.5rem;
			right: 0.5rem;
			width: auto;
			height: min(62vh, 520px);
			max-height: none;
			border-radius: 14px;
		}

		.picker-titlebar {
			padding-top: 0.62rem;
		}

		.picker-title span {
			display: none;
		}

		.close-btn,
		.mode-tab,
		.collection-tab,
		.group-tab {
			min-height: 40px;
		}

		.search-box {
			min-height: 44px;
		}

		.search-box input {
			min-height: 42px;
			font-size: 16px;
		}

		.library-meta {
			font-size: 0.64rem;
		}
	}

	@media (max-width: 400px) {
		.emoji-picker {
			left: 0.25rem;
			right: 0.25rem;
			height: min(60vh, 500px);
		}

		.collection-tabs,
		.group-tabs,
		.search-row,
		.mode-tabs {
			padding-left: 0.5rem;
			padding-right: 0.5rem;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.mode-tab,
		.collection-tab,
		.group-tab {
			transition: none;
		}
	}
</style>
