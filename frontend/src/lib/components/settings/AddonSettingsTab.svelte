<script lang="ts">
	import GamesSettingsEntry from '$lib/games/GamesSettingsEntry.svelte';
	import {
		ADDON_SECTION_IDS,
		ADDON_SECTION_LABELS,
		type AddonSectionId
	} from './addonSettingsRegistry';
	import { createAddonSettingsView, type AddonCategoryFilter } from './addonSettingsView';
	import { addonEnabledState } from './addonEnabledRegistry.svelte';
	import {
		fetchPluginInventory,
		pluginBackendAddons,
		pluginFrontendAddons,
		switchAddon,
		type DetectedAddon
	} from './addonDetection';
	import { getServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import { onMount } from 'svelte';
	import AddonRow from './addons/AddonRow.svelte';
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
	let backendAddons = $state<DetectedAddon[]>([]);
	/** Bundled frontend allowlist entries reported by inventory */
	let frontendAddons = $state<DetectedAddon[]>([]);
	let addonsLastDetectedAt = $state('');
	let addonsLoading = $state(false);
	let addonsError = $state('');
	let addonSearchQuery = $state('');
	/** Blender's "Enabled Only" filter. */
	let enabledOnly = $state(false);
	/** Blender's category dropdown: All / Server / Bundled / one local section. */
	let categoryFilter = $state<AddonCategoryFilter>('all');
	/** In-app switch feedback (owner action on a compiled-in add-on). */
	let addonSwitchBusy = $state<string | null>(null);
	let addonSwitchStatus = $state('');
	let translatorAddonDetected = $derived(
		[...frontendAddons, ...backendAddons].some((addon) => addon.id === 'translator-assist')
	);
	let addonView = $derived(
		createAddonSettingsView(addonSearchQuery, enabledOnly, addonEnabledState, categoryFilter)
	);
	let localAddonControlMatches = $derived(addonView.localAddonControlMatches);
	let addonSectionMatchCount = $derived(addonView.addonSectionMatchCount);
	let availableLocalAddonControlCount = $derived(addonView.availableLocalAddonControlCount);
	let visibleLocalAddonControlCount = $derived(addonView.visibleLocalAddonControlCount);
	let hasVisibleRows = $derived(
		visibleLocalAddonControlCount > 0 ||
			(addonView.showServerRows && backendAddons.length > 0) ||
			(addonView.showBundledRows && frontendAddons.length > 0)
	);

	function clearAddonSearchQuery(): void {
		addonSearchQuery = '';
	}

	/** How this add-on is attached: build-time feature and/or runtime switch. */
	function attachMeta(addon: DetectedAddon): string {
		const parts = [`id: ${addon.id}`, `version: ${addon.version}`];
		parts.push(addon.cargoFeature ? `build: --features ${addon.cargoFeature}` : 'always compiled');
		if (addon.runtimeEnv) parts.push(`runtime: ${addon.runtimeEnv}=1`);
		parts.push(addon.runtimeSwitch ? 'switch: in-app' : 'switch: rebuild only');
		return parts.join(' · ');
	}

	function serverAddonDescription(addon: DetectedAddon): string {
		const detach = addon.cargoFeature
			? `Detach it by rebuilding without the ${addon.cargoFeature} cargo feature.`
			: 'Always compiled into this server binary — detaching needs a rebuild.';
		const runtime = addon.runtimeEnv
			? ` Runtime switch on the host: ${addon.runtimeEnv}=1.`
			: '';
		return `Server add-on. ${detach}${runtime}`;
	}

	function bundledAddonDescription(): string {
		return 'Bundled with this client build (static allowlist — never a remote import). Remove it from the allowlist and rebuild the frontend to detach.';
	}

	/**
	 * Flip a compiled-in add-on from the app (owner/admin). Steam and tailcat
	 * apply immediately; lore attaches to its service at startup, so the server
	 * tells us when a restart is needed.
	 */
	async function toggleServerAddon(addon: DetectedAddon): Promise<void> {
		if (!addon.runtimeSwitch || addonSwitchBusy) return;
		const next = !addon.enabled;
		addonSwitchBusy = addon.id;
		addonSwitchStatus = '';
		const result = await switchAddon(getServerUrl(), getAuthToken(), addon.id, next);
		addonSwitchBusy = null;
		if (!result) {
			addonSwitchStatus = `Could not switch ${addon.name}. This action needs an owner or admin session on this server.`;
			return;
		}
		backendAddons = backendAddons.map((entry) =>
			entry.id === addon.id ? { ...entry, enabled: result.enabled } : entry
		);
		addonSwitchStatus = result.appliesOnRestart
			? `${addon.name} ${result.enabled ? 'enabled' : 'disabled'} — applies after the next server restart.`
			: `${addon.name} ${result.enabled ? 'enabled' : 'disabled'}.`;
		void refreshAddonDetection();
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
</script>

<div class="settings-section">
	<GamesSettingsEntry />

	<div class="addons-settings-window">
		<div class="addons-settings-window-header">
			<div class="addons-settings-toolbar">
				<label class="addons-search-field">
					<span class="addons-search-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24">
							<circle cx="11" cy="11" r="7" />
							<path d="M20 20l-3.6-3.6" />
						</svg>
					</span>
					<input
						type="search"
						class="addon-search-input"
						bind:value={addonSearchQuery}
						placeholder="Search add-ons…"
						aria-label="Search add-ons"
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
				<label class="addon-enabled-only">
					<input type="checkbox" bind:checked={enabledOnly} />
					<span>Enabled Only</span>
				</label>
				<div class="addon-toolbar-actions">
					<label class="addon-category-filter">
						<span class="visually-hidden">Add-on category</span>
						<select class="addon-category-select" bind:value={categoryFilter}>
							<option value="all">All</option>
							<option value="server">Server</option>
							<option value="bundled">Bundled</option>
							{#each ADDON_SECTION_IDS as section (section)}
								<option value={section}>
									{ADDON_SECTION_LABELS[section]} ({addonSectionMatchCount(section)})
								</option>
							{/each}
						</select>
					</label>
					<button
						type="button"
						class="addon-icon-btn"
						onclick={refreshAddonDetection}
						disabled={addonsLoading}
						title="Refresh add-on inventory"
						aria-label="Refresh add-on inventory"
					>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path d="M21 12a9 9 0 1 1-2.6-6.4" />
							<path d="M21 4v5h-5" />
						</svg>
					</button>
				</div>
			</div>
			<div class="addons-search-meta">
				<span class="addon-status-note">
					Showing {visibleLocalAddonControlCount} of {availableLocalAddonControlCount} local add-ons{#if addonsLastDetectedAt}
						· inventory refreshed {addonsLastDetectedAt}{/if}
				</span>
				{#if addonSearchQuery.trim()}
					<button
						type="button"
						class="addon-search-clear"
						onclick={clearAddonSearchQuery}
					>
						Clear
					</button>
				{/if}
			</div>
			{#if addonSwitchStatus}
				<div class="addon-status-note addon-switch-status" role="status">{addonSwitchStatus}</div>
			{/if}
		</div>
		<div class="addons-settings-window-body">
			{#if addonsError}
				<div class="runtime-note addon-error">{addonsError}</div>
			{/if}

			{#if addonView.showServerRows}
				{#each backendAddons as addon (addon.id)}
					<AddonRow
						id={`server:${addon.id}`}
						label={addon.name}
						description={serverAddonDescription(addon)}
						enabled={addon.enabled}
						locked={!addon.runtimeSwitch}
						badge="Server"
						meta={attachMeta(addon)}
						onToggle={addon.runtimeSwitch ? () => void toggleServerAddon(addon) : undefined}
					/>
				{:else}
					<div class="addon-group-note">
						No backend add-ons enabled in this server build. Enable Cargo features (e.g.
						<code>--features addons</code>) and restart the server.
					</div>
				{/each}
			{/if}

			{#if addonView.showBundledRows && frontendAddons.length > 0}
				{#each frontendAddons as addon (addon.id + addon.source)}
					<AddonRow
						id={`bundled:${addon.id}`}
						label={addon.name}
						description={bundledAddonDescription()}
						enabled={addon.enabled}
						locked={true}
						badge="Bundled"
						meta={attachMeta(addon)}
					/>
				{/each}
			{/if}

			{#if addonView.showLocalRows}
				{#if !hasVisibleRows}
					<div class="addon-empty-state">
						<div class="addon-empty-state-title">No add-ons matched that filter.</div>
						<div class="runtime-note">
							Try another keyword, turn off Enabled Only, or clear the category filter.
						</div>
						<button type="button" class="addon-search-clear" onclick={clearAddonSearchQuery}>
							Clear search
						</button>
					</div>
				{/if}
				<!-- Keep section instances alive through empty searches so local edits survive. -->
				<ChatSection {localAddonControlMatches} />
				<SpoilersSection {localAddonControlMatches} />
				<SearchSection {localAddonControlMatches} />
				<NavigationSection {localAddonControlMatches} />
				<IdentitySection {localAddonControlMatches} />
				<NotificationsSection {localAddonControlMatches} />
				<MediaSection {localAddonControlMatches} />
				<AppearanceSection {localAddonControlMatches} />
				<UtilitiesSection {localAddonControlMatches} {translatorAddonDetected} />
			{/if}
		</div>
	</div>
</div>
