<script lang="ts">
	import { _ } from '$lib/i18n';
	import { emojis } from '$lib/socket';
	import { brandName } from '$lib/branding';
	import type { Emoji } from '$lib/socket';
	import { displayEnhancementSettingsStore, setEmojiStatisticsEnabled, setSpotifyControlsEnabled } from '$lib/displayEnhancements';
	import { getReverseImageSearchProvider, setReverseImageSearchProvider, type ReverseImageSearchProvider } from '$lib/imageUtilities';
	import {
		gifCaptionerSettingsStore, setGifCaptionerCaptionStyle,
		setGifCaptionerDedicatedCaptionFieldEnabled, setGifCaptionerEnabled, type GifCaptionStylePreset
	} from '$lib/gifCaptionerSettings';
	import { setZipPreviewEnabled, setZipPreviewInlinePreviewEnabled, zipPreviewSettingsStore } from '$lib/zip/zipPreviewSettings';
	import {
		MAX_CUSTOM_QUICK_REACTION_EMOJIS, addQuickReactionCustomEmojiId,
		clearQuickReactionCustomEmojiIds, quickReactionSettingsStore,
		removeQuickReactionCustomEmojiId, setQuickReactionsEnabled
	} from '$lib/quickReactions';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import ReactionEmojiSelect from '../../emoji/ReactionEmojiSelect.svelte';
	import { confirmAction } from '$lib/confirm';
	import AddonRow from './AddonRow.svelte';
	import Switch from '../../ui/Switch.svelte';
	import Select from '../../ui/Select.svelte';

	export let localAddonControlMatches: (controlId: string) => boolean;

	const SECTION = ADDON_SECTION_LABELS.media;
	const GIF_CAPTIONER_MAX_CAPTION_LENGTH = 280;

	let reverseImageSearchProvider: ReverseImageSearchProvider = 'google_lens';
	let emojiStatisticsEnabled = true;
	let emojiStatsCategories: Array<{ category: string; count: number }> = [];
	let spotifyControlsEnabled = true;
	let gifCaptionerEnabled = true;
	let gifCaptionerDedicatedFieldEnabled = false;
	let gifCaptionerCaptionStyle: GifCaptionStylePreset = 'plain';
	let zipPreviewEnabled = true;
	let zipPreviewInlineEnabled = true;
	let quickReactionsEnabled = true;
	let quickReactionCustomEmojiIdDraft = '';
	let quickReactionSettingsStatus = '';
	let quickReactionCustomEmojiEntries: Emoji[] = [];

	$: emojiStatisticsEnabled = $displayEnhancementSettingsStore.emojiStatisticsEnabled;
	$: spotifyControlsEnabled = $displayEnhancementSettingsStore.spotifyControlsEnabled;
	$: gifCaptionerEnabled = $gifCaptionerSettingsStore.enabled;
	$: gifCaptionerDedicatedFieldEnabled = $gifCaptionerSettingsStore.dedicatedCaptionFieldEnabled;
	$: gifCaptionerCaptionStyle = $gifCaptionerSettingsStore.captionStyle;
	$: zipPreviewEnabled = $zipPreviewSettingsStore.enabled;
	$: zipPreviewInlineEnabled = $zipPreviewSettingsStore.inlinePreviewEnabled;
	$: quickReactionsEnabled = $quickReactionSettingsStore.enabled;
	$: quickReactionCustomEmojiEntries = $quickReactionSettingsStore.customEmojiIds
		.map((emojiId) => $emojis.find((emoji) => emoji.id === emojiId))
		.filter((emoji): emoji is Emoji => Boolean(emoji));
	$: emojiStatsCategories = (() => {
		const byCategory = new Map<string, number>();
		for (const emoji of $emojis) {
			const category = (emoji.category || 'uncategorized').trim().toLowerCase();
			byCategory.set(category, (byCategory.get(category) || 0) + 1);
		}
		return Array.from(byCategory.entries())
			.map(([category, count]) => ({ category, count }))
			.sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
			.slice(0, 8);
	})();

	function initReverseSearchProvider(): void {
		reverseImageSearchProvider = getReverseImageSearchProvider();
	}
	initReverseSearchProvider();

	function updateReverseSearchProvider(value: ReverseImageSearchProvider): void {
		reverseImageSearchProvider = value;
		setReverseImageSearchProvider(value);
	}

	function toggleEmojiStatisticsAddon(): void {
		setEmojiStatisticsEnabled(!emojiStatisticsEnabled);
	}

	function toggleSpotifyControlsAddon(): void {
		setSpotifyControlsEnabled(!spotifyControlsEnabled);
	}

	function toggleGifCaptionerAddon(): void {
		setGifCaptionerEnabled(!gifCaptionerEnabled);
	}

	function toggleGifCaptionerDedicatedField(): void {
		setGifCaptionerDedicatedCaptionFieldEnabled(!gifCaptionerDedicatedFieldEnabled);
	}

	function updateGifCaptionerStyle(style: string): void {
		if (style === 'plain' || style === 'accent' || style === 'card') {
			setGifCaptionerCaptionStyle(style);
		}
	}

	function toggleZipPreviewAddon(): void {
		setZipPreviewEnabled(!zipPreviewEnabled);
	}

	function toggleZipPreviewInlineAddon(): void {
		setZipPreviewInlinePreviewEnabled(!zipPreviewInlineEnabled);
	}

	function toggleMoreQuickReactsAddon(): void {
		setQuickReactionsEnabled(!quickReactionsEnabled);
		quickReactionSettingsStatus = '';
	}

	function addCustomQuickReactionEmoji(): void {
		const emojiId = quickReactionCustomEmojiIdDraft.trim();
		if (!emojiId) return;
		if (!$emojis.some((emoji) => emoji.id === emojiId)) {
			quickReactionSettingsStatus = $_('media_addon.no_longer_available');
			return;
		}
		const alreadyAdded = $quickReactionSettingsStore.customEmojiIds.includes(emojiId);
		const added = addQuickReactionCustomEmojiId(emojiId);
		if (added) {
			quickReactionSettingsStatus = $_('media_addon.added_reactions');
			quickReactionCustomEmojiIdDraft = '';
			return;
		}
		quickReactionSettingsStatus = alreadyAdded
			? $_('media_addon.already_reaction')
			: $_('media_addon.reactions_limit', { values: { max: MAX_CUSTOM_QUICK_REACTION_EMOJIS } });
	}

	function removeCustomQuickReactionEmoji(emojiId: string): void {
		removeQuickReactionCustomEmojiId(emojiId);
		quickReactionSettingsStatus = '';
	}

	async function clearCustomQuickReactionEmojis(): Promise<void> {
		if ($quickReactionSettingsStore.customEmojiIds.length === 0) return;
		const confirmed = await confirmAction({
			title: $_('media_addon.clear_title'),
			body: $_('media_addon.clear_body', { values: { brand: brandName } }),
			confirm: $_('media_addon.clear_confirm'),
			danger: true
		});
		if (!confirmed) return;
		clearQuickReactionCustomEmojiIds();
		quickReactionSettingsStatus = '';
	}
