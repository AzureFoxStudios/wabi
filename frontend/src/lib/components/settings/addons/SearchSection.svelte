<script lang="ts">
	import { displayEnhancementSettingsStore, setBetterSearchPageEnabled, setGoogleSearchReplaceEnabled } from '$lib/displayEnhancements';
	import { brandName } from '$lib/branding';
	import { getSearchEngineProvider, getCustomSearchEngineTemplate, setCustomSearchEngineTemplate, setSearchEngineProvider, type SearchEngineProvider } from '$lib/searchEngineJump';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import AddonRow from './AddonRow.svelte';

	export let localAddonControlMatches: (controlId: string) => boolean;

	const SECTION = ADDON_SECTION_LABELS.search;

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

{#if localAddonControlMatches('better_search_page')}
	<AddonRow
		id="better_search_page"
		label="BetterSearchPage"
		description="Keep search results controls pinned above the message list while you scroll through matches."
		enabled={betterSearchPageEnabled}
		badge={SECTION}
		onToggle={toggleBetterSearchPageAddon}
	/>
{/if}

{#if localAddonControlMatches('google_search_replace')}
	<AddonRow
		id="google_search_replace"
		label={`GoogleSearchReplace (${brandName} translation)`}
		description='Add a quick "Search on Web" action from the in-chat search bar so users can continue the same query in a browser.'
		enabled={googleSearchReplaceEnabled}
		badge={SECTION}
		onToggle={toggleGoogleSearchReplaceAddon}
	>
		{#snippet preferences()}
			<label class="addon-pref-field">
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
		{/snippet}
	</AddonRow>
{/if}
