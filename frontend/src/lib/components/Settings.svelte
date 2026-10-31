<script lang="ts">
	import { createEventDispatcher, tick } from 'svelte';
	import { openAdminSection } from '$lib/adminNavigationState';
	import type { AdminSection } from '$lib/adminNavigation';
	import { _ as t } from '$lib/i18n';
	import { currentUser, getSocket, updateProfile } from '$lib/socket';
	import { getAuthToken } from '$lib/authSession';
	import { uploadProfilePictureFile } from '$lib/profilePictureUpload';
	import { brandName } from '$lib/branding';
	import { currentSavedServer } from '$lib/savedServers';
	import { resolveServerUrl } from '$lib/serverUrl';
	import { isMobile } from '$lib/layoutStoreStates';
	import { confirmAction } from '$lib/confirm';
	import {
		PRIVACY_EXPLANATION,
		PRIVACY_LINK_HREF,
		PRIVACY_LINK_LABEL,
		privacyPopoverBody,
		privacyWords,
		type PrivacyState
	} from '$lib/privacy/privacyState';
	import BaseModal from './BaseModal.svelte';
	import Icon from './ui/Icon.svelte';
	import AvatarEditor from './AvatarEditor.svelte';
	import GamesSettingsEntry from '$lib/games/GamesSettingsEntry.svelte';
	import StorageSettings from './StorageSettings.svelte';
	import AboutSettingsTab from './settings/AboutSettingsTab.svelte';
	import AccessibilitySettingsTab from './settings/AccessibilitySettingsTab.svelte';
	import AddonSettingsTab from './settings/AddonSettingsTab.svelte';
	import AdminSettingsTab from './settings/AdminSettingsTab.svelte';
	import AppearanceSettingsTab from './settings/AppearanceSettingsTab.svelte';
	import AudioSettingsTab from './settings/AudioSettingsTab.svelte';
	import EmojiSettingsTab from './settings/EmojiSettingsTab.svelte';
	import NotificationsSettingsTab from './settings/NotificationsSettingsTab.svelte';
	import ProfileSettingsTab from './settings/ProfileSettingsTab.svelte';
	import ServerSettingsTab from './settings/ServerSettingsTab.svelte';
	import {
		FOOT_PAGE,
		SETTINGS_PAGES,
		resolveSettingsRequest,
		searchSettings,
		settingsNavGroups,
		settingsScopeNote,
		settingsTabOrder,
		type SettingsPage,
		type SettingsRequest,
		type SettingsSearchResult,
		type SettingsTab
	} from './settings/settingsFrame';
	import PaymentConnectionsModal from '$lib/payments/PaymentConnectionsModal.svelte';
	import PaymentHistoryModal from '$lib/payments/PaymentHistoryModal.svelte';
	import PaymentSheet from '$lib/payments/PaymentSheet.svelte';
	import ServerDonationModal from '$lib/payments/ServerDonationModal.svelte';

	export let isOpen = false;
	export let requestedPaymentSurface: 'connections' | null = null;
	export let requestedTab: SettingsRequest | null = null;
	export let requestedPasswordChangeRequest = 0;

	interface DonationPrefillPayload {
		amountInput: string;
		providerPluginId: string;
		methodId: string;
		currency: string;
		countryCode: string | null;
		description: string;
		metadata: Record<string, unknown>;
	}

	const dispatch = createEventDispatcher<{ logout: void }>();

	/** The three states a member can meet, in the order a new DM moves through them. */
	const PRIVACY_STATE_ROWS: PrivacyState[] = ['server-readable', 'encryption-pending', 'experimental-encryption'];

	let activeSettingsTab: SettingsTab = 'profile';
	/** Phones are list-first: the page list, or one page pushed over it with a back chevron. */
	let phonePageOpen = false;
	let lastHandledRequestedTab: SettingsRequest | null = null;
	let lastHandledRequestedPaymentSurface: 'connections' | null = null;
	let lastHandledRequestedPasswordChangeRequest = 0;
	let showAvatarEditor = false;
	let selectedAvatarFile: File | null = null;
	let paymentConnectionsOpen = false;
	let paymentHistoryOpen = false;
	let serverDonationOpen = false;
	let profilePaymentSheetOpen = false;
	let profilePaymentSheetOpenSeed = 0;
	let profilePaymentSheetInitialAmountInput: string | null = null;
	let profilePaymentSheetInitialCurrency: string | null = null;
	let profilePaymentSheetInitialCountryCode: string | null = null;
	let profilePaymentSheetInitialDescription: string | null = null;
	let profilePaymentSheetInitialCustomerRef: string | null = null;
	let profilePaymentSheetInitialProviderId: string | null = null;
	let profilePaymentSheetInitialMethodId: string | null = null;
	let profilePaymentSheetInitialMetadata: Record<string, unknown> | null = null;
	let avatarUploadStatus = '';
	let avatarUploadError = '';

	// "Search settings"
	let searchQuery = '';
	let searchOpen = false;
	let searchActive = 0;
	let searchInput: HTMLInputElement | null = null;
	let contentEl: HTMLElement | null = null;
	const tabButtons: Record<string, HTMLButtonElement | null> = {};

	$: canManageAdmin = $currentUser?.highestRole === 'owner' || $currentUser?.highestRole === 'admin';
	$: communityName = $currentSavedServer?.effectiveName || serverHostLabel();
	$: navGroups = settingsNavGroups(communityName, canManageAdmin);
	$: tabOrder = settingsTabOrder(canManageAdmin);
	$: activePage = SETTINGS_PAGES[activeSettingsTab];
	$: scopeNote = settingsScopeNote(activeSettingsTab, communityName);
	$: searchResults = searchSettings(searchQuery, canManageAdmin);
	$: if (searchActive >= searchResults.length) searchActive = 0;
	$: showResults = searchOpen && searchQuery.trim().length > 0;
	$: if (!canManageAdmin && activeSettingsTab === 'admin') {
		activeSettingsTab = 'profile';
	}
	$: if (!isOpen) {
		lastHandledRequestedPaymentSurface = null;
		lastHandledRequestedTab = null;
		phonePageOpen = false;
		searchQuery = '';
		searchOpen = false;
	}
	$: if (isOpen && requestedTab && lastHandledRequestedTab !== requestedTab) {
		const target = resolveSettingsRequest(requestedTab);
		if (target) {
			activeSettingsTab = target;
			phonePageOpen = true;
		}
		lastHandledRequestedTab = requestedTab;
	}
	$: if (
		isOpen &&
		requestedPaymentSurface === 'connections' &&
		lastHandledRequestedPaymentSurface !== requestedPaymentSurface
	) {
		paymentConnectionsOpen = true;
		lastHandledRequestedPaymentSurface = requestedPaymentSurface;
	}
	$: if (isOpen && requestedPasswordChangeRequest > lastHandledRequestedPasswordChangeRequest) {
		lastHandledRequestedPasswordChangeRequest = requestedPasswordChangeRequest;
		activeSettingsTab = 'profile';
		phonePageOpen = true;
	}

	function serverHostLabel(): string {
		try {
			return new URL(resolveServerUrl().url).hostname;
		} catch {
			return brandName;
		}
	}

	/** The page's translated label (falls back to English); `translate` is passed in so the
	 *  template re-renders when the language changes. */
	function pageLabel(page: SettingsPage, translate: (key: string) => string): string {
		const translated = translate(page.labelKey);
		return translated && translated !== page.labelKey ? translated : page.label;
	}

	function closeModal(): void {
		isOpen = false;
	}

	function selectTab(tab: SettingsTab, focus = false): void {
		activeSettingsTab = tab;
		phonePageOpen = true;
		if (contentEl) contentEl.scrollTop = 0;
		if (focus) void tick().then(() => tabButtons[tab]?.focus());
	}

	/** Vertical tablist: ↑/↓ move and open (wrapping), Home/End jump. */
	function handleTabKeydown(event: KeyboardEvent, tab: SettingsTab): void {
		const index = tabOrder.indexOf(tab);
		let next = -1;
		if (event.key === 'ArrowDown') next = (index + 1) % tabOrder.length;
		else if (event.key === 'ArrowUp') next = (index - 1 + tabOrder.length) % tabOrder.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = tabOrder.length - 1;
		else return;
		event.preventDefault();
		selectTab(tabOrder[next], true);
	}

	function backToList(): void {
		phonePageOpen = false;
		void tick().then(() => tabButtons[activeSettingsTab]?.focus());
	}

	async function handleSignOut(): Promise<void> {
		const confirmed = await confirmAction({
			title: 'Sign out?',
			body: `This device will no longer be signed in to ${communityName}.`,
			confirm: 'Sign out'
		});
		if (!confirmed) return;
		closeModal();
		dispatch('logout');
	}

	// ---------------------------------------------------------------- search
	function openSearchResult(result: SettingsSearchResult): void {
		searchOpen = false;
		searchQuery = '';
		selectTab(result.tab);
		void revealSetting(result.label);
	}

	/** After the page renders, scroll to the row with this label and mark it briefly. */
	async function revealSetting(label: string): Promise<void> {
		await tick();
		await new Promise((resolve) => requestAnimationFrame(resolve));
		const root = contentEl;
		if (!root) return;
		const wanted = label.trim().toLowerCase();
		const candidates = root.querySelectorAll<HTMLElement>(
			'.w-srow__label, .setting-label, h3, h4, legend, .settings-section-title'
		);
		const match = Array.from(candidates).find((node) => (node.textContent ?? '').trim().toLowerCase().startsWith(wanted));
		if (!match) return;
		const row = match.closest<HTMLElement>('.w-srow, .setting-item, .setting-item-full, section, .settings-section') ?? match;
		row.scrollIntoView({ block: 'center' });
		row.classList.remove('settings-found');
		void row.offsetWidth;
		row.classList.add('settings-found');
		window.setTimeout(() => row.classList.remove('settings-found'), 1700);
		const control = row.querySelector<HTMLElement>('button, input, select, textarea, [tabindex="0"]');
		control?.focus({ preventScroll: true });
	}

	function handleSearchKeydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			if (!searchResults.length) return;
			event.preventDefault();
			searchOpen = true;
			const step = event.key === 'ArrowDown' ? 1 : -1;
			searchActive = (searchActive + step + searchResults.length) % searchResults.length;
		} else if (event.key === 'Enter') {
			const result = searchResults[searchActive];
			if (!result) return;
			event.preventDefault();
			openSearchResult(result);
		} else if (event.key === 'Escape' && (searchOpen || searchQuery)) {
			// Clear the search first; a second Escape closes Settings.
			event.preventDefault();
			event.stopPropagation();
			searchQuery = '';
			searchOpen = false;
		}
	}

	/** "/" focuses the search field unless you are typing somewhere. */
	function handleFrameKeydown(event: KeyboardEvent): void {
		if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
		event.preventDefault();
		searchInput?.focus();
	}

	function openAdminDashboard(event?: CustomEvent<{ section?: AdminSection }>): void {
		closeModal();
		openAdminSection(event?.detail?.section ?? 'overview');
	}

	function openPaymentConnections(): void {
		const token = getAuthToken();
		if (!token || !$currentUser?.dbUserId) {
			void confirmAction({ title: 'Sign in first', body: 'Sign in with a registered account to manage saved payment references.', confirm: 'Got it', cancel: null });
			return;
		}
		paymentConnectionsOpen = true;
	}

	function openPaymentHistory(): void {
		const token = getAuthToken();
		if (!token || !$currentUser?.dbUserId) {
			void confirmAction({ title: 'Sign in first', body: 'Sign in with a registered account to view your payment history.', confirm: 'Got it', cancel: null });
			return;
		}
		paymentHistoryOpen = true;
	}

	function openServerDonation(): void {
		serverDonationOpen = true;
	}

	function setPaymentSheetPrefill(options: {
		amountInput?: string | null;
		currency?: string | null;
		countryCode?: string | null;
		description?: string | null;
		customerRef?: string | null;
		providerId?: string | null;
		methodId?: string | null;
		metadata?: Record<string, unknown> | null;
	} = {}): void {
		profilePaymentSheetInitialAmountInput = options.amountInput ?? null;
		profilePaymentSheetInitialCurrency = options.currency ?? null;
		profilePaymentSheetInitialCountryCode = options.countryCode ?? null;
		profilePaymentSheetInitialDescription = options.description ?? null;
		profilePaymentSheetInitialCustomerRef = options.customerRef ?? null;
		profilePaymentSheetInitialProviderId = options.providerId ?? null;
		profilePaymentSheetInitialMethodId = options.methodId ?? null;
		profilePaymentSheetInitialMetadata = options.metadata ?? null;
	}

	function openProfilePaymentSheet(options: Parameters<typeof setPaymentSheetPrefill>[0] = {}): void {
		const token = getAuthToken();
		if (!token || !$currentUser?.dbUserId) {
			void confirmAction({ title: 'Sign in first', body: 'Sign in with a registered account to create payment requests.', confirm: 'Got it', cancel: null });
			return;
		}
		setPaymentSheetPrefill({
			amountInput: '100.00',
			currency: null,
			countryCode: null,
			description: '',
			customerRef: '',
			providerId: null,
			methodId: null,
			metadata: null,
			...options
		});
		profilePaymentSheetOpenSeed += 1;
		profilePaymentSheetOpen = true;
	}

	function handleDonationPrefill(payload: DonationPrefillPayload): void {
		serverDonationOpen = false;
		openProfilePaymentSheet({
			amountInput: payload.amountInput,
			currency: payload.currency,
			countryCode: payload.countryCode,
			description: payload.description,
			providerId: payload.providerPluginId,
			methodId: payload.methodId,
			metadata: payload.metadata
		});
	}

	function handleAvatarSelected(event: CustomEvent<{ file: File; dataUrl: string }>): void {
		selectedAvatarFile = event.detail.file;
		avatarUploadStatus = 'Uploading avatar…';
		avatarUploadError = '';
		void uploadProfilePicture();
	}

	async function uploadProfilePicture(): Promise<void> {
		if (!selectedAvatarFile) {
			avatarUploadError = 'Choose an image to upload.';
			avatarUploadStatus = '';
			return;
		}
		if (!getSocket()) {
			avatarUploadError = 'Not connected. Reconnect before updating your profile picture.';
			avatarUploadStatus = '';
			return;
		}

		try {
			const uploadedProfilePictureUrl = await uploadProfilePictureFile(selectedAvatarFile);
			await updateProfile({ profilePicture: uploadedProfilePictureUrl });
			currentUser.update((user) => user ? { ...user, profilePicture: uploadedProfilePictureUrl } : user);
			avatarUploadStatus = 'Avatar updated and synced.';
		} catch (error) {
			console.error('Error uploading profile picture:', error);
			avatarUploadError = error instanceof Error ? error.message : 'Failed to upload profile picture. Please try again.';
			avatarUploadStatus = '';
		} finally {
			selectedAvatarFile = null;
		}
	}

