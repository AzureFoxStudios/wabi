<script lang="ts">
	import {
		addonControlMatches,
		LOCAL_ADDON_CONTROL_META,
		ADDON_SECTION_LABELS,
		addonSectionHasMatches as registrySectionHasMatches,
		addonSectionMatchCount as registrySectionMatchCount,
		countAvailableAddonControls,
		countVisibleAddonControls,
		tokenizeAddonSearchQuery,
		type AddonSectionId
	} from './addonSettingsRegistry';
	import {
		detectFrontendAddons,
		fetchPluginInventory,
		mergeFrontendAddonLists,
		pluginBackendAddons,
		pluginFrontendAddons,
		type DetectedAddon
	} from './addonDetection';
	import { getServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import AddonManifestSection from './addons/AddonManifestSection.svelte';
		import ChatSection from './addons/ChatSection.svelte';
	import SearchSection from './addons/SearchSection.svelte';
	import NavigationSection from './addons/NavigationSection.svelte';
	import IdentitySection from './addons/IdentitySection.svelte';
	import NotificationsSection from './addons/NotificationsSection.svelte';
	import MediaSection from './addons/MediaSection.svelte';
	import AppearanceSection from './addons/AppearanceSection.svelte';
	import UtilitiesSection from './addons/UtilitiesSection.svelte';

	let frontendAddons: DetectedAddon[] = [];
	let backendAddons: DetectedAddon[] = [];
	let addonsLastDetectedAt = '';
	let addonsLoading = false;
	let addonInstallLoading = false;
	let addonInstallStatus = '';
	let addonsImportPreview: { importedAt?: string; frontend?: unknown[]; backend?: unknown[] } | null = null;
	let addonSearchQuery = '';
	let addonSearchTokens: string[] = [];
	let activeAddonSection: AddonSectionId | null = 'dms';
	let visibleLocalAddonControlCount = 0;
	let availableLocalAddonControlCount = 0;
	const frontendAddonModules = import.meta.glob('./plugins/*.svelte');

	$: translatorAddonDetected = [...frontendAddons, ...backendAddons].some((addon) => addon.id === 'translator-assist');

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

	async function refreshAddonDetection(): Promise<void> {
		addonsLoading = true;
		try {
			const localFrontendAddons = detectFrontendAddons(Object.keys(frontendAddonModules));
			const plugins = await fetchPluginInventory(getServerUrl(), getAuthToken());
			if (plugins) {
				frontendAddons = mergeFrontendAddonLists(pluginFrontendAddons(plugins), localFrontendAddons);
				backendAddons = pluginBackendAddons(plugins);
			} else {
				frontendAddons = localFrontendAddons;
				backendAddons = [];
			}
			addonsLastDetectedAt = new Date().toLocaleString();
		} finally {
			addonsLoading = false;
		}
	}

	function exportAddonManifest(): void {
		const data = {
			exportedAt: new Date().toISOString(),
			frontend: frontendAddons,
			backend: backendAddons
		};
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `wabi-addons-manifest-${Date.now()}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	function triggerAddonImport(): void {
		(addonsImportInput as HTMLInputElement)?.click();
	}

	function triggerAddonPackageInstall(): void {
		(addonsPackageInput as HTMLInputElement)?.click();
	}

	let addonsImportInput: HTMLInputElement;
	let addonsPackageInput: HTMLInputElement;

	async function importAddonManifest(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			const raw = await file.text();
			const parsed = JSON.parse(raw);
			addonsImportPreview = {
				importedAt: parsed?.exportedAt,
				frontend: Array.isArray(parsed?.frontend) ? parsed.frontend : [],
				backend: Array.isArray(parsed?.backend) ? parsed.backend : []
			};
		} catch {
			alert('Invalid add-ons manifest JSON file.');
		} finally {
			input.value = '';
		}
	}

	async function installAddonPackage(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const token = getAuthToken();
		if (!token) {
			alert('Please log in with an admin account to install plugins.');
			input.value = '';
			return;
		}

		const lowerName = file.name.toLowerCase();
		if (!lowerName.endsWith('.zip') && !lowerName.endsWith('.wabi-plugin') && !lowerName.endsWith('.wabip')) {
			alert('Please select a .zip, .wabi-plugin, or .wabip file.');
			input.value = '';
			return;
		}

		const formData = new FormData();
		formData.append('pluginPackage', file);

		addonInstallLoading = true;
		addonInstallStatus = `Installing ${file.name}...`;
		try {
			const response = await fetch(`${getServerUrl()}/api/plugins/install`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: formData
			});

			const payload = await response.json().catch(() => ({}));
			if (!response.ok || !payload?.success) {
				throw new Error(String(payload?.error || 'Plugin install failed'));
			}

			const pluginName = String(payload?.plugin?.name || payload?.plugin?.pluginId || 'plugin');
			const pluginVersion = String(payload?.plugin?.version || 'unknown');
			addonInstallStatus = `Installed ${pluginName} (v${pluginVersion}).`;
			await refreshAddonDetection();
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Plugin install failed';
			addonInstallStatus = `Install failed: ${message}`;
			alert(`Plugin install failed: ${message}`);
		} finally {
			addonInstallLoading = false;
			input.value = '';
		}
	}

	$: addonSearchTokens = tokenizeAddonSearchQuery(addonSearchQuery);
	$: availableLocalAddonControlCount = countAvailableAddonControls(localAddonControlAvailable);
	$: visibleLocalAddonControlCount = countVisibleAddonControls(addonSearchTokens, localAddonControlAvailable);
</script>

<div class="settings-section">
	<AddonManifestSection
		bind:frontendAddons
		bind:backendAddons
		bind:addonsLastDetectedAt
		bind:addonsLoading
		bind:addonInstallLoading
		bind:addonInstallStatus
		bind:addonsImportPreview
		bind:addonsImportInput
		bind:addonsPackageInput
		{refreshAddonDetection}
		{exportAddonManifest}
		{triggerAddonImport}
		{triggerAddonPackageInstall}
		{importAddonManifest}
		{installAddonPackage}
	/>

	<div class="addons-settings-window">
		<div class="addons-settings-window-header">
			<div class="setting-info">
				<span class="setting-label">Local Add-on Controls</span>
				<span class="setting-description">Browse and tune device-local add-on behavior here. Search auto-expands matching sections while you filter.</span>
			</div>
			<div class="addons-settings-toolbar">
				<label class="addons-search-field">
					<span class="addons-search-label">Search add-ons</span>
					<input
						type="search"
						class="theme-select addon-search-input"
						bind:value={addonSearchQuery}
						placeholder="Search local add-ons, tools, and settings"
					/>
				</label>
				<div class="addons-search-meta">
					<span class="runtime-note">Showing {visibleLocalAddonControlCount} of {availableLocalAddonControlCount} local add-ons</span>
					{#if addonSearchQuery.trim()}
						<button type="button" class="action-btn secondary addon-search-clear" on:click={clearAddonSearchQuery}>
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
					<button type="button" class="action-btn secondary addon-search-clear" on:click={clearAddonSearchQuery}>
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
