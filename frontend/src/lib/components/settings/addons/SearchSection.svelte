<script lang="ts">
	import { displayEnhancementSettingsStore, setBetterSearchPageEnabled, setGoogleSearchReplaceEnabled } from '$lib/displayEnhancements';
	import { brandName } from '$lib/branding';
	import { getSearchEngineProvider, getCustomSearchEngineTemplate, setCustomSearchEngineTemplate, setSearchEngineProvider, type SearchEngineProvider } from '$lib/searchEngineJump';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import type { AddonSectionId } from '../addonSettingsRegistry';

	export let localAddonControlMatches: (controlId: string) => boolean;
	export let isAddonSectionOpen: (section: AddonSectionId) => boolean;
	export let toggleAddonSection: (section: AddonSectionId) => void;
	export let addonSectionMatchCount: (section: AddonSectionId) => number;

	let betterSearchPageEnabled = true;
	let googleSearchReplaceEnabled = true;
	let searchEngineProvider: SearchEngineProvider = 'brave';
	let searchEngineCustomTemplate = 'https://search.brave.com/search?q={query}';
	const SEARCH_ENGINE_CUSTOM_TEMPLATE_PLACEHOLDER = 'https://example.com/search?q={query}';
	const SEARCH_ENGINE_CUSTOM_QUERY_TOKEN = '{query}';

	$: betterSearchPageEnabled = $displayEnhancementSettingsStore.betterSearchPageEnabled;
	$: googleSearchReplaceEnabled = $displayEnhancementSettingsStore.googleSearchReplaceEnabled;

	function initSearchSettings(): void {
		searchEngineProvider = getSearchEngineProvider();
		searchEngineCustomTemplate = getCustomSearchEngineTemplate();
	}
	initSearchSettings();

	function toggleBetterSearchPageAddon(): void {
		setBetterSearchPageEnabled(!betterSearchPageEnabled);
	}

	function toggleGoogleSearchReplaceAddon(): void {
		setGoogleSearchReplaceEnabled(!googleSearchReplaceEnabled);
	}

	function updateSearchEngineProvider(value: string): void {
		if (
			value === 'google' ||
			value === 'duckduckgo' ||
			value === 'bing' ||
			value === 'brave' ||
			value === 'startpage' ||
			value === 'custom'
		) {
			searchEngineProvider = value as SearchEngineProvider;
			setSearchEngineProvider(searchEngineProvider);
		}
	}

	function saveCustomSearchEngineTemplateFromSettings(): void {
		const saved = setCustomSearchEngineTemplate(searchEngineCustomTemplate);
		if (!saved) {
			alert(
				'Custom search template must include {query} and use an http(s) URL. Example: https://search.brave.com/search?q={query}'
			);
			searchEngineCustomTemplate = getCustomSearchEngineTemplate();
			return;
		}
		searchEngineCustomTemplate = getCustomSearchEngineTemplate();
	}
</script>

{#if localAddonControlMatches('better_search_page') || localAddonControlMatches('google_search_replace')}
<section class="addon-accordion-section">
	<button
		type="button"
		class="addon-accordion-trigger"
		aria-expanded={isAddonSectionOpen('search')}
		aria-controls="addon-section-search"
		on:click={() => toggleAddonSection('search')}
	>
		<span class="addon-accordion-trigger-main">
			<span class="addon-section-chevron" aria-hidden="true">
				<svg viewBox="0 0 24 24">
					<path d="M9 6l6 6-6 6"></path>
				</svg>
			</span>
			<span class="addon-accordion-label">{ADDON_SECTION_LABELS.search}</span>
		</span>
		<span class="addon-accordion-count">{addonSectionMatchCount('search')}</span>
	</button>
	{#if isAddonSectionOpen('search')}
	<div class="addon-accordion-body" id="addon-section-search">
		{#if localAddonControlMatches('better_search_page')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">BetterSearchPage</span>
					<span class="setting-description">Keep search results controls pinned above the message list while you scroll through matches.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={betterSearchPageEnabled} on:click={toggleBetterSearchPageAddon}>
						{betterSearchPageEnabled ? 'ON' : 'OFF'}
					</button>
				</div>
			</div>
		{/if}

		{#if localAddonControlMatches('google_search_replace')}
			<div class="setting-item-full">
				<div class="setting-info">
					<span class="setting-label">GoogleSearchReplace ({brandName} translation)</span>
					<span class="setting-description">Add a quick "Search on Web" action from the in-chat search bar so users can continue the same query in a browser.</span>
				</div>
				<div class="settings-row-actions">
					<button class="toggle-btn" class:active={googleSearchReplaceEnabled} on:click={toggleGoogleSearchReplaceAddon}>
						{googleSearchReplaceEnabled ? 'ON' : 'OFF'}
					</button>
					<label class="upload-limit-row split-chunk-size-row">
						<span>Search engine</span>
						<select
							class="theme-select"
							value={searchEngineProvider}
							on:change={(event) => updateSearchEngineProvider(event.currentTarget.value)}
							disabled={!googleSearchReplaceEnabled}
						>
							<option value="brave">Brave</option>
							<option value="duckduckgo">DuckDuckGo</option>
							<option value="startpage">Startpage</option>
							<option value="bing">Bing</option>
							<option value="google">Google</option>
							<option value="custom">Custom template</option>
						</select>
					</label>
				</div>
				{#if searchEngineProvider === 'custom'}
					<div class="settings-row-actions">
						<input
							type="text"
							class="theme-select"
							bind:value={searchEngineCustomTemplate}
							placeholder={SEARCH_ENGINE_CUSTOM_TEMPLATE_PLACEHOLDER}
							disabled={!googleSearchReplaceEnabled}
						/>
						<button
							class="action-btn secondary"
							on:click={saveCustomSearchEngineTemplateFromSettings}
							disabled={!googleSearchReplaceEnabled}
						>
							Save Template
						</button>
					</div>
					<div class="runtime-note">Use <code>{SEARCH_ENGINE_CUSTOM_QUERY_TOKEN}</code> where the search text should be inserted.</div>
				{/if}
			</div>
		{/if}
	</div>
	{/if}
</section>
{/if}
