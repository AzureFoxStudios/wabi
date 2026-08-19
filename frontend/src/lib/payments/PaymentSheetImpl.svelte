<script lang="ts">
	import PaymentSheetBody from './PaymentSheetBody.svelte';
	import { brandName } from '$lib/branding';
	import { getAuthToken } from '$lib/authSession';
	import { subscribePaymentRealtimeEvent } from '$lib/payments/paymentRealtime';
	import {
		copyPaymentText,
		createPaymentQrDataUrl,
		fetchPaymentAccessStatus,
		fetchPaymentAccountLinks,
		fetchPaymentIntentStatus,
		getQrImageSource,
		getShareablePaymentTarget,
		loadPaymentAccountRoutePreference,
		parsePaymentAmountMinor,
		savePaymentAccountRoutePreference,
		savePaymentQrImage,
		sharePaymentTarget as sharePaymentTargetAction,
		type PaymentActionResult
	} from '$lib/payments/paymentSheetActions';
	import {
		buildRoutePresets,
		isMethodEligibleForDraft,
		isRecord,
		normalizeCheckoutMode,
		normalizePrefillValue,
		normalizeProviderOptions,
		reconcileProviderOption,
		type RoutePreset
	} from '$lib/payments/paymentSheetHelpers';
	import {
		getCurrentPaymentRouteKey,
		getPreferredPaymentProviderId,
		readPreferredPaymentRouteKey,
		resolvePreferredPaymentRoutePreset,
		writePreferredPaymentRouteKey
	} from '$lib/payments/paymentSheetRouting';
	import {
		createPaymentIntent,
		listPaymentProviders,
		type PaymentAccountLink,
		type PaymentAccessActorStatus,
		type PaymentEvent,
		type PaymentIntent,
		type PaymentIntentStatus,
		type PaymentMethodCapability,
		type PaymentProviderCapability
	} from '$lib/api';

	let {
		isOpen = false,
		onClose,
		onManageConnections,
		defaultChannelId = null,
		defaultTargetLabel = null,
		defaultTargetKind = null,
		openSeed = 0,
		initialAmountInput = null,
		initialCurrency = null,
		initialCountryCode = null,
		initialDescription = null,
		initialCustomerRef = null,
		initialProviderId = null,
		initialMethodId = null,
		initialMetadata = null,
		overlayZIndex = null
	}: {
		isOpen?: boolean;
		onClose?: () => void;
		onManageConnections?: () => void;
		defaultChannelId?: string | null;
		defaultTargetLabel?: string | null;
		defaultTargetKind?: 'channel' | 'dm' | 'group' | 'workspace' | null;
		openSeed?: number;
		initialAmountInput?: string | null;
		initialCurrency?: string | null;
		initialCountryCode?: string | null;
		initialDescription?: string | null;
		initialCustomerRef?: string | null;
		initialProviderId?: string | null;
		initialMethodId?: string | null;
		initialMetadata?: Record<string, unknown> | null;
		overlayZIndex?: number | string | null;
	} = $props();

	let loadingProviders = $state(false);
	let providersLoaded = $state(false);
	let providersError = $state('');
	let providers = $state<PaymentProviderCapability[]>([]);
	let selectedProviderId = $state('');
	let selectedMethodId = $state('');
	let amountInput = $state('100.00');
	let currency = $state('');
	let countryCode = $state('');
	let channelId = $state('');
	let description = $state('');
	let customerRef = $state('');
	let showCustomCustomerRef = $state(false);
	let showOptionalNote = $state(false);
	let showAdvancedRouting = $state(false);
	let requestMetadata = $state<Record<string, unknown> | null>(null);
	let creatingIntent = $state(false);
	let actionError = $state('');
	let actionInfo = $state('');
	let activeIntent = $state<PaymentIntent | null>(null);
	let activeEvents = $state<PaymentEvent[]>([]);
	let pollingHandle = $state<number | null>(null);
	let qrDataUrl = $state('');
	let accessLoading = $state(false);
	let accessStatus = $state<PaymentAccessActorStatus | null>(null);
	let paymentAccountLinks = $state<PaymentAccountLink[]>([]);
	let accountLinksLoaded = $state(false);
	let accountLinksLoading = $state(false);
	let lastAppliedOpenSeed = $state(-1);
	let accountPreferredRouteKey = $state('');
	let accountRoutePreferenceLoaded = $state(false);
	let accountRoutePreferenceLoading = $state(false);

	const terminalStatuses = new Set<PaymentIntentStatus>([
		'succeeded',
		'failed',
		'expired',
		'refunded',
		'disputed',
		'canceled'
	]);

	const routePresets = $derived(buildRoutePresets(providers));
	const selectedProvider = $derived(
		providers.find((provider) => provider.pluginId === selectedProviderId) || null
	);
	const selectedRoutePreset = $derived(
		routePresets.find((preset) => preset.key === getCurrentRouteKey()) || null
	);
	const providerMethods = $derived(selectedProvider?.methods || []);
	const providerCountryOptions = $derived(normalizeProviderOptions(selectedProvider?.countries || []));
	const providerCurrencyOptions = $derived(normalizeProviderOptions(selectedProvider?.currencies || []));
	const selectedAccountLink = $derived(
		paymentAccountLinks.find((link) => link.pluginId === selectedProviderId) || null
	);
	const isServerDonationDraft = $derived(
		Boolean(requestMetadata && requestMetadata.kind === 'server_donation')
	);
	const effectiveDraftCurrency = $derived(
		String(currency || selectedRoutePreset?.currency || selectedProvider?.currencies?.[0] || 'USD')
			.trim()
			.toUpperCase()
	);
	const eligibleProviderMethods = $derived(
		providerMethods.filter((method) =>
			isMethodEligibleForDraft(
				method,
				parsePaymentAmountMinor(amountInput, effectiveDraftCurrency),
				effectiveDraftCurrency,
				countryCode
			)
		)
	);
	const selectedMethod = $derived(
		providerMethods.find((method) => method.id === selectedMethodId) ||
			eligibleProviderMethods[0] ||
			providerMethods[0] ||
			null
	);
	const isThaiPromptPayDraft = $derived(
		selectedProvider?.pluginId === 'promptpay' && selectedMethod?.id === 'promptpay_qr'
	);
	const isThaiQrIntent = $derived(
		Boolean(activeIntent && activeIntent.pluginId === 'promptpay' && activeIntent.checkoutMode === 'qr')
	);
	const effectiveDraftCustomerRef = $derived(
		(
			showCustomCustomerRef || !selectedAccountLink
				? customerRef
				: selectedAccountLink?.providerAccountRef || ''
		).trim()
	);
	const missingRequiredThaiPromptPayReference = $derived(
		Boolean(isThaiPromptPayDraft) && !isServerDonationDraft && effectiveDraftCustomerRef.length === 0
	);
	const presentation = $derived(((activeIntent?.presentation || {}) as Record<string, unknown>) || {});
	const presentationMode = $derived(normalizeCheckoutMode(presentation.mode));

	function parseAmountMinor(value: string): number {
		return parsePaymentAmountMinor(value, effectiveDraftCurrency);
	}

	function getCurrentRouteKey(): string {
		return getCurrentPaymentRouteKey(routePresets, selectedProviderId, selectedMethodId, countryCode, currency);
	}

	function applyRoutePreset(preset: RoutePreset): void {
		applyRoutePresetInternal(preset, true);
	}

	function applyRoutePresetInternal(preset: RoutePreset, persistPreference: boolean): void {
		const currentAmount = String(amountInput || '').trim();
		const currentRouteDefault = String(selectedRoutePreset?.defaultAmountInput || '').trim();
		selectedProviderId = preset.providerId;
		selectedMethodId = preset.methodId;
		countryCode = preset.countryCode;
		currency = preset.currency;
		if (
			(!currentAmount ||
				currentAmount === currentRouteDefault ||
				currentAmount === '100.00' ||
				currentAmount === '10.00') &&
			preset.defaultAmountInput
		) {
			amountInput = preset.defaultAmountInput;
		}
		showAdvancedRouting = false;
		if (persistPreference) {
			persistPreferredRouteKey(preset.key);
			void syncPreferredRouteToAccount(preset.key);
		}
	}

	function readPreferredRouteKey(): string {
		return readPreferredPaymentRouteKey(accountPreferredRouteKey);
	}

	function persistPreferredRouteKey(routeKey: string): void {
		accountPreferredRouteKey = writePreferredPaymentRouteKey(routeKey);
	}

	function resolvePreferredRoutePreset(nextRoutePresets: RoutePreset[]): RoutePreset | null {
		return resolvePreferredPaymentRoutePreset({
			nextRoutePresets,
			currentRouteKey: getCurrentRouteKey(),
			initialProviderId,
			initialCountryCode,
			initialCurrency,
			initialMethodId,
			preferredRouteKey: readPreferredRouteKey(),
			paymentAccountLinks,
			selectedProviderId
		});
	}

	async function loadAccountRoutePreference(): Promise<void> {
		if (accountRoutePreferenceLoaded || accountRoutePreferenceLoading) return;
		accountRoutePreferenceLoading = true;
		try {
			accountPreferredRouteKey = await loadPaymentAccountRoutePreference(getAuthToken());
			accountRoutePreferenceLoaded = true;
		} finally {
			accountRoutePreferenceLoading = false;
		}
	}

	async function syncPreferredRouteToAccount(routeKey: string): Promise<void> {
		try {
			const normalized = await savePaymentAccountRoutePreference(getAuthToken(), routeKey);
			if (normalized) {
				accountPreferredRouteKey = normalized;
				accountRoutePreferenceLoaded = true;
			}
		} catch {
			// Ignore sync failures and keep the local preference.
		}
	}

	function getPreferredProviderId(): string {
		return getPreferredPaymentProviderId(initialProviderId, providers, paymentAccountLinks);
	}

	function resetDraftState(): void {
		amountInput = '100.00';
		currency = '';
		countryCode = '';
		channelId = defaultChannelId?.trim() || '';
		description = '';
		customerRef = '';
		showCustomCustomerRef = false;
		showOptionalNote = false;
		showAdvancedRouting = false;
		requestMetadata = null;
		selectedProviderId = '';
		selectedMethodId = '';
		providers = [];
		providersLoaded = false;
		providersError = '';
		resetForNewIntent();
	}

	function applyPrefillFromProps(): void {
		resetDraftState();
		const nextAmount = normalizePrefillValue(initialAmountInput);
		const nextCurrency = normalizePrefillValue(initialCurrency);
		const nextCountryCode = normalizePrefillValue(initialCountryCode);
		const nextDescription = normalizePrefillValue(initialDescription);
		const nextCustomerRef = normalizePrefillValue(initialCustomerRef);
		const nextProviderId = normalizePrefillValue(initialProviderId);
		const nextMethodId = normalizePrefillValue(initialMethodId);

		if (nextAmount !== null) amountInput = nextAmount;
		if (nextCurrency !== null) currency = nextCurrency.toUpperCase();
		if (nextCountryCode !== null) countryCode = nextCountryCode.toUpperCase();
		if (nextDescription !== null) description = nextDescription;
		if (nextCustomerRef !== null) {
			customerRef = nextCustomerRef;
			showCustomCustomerRef = nextCustomerRef.length > 0;
		}
		if (nextProviderId !== null) selectedProviderId = nextProviderId;
		if (nextMethodId !== null) selectedMethodId = nextMethodId;
		requestMetadata = isRecord(initialMetadata) ? { ...initialMetadata } : null;
	}

	function openSheetUrl(url: string): void {
		if (!url) return;
		window.open(url, '_blank', 'noopener,noreferrer');
	}

	function applyActionResult(result: PaymentActionResult): void {
		if (result.actionInfo) actionInfo = result.actionInfo;
		if (result.actionError) actionError = result.actionError;
	}

	async function copyToClipboard(text: string): Promise<void> {
		applyActionResult(await copyPaymentText(text));
	}

	async function saveQrImage(): Promise<void> {
		applyActionResult(await savePaymentQrImage(getQrImageSource(presentation, qrDataUrl), activeIntent?.intentId));
	}

	async function sharePaymentTarget(): Promise<void> {
		applyActionResult(await sharePaymentTargetAction(getShareablePaymentTarget(presentation), activeIntent));
	}

	async function loadProviders(): Promise<void> {
		loadingProviders = true;
		providersError = '';
		actionError = '';
		try {
			await loadAccountRoutePreference();
			providers = await listPaymentProviders();
			providersLoaded = true;
			if (providers.length > 0 && !selectedProviderId) {
				selectedProviderId = getPreferredProviderId();
			}
			const nextRoutePresets = buildRoutePresets(providers);
			if (nextRoutePresets.length > 0 && !getCurrentRouteKey()) {
				const matchingPreset = resolvePreferredRoutePreset(nextRoutePresets);
				if (matchingPreset) {
					applyRoutePresetInternal(matchingPreset, false);
				}
			}
		} catch (error) {
			providersError = error instanceof Error ? error.message : 'Failed to load payment providers';
		} finally {
			loadingProviders = false;
		}
	}

	async function loadPaymentAccountLinks(): Promise<void> {
		accountLinksLoading = true;
		try {
			paymentAccountLinks = await fetchPaymentAccountLinks(getAuthToken());
			accountLinksLoaded = true;
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Failed to load saved payment references';
		} finally {
			accountLinksLoading = false;
		}
	}

	async function refreshAccessStatus(): Promise<void> {
		accessLoading = true;
		try {
			accessStatus = await fetchPaymentAccessStatus(getAuthToken());
		} finally {
			accessLoading = false;
		}
	}

	function stopPolling(): void {
		if (pollingHandle != null) {
			window.clearInterval(pollingHandle);
			pollingHandle = null;
		}
	}

	function startPolling(intentId: string): void {
		stopPolling();
		pollingHandle = window.setInterval(async () => {
			await refreshIntent(intentId, true);
		}, 2500);
	}

	function resetForNewIntent(): void {
		stopPolling();
		activeIntent = null;
		activeEvents = [];
		qrDataUrl = '';
		actionError = '';
		actionInfo = '';
	}

	async function refreshIntent(intentId: string, refresh = true): Promise<void> {
		try {
			const payload = await fetchPaymentIntentStatus(getAuthToken(), intentId, refresh);
			activeIntent = payload.intent;
			activeEvents = payload.events;
			if (payload.providerRefreshError) actionInfo = `Provider refresh warning: ${payload.providerRefreshError}`;
			if (terminalStatuses.has(payload.intent.status)) stopPolling();
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Failed to refresh payment status';
			stopPolling();
		}
	}

	async function handleCreateIntent(): Promise<void> {
		actionError = '';
		actionInfo = '';
		const token = getAuthToken();
		if (!token) {
			actionError = 'You must be logged in to create a payment.';
			return;
		}
		if (accessStatus && !accessStatus.canCreate) {
			actionError = accessStatus.reason || 'Your account cannot create payments on this server.';
			return;
		}
		if (!selectedProviderId || !selectedMethodId) {
			actionError = 'No payment method is currently available for this amount and provider.';
			return;
		}
		const amountMinor = parseAmountMinor(amountInput);
		if (amountMinor <= 0) {
			actionError = 'Enter a valid amount.';
			return;
		}
		const normalizedCurrency = currency.trim().toUpperCase();
		if (!normalizedCurrency) {
			actionError = 'Select a currency first.';
			return;
		}
		const normalizedCountryCode = countryCode.trim().toUpperCase();
		if (providerCountryOptions.length > 0 && !normalizedCountryCode) {
			actionError = 'Select a country first.';
			return;
		}
		if (missingRequiredThaiPromptPayReference) {
			actionError = `Thai PromptPay requests need your own PromptPay number before ${brandName} can build the QR. Save it in Saved Payment References or enter it as a one-off number.`;
			return;
		}

		creatingIntent = true;
		try {
			if (selectedRoutePreset) {
				persistPreferredRouteKey(selectedRoutePreset.key);
				void syncPreferredRouteToAccount(selectedRoutePreset.key);
			}
			const useInlineCustomerRef = showCustomCustomerRef || !selectedAccountLink;
			const response = await createPaymentIntent(token, {
				pluginId: selectedProviderId,
				methodId: selectedMethodId,
				amountMinor,
				currency: normalizedCurrency,
				countryCode: normalizedCountryCode || undefined,
				channelId: channelId.trim() || undefined,
				description: description.trim() || undefined,
				customerRef: useInlineCustomerRef ? customerRef.trim() || undefined : undefined,
				metadata: requestMetadata || undefined
			});
			activeIntent = response.intent;
			activeEvents = response.events;
			actionInfo = 'Payment request created.';
			if (terminalStatuses.has(response.intent.status)) {
				stopPolling();
			} else {
				startPolling(response.intent.intentId);
			}
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Failed to create payment intent';
		} finally {
			creatingIntent = false;
		}
	}

	function handleClose(): void {
		stopPolling();
		onClose?.();
	}

	function handleManageConnections(): void {
		handleClose();
		onManageConnections?.();
	}

	// Realtime subscriptions (local event bus today; socket push lands with the
	// WabiDB payment projection — roadmap Phase 1).
	const unsubscribePaymentIntentRealtime = subscribePaymentRealtimeEvent('payments:intent-updated', (detail) => {
		if (!isOpen || !activeIntent || detail.intentId !== activeIntent.intentId) return;
		void refreshIntent(detail.intentId, false);
	});
	const unsubscribePaymentAccountLinksRealtime = subscribePaymentRealtimeEvent('payments:account-links-updated', () => {
		if (!isOpen) return;
		accountLinksLoaded = false;
		void loadPaymentAccountLinks();
	});
	const unsubscribePaymentAccessRealtime = subscribePaymentRealtimeEvent('payments:access-updated', () => {
		if (!isOpen) return;
		void refreshAccessStatus();
	});

	$effect(() => () => {
		stopPolling();
		unsubscribePaymentIntentRealtime();
		unsubscribePaymentAccountLinksRealtime();
		unsubscribePaymentAccessRealtime();
	});

	$effect(() => {
		if (defaultChannelId && !channelId) {
			channelId = defaultChannelId;
		}
	});

	$effect(() => {
		if (providers.length > 0 && !providers.some((provider) => provider.pluginId === selectedProviderId)) {
			selectedProviderId = getPreferredProviderId();
		}
	});

	$effect(() => {
		if (selectedProvider) {
			countryCode = reconcileProviderOption(countryCode, providerCountryOptions);
			currency = reconcileProviderOption(currency, providerCurrencyOptions);
		}
	});

	$effect(() => {
		if (
			eligibleProviderMethods.length > 0 &&
			!eligibleProviderMethods.some((method) => method.id === selectedMethodId)
		) {
			selectedMethodId = eligibleProviderMethods[0].id;
		} else if (eligibleProviderMethods.length === 0 && selectedMethodId) {
			selectedMethodId = '';
		}
	});

	$effect(() => {
		if (presentationMode === 'qr') {
			void createPaymentQrDataUrl(presentation).then((url) => {
				qrDataUrl = url;
			});
		} else {
			qrDataUrl = '';
		}
	});

	$effect(() => {
		if (isOpen && !providersLoaded) {
			void loadProviders();
		}
	});

	$effect(() => {
		if (isOpen && openSeed !== lastAppliedOpenSeed) {
			applyPrefillFromProps();
			lastAppliedOpenSeed = openSeed;
		}
	});

	$effect(() => {
		if (isOpen && !accessStatus && !accessLoading) {
			void refreshAccessStatus();
		}
	});

	$effect(() => {
		if (isOpen && !accountLinksLoaded && !accountLinksLoading) {
			void loadPaymentAccountLinks();
		}
	});

	$effect(() => {
		if (!isOpen) {
			stopPolling();
			accessStatus = null;
			accountLinksLoaded = false;
			accountRoutePreferenceLoaded = false;
			lastAppliedOpenSeed = -1;
		}
	});