</script>

{#if localAddonControlMatches('image_utilities')}
	<AddonRow
		id="image_utilities"
		label={$_('messages.viewer.reverse_search')}
		description={$_('media_addon.reverse_desc')}
		enabled={true}
		locked={true}
		badge={SECTION}
	>
		{#snippet preferences()}
			<div class="addon-field">
				<span class="w-label">{$_('media_addon.reverse_provider')}</span>
				<Select ariaLabel="Reverse image search provider" options={[{ value: 'google_lens', label: 'Google Lens' }, { value: 'bing', label: 'Bing Visual Search' }, { value: 'tineye', label: 'TinEye' }, { value: 'yandex', label: 'Yandex Images' }]} value={reverseImageSearchProvider} onchange={(value) => updateReverseSearchProvider(value as ReverseImageSearchProvider)} />
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('emoji_statistics')}
	<AddonRow
		id="emoji_statistics"
		label={$_('media_addon.emoji_stats_label')}
		description={$_('media_addon.emoji_stats_desc')}
		enabled={emojiStatisticsEnabled}
		badge={SECTION}
		onToggle={toggleEmojiStatisticsAddon}
	>
		{#snippet preferences()}
			{#if emojiStatisticsEnabled}
				<div class="addon-note">
					{$_('media_addon.emoji_custom_summary', { values: { total: $emojis.length, custom: $emojis.filter((emoji) => emoji.isCustom).length } })}
					{$_('media_addon.emoji_builtin_summary', { values: { count: $emojis.filter((emoji) => !emoji.isCustom).length } })}
				</div>
				{#if emojiStatsCategories.length > 0}
					<div class="addon-note">
						{$_('media_addon.largest_categories')} {emojiStatsCategories.map((entry) => `${entry.category} (${entry.count})`).join(', ')}.
					</div>
				{:else}
					<div class="addon-note">{$_('media_addon.emoji_not_loaded')}</div>
				{/if}
			{/if}
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('spotify_controls')}
	<AddonRow
		id="spotify_controls"
		label={$_('media_addon.spotify_label')}
		description={$_('media_addon.spotify_desc')}
		enabled={spotifyControlsEnabled}
		badge={SECTION}
		onToggle={toggleSpotifyControlsAddon}
	/>
{/if}

{#if localAddonControlMatches('gif_captioner')}
	<AddonRow
		id="gif_captioner"
		label={$_('media_addon.gif_label')}
		description={$_('media_addon.gif_desc')}
		enabled={gifCaptionerEnabled}
		badge={SECTION}
		onToggle={toggleGifCaptionerAddon}
	>
		{#snippet preferences()}
<div class="addon-option">
				<span class="addon-option__label" id="addon-opt-gif-field">{$_('media_addon.gif_separate_field')}</span>
				<Switch labelledby="addon-opt-gif-field" checked={gifCaptionerDedicatedFieldEnabled} disabled={!gifCaptionerEnabled} onchange={toggleGifCaptionerDedicatedField} />
			</div>
			<div class="addon-field">
				<span class="w-label">{$_('media_addon.gif_style')}</span>
				<Select ariaLabel="Caption style" options={[{ value: 'plain', label: $_('media_addon.style_plain') }, { value: 'accent', label: $_('media_addon.style_accent') }, { value: 'card', label: $_('media_addon.style_card') }]} value={gifCaptionerCaptionStyle} onchange={(value) => updateGifCaptionerStyle(value)} disabled={!gifCaptionerEnabled} />
			</div>
			<div class="addon-note">
				{$_('media_addon.gif_max', { values: { max: GIF_CAPTIONER_MAX_CAPTION_LENGTH } })}
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('zip_preview')}
	<AddonRow
		id="zip_preview"
		label={$_('media_addon.zip_label')}
		description={$_('media_addon.zip_desc')}
		enabled={zipPreviewEnabled}
		badge={SECTION}
		onToggle={toggleZipPreviewAddon}
	>
		{#snippet preferences()}
<div class="addon-option">
				<span class="addon-option__label" id="addon-opt-zip-inline">{$_('media_addon.zip_inline')}</span>
				<Switch labelledby="addon-opt-zip-inline" checked={zipPreviewInlineEnabled} disabled={!zipPreviewEnabled} onchange={toggleZipPreviewInlineAddon} />
			</div>
			<div class="addon-note">{$_('media_addon.zip_remembers')}</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('more_quick_reacts')}
	<AddonRow
		id="more_quick_reacts"
		label={$_('media_addon.more_reacts_label')}
		description={$_('media_addon.more_reacts_desc')}
		enabled={quickReactionsEnabled}
		badge={SECTION}
		onToggle={toggleMoreQuickReactsAddon}
	>
		{#snippet preferences()}
			<div class="addon-note">
				{$_('media_addon.your_reactions', { values: { count: $quickReactionSettingsStore.customEmojiIds.length, max: MAX_CUSTOM_QUICK_REACTION_EMOJIS } })}
			</div>
			<div class="addon-actions">
				<div class="quick-reaction-picker-field">
					<ReactionEmojiSelect value={quickReactionCustomEmojiIdDraft} onchange={(id) => quickReactionCustomEmojiIdDraft = id} />
				</div>
				<button class="w-btn w-btn--sm" on:click={addCustomQuickReactionEmoji} disabled={!quickReactionCustomEmojiIdDraft.trim()}>
					{$_('chat.compose.add_emoji')}
				</button>
				<button class="w-btn w-btn--sm" on:click={clearCustomQuickReactionEmojis} disabled={$quickReactionSettingsStore.customEmojiIds.length === 0}>
					{$_('media_addon.clear_mine')}
				</button>
			</div>
			{#if quickReactionCustomEmojiEntries.length === 0}
				<div class="addon-note">{$_('media_addon.no_reactions', { values: { brand: brandName } })}</div>
			{:else}
				<div class="addon-list">
					{#each quickReactionCustomEmojiEntries as emoji (emoji.id)}
						<div class="addon-item addon-item--emoji">
							<img
								src={emoji.url}
								alt={emoji.displayName || emoji.name}
								class="addon-item__emoji"
								loading="lazy"
								decoding="async"
							/>
							<div class="addon-item__name">{emoji.displayName || emoji.name}</div>
							<button class="w-btn w-btn--sm w-btn--danger" on:click={() => removeCustomQuickReactionEmoji(emoji.id)}>
								{$_('profile_settings.remove')}
							</button>
						</div>
					{/each}
				</div>
			{/if}
			{#if quickReactionSettingsStatus}
				<div class="addon-note">{quickReactionSettingsStatus}</div>
			{/if}
		{/snippet}
	</AddonRow>
{/if}

<style>
	.quick-reaction-picker-field {
		flex: 1 1 240px;
		min-width: 0;
		max-width: 100%;
	}
</style>
