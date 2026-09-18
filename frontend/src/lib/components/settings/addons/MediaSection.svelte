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
	import { getQuickReactionClickShare, quickReactionTelemetryStore, resetQuickReactionTelemetry } from '$lib/quickReactionTelemetry';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import ReactionEmojiSelect from '../../emoji/ReactionEmojiSelect.svelte';
	import AddonRow from './AddonRow.svelte';

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
	let quickReactionClickShare: number | null = null;
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
	$: quickReactionClickShare = getQuickReactionClickShare($quickReactionTelemetryStore);

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
			quickReactionSettingsStatus = 'Selected emoji is no longer available.';
			return;
		}
		const alreadyAdded = $quickReactionSettingsStore.customEmojiIds.includes(emojiId);
		const added = addQuickReactionCustomEmojiId(emojiId);
		if (added) {
			quickReactionSettingsStatus = 'Custom quick reaction added.';
			quickReactionCustomEmojiIdDraft = '';
			return;
		}
		quickReactionSettingsStatus = alreadyAdded
			? 'Emoji already exists in your custom quick-reaction set.'
			: `Custom quick-reaction set is capped at ${MAX_CUSTOM_QUICK_REACTION_EMOJIS} emojis.`;
	}

	function removeCustomQuickReactionEmoji(emojiId: string): void {
		removeQuickReactionCustomEmojiId(emojiId);
		quickReactionSettingsStatus = '';
	}

	function clearCustomQuickReactionEmojis(): void {
		if ($quickReactionSettingsStore.customEmojiIds.length === 0) return;
		const confirmed = window.confirm('Clear all custom quick-reaction emojis?');
		if (!confirmed) return;
		clearQuickReactionCustomEmojiIds();
		quickReactionSettingsStatus = '';
	}

	function resetMoreQuickReactsTelemetry(): void {
		if ($quickReactionTelemetryStore.quickStripClicks + $quickReactionTelemetryStore.pickerOpens === 0) return;
		const confirmed = window.confirm('Reset MoreQuickReacts usage counters?');
		if (!confirmed) return;
		resetQuickReactionTelemetry();
	}

	function formatQuickReactionShare(value: number | null): string {
		if (value === null) return 'n/a';
		return `${Math.round(value * 100)}%`;
	}
</script>

