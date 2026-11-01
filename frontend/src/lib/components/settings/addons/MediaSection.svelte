<script lang="ts">
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
			quickReactionSettingsStatus = 'That emoji is no longer available.';
			return;
		}
		const alreadyAdded = $quickReactionSettingsStore.customEmojiIds.includes(emojiId);
		const added = addQuickReactionCustomEmojiId(emojiId);
		if (added) {
			quickReactionSettingsStatus = 'Added to your quick reactions.';
			quickReactionCustomEmojiIdDraft = '';
			return;
		}
		quickReactionSettingsStatus = alreadyAdded
			? 'That emoji is already one of your quick reactions.'
			: `You can choose up to ${MAX_CUSTOM_QUICK_REACTION_EMOJIS} quick reactions.`;
	}

	function removeCustomQuickReactionEmoji(emojiId: string): void {
		removeQuickReactionCustomEmojiId(emojiId);
		quickReactionSettingsStatus = '';
	}

	async function clearCustomQuickReactionEmojis(): Promise<void> {
		if ($quickReactionSettingsStore.customEmojiIds.length === 0) return;
		const confirmed = await confirmAction({
			title: 'Clear your quick reactions?',
			body: `${brandName} goes back to its suggested reactions.`,
			confirm: 'Clear reactions',
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
		label="Reverse image search"
		description="Find where an image came from, from the image viewer's menu."
		enabled={true}
		locked={true}
		badge={SECTION}
	>
		{#snippet preferences()}
			<div class="addon-field">
				<span class="w-label">Reverse image search provider</span>
				<Select ariaLabel="Reverse image search provider" options={[{ value: 'google_lens', label: 'Google Lens' }, { value: 'bing', label: 'Bing Visual Search' }, { value: 'tineye', label: 'TinEye' }, { value: 'yandex', label: 'Yandex Images' }]} value={reverseImageSearchProvider} onchange={(value) => updateReverseSearchProvider(value as ReverseImageSearchProvider)} />
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('emoji_statistics')}
	<AddonRow
		id="emoji_statistics"
		label="Emoji statistics"
		description="Shows how many custom emoji this server has, by category."
		enabled={emojiStatisticsEnabled}
		badge={SECTION}
		onToggle={toggleEmojiStatisticsAddon}
	>
		{#snippet preferences()}
			{#if emojiStatisticsEnabled}
				<div class="addon-note">
					{$emojis.length} emoji: {$emojis.filter((emoji) => emoji.isCustom).length} from this server,
					{$emojis.filter((emoji) => !emoji.isCustom).length} built in.
				</div>
				{#if emojiStatsCategories.length > 0}
					<div class="addon-note">
						Largest categories: {emojiStatsCategories.map((entry) => `${entry.category} (${entry.count})`).join(', ')}.
					</div>
				{:else}
					<div class="addon-note">The emoji list hasn't loaded yet.</div>
				{/if}
			{/if}
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('spotify_controls')}
	<AddonRow
		id="spotify_controls"
		label="Spotify controls"
		description="Spotify links in chat get small play controls."
		enabled={spotifyControlsEnabled}
		badge={SECTION}
		onToggle={toggleSpotifyControlsAddon}
	/>
{/if}

{#if localAddonControlMatches('gif_captioner')}
	<AddonRow
		id="gif_captioner"
		label="GIF captions"
		description="Add a caption to the GIFs you send."
		enabled={gifCaptionerEnabled}
		badge={SECTION}
		onToggle={toggleGifCaptionerAddon}
	>
		{#snippet preferences()}
<div class="addon-option">
				<span class="addon-option__label" id="addon-opt-gif-field">A separate caption field</span>
				<Switch labelledby="addon-opt-gif-field" checked={gifCaptionerDedicatedFieldEnabled} disabled={!gifCaptionerEnabled} onchange={toggleGifCaptionerDedicatedField} />
			</div>
			<div class="addon-field">
				<span class="w-label">Caption style</span>
				<Select ariaLabel="Caption style" options={[{ value: 'plain', label: 'Plain' }, { value: 'accent', label: 'Accent line' }, { value: 'card', label: 'Caption card' }]} value={gifCaptionerCaptionStyle} onchange={(value) => updateGifCaptionerStyle(value)} disabled={!gifCaptionerEnabled} />
			</div>
			<div class="addon-note">
				Captions can be up to {GIF_CAPTIONER_MAX_CAPTION_LENGTH} characters.
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('zip_preview')}
	<AddonRow
		id="zip_preview"
		label="ZIP previews"
		description="Look inside ZIP files in chat, with previews of text and images."
		enabled={zipPreviewEnabled}
		badge={SECTION}
		onToggle={toggleZipPreviewAddon}
	>
		{#snippet preferences()}
<div class="addon-option">
				<span class="addon-option__label" id="addon-opt-zip-inline">Preview files inside the message</span>
				<Switch labelledby="addon-opt-zip-inline" checked={zipPreviewInlineEnabled} disabled={!zipPreviewEnabled} onchange={toggleZipPreviewInlineAddon} />
			</div>
			<div class="addon-note">The preview remembers how you last sorted its files.</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('more_quick_reacts')}
	<AddonRow
		id="more_quick_reacts"
		label="More quick reactions"
		description="One-click reactions over each message, including your own favorites."
		enabled={quickReactionsEnabled}
		badge={SECTION}
		onToggle={toggleMoreQuickReactsAddon}
	>
		{#snippet preferences()}
			<div class="addon-note">
				Your quick reactions: {$quickReactionSettingsStore.customEmojiIds.length} / {MAX_CUSTOM_QUICK_REACTION_EMOJIS}
			</div>
			<div class="addon-actions">
				<div class="quick-reaction-picker-field">
					<ReactionEmojiSelect value={quickReactionCustomEmojiIdDraft} onchange={(id) => quickReactionCustomEmojiIdDraft = id} />
				</div>
				<button class="w-btn w-btn--sm" on:click={addCustomQuickReactionEmoji} disabled={!quickReactionCustomEmojiIdDraft.trim()}>
					Add emoji
				</button>
				<button class="w-btn w-btn--sm" on:click={clearCustomQuickReactionEmojis} disabled={$quickReactionSettingsStore.customEmojiIds.length === 0}>
					Clear mine
				</button>
			</div>
			{#if quickReactionCustomEmojiEntries.length === 0}
				<div class="addon-note">No reactions chosen yet, so {brandName} suggests some.</div>
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
								Remove
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
