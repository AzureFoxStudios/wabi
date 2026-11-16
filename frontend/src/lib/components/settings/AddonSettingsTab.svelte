<script lang="ts">
	/**
	 * Settings › Add-ons (THIS DEVICE, §8.9): the office tools first, as per-device switches with
	 * their maturity word and consent facts, then the small chat and reading tools, then what this
	 * server includes. No usage counters, no build flags: members see what each add-on does and
	 * whether it is on.
	 */
	import { onMount } from 'svelte';
	import { _ as t } from '$lib/i18n';
	import { ADDON_SECTION_IDS, ADDON_SECTION_LABELS, LOCAL_ADDON_CONTROL_META } from './addonSettingsRegistry';
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
	import { currentUser } from '$lib/socket';
	import { getAuthToken } from '$lib/authSession';
	import { brandName } from '$lib/branding';
	import { hydrateWorkspaceAddons, setWorkspaceAddonEnabled, workspaceAddonEnabled, type OfficeAddon } from '$lib/workspaces/addonState';
	import { OFFICE_ADDON_ROWS, OFFICE_KICKER, PREVIEW_TITLE, RETIRED_LOCAL_ADDON_CONTROLS, officeAddonState } from './officeAddonsSetting';
	import Icon from '../ui/Icon.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import Select from '../ui/Select.svelte';
	import Notice from '../ui/Notice.svelte';
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

	/** A locale word, or the English fallback while packs load. */
	const word = (key: string, fallback: string) => {
		const value = $t(key);
		return value && value !== key ? value : fallback;
	};

	// ── Office tools (Sheets, Present): per device ──
	let officeAvailable = $state<Record<OfficeAddon, boolean | null>>({ sheets: null, present: null });
	let officeBusy = $state<OfficeAddon | null>(null);
	let officeError = $state<{ id: OfficeAddon; text: string } | null>(null);

	async function loadOfficeAvailability(): Promise<void> {
		try {
			await hydrateWorkspaceAddons();
		} catch (error) {
			console.warn('[Add-ons] office add-on state did not load:', error);
		}
		const [sheets, present] = await Promise.all([
			import('@wabi/workspace-sheets').then((entry) => entry.available).catch(() => false),
			import('@wabi/workspace-present').then((entry) => entry.available).catch(() => false)
		]);
		officeAvailable = { sheets, present };
	}

	async function toggleOffice(id: OfficeAddon): Promise<void> {
		if (officeBusy || !officeAvailable[id]) return;
		const next = !$workspaceAddonEnabled[id];
		officeBusy = id;
		officeError = null;
		try {
			await setWorkspaceAddonEnabled(id, next);
		} catch (error) {
			console.warn('[Add-ons] office add-on switch failed:', error);
			const name = id === 'sheets' ? 'Sheets' : 'Present';
			officeError = { id, text: $t(next ? 'addon.office_fail_on' : 'addon.office_fail_off', { values: { name } }) };
		} finally {
			officeBusy = null;
		}
	}

	// ── Chat and reading tools (local) ──
	let addonSearchQuery = $state('');
	/** "All" or only the tools that are on. */
	let showWhich = $state<'all' | 'on'>('all');
	let categoryFilter = $state<AddonCategoryFilter>('all');
	const enabledOnly = $derived(showWhich === 'on');
	const categoryOptions = $derived([
		{ value: 'all', label: $t('addon.kind_all') },
		...ADDON_SECTION_IDS.map((section) => ({ value: section, label: ADDON_SECTION_LABELS[section] })),
		{ value: 'server', label: $t('addon.kind_server'), group: $t('settings.tabs.server') }
	]);

	// ── What this server includes (GET /api/addons) ──
	let backendAddons = $state<DetectedAddon[]>([]);
	let frontendAddons = $state<DetectedAddon[]>([]);
	let addonsLoading = $state(false);
	let addonsError = $state(false);
	let addonSwitchBusy = $state<string | null>(null);
	let addonSwitchStatus = $state('');

	const addonView = $derived(createAddonSettingsView(addonSearchQuery, enabledOnly, addonEnabledState, categoryFilter));
	const localAddonControlMatches = $derived(addonView.localAddonControlMatches);
	const visibleBackendAddons = $derived(
		addonView.showServerRows ? backendAddons.filter((addon) => addonView.inventoryAddonMatches(addon, 'server')) : []
	);
	const visibleFrontendAddons = $derived(
		addonView.showBundledRows ? frontendAddons.filter((addon) => addonView.inventoryAddonMatches(addon, 'bundled')) : []
	);
	// Count only rows that render: a retired control can still sit in the registry.
	const visibleLocalCount = $derived(
		Object.keys(LOCAL_ADDON_CONTROL_META).filter(
			(id) => !RETIRED_LOCAL_ADDON_CONTROLS.has(id) && addonView.localAddonControlMatches(id)
		).length
	);
	const visibleServerCount = $derived(visibleBackendAddons.length + visibleFrontendAddons.length);
	const filtering = $derived(Boolean(addonSearchQuery.trim()) || enabledOnly || categoryFilter !== 'all');
	// Server rows are in scope unless the Kind filter picked a local kind. While their list loads or
	// fails, the server section shows that state, so the empty state speaks only for the tools here
	// (and is left out when the server list is all that is in view: a failed list is never empty).
	const serverRowsInScope = $derived(addonView.showServerRows || addonView.showBundledRows);
	const serverListPending = $derived(serverRowsInScope && (addonsError || addonsLoading));
	const nothingMatches = $derived(
		filtering && visibleLocalCount + visibleServerCount === 0 && (addonView.showLocalRows || !serverListPending)
	);
	const showServerSection = $derived(serverRowsInScope && (serverListPending || visibleServerCount > 0));
	/** Only owners and admins can switch a server add-on; everyone else sees its state as a fact. */
	const canSwitchServerAddons = $derived(['owner', 'admin'].includes($currentUser?.highestRole ?? ''));

	function clearFilters(): void {
		addonSearchQuery = '';
		showWhich = 'all';
		categoryFilter = 'all';
	}

	function serverAddonDescription(addon: DetectedAddon): string {
		if (!addon.runtimeSwitch) return $t('addon.srv_fixed');
		return canSwitchServerAddons
			? $t('addon.srv_switch')
			: $t('addon.srv_owners');
	}

	/**
	 * Flip a compiled-in add-on from the app (owner/admin). Some apply right away; others attach
	 * when the server restarts, and the server says which.
	 */
	async function toggleServerAddon(addon: DetectedAddon): Promise<void> {
		if (!addon.runtimeSwitch || !canSwitchServerAddons || addonSwitchBusy) return;
		const next = !addon.enabled;
		addonSwitchBusy = addon.id;
		addonSwitchStatus = '';
		const result = await switchAddon(getServerUrl(), getAuthToken(), addon.id, next);
		addonSwitchBusy = null;
		if (!result) {
			addonSwitchStatus = $t('addon.switch_failed', { values: { name: addon.name } });
			return;
		}
		backendAddons = backendAddons.map((entry) => (entry.id === addon.id ? { ...entry, enabled: result.enabled } : entry));
		addonSwitchStatus = result.appliesOnRestart
			? $t(result.enabled ? 'addon.restart_on' : 'addon.restart_off', { values: { name: addon.name } })
			: $t(result.enabled ? 'addon.now_on' : 'addon.now_off', { values: { name: addon.name } });
		void refreshAddonDetection();
	}

	async function refreshAddonDetection(): Promise<void> {
		addonsLoading = true;
		addonsError = false;
		try {
			const plugins = await fetchPluginInventory(getServerUrl(), getAuthToken());
			if (plugins) {
				backendAddons = pluginBackendAddons(plugins);
				frontendAddons = pluginFrontendAddons(plugins);
			} else {
				backendAddons = [];
				frontendAddons = [];
				addonsError = true;
			}
		} catch (err) {
			console.warn('[Add-ons] server inventory failed:', err);
			backendAddons = [];
			frontendAddons = [];
			addonsError = true;
		} finally {
			addonsLoading = false;
		}
	}

	onMount(() => {
		void loadOfficeAvailability();
		void refreshAddonDetection();
	});