</script>

<PaymentSheetBody
	{isOpen}
	onClose={handleClose}
	{overlayZIndex}
	{defaultTargetLabel}
	bind:channelId
	{loadingProviders}
	{providersLoaded}
	{providersError}
	{accessStatus}
	{providers}
	{routePresets}
	{selectedRoutePreset}
	{selectedProvider}
	{selectedMethod}
	{selectedAccountLink}
	{eligibleProviderMethods}
	{providerCurrencyOptions}
	{providerCountryOptions}
	bind:selectedProviderId
	bind:selectedMethodId
	bind:amountInput
	bind:currency
	bind:countryCode
	bind:showAdvancedRouting
	bind:showCustomCustomerRef
	bind:customerRef
	bind:showOptionalNote
	bind:description
	{accountLinksLoading}
	{isServerDonationDraft}
	{isThaiPromptPayDraft}
	{isThaiQrIntent}
	{missingRequiredThaiPromptPayReference}
	{creatingIntent}
	{actionInfo}
	{actionError}
	{activeIntent}
	{activeEvents}
	{presentation}
	{presentationMode}
	{qrDataUrl}
	{terminalStatuses}
	onLoadProviders={() => void loadProviders()}
	onApplyRoutePreset={applyRoutePreset}
	onManageConnections={handleManageConnections}
	onCreateIntent={() => void handleCreateIntent()}
	onSaveQrImage={() => void saveQrImage()}
	onSharePaymentTarget={() => void sharePaymentTarget()}
	onOpenSheetUrl={openSheetUrl}
	onCopyToClipboard={(text) => void copyToClipboard(text)}
	onRefreshIntent={(intentId, refresh) => void refreshIntent(intentId, refresh)}
	onResetForNewIntent={resetForNewIntent}
/>
