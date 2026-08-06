<script lang="ts">
	import {
		addonControlMatches,
		LOCAL_ADDON_CONTROL_META,
		addonSectionHasMatches as registrySectionHasMatches,
		addonSectionMatchCount as registrySectionMatchCount,
		countAvailableAddonControls,
		countVisibleAddonControls,
		tokenizeAddonSearchQuery,
		type AddonSectionId
	} from './addonSettingsRegistry';
	import {
		fetchPluginInventory,
		pluginBackendAddons,
		pluginFrontendAddons,
		type DetectedAddon
	} from './addonDetection';
	import { getServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import { onMount } from 'svelte';
	import AddonManifestSection from './addons/AddonManifestSection.svelte';
	import ChatSection from './addons/ChatSection.svelte';
	import SpoilersSection from './addons/SpoilersSection.svelte';
	import SearchSection from './addons/SearchSection.svelte';
	import NavigationSection from './addons/NavigationSection.svelte';
	import IdentitySection from './addons/IdentitySection.svelte';
	import NotificationsSection from './addons/NotificationsSection.svelte';
	import MediaSection from './addons/MediaSection.svelte';
	import AppearanceSection from './addons/AppearanceSection.svelte';
	import UtilitiesSection from './addons/UtilitiesSection.svelte';

	/** Backend-enabled addons from GET /api/addons */
	let backendAddons: DetectedAddon[] = [];
	/** Bundled frontend allowlist entries reported by inventory */
	let frontendAddons: DetectedAddon[] = [];
	let addonsLastDetectedAt = '';
	let addonsLoading = false;
	let addonsError = '';
	let addonSearchQuery = '';
	let addonSearchTokens: string[] = [];
	// Finding 22: default to first rendered section (chat). 'dms' was removed.
	let activeAddonSection: AddonSectionId | null = 'chat';
	let visibleLocalAddonControlCount = 0;
	let availableLocalAddonControlCount = 0;

	$: translatorAddonDetected = [...frontendAddons, ...backendAddons].some(
		(addon) => addon.id === 'translator-assist'
	);

	function localAddonControlAvailable(controlId: string): boolean {
		if (!LOCAL_ADDON_CONTROL_META[controlId]) return false;
		return controlId !== 'translator_addon' || translatorAddonDetected;
	}

	function localAddonControlMatches(controlId: string): boolean {
		return addonControlMatches(controlId, addonSearchTokens, localAddonControlAvailable);
	}

	function addonSectionHasMatches(section: AddonSectionId): boolean {
		return registrySectionHasMatches(section, addonSearchTokens, localAddonControlAvailable);
	}

	function addonSectionMatchCount(section: AddonSectionId): number {
		return registrySectionMatchCount(section, addonSearchTokens, localAddonControlAvailable);
	}

	function isAddonSectionOpen(section: AddonSectionId): boolean {
		if (addonSearchTokens.length > 0) {
			return addonSectionHasMatches(section);
		}
		return activeAddonSection === section;
	}

	function toggleAddonSection(section: AddonSectionId): void {
		activeAddonSection = activeAddonSection === section ? null : section;
	}

	function clearAddonSearchQuery(): void {
		addonSearchQuery = '';
	}

	/**
	 * A4: inventory only from GET /api/addons (via addonDetection).
	 * No package install, no broken ./plugins/*.svelte glob, no import theater.
	 */
	async function refreshAddonDetection(): Promise<void> {
		addonsLoading = true;
		addonsError = '';
		try {
			const plugins = await fetchPluginInventory(getServerUrl(), getAuthToken());
			if (plugins) {
				backendAddons = pluginBackendAddons(plugins);
				frontendAddons = pluginFrontendAddons(plugins);
			} else {
				backendAddons = [];
				frontendAddons = [];
				addonsError =
					'Could not reach GET /api/addons. Is the server running this build with the addons endpoint?';
			}
			addonsLastDetectedAt = new Date().toLocaleString();
		} catch (err) {
			backendAddons = [];
			frontendAddons = [];
			addonsError = err instanceof Error ? err.message : 'Failed to refresh add-on inventory';
		} finally {
			addonsLoading = false;
		}
	}

	onMount(() => {
		void refreshAddonDetection();
	});

	$: addonSearchTokens = tokenizeAddonSearchQuery(addonSearchQuery);
	$: availableLocalAddonControlCount = countAvailableAddonControls(localAddonControlAvailable);
	$: visibleLocalAddonControlCount = countVisibleAddonControls(
		addonSearchTokens,
		localAddonControlAvailable
	);
</script>

<div class="settings-section">
	<AddonManifestSection
		{frontendAddons}
		{backendAddons}
		{addonsLastDetectedAt}
		{addonsLoading}
		{addonsError}
		{refreshAddonDetection}
	/>

	<div class="addons-settings-window">
		<div class="addons-settings-window-header">
			<div class="setting-info">
				<span class="setting-label">Local controls</span>
				<span class="setting-description"
					>Local device controls. Search expands matches.</span
				>
			</div>
			<div class="addons-settings-toolbar">
				<label class="addons-search-field">
					<span class="addons-search-label">Search add-ons</span>
					<input
						type="search"
						class="theme-select addon-search-input"
						bind:value={addonSearchQuery}
						placeholder="Filter add-ons…"
						name="addon-filter"
						id="settings-addon-filter"
						autocomplete="off"
						autocapitalize="off"
						autocorrect="off"
						spellcheck="false"
						data-lpignore="true"
						data-1p-ignore="true"
						data-form-type="other"
					/>
				</label>
				<div class="addons-search-meta">
					<span class="runtime-note"
						>Showing {visibleLocalAddonControlCount} of {availableLocalAddonControlCount} local
						add-ons</span
					>
					{#if addonSearchQuery.trim()}
						<button
							type="button"
							class="action-btn secondary addon-search-clear"
							on:click={clearAddonSearchQuery}
						>
							Clear Search
						</button>
					{/if}
				</div>
			</div>
		</div>
		<div class="addons-settings-window-body">
			{#if visibleLocalAddonControlCount === 0}
				<div class="addon-empty-state">
					<div class="addon-empty-state-title">No local add-ons matched that search.</div>
					<div class="runtime-note">Try another keyword, or clear the filter to show everything again.</div>
					<button
						type="button"
						class="action-btn secondary addon-search-clear"
						on:click={clearAddonSearchQuery}
					>
						Clear Search
					</button>
				</div>
			{:else}
				<!-- DM-strip 2026-06-16: DmsSection removed. Only Chat + Search addon panels remain. -->
				<ChatSection
					{localAddonControlMatches}
					{isAddonSectionOpen}
					{toggleAddonSection}
					{addonSectionMatchCount}
				/>
				<SpoilersSection
					{localAddonControlMatches}
					{isAddonSectionOpen}
					{toggleAddonSection}
					{addonSectionMatchCount}
				/>
				<SearchSection
					{localAddonControlMatches}
					{isAddonSectionOpen}
					{toggleAddonSection}
					{addonSectionMatchCount}
				/>
				<NavigationSection
					{localAddonControlMatches}
					{isAddonSectionOpen}
					{toggleAddonSection}
					{addonSectionMatchCount}
				/>
				<IdentitySection
					{localAddonControlMatches}
					{isAddonSectionOpen}
					{toggleAddonSection}
					{addonSectionMatchCount}
				/>
				<NotificationsSection
					{localAddonControlMatches}
					{isAddonSectionOpen}
					{toggleAddonSection}
					{addonSectionMatchCount}
				/>
				<MediaSection
					{localAddonControlMatches}
					{isAddonSectionOpen}
					{toggleAddonSection}
					{addonSectionMatchCount}
				/>
				<AppearanceSection
					{localAddonControlMatches}
					{isAddonSectionOpen}
					{toggleAddonSection}
					{addonSectionMatchCount}
				/>
				<UtilitiesSection
					{localAddonControlMatches}
					{isAddonSectionOpen}
					{toggleAddonSection}
					{addonSectionMatchCount}
					{translatorAddonDetected}
				/>
			{/if}
		</div>
	</div>
</div>