</script>

<!-- Office tools: one switch per device each, maturity and consent said first. -->
<section class="settings-block addons-office" aria-labelledby="addons-office-title">
	<p class="w-kicker addons-office__kicker" title={word('maturity.preview_title', PREVIEW_TITLE)}>{word('maturity.optional_addon_preview', OFFICE_KICKER)}</p>
	<h3 class="settings-block__title" id="addons-office-title">{$t('addon.office_title')}</h3>
	<p class="settings-block__hint">{$t('addon.office_hint')}</p>
	<div class="w-srows">
		{#each OFFICE_ADDON_ROWS as row (row.id)}
			{@const available = officeAvailable[row.id]}
			{@const on = $workspaceAddonEnabled[row.id]}
			<div class="w-srow addons-office__row">
				<div class="w-srow__text">
					<p class="w-srow__label">
						<span id={`addons-office-${row.id}`}>{row.name}</span>
						<span class="w-tag w-tag--mat" title={word('maturity.preview_title', PREVIEW_TITLE)}>{word('maturity.preview', 'Preview')}</span>
					</p>
					<p class="w-srow__hint" id={`addons-office-${row.id}-hint`}>{row.summary} {officeAddonState(available, on)}</p>
					<ul class="addons-office__facts" aria-label={$t('addon.office_turning_on', { values: { name: row.name } })}>
						{#each row.facts as fact (fact)}<li>{fact}</li>{/each}
					</ul>
					{#if officeError?.id === row.id}
						<p class="addon-note is-error" role="alert"><Icon name="alert" size={14} />{officeError.text}</p>
					{/if}
				</div>
				<div class="w-srow__control">
					<button
						type="button"
						class="w-switch"
						role="switch"
						aria-checked={Boolean(available) && on}
						aria-labelledby={`addons-office-${row.id}`}
						aria-describedby={`addons-office-${row.id}-hint`}
						aria-busy={officeBusy === row.id}
						disabled={!available || officeBusy !== null}
						onclick={() => void toggleOffice(row.id)}
					></button>
				</div>
			</div>
		{/each}
	</div>
	<p class="addon-note">{$t('addon.office_note')}</p>
</section>

<!-- Small tools for chat and reading. -->
<section class="settings-block addons-local" aria-labelledby="addons-local-title">
	<h3 class="settings-block__title" id="addons-local-title">{$t('addon.local_title')}</h3>
	<p class="settings-block__hint">{$t('addon.local_hint', { values: { brand: brandName } })}</p>
	<div class="addons-toolbar" role="search" aria-label={$t('addon.find')}>
		<label class="w-field w-field--chrome addons-toolbar__search">
			<Icon name="search" size={16} />
			<input
				type="search"
				bind:value={addonSearchQuery}
				placeholder={$t('addon.find')}
				aria-label={$t('addon.find')}
				autocomplete="off"
				spellcheck="false"
				data-lpignore="true"
				data-1p-ignore="true"
				data-form-type="other"
			/>
		</label>
		<Segmented label={$t('panels.show')} options={[{ value: 'all', label: $t('emoji_picker.filters.all') }, { value: 'on', label: $t('audio_settings.on') }]} bind:value={showWhich} />
		<Select ariaLabel={$t('addon.kind_label')} options={categoryOptions} value={categoryFilter} onchange={(value) => (categoryFilter = value as AddonCategoryFilter)} applied={categoryFilter !== 'all'} align="end" />
	</div>
	{#if filtering && !nothingMatches}
		<p class="addons-toolbar__count" role="status">
			{$t('addon.shown', { values: { count: visibleLocalCount + visibleServerCount } })}
			<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={clearFilters}>{$t('addon.clear')}</button>
		</p>
	{/if}
	{#if nothingMatches}
		<!-- One message for an empty search, with its way out (§7.16). -->
		<div class="w-empty addons-empty" role="status">
			<Icon name="search" />
			<p class="w-empty__title">{serverListPending ? $t('addon.no_tools') : $t('addon.no_addons')}</p>
			<p class="w-empty__text">{$t('addon.empty_text')}</p>
			<div class="w-empty__actions"><button type="button" class="w-btn w-btn--sm" onclick={clearFilters}>{$t('forum.clear_filters')}</button></div>
		</div>
	{/if}

	{#if addonView.showLocalRows}
		<div class="w-srows w-addons">
			<!-- Section instances stay mounted through empty searches so local edits survive. -->
			<ChatSection {localAddonControlMatches} />
			<SpoilersSection {localAddonControlMatches} />
			<SearchSection {localAddonControlMatches} />
			<NavigationSection {localAddonControlMatches} />
			<IdentitySection {localAddonControlMatches} />
			<NotificationsSection {localAddonControlMatches} />
			<MediaSection {localAddonControlMatches} />
			<AppearanceSection {localAddonControlMatches} />
			<UtilitiesSection {localAddonControlMatches} />
		</div>
	{/if}
</section>

<!-- What this server includes. -->
{#if showServerSection}
	<section class="settings-block addons-server" aria-labelledby="addons-server-title" aria-busy={addonsLoading}>
		<h3 class="settings-block__title" id="addons-server-title">{$t('addon.server_title')}</h3>
		<p class="settings-block__hint">{$t('addon.server_hint')}</p>
		{#if addonsError}
			<Notice title={$t('addon.list_failed_title')} text={$t('addon.list_failed_text')} onretry={refreshAddonDetection} />
		{:else if addonsLoading && !backendAddons.length && !frontendAddons.length}
			<p class="addon-note" role="status">{$t('addon.checking')}</p>
		{:else if addonView.showServerRows}
			<div class="w-srows w-addons">
				{#each visibleBackendAddons as addon (addon.id)}
					<AddonRow
						id={`server:${addon.id}`}
						label={addon.name}
						description={serverAddonDescription(addon)}
						enabled={addon.enabled}
						locked={!addon.runtimeSwitch || !canSwitchServerAddons}
						fixedWord={addon.runtimeSwitch ? (addon.enabled ? 'On' : 'Off') : undefined}
						meta={$t('addon.version', { values: { version: addon.version } })}
						onToggle={addon.runtimeSwitch && canSwitchServerAddons ? () => void toggleServerAddon(addon) : undefined}
					/>
				{/each}
				{#each visibleFrontendAddons as addon (addon.id + addon.source)}
					<AddonRow
						id={`bundled:${addon.id}`}
						label={addon.name}
						description={$t('addon.bundled_desc')}
						enabled={addon.enabled}
						locked={true}
						meta={$t('addon.version', { values: { version: addon.version } })}
					/>
				{/each}
			</div>
		{/if}
		{#if addonSwitchStatus}<p class="addon-note" role="status">{addonSwitchStatus}</p>{/if}
	</section>
{/if}
