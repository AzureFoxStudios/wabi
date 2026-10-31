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
			officeError = { id, text: `${name} wasn't turned ${next ? 'on' : 'off'}. Nothing changed on this device.` };
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
		{ value: 'all', label: 'All kinds' },
		...ADDON_SECTION_IDS.map((section) => ({ value: section, label: ADDON_SECTION_LABELS[section] })),
		{ value: 'server', label: 'On this server', group: 'Server' }
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
		if (!addon.runtimeSwitch) return 'Part of this server, fixed when the server was set up.';
		return canSwitchServerAddons
			? 'Part of this server. Switching it changes it for everyone here.'
			: 'Part of this server. Its owners and admins can turn it on or off.';
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
			addonSwitchStatus = `${addon.name} didn't change. Only owners and admins of this server can switch it.`;
			return;
		}
		backendAddons = backendAddons.map((entry) => (entry.id === addon.id ? { ...entry, enabled: result.enabled } : entry));
		addonSwitchStatus = result.appliesOnRestart
			? `${addon.name} is ${result.enabled ? 'on' : 'off'} after the server next restarts.`
			: `${addon.name} is ${result.enabled ? 'on' : 'off'}.`;
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
	<h3 class="settings-block__title" id="addons-office-title">Office tools</h3>
	<p class="settings-block__hint">An integration candidate, not a deployed feature. Each tool is off on this device until you turn it on here.</p>
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
					<ul class="addons-office__facts" aria-label={`Turning on ${row.name}`}>
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
	<p class="addon-note">Admins of this server choose whether members can share spreadsheets and decks.</p>
</section>

<!-- Small tools for chat and reading. -->
<section class="settings-block addons-local" aria-labelledby="addons-local-title">
	<h3 class="settings-block__title" id="addons-local-title">Chat and reading tools</h3>
	<p class="settings-block__hint">Small tools that change how {brandName} looks and behaves for you.</p>
	<div class="addons-toolbar" role="search" aria-label="Find an add-on">
		<label class="w-field w-field--chrome addons-toolbar__search">
			<Icon name="search" size={16} />
			<input
				type="search"
				bind:value={addonSearchQuery}
				placeholder="Find an add-on"
				aria-label="Find an add-on"
				autocomplete="off"
				spellcheck="false"
				data-lpignore="true"
				data-1p-ignore="true"
				data-form-type="other"
			/>
		</label>
		<Segmented label="Show" options={[{ value: 'all', label: 'All' }, { value: 'on', label: 'On' }]} bind:value={showWhich} />
		<Select ariaLabel="Kind of add-on" options={categoryOptions} value={categoryFilter} onchange={(value) => (categoryFilter = value as AddonCategoryFilter)} applied={categoryFilter !== 'all'} align="end" />
	</div>
	{#if filtering && !nothingMatches}
		<p class="addons-toolbar__count" role="status">
			{visibleLocalCount + visibleServerCount} shown
			<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={clearFilters}>Clear</button>
		</p>
	{/if}
	{#if nothingMatches}
		<!-- One message for an empty search, with its way out (§7.16). -->
		<div class="w-empty addons-empty" role="status">
			<Icon name="search" />
			<p class="w-empty__title">{serverListPending ? 'No tools match' : 'No add-ons match'}</p>
			<p class="w-empty__text">Try another word, or show every kind.</p>
			<div class="w-empty__actions"><button type="button" class="w-btn w-btn--sm" onclick={clearFilters}>Clear filters</button></div>
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
		<h3 class="settings-block__title" id="addons-server-title">Included with this server</h3>
		<p class="settings-block__hint">Built into this server and app, and the same for everyone on this server.</p>
		{#if addonsError}
			<Notice title="This server didn't list its add-ons" text="Office tools and the tools above work as they are." onretry={refreshAddonDetection} />
		{:else if addonsLoading && !backendAddons.length && !frontendAddons.length}
			<p class="addon-note" role="status">Checking this server…</p>
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
						meta={`Version ${addon.version}`}
						onToggle={addon.runtimeSwitch && canSwitchServerAddons ? () => void toggleServerAddon(addon) : undefined}
					/>
				{/each}
				{#each visibleFrontendAddons as addon (addon.id + addon.source)}
					<AddonRow
						id={`bundled:${addon.id}`}
						label={addon.name}
						description="Comes with this app."
						enabled={addon.enabled}
						locked={true}
						meta={`Version ${addon.version}`}
					/>
				{/each}
			</div>
		{/if}
		{#if addonSwitchStatus}<p class="addon-note" role="status">{addonSwitchStatus}</p>{/if}
	</section>
{/if}
