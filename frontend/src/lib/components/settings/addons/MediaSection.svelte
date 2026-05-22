<script lang="ts">
	import { emojis } from '$lib/socket';
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
	import type { AddonSectionId } from '../addonSettingsRegistry';

	export let localAddonControlMatches: (controlId: string) => boolean;
	export let isAddonSectionOpen: (section: AddonSectionId) => boolean;
	export let toggleAddonSection: (section: AddonSectionId) => void;
	export let addonSectionMatchCount: (section: AddonSectionId) => number;

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

{#if localAddonControlMatches('image_utilities') || localAddonControlMatches('emoji_statistics') || localAddonControlMatches('spotify_controls') || localAddonControlMatches('gif_captioner') || localAddonControlMatches('zip_preview') || localAddonControlMatches('more_quick_reacts')}
<section class="addon-accordion-section">
	<button
		type="button"
		class="addon-accordion-trigger"
		aria-expanded={isAddonSectionOpen('media')}
		aria-controls="addon-section-media"
		on:click={() => toggleAddonSection('media')}
	>
		<span class="addon-accordion-trigger-main">
			<span class="addon-section-chevron" aria-hidden="true">
				<svg viewBox="0 0 24 24">
					<path d="M9 6l6 6-6 6"></path>
				</svg>
			</span>
			<span class="addon-accordion-label">{ADDON_SECTION_LABELS.media}</span>
		</span>
		<span class="addon-accordion-count">{addonSectionMatchCount('media')}</span>
	</button>
	{#if isAddonSectionOpen('media')}
	<div class="addon-accordion-body" id="addon-section-media">
		{#if localAddonControlMatches('image_utilities')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">ImageUtilities (MVP)</span>
					<span class="setting-description">Choose the default provider for reverse image search from the image lightbox menu.</span>
				</div>
				<label class="upload-limit-row">
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
			</div>
		{/if}

		{#if localAddonControlMatches('emoji_statistics')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">EmojiStatistics</span>
					<span class="setting-description">Show local emoji inventory stats and category breakdown in Add-ons.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={emojiStatisticsEnabled} on:click={toggleEmojiStatisticsAddon}>
						{emojiStatisticsEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
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
			</div>
		{/if}

		{#if localAddonControlMatches('spotify_controls')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">SpotifyControls (Wabi translation)</span>
					<span class="setting-description">Render playable Spotify mini-controls for Spotify track/album/playlist links directly in chat.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={spotifyControlsEnabled} on:click={toggleSpotifyControlsAddon}>
						{spotifyControlsEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('gif_captioner')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">GifCaptioner</span>
					<span class="setting-description">Allow GIF sends to include caption text and keep caption rules consistent with outgoing text filters.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={gifCaptionerEnabled} on:click={toggleGifCaptionerAddon}>
						{gifCaptionerEnabled ? 'ON' : 'OFF'}
					</button>
					<button
						class="toggle-btn"
						class:active={gifCaptionerDedicatedFieldEnabled}
						on:click={toggleGifCaptionerDedicatedField}
						disabled={!gifCaptionerEnabled}
					>
						Dedicated caption field: {gifCaptionerDedicatedFieldEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
				<div class="settings-row-actions">
					<label class="upload-limit-row split-chunk-size-row">
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
				</div>
				<div class="runtime-note">
					Caption limit: {GIF_CAPTIONER_MAX_CAPTION_LENGTH} characters.
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('zip_preview')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">ZipPreview</span>
					<span class="setting-description">Inspect ZIP contents inline in chat, with optional per-entry text/image previews.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={zipPreviewEnabled} on:click={toggleZipPreviewAddon}>
						{zipPreviewEnabled ? 'ON' : 'OFF'}
					</button>
					<button
						class="toggle-btn"
						class:active={zipPreviewInlineEnabled}
						on:click={toggleZipPreviewInlineAddon}
						disabled={!zipPreviewEnabled}
					>
						Inline entry preview: {zipPreviewInlineEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
				<div class="runtime-note">Sort preference is saved from the preview panel controls.</div>
			</div>
		{/if}

		{#if localAddonControlMatches('more_quick_reacts')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">MoreQuickReacts</span>
					<span class="setting-description">Show one-click quick-reaction buttons in message hover actions, with optional custom emoji shortcuts.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={quickReactionsEnabled} on:click={toggleMoreQuickReactsAddon}>
						{quickReactionsEnabled ? 'ON' : 'OFF'}
					</button>
					<div class="runtime-note">
						Custom quick set: {$quickReactionSettingsStore.customEmojiIds.length}/{MAX_CUSTOM_QUICK_REACTION_EMOJIS}
					</div>
				</div>
				<div class="settings-row-actions">
					<select class="theme-select" bind:value={quickReactionCustomEmojiIdDraft}>
						<option value="">Select emoji to add</option>
						{#each $emojis as emoji (emoji.id)}
							<option value={emoji.id}>
								{emoji.displayName || emoji.name} ({emoji.name})
							</option>
						{/each}
					</select>
					<button class="action-btn" on:click={addCustomQuickReactionEmoji} disabled={!quickReactionCustomEmojiIdDraft.trim()}>
						Add Emoji
					</button>
					<button class="action-btn secondary" on:click={clearCustomQuickReactionEmojis} disabled={$quickReactionSettingsStore.customEmojiIds.length === 0}>
						Clear Custom
					</button>
				</div>
				{#if quickReactionCustomEmojiEntries.length === 0}
					<div class="runtime-note">No custom quick reactions configured. Wabi will fall back to smart defaults.</div>
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
			</div>
		{/if}
	</div>
	{/if}
</section>
{/if}