{#if localAddonControlMatches('image_utilities')}
	<AddonRow
		id="image_utilities"
		label="ImageUtilities (MVP)"
		description="Choose the default provider for reverse image search from the image lightbox menu."
		enabled={true}
		locked={true}
		badge={SECTION}
	>
		{#snippet preferences()}
			<label class="addon-pref-field">
				<span>Reverse image search provider</span>
				<select
					class="theme-select"
					value={reverseImageSearchProvider}
					on:change={(event) => updateReverseSearchProvider(event.currentTarget.value as ReverseImageSearchProvider)}
				>
					<option value="google_lens">Google Lens</option>
					<option value="bing">Bing Visual Search</option>
					<option value="tineye">TinEye</option>
					<option value="yandex">Yandex Images</option>
				</select>
			</label>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('emoji_statistics')}
	<AddonRow
		id="emoji_statistics"
		label="EmojiStatistics"
		description="Show local emoji inventory stats and category breakdown in Add-ons."
		enabled={emojiStatisticsEnabled}
		badge={SECTION}
		onToggle={toggleEmojiStatisticsAddon}
	>
		{#snippet preferences()}
			{#if emojiStatisticsEnabled}
				<div class="runtime-note">
					Inventory: total {$emojis.length},
					custom {$emojis.filter((emoji) => emoji.isCustom).length},
					default/open {$emojis.filter((emoji) => !emoji.isCustom).length}.
				</div>
				{#if emojiStatsCategories.length > 0}
					<div class="runtime-note">
						Top categories:
						{#each emojiStatsCategories as categoryEntry, index}
							{index > 0 ? ', ' : ''}
							{categoryEntry.category} ({categoryEntry.count})
						{/each}
					</div>
				{:else}
					<div class="runtime-note">No emoji catalog data loaded yet.</div>
				{/if}
			{/if}
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('spotify_controls')}
	<AddonRow
		id="spotify_controls"
		label={`SpotifyControls (${brandName} translation)`}
		description="Render playable Spotify mini-controls for Spotify track/album/playlist links directly in chat."
		enabled={spotifyControlsEnabled}
		badge={SECTION}
		onToggle={toggleSpotifyControlsAddon}
	/>
{/if}

{#if localAddonControlMatches('gif_captioner')}
	<AddonRow
		id="gif_captioner"
		label="GifCaptioner"
		description="Allow GIF sends to include caption text and keep caption rules consistent with outgoing text filters."
		enabled={gifCaptionerEnabled}
		badge={SECTION}
		onToggle={toggleGifCaptionerAddon}
	>
		{#snippet preferences()}
			<label class="addon-pref-check">
				<input
					type="checkbox"
					checked={gifCaptionerDedicatedFieldEnabled}
					on:change={toggleGifCaptionerDedicatedField}
					disabled={!gifCaptionerEnabled}
				/>
				<span>Dedicated caption field</span>
			</label>
			<label class="addon-pref-field">
				<span>Caption style</span>
				<select
					value={gifCaptionerCaptionStyle}
					on:change={(event) => updateGifCaptionerStyle(event.currentTarget.value)}
					disabled={!gifCaptionerEnabled}
				>
					<option value="plain">Plain</option>
					<option value="accent">Accent line</option>
					<option value="card">Caption card</option>
				</select>
			</label>
			<div class="runtime-note">
				Caption limit: {GIF_CAPTIONER_MAX_CAPTION_LENGTH} characters.
			</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('zip_preview')}
	<AddonRow
		id="zip_preview"
		label="ZipPreview"
		description="Inspect ZIP contents inline in chat, with optional per-entry text/image previews."
		enabled={zipPreviewEnabled}
		badge={SECTION}
		onToggle={toggleZipPreviewAddon}
	>
		{#snippet preferences()}
			<label class="addon-pref-check">
				<input
					type="checkbox"
					checked={zipPreviewInlineEnabled}
					on:change={toggleZipPreviewInlineAddon}
					disabled={!zipPreviewEnabled}
				/>
				<span>Inline entry preview</span>
			</label>
			<div class="runtime-note">Sort preference is saved from the preview panel controls.</div>
		{/snippet}
	</AddonRow>
{/if}

{#if localAddonControlMatches('more_quick_reacts')}
	<AddonRow
		id="more_quick_reacts"
		label="MoreQuickReacts"
		description="Show one-click quick-reaction buttons in message hover actions, with optional custom emoji shortcuts."
		enabled={quickReactionsEnabled}
		badge={SECTION}
		onToggle={toggleMoreQuickReactsAddon}
	>
		{#snippet preferences()}
			<div class="runtime-note">
				Custom quick set: {$quickReactionSettingsStore.customEmojiIds.length}/{MAX_CUSTOM_QUICK_REACTION_EMOJIS}
			</div>
			<div class="settings-row-actions">
				<div class="quick-reaction-picker-field">
					<ReactionEmojiSelect value={quickReactionCustomEmojiIdDraft} onchange={(id) => quickReactionCustomEmojiIdDraft = id} />
				</div>
				<button class="action-btn" on:click={addCustomQuickReactionEmoji} disabled={!quickReactionCustomEmojiIdDraft.trim()}>
					Add Emoji
				</button>
				<button class="action-btn secondary" on:click={clearCustomQuickReactionEmojis} disabled={$quickReactionSettingsStore.customEmojiIds.length === 0}>
					Clear Custom
				</button>
			</div>
			{#if quickReactionCustomEmojiEntries.length === 0}
				<div class="runtime-note">No custom quick reactions configured. {brandName} will fall back to smart defaults.</div>
			{:else}
				<div class="quick-reaction-settings-list">
					{#each quickReactionCustomEmojiEntries as emoji (emoji.id)}
						<div class="quick-reaction-settings-row">
							<img
								src={emoji.url}
								alt={emoji.displayName || emoji.name}
								class="quick-reaction-settings-emoji"
								loading="lazy"
								decoding="async"
							/>
							<div class="quick-reaction-settings-name">{emoji.displayName || emoji.name}</div>
							<button class="action-btn danger" on:click={() => removeCustomQuickReactionEmoji(emoji.id)}>
								Remove
							</button>
						</div>
					{/each}
				</div>
			{/if}
			{#if quickReactionSettingsStatus}
				<div class="runtime-note">{quickReactionSettingsStatus}</div>
			{/if}
			<div class="runtime-note">
				Local usage counters (device-only):
				quick-strip clicks {$quickReactionTelemetryStore.quickStripClicks},
				picker opens {$quickReactionTelemetryStore.pickerOpens},
				quick-strip share {formatQuickReactionShare(quickReactionClickShare)}.
			</div>
			<div class="settings-row-actions">
				<button
					class="action-btn secondary"
					on:click={resetMoreQuickReactsTelemetry}
					disabled={$quickReactionTelemetryStore.quickStripClicks + $quickReactionTelemetryStore.pickerOpens === 0}
				>
					Reset Usage Counters
				</button>
			</div>
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
