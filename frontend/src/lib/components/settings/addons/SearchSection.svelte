<script lang="ts">
	import { displayEnhancementSettingsStore, setBetterSearchPageEnabled, setGoogleSearchReplaceEnabled } from '$lib/displayEnhancements';
	import { brandName } from '$lib/branding';
	import { getSearchEngineProvider, getCustomSearchEngineTemplate, setCustomSearchEngineTemplate, setSearchEngineProvider, type SearchEngineProvider } from '$lib/searchEngineJump';
	import { ADDON_SECTION_LABELS } from '../addonSettingsRegistry';
	import AddonRow from './AddonRow.svelte';
	import Select from '../../ui/Select.svelte';

	export let localAddonControlMatches: (controlId: string) => boolean;

	const SECTION = ADDON_SECTION_LABELS.search;

	let betterSearchPageEnabled = true;
	let googleSearchReplaceEnabled = true;
	let searchEngineProvider: SearchEngineProvider = 'brave';
	let searchEngineCustomTemplate = 'https://search.brave.com/search?q={query}';
	const SEARCH_ENGINE_CUSTOM_TEMPLATE_PLACEHOLDER = 'https://example.com/search?q={query}';
	const SEARCH_ENGINE_CUSTOM_QUERY_TOKEN = '{query}';
	let templateError = '';

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
			templateError = 'Use an http(s) address that includes {query}, such as https://search.brave.com/search?q={query}.';
			return;
		}
		templateError = '';
		searchEngineCustomTemplate = getCustomSearchEngineTemplate();
	}
</script>

{#if localAddonControlMatches('better_search_page')}
	<AddonRow
		id="better_search_page"
		label="Pinned search controls"
		description="Keeps the search controls in view while you scroll through results."
		enabled={betterSearchPageEnabled}
		badge={SECTION}
		onToggle={toggleBetterSearchPageAddon}
	/>
{/if}

{#if localAddonControlMatches('google_search_replace')}
	<AddonRow
		id="google_search_replace"
		label="Search the web"
		description="Adds Search on the web to chat search, so you can take the same words to a search engine."
		enabled={googleSearchReplaceEnabled}
		badge={SECTION}
		onToggle={toggleGoogleSearchReplaceAddon}
	>
		{#snippet preferences()}
			<div class="addon-field">
				<span class="w-label">Search engine</span>
				<Select ariaLabel="Search engine" options={[{ value: 'brave', label: 'Brave' }, { value: 'duckduckgo', label: 'DuckDuckGo' }, { value: 'startpage', label: 'Startpage' }, { value: 'bing', label: 'Bing' }, { value: 'google', label: 'Google' }, { value: 'custom', label: 'Custom template' }]} value={searchEngineProvider} onchange={(value) => updateSearchEngineProvider(value)} disabled={!googleSearchReplaceEnabled} />
			</div>
			{#if searchEngineProvider === 'custom'}
				<div class="addon-actions">
					<input
						type="text"
						class="w-field"
						bind:value={searchEngineCustomTemplate}
						placeholder={SEARCH_ENGINE_CUSTOM_TEMPLATE_PLACEHOLDER}
						disabled={!googleSearchReplaceEnabled}
					/>
					<button
						class="w-btn w-btn--sm"
						on:click={saveCustomSearchEngineTemplateFromSettings}
						disabled={!googleSearchReplaceEnabled}
					>
						Save template
					</button>
				</div>
				{#if templateError}<div class="addon-note is-error" role="alert">{templateError}</div>{/if}
				<div class="addon-note">Put <code>{SEARCH_ENGINE_CUSTOM_QUERY_TOKEN}</code> where your search words go.</div>
			{/if}
		{/snippet}
	</AddonRow>
{/if}
