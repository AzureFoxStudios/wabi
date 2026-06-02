<script lang="ts">
	import { onDestroy } from 'svelte';
	import PaymentSheetBody from './PaymentSheetBody.svelte';
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
		cancelPaymentIntent,
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

	export let isOpen = false;
	export let onClose: () => void = () => {};
	export let onManageConnections: () => void = () => {};
	export let defaultChannelId: string | null = null;
	export let defaultTargetLabel: string | null = null;
	export let defaultTargetKind: 'channel' | 'dm' | 'group' | 'workspace' | null = null;
	export let openSeed = 0;
	export let initialAmountInput: string | null = null;
	export let initialCurrency: string | null = null;
	export let initialCountryCode: string | null = null;
	export let initialDescription: string | null = null;
	export let initialCustomerRef: string | null = null;
	export let initialProviderId: string | null = null;
	export let initialMethodId: string | null = null;
	export let initialMetadata: Record<string, unknown> | null = null;
	export let overlayZIndex: number | string | null = null;

	let loadingProviders = false;
	let providersLoaded = false;
	let providersError = '';
	let providers: PaymentProviderCapability[] = [];
	let selectedProviderId = '';
	let selectedMethodId = '';
	let amountInput = '100.00';
	let currency = '';
	let countryCode = '';
	let channelId = '';
	let description = '';
	let customerRef = '';
	let showCustomCustomerRef = false;
	let showOptionalNote = false;
	let showAdvancedRouting = false;
	let requestMetadata: Record<string, unknown> | null = null;
	let creatingIntent = false;
	let actionError = '';
	let actionInfo = '';
	let activeIntent: PaymentIntent | null = null;
	let activeEvents: PaymentEvent[] = [];
	let pollingHandle: number | null = null;
	let qrDataUrl = '';
	let accessLoading = false;
	let accessStatus: PaymentAccessActorStatus | null = null;
	let paymentAccountLinks: PaymentAccountLink[] = [];
	let accountLinksLoaded = false;
	let accountLinksLoading = false;
	let lastAppliedOpenSeed = -1;
	let accountPreferredRouteKey = '';
	let accountRoutePreferenceLoaded = false;
	let accountRoutePreferenceLoading = false;

	const terminalStatuses = new Set<PaymentIntentStatus>([
		'succeeded',
		'failed',
		'expired',
		'refunded',
		'disputed',
		'canceled'
	]);
	$: if (defaultChannelId && !channelId) {
		channelId = defaultChannelId;
	}

	$: routePresets = buildRoutePresets(providers);
	$: selectedProvider = providers.find((provider) => provider.pluginId === selectedProviderId) || null;
	$: selectedRoutePreset = routePresets.find((preset) => preset.key === getCurrentRouteKey()) || null;
	$: providerMethods = selectedProvider?.methods || [];
	$: providerCountryOptions = normalizeProviderOptions(selectedProvider?.countries || []);
	$: providerCurrencyOptions = normalizeProviderOptions(selectedProvider?.currencies || []);
	$: selectedAccountLink = paymentAccountLinks.find((link) => link.pluginId === selectedProviderId) || null;
	$: isServerDonationDraft = Boolean(requestMetadata && requestMetadata.kind === 'server_donation');
	$: if (providers.length > 0 && !providers.some((provider) => provider.pluginId === selectedProviderId)) {
		selectedProviderId = getPreferredProviderId();
	}
	$: if (selectedProvider) {
		countryCode = reconcileProviderOption(countryCode, providerCountryOptions);
		currency = reconcileProviderOption(currency, providerCurrencyOptions);
	}
	$: eligibleProviderMethods = providerMethods.filter((method) =>
		isMethodEligibleForDraft(method, parseAmountMinor(amountInput), currency, countryCode)
	);
	$: selectedMethod =
		providerMethods.find((method) => method.id === selectedMethodId) ||
		eligibleProviderMethods[0] ||
		providerMethods[0] ||
		null;
	$: isThaiPromptPayDraft = selectedProvider?.pluginId === 'th-payments' && selectedMethod?.id === 'promptpay_qr';
	$: isBitcoinQrDraft = selectedProvider?.pluginId === 'btc-payments' && selectedMethod?.id === 'bitcoin_qr';
	$: isThaiQrIntent = Boolean(activeIntent && activeIntent.pluginId === 'th-payments' && activeIntent.checkoutMode === 'qr');
	$: isBitcoinQrIntent = Boolean(activeIntent && activeIntent.pluginId === 'btc-payments' && activeIntent.checkoutMode === 'qr');
	$: effectiveDraftCustomerRef = (
		showCustomCustomerRef || !selectedAccountLink ? customerRef : selectedAccountLink?.providerAccountRef || ''
	).trim();
	$: missingRequiredThaiPromptPayReference =
		Boolean(isThaiPromptPayDraft) && !isServerDonationDraft && effectiveDraftCustomerRef.length === 0;
	$: missingRequiredBitcoinAddress =
		Boolean(isBitcoinQrDraft) && !isServerDonationDraft && effectiveDraftCustomerRef.length === 0;
	$: if (eligibleProviderMethods.length > 0 && !eligibleProviderMethods.some((method) => method.id === selectedMethodId)) {
		selectedMethodId = eligibleProviderMethods[0].id;
	} else if (eligibleProviderMethods.length === 0 && selectedMethodId) {
		selectedMethodId = '';
	}

	$: presentation = ((activeIntent?.presentation || {}) as Record<string, unknown>) || {};
	$: presentationMode = normalizeCheckoutMode(presentation.mode);
	$: if (presentationMode === 'qr') {
		void updateQrDataUrl();
	} else {
		qrDataUrl = '';
	}

	$: if (isOpen && !providersLoaded) {
		void loadProviders();
	}
	$: if (isOpen && openSeed !== lastAppliedOpenSeed) {
		applyPrefillFromProps();
		lastAppliedOpenSeed = openSeed;
	}
	$: if (isOpen && !accessStatus && !accessLoading) {
		void refreshAccessStatus();
	}
	$: if (isOpen && !accountLinksLoaded && !accountLinksLoading) {
		void loadPaymentAccountLinks();
	}

	$: if (!isOpen) {
		stopPolling();
		accessStatus = null;
		accountLinksLoaded = false;
		accountRoutePreferenceLoaded = false;
		lastAppliedOpenSeed = -1;
	}

	onDestroy(() => {
		stopPolling();
		unsubscribePaymentIntentRealtime();
		unsubscribePaymentAccountLinksRealtime();
		unsubscribePaymentAccessRealtime();
	});

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


	function parseAmountMinor(value: string): number {
		return parsePaymentAmountMinor(value, getEffectiveDraftCurrency());
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

	function getEffectiveDraftCurrency(): string {
		return String(currency || selectedRoutePreset?.currency || selectedProvider?.currencies?.[0] || 'USD')
			.trim()
			.toUpperCase();
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

	async function updateQrDataUrl(): Promise<void> {
		qrDataUrl = await createPaymentQrDataUrl(presentation);
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
		if (missingRequiredThaiPromptPayReference || missingRequiredBitcoinAddress) {
			actionError = getMissingDirectReferenceMessage();
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
			actionInfo = response.reused
				? 'Existing payment request returned from idempotency key.'
				: 'Payment request created.';
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

	async function handleCancelIntent(): Promise<void> {
		if (!activeIntent) return;
		actionError = '';
		actionInfo = '';
		const token = getAuthToken();
		if (!token) {
			actionError = 'You must be logged in to cancel a payment.';
			return;
		}

		try {
			const canceled = await cancelPaymentIntent(token, activeIntent.intentId, 'Canceled from payment sheet');
			activeIntent = canceled.intent;
			activeEvents = canceled.events;
			actionInfo = 'Payment intent canceled.';
			if (terminalStatuses.has(canceled.intent.status)) {
				stopPolling();
			}
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Failed to cancel payment intent';
		}
	}

	function handleClose(): void {
		stopPolling();
		onClose();
	}

	function handleManageConnections(): void {
		handleClose();
		onManageConnections();
	}

	function getMissingDirectReferenceMessage(): string {
		if (isThaiPromptPayDraft) {
			return 'Thai PromptPay requests need your own PromptPay number before Wabi can build the QR. Save it in Saved Payment References or enter it as a one-off number.';
		}
		if (isBitcoinQrDraft) {
			return 'Bitcoin QR requests need your own Bitcoin address before Wabi can build the QR. Save it in Saved Payment References or enter it as a one-off address.';
		}
		return 'A saved payment reference is required for this request.';
	}

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
	{isBitcoinQrDraft}
	{isThaiQrIntent}
	{isBitcoinQrIntent}
	{missingRequiredThaiPromptPayReference}
	{missingRequiredBitcoinAddress}
	{creatingIntent}
	{actionInfo}
	{actionError}
	{activeIntent}
	{activeEvents}
	{presentation}
	{presentationMode}
	{qrDataUrl}
	{terminalStatuses}
	onLoadProviders={loadProviders}
	onApplyRoutePreset={applyRoutePreset}
	onManageConnections={handleManageConnections}
	onCreateIntent={handleCreateIntent}
	onSaveQrImage={saveQrImage}
	onSharePaymentTarget={sharePaymentTarget}
	onOpenSheetUrl={openSheetUrl}
	onCopyToClipboard={copyToClipboard}
	onRefreshIntent={refreshIntent}
	onCancelIntent={handleCancelIntent}
	onResetForNewIntent={resetForNewIntent}
/>