</script>

<BaseModal
	{isOpen}
	onClose={closeModal}
	size="settings"
	overlayZIndex="var(--z-settings-shell)"
	ariaLabel={$t('settings.title')}
	showCloseButton={false}
	panelClass="wabi-settings-modal"
>
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div
		class="settings-frame"
		class:settings-frame--phone={$isMobile}
		class:settings-frame--page={$isMobile && phonePageOpen}
		on:keydown={handleFrameKeydown}
	>
		<nav class="settings-nav" aria-labelledby="settings-nav-title">
			<div class="settings-nav__head">
				<h2 class="settings-nav__title" id="settings-nav-title">{$t('settings.title')}</h2>
				{#if $isMobile}
					<button type="button" class="w-ibtn settings-close" on:click={closeModal} aria-label="Close settings">
						<Icon name="x" size={18} />
					</button>
				{/if}
			</div>
			{#if $isMobile}
				{@render searchField('phone')}
			{/if}
			<div class="settings-nav__list" role="tablist" aria-orientation="vertical" aria-labelledby="settings-nav-title">
				{#each navGroups as group (group.id)}
					{#if group.pages.length}
						<div class="settings-nav__kicker w-kicker" id="settings-group-{group.id}">{group.label}</div>
						{#each group.pages as page (page.id)}
							{@render navItem(page)}
						{/each}
					{/if}
				{/each}
				<div class="settings-nav__foot">
					{@render navItem(FOOT_PAGE)}
				</div>
			</div>
			<button type="button" class="settings-tab settings-signout" on:click={handleSignOut}>
				<Icon name="logout" size={17} />
				<span>{$t('settings.tabs.logout')}</span>
			</button>
		</nav>

		<div class="settings-main">
			<header class="settings-head">
				{#if $isMobile}
					<button type="button" class="w-ibtn settings-back" on:click={backToList} aria-label="All settings">
						<Icon name="chevLeft" size={18} />
					</button>
				{/if}
				<h2 class="settings-head__title" id="settings-page-title">
					<span class="settings-head__name">{pageLabel(activePage, $t)}</span>
					{#if scopeNote}<span class="settings-head__note">{scopeNote}</span>{/if}
				</h2>
				{#if !$isMobile}
					{@render searchField('desk')}
				{/if}
				<button type="button" class="w-ibtn settings-close" on:click={closeModal} aria-label="Close settings">
					<Icon name="x" size={18} />
				</button>
			</header>

			<div
				class="settings-content"
				id="settings-panel"
				role="tabpanel"
				aria-labelledby="settings-tab-{activeSettingsTab}"
				tabindex="-1"
				bind:this={contentEl}
			>
				{#if avatarUploadStatus || avatarUploadError}
					<div class="settings-inline-status" class:error={Boolean(avatarUploadError)} role={avatarUploadError ? 'alert' : 'status'}>
						{avatarUploadError || avatarUploadStatus}
					</div>
				{/if}
				{#if activeSettingsTab === 'profile'}
					<ProfileSettingsTab
						passwordChangeRequest={requestedPasswordChangeRequest}
						on:openAvatarEditor={() => (showAvatarEditor = true)}
						on:openPaymentHistory={openPaymentHistory}
						on:openPaymentConnections={openPaymentConnections}
						on:openServerDonation={openServerDonation}
					/>
				{:else if activeSettingsTab === 'privacy'}
					<section class="settings-block" aria-labelledby="privacy-who-reads">
						<h3 class="settings-block__title" id="privacy-who-reads">Who can read your messages</h3>
						<p class="settings-block__hint">{PRIVACY_EXPLANATION}</p>
						<div class="w-srows settings-privacy-states">
							{#each PRIVACY_STATE_ROWS as state (state)}
								{@const words = privacyWords(state)}
								<div class="w-srow w-srow--seal">
									<div class="w-srow__text">
										<p class="w-srow__label"><Icon name={words.glyph} size={14} />{words.word}</p>
										<p class="w-srow__hint">
											{privacyPopoverBody(state, { conversation: state !== 'server-readable' })}
											{#if state === 'experimental-encryption'}{words.sentence}{/if}
										</p>
									</div>
								</div>
							{/each}
						</div>
						<p class="settings-block__more">
							<a href={PRIVACY_LINK_HREF} target="_blank" rel="noopener noreferrer">{PRIVACY_LINK_LABEL}</a>
						</p>
					</section>
					<ServerSettingsTab />
				{:else if activeSettingsTab === 'games'}
					<GamesSettingsEntry />
				{:else if activeSettingsTab === 'audio'}
					<AudioSettingsTab />
				{:else if activeSettingsTab === 'notifications'}
					<NotificationsSettingsTab />
				{:else if activeSettingsTab === 'accessibility'}
					<AccessibilitySettingsTab />
				{:else if activeSettingsTab === 'appearance'}
					<AppearanceSettingsTab />
				{:else if activeSettingsTab === 'addons'}
					<AddonSettingsTab />
				{:else if activeSettingsTab === 'emojis'}
					<EmojiSettingsTab />
				{:else if activeSettingsTab === 'storage'}
					<StorageSettings />
				{:else if activeSettingsTab === 'admin'}
					<AdminSettingsTab on:openServerDonation={openServerDonation} on:openDashboard={openAdminDashboard} />
				{:else if activeSettingsTab === 'about'}
					<AboutSettingsTab />
				{/if}
			</div>
		</div>
	</div>
</BaseModal>

{#snippet navItem(page: SettingsPage)}
	{@const selected = activeSettingsTab === page.id}
	<button
		type="button"
		class="settings-tab settings-nav__item"
		id="settings-tab-{page.id}"
		role="tab"
		aria-selected={selected}
		aria-controls={selected ? 'settings-panel' : undefined}
		tabindex={selected ? 0 : -1}
		bind:this={tabButtons[page.id]}
		on:click={() => selectTab(page.id)}
		on:keydown={(event) => handleTabKeydown(event, page.id)}
	>
		<Icon name={page.icon} size={17} />
		<span>{pageLabel(page, $t)}</span>
		{#if $isMobile}<Icon name="chevRight" size={16} class="settings-nav__chev" />{/if}
	</button>
{/snippet}

{#snippet searchField(where: 'desk' | 'phone')}
	<div class="settings-search" class:settings-search--phone={where === 'phone'}>
		<label class="w-field w-field--chrome settings-search__field">
			<Icon name="search" size={16} />
			<input
				bind:this={searchInput}
				bind:value={searchQuery}
				type="text"
				role="combobox"
				aria-label="Search settings"
				aria-expanded={showResults}
				aria-controls={showResults ? 'settings-search-results' : undefined}
				aria-autocomplete="list"
				aria-activedescendant={showResults && searchResults.length ? `settings-search-option-${searchActive}` : undefined}
				placeholder="Search settings"
				autocomplete="off"
				spellcheck="false"
				on:input={() => {
					searchOpen = true;
					searchActive = 0;
				}}
				on:focus={() => (searchOpen = true)}
				on:blur={() => window.setTimeout(() => (searchOpen = false), 120)}
				on:keydown={handleSearchKeydown}
			/>
			{#if where === 'desk' && !searchQuery}<kbd class="w-kbd" aria-hidden="true">/</kbd>{/if}
		</label>
		{#if showResults}
			<div class="settings-search__pop w-pop">
				{#if searchResults.length}
					<ul class="settings-search__list" id="settings-search-results" role="listbox" aria-label="Settings">
						{#each searchResults as result, index (result.tab + result.label)}
							<li
								id="settings-search-option-{index}"
								class="settings-search__option"
								role="option"
								aria-selected={index === searchActive}
								on:mousedown|preventDefault={() => openSearchResult(result)}
								on:mouseenter={() => (searchActive = index)}
							>
								<span class="settings-search__label">{result.label}</span>
								<span class="settings-search__page">{result.pageLabel}</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="settings-search__empty" id="settings-search-results" role="status">
						Nothing in Settings matches “{searchQuery.trim()}”.
					</p>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

<AvatarEditor
	bind:isOpen={showAvatarEditor}
	overlayZIndex={'var(--z-settings-nested)'}
	on:change={handleAvatarSelected}
/>

<PaymentHistoryModal
	isOpen={paymentHistoryOpen}
	overlayZIndex={'var(--z-settings-nested)'}
	onCreatePayment={() => {
		paymentHistoryOpen = false;
		openProfilePaymentSheet();
	}}
	onClose={() => {
		paymentHistoryOpen = false;
	}}
/>

<ServerDonationModal
	isOpen={serverDonationOpen}
	overlayZIndex={'var(--z-settings-nested)'}
	onDonate={handleDonationPrefill}
	onClose={() => {
		serverDonationOpen = false;
	}}
/>

<PaymentConnectionsModal
	isOpen={paymentConnectionsOpen}
	overlayZIndex={'var(--z-settings-nested)'}
	onClose={() => {
		paymentConnectionsOpen = false;
	}}
/>

<PaymentSheet
	isOpen={profilePaymentSheetOpen}
	openSeed={profilePaymentSheetOpenSeed}
	overlayZIndex={'var(--z-settings-nested)'}
	initialAmountInput={profilePaymentSheetInitialAmountInput}
	initialCurrency={profilePaymentSheetInitialCurrency}
	initialCountryCode={profilePaymentSheetInitialCountryCode}
	initialDescription={profilePaymentSheetInitialDescription}
	initialCustomerRef={profilePaymentSheetInitialCustomerRef}
	initialProviderId={profilePaymentSheetInitialProviderId}
	initialMethodId={profilePaymentSheetInitialMethodId}
	initialMetadata={profilePaymentSheetInitialMetadata}
	onManageConnections={() => {
		profilePaymentSheetOpen = false;
		paymentConnectionsOpen = true;
	}}
	onClose={() => {
		profilePaymentSheetOpen = false;
	}}
/>
