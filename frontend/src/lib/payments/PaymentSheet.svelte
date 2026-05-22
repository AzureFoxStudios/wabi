<script lang="ts">
	import { onDestroy } from 'svelte';
	import QRCode from 'qrcode';
	import BaseModal from '../components/BaseModal.svelte';
	import { getAuthToken } from '$lib/authSession';
	import { subscribePaymentRealtimeEvent } from '$lib/payments/paymentRealtime';
	import { formatMinorAmount, parseMajorAmountInput } from '$lib/payments/paymentAmounts';
	import {
		getPaymentIntentStatusHelp,
		getPaymentIntentStatusLabel,
		getPaymentVerificationMode
	} from '$lib/payments/paymentRequestPresentation';
	import {
		cancelPaymentIntent,
		createPaymentIntent,
		getPaymentAccess,
		getPaymentIntent,
		getUserSettings,
		listPaymentAccountLinks,
		listPaymentProviders,
		saveUserSettings,
		type PaymentCheckoutMode,
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
	const euroPresetCountries = ['DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'AT', 'IE', 'PT', 'FI', 'LU'];
	const PAYMENT_ROUTE_PREFERENCE_KEY = 'wabi.payment.preferred-route';

	type RoutePreset = {
		key: string;
		label: string;
		flag: string;
		providerId: string;
		methodId: string;
		countryCode: string;
		currency: string;
		defaultAmountInput?: string;
	};

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

	function normalizeCheckoutMode(value: unknown): PaymentCheckoutMode | null {
		if (
			value === 'qr' ||
			value === 'payment_link' ||
			value === 'app_switch' ||
			value === 'redirect' ||
			value === 'tap_to_pay'
		) {
			return value;
		}
		return null;
	}

	function parseAmountMinor(value: string): number {
		return parseMajorAmountInput(value, getEffectiveDraftCurrency());
	}

	function normalizePrefillValue(value: string | null): string | null {
		if (typeof value !== 'string') return null;
		return value.trim();
	}

	function normalizeProviderOptions(values: string[]): string[] {
		const seen = new Set<string>();
		const normalized: string[] = [];
		for (const value of values) {
			const upper = String(value || '').trim().toUpperCase();
			if (!upper || seen.has(upper)) continue;
			seen.add(upper);
			normalized.push(upper);
		}
		return normalized;
	}

	function getPreferredMethodId(provider: PaymentProviderCapability): string {
		if (provider.pluginId === 'th-payments') {
			const promptPayMethod = provider.methods.find((method) => method.id === 'promptpay_qr');
			if (promptPayMethod) {
				return promptPayMethod.id;
			}
		}
		const cardMethod = provider.methods.find((method) => method.id === 'card_checkout');
		if (cardMethod) {
			return cardMethod.id;
		}
		return provider.methods[0]?.id || '';
	}

	function buildRoutePresets(inputProviders: PaymentProviderCapability[]): RoutePreset[] {
		const presets: RoutePreset[] = [];
		const thaiProvider = inputProviders.find((provider) => provider.pluginId === 'th-payments');
		if (thaiProvider) {
			const methodId = getPreferredMethodId(thaiProvider);
			if (methodId) {
				presets.push({
					key: 'TH',
					label: 'Thailand',
					flag: '🇹🇭',
					providerId: thaiProvider.pluginId,
					methodId,
					countryCode: 'TH',
					currency: 'THB',
					defaultAmountInput: '100.00'
				});
			}
		}

		const westernProvider = inputProviders.find((provider) => provider.pluginId === 'western-payments');
		if (westernProvider) {
			const methodId = getPreferredMethodId(westernProvider);
			if (methodId) {
				if (westernProvider.countries.includes('US') && westernProvider.currencies.includes('USD')) {
					presets.push({
						key: 'US',
						label: 'United States',
						flag: '🇺🇸',
						providerId: westernProvider.pluginId,
						methodId,
						countryCode: 'US',
						currency: 'USD',
						defaultAmountInput: '10.00'
					});
				}
				if (westernProvider.countries.includes('CA') && westernProvider.currencies.includes('CAD')) {
					presets.push({
						key: 'CA',
						label: 'Canada',
						flag: '🇨🇦',
						providerId: westernProvider.pluginId,
						methodId,
						countryCode: 'CA',
						currency: 'CAD',
						defaultAmountInput: '10.00'
					});
				}
				if (westernProvider.countries.includes('GB') && westernProvider.currencies.includes('GBP')) {
					presets.push({
						key: 'GB',
						label: 'United Kingdom',
						flag: '🇬🇧',
						providerId: westernProvider.pluginId,
						methodId,
						countryCode: 'GB',
						currency: 'GBP',
						defaultAmountInput: '10.00'
					});
				}
				if (
					euroPresetCountries.some((country) => westernProvider.countries.includes(country)) &&
					westernProvider.currencies.includes('EUR')
				) {
					presets.push({
						key: 'EU',
						label: 'Euro Area',
						flag: '🇪🇺',
						providerId: westernProvider.pluginId,
						methodId,
						countryCode: 'DE',
						currency: 'EUR',
						defaultAmountInput: '10.00'
					});
				}
			}
		}

		const btcProvider = inputProviders.find((provider) => provider.pluginId === 'btc-payments');
		if (btcProvider) {
			const bitcoinMethod = btcProvider.methods.find((method) => method.id === 'bitcoin_qr');
			if (bitcoinMethod) {
				presets.push({
					key: 'BTC',
					label: 'Bitcoin',
					flag: '₿',
					providerId: btcProvider.pluginId,
					methodId: bitcoinMethod.id,
					countryCode: '',
					currency: 'BTC',
					defaultAmountInput: '0.001'
				});
			}
			const lightningMethod = btcProvider.methods.find((method) => method.id === 'lightning_checkout');
			if (lightningMethod) {
				presets.push({
					key: 'LIGHTNING',
					label: 'Lightning',
					flag: '⚡',
					providerId: btcProvider.pluginId,
					methodId: lightningMethod.id,
					countryCode: '',
					currency: 'BTC',
					defaultAmountInput: '0.0001'
				});
			}
		}

		return presets;
	}

	function getCurrentRouteKey(): string {
		const normalizedCountry = String(countryCode || '').trim().toUpperCase();
		const normalizedCurrency = String(currency || '').trim().toUpperCase();
		return (
			routePresets.find(
				(preset) =>
					preset.providerId === selectedProviderId &&
					preset.methodId === selectedMethodId &&
					preset.countryCode === normalizedCountry &&
					preset.currency === normalizedCurrency
			)?.key || ''
		);
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
		if (accountPreferredRouteKey) {
			return accountPreferredRouteKey;
		}
		if (typeof localStorage === 'undefined') return '';
		try {
			return String(localStorage.getItem(PAYMENT_ROUTE_PREFERENCE_KEY) || '').trim().toUpperCase();
		} catch {
			return '';
		}
	}

	function persistPreferredRouteKey(routeKey: string): void {
		const normalized = String(routeKey || '').trim().toUpperCase();
		accountPreferredRouteKey = normalized;
		if (typeof localStorage === 'undefined') return;
		try {
			if (!normalized) {
				localStorage.removeItem(PAYMENT_ROUTE_PREFERENCE_KEY);
				return;
			}
			localStorage.setItem(PAYMENT_ROUTE_PREFERENCE_KEY, normalized);
		} catch {
			// Ignore local preference persistence failures.
		}
	}

	function getBrowserPreferredRouteKey(): string {
		if (typeof navigator === 'undefined') return '';
		const localeCandidates = [...(navigator.languages || []), navigator.language]
			.map((value) => String(value || '').trim())
			.filter(Boolean);
		for (const locale of localeCandidates) {
			const match = locale.match(/[-_](TH|US|CA|GB|DE|FR|ES|IT|NL|BE|AT|IE|PT|FI|LU)\b/i);
			if (!match) continue;
			const region = match[1].toUpperCase();
			if (region === 'TH' || region === 'US' || region === 'CA' || region === 'GB') {
				return region;
			}
			if (euroPresetCountries.includes(region)) {
				return 'EU';
			}
		}
		return '';
	}

	function resolvePreferredRoutePreset(nextRoutePresets: RoutePreset[]): RoutePreset | null {
		if (nextRoutePresets.length === 0) return null;

		const currentRouteKey = getCurrentRouteKey();
		if (currentRouteKey) {
			const currentPreset = nextRoutePresets.find((preset) => preset.key === currentRouteKey);
			if (currentPreset) {
				return currentPreset;
			}
		}

		const requestedProviderId = normalizePrefillValue(initialProviderId);
		const requestedCountryCode = normalizePrefillValue(initialCountryCode)?.toUpperCase() || '';
		const requestedCurrency = normalizePrefillValue(initialCurrency)?.toUpperCase() || '';
		const requestedMethodId = normalizePrefillValue(initialMethodId);
		const explicitPreset = nextRoutePresets.find(
			(preset) =>
				(!requestedProviderId || preset.providerId === requestedProviderId) &&
				(!requestedMethodId || preset.methodId === requestedMethodId) &&
				(!requestedCountryCode || preset.countryCode === requestedCountryCode) &&
				(!requestedCurrency || preset.currency === requestedCurrency)
		);
		if (explicitPreset) {
			return explicitPreset;
		}

		const preferredRouteKey = readPreferredRouteKey();
		if (preferredRouteKey) {
			const preferredPreset = nextRoutePresets.find((preset) => preset.key === preferredRouteKey);
			if (preferredPreset) {
				return preferredPreset;
			}
		}

		const browserPreferredRouteKey = getBrowserPreferredRouteKey();
		if (browserPreferredRouteKey) {
			const browserPreset = nextRoutePresets.find((preset) => preset.key === browserPreferredRouteKey);
			if (browserPreset) {
				return browserPreset;
			}
		}

		const linkedProviderPreset = nextRoutePresets.find((preset) =>
			paymentAccountLinks.some((link) => link.pluginId === preset.providerId)
		);
		if (linkedProviderPreset) {
			return linkedProviderPreset;
		}

		const selectedProviderPreset = nextRoutePresets.find((preset) => preset.providerId === selectedProviderId);
		if (selectedProviderPreset) {
			return selectedProviderPreset;
		}

		return nextRoutePresets[0] || null;
	}

	async function loadAccountRoutePreference(): Promise<void> {
		if (accountRoutePreferenceLoaded || accountRoutePreferenceLoading) return;
		const token = getAuthToken();
		if (!token) {
			accountPreferredRouteKey = '';
			accountRoutePreferenceLoaded = true;
			return;
		}
		accountRoutePreferenceLoading = true;
		try {
			const settings = await getUserSettings(token);
			accountPreferredRouteKey = String(settings?.payment_preferred_route || '').trim().toUpperCase();
			accountRoutePreferenceLoaded = true;
		} catch {
			accountPreferredRouteKey = '';
			accountRoutePreferenceLoaded = true;
		} finally {
			accountRoutePreferenceLoading = false;
		}
	}

	async function syncPreferredRouteToAccount(routeKey: string): Promise<void> {
		const normalized = String(routeKey || '').trim().toUpperCase();
		if (!normalized) return;
		const token = getAuthToken();
		if (!token) return;
		try {
			await saveUserSettings(token, { payment_preferred_route: normalized });
			accountPreferredRouteKey = normalized;
			accountRoutePreferenceLoaded = true;
		} catch {
			// Ignore sync failures and keep the local preference.
		}
	}

	function reconcileProviderOption(currentValue: string, options: string[]): string {
		const normalizedCurrent = String(currentValue || '').trim().toUpperCase();
		if (options.length === 0) {
			return normalizedCurrent;
		}
		if (normalizedCurrent && options.includes(normalizedCurrent)) {
			return normalizedCurrent;
		}
		return options[0] || '';
	}

	function isMethodEligibleForDraft(
		method: PaymentMethodCapability,
		amountMinor: number,
		draftCurrency: string,
		draftCountryCode: string
	): boolean {
		const normalizedCurrency = String(draftCurrency || '').trim().toUpperCase();
		const normalizedCountry = String(draftCountryCode || '').trim().toUpperCase();
		const methodCurrencies = normalizeProviderOptions(method.currencies || []);
		const methodCountries = normalizeProviderOptions(method.countries || []);

		if (amountMinor > 0 && typeof method.minAmountMinor === 'number' && amountMinor < method.minAmountMinor) {
			return false;
		}
		if (amountMinor > 0 && typeof method.maxAmountMinor === 'number' && amountMinor > method.maxAmountMinor) {
			return false;
		}
		if (methodCurrencies.length > 0 && normalizedCurrency && !methodCurrencies.includes(normalizedCurrency)) {
			return false;
		}
		if (methodCountries.length > 0 && normalizedCountry && !methodCountries.includes(normalizedCountry)) {
			return false;
		}
		return true;
	}

	function getPreferredProviderId(): string {
		const requestedProviderId = normalizePrefillValue(initialProviderId);
		if (requestedProviderId && providers.some((provider) => provider.pluginId === requestedProviderId)) {
			return requestedProviderId;
		}

		for (const link of paymentAccountLinks) {
			if (providers.some((provider) => provider.pluginId === link.pluginId)) {
				return link.pluginId;
			}
		}

		return providers[0]?.pluginId || '';
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

	function getPresentationString(key: string): string {
		const value = presentation[key];
		return typeof value === 'string' ? value.trim() : '';
	}

	function getShareablePaymentTarget(): string {
		return (
			getPresentationString('url') ||
			getPresentationString('deepLinkUrl') ||
			getPresentationString('fallbackUrl') ||
			getPresentationString('qrData')
		);
	}

	function getQrImageSource(): string {
		return getPresentationString('qrImageUrl') || qrDataUrl;
	}

	function getEffectiveDraftCurrency(): string {
		return String(currency || selectedRoutePreset?.currency || selectedProvider?.currencies?.[0] || 'USD')
			.trim()
			.toUpperCase();
	}

	async function copyToClipboard(text: string): Promise<void> {
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			actionInfo = 'Copied to clipboard.';
		} catch {
			actionError = 'Failed to copy to clipboard.';
		}
	}

	async function saveQrImage(): Promise<void> {
		const source = getQrImageSource();
		if (!source) {
			actionError = 'No QR image is available to save.';
			return;
		}

		const filename = `wabi-payment-${activeIntent?.intentId || 'intent'}.png`;
		const anchor = document.createElement('a');
		anchor.download = filename;

		try {
			if (source.startsWith('data:')) {
				anchor.href = source;
				anchor.click();
				actionInfo = 'QR image saved.';
				return;
			}

			const response = await fetch(source);
			if (!response.ok) {
				throw new Error('download_failed');
			}
			const blob = await response.blob();
			const objectUrl = URL.createObjectURL(blob);
			anchor.href = objectUrl;
			anchor.click();
			URL.revokeObjectURL(objectUrl);
			actionInfo = 'QR image saved.';
		} catch {
			anchor.href = source;
			anchor.target = '_blank';
			anchor.rel = 'noopener noreferrer';
			anchor.click();
			actionInfo = 'Opened QR image. Use browser save if download was blocked.';
		}
	}

	async function sharePaymentTarget(): Promise<void> {
		const target = getShareablePaymentTarget();
		if (!target) {
			actionError = 'No payment target is available to share.';
			return;
		}

		const title = 'Wabi payment request';
		const text = activeIntent
			? `Pay ${formatMinorAmount(activeIntent.amountMinor, activeIntent.currency)}`
			: 'Wabi payment request';

		const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
		if (canNativeShare) {
			try {
				await navigator.share({
					title,
					text,
					url: target
				});
				actionInfo = 'Payment request shared.';
				return;
			} catch {
				// Fall through to clipboard copy for dismissed or unsupported native share flows.
			}
		}

		await copyToClipboard(target);
		actionInfo = 'Share unavailable on this device. Copied payment target instead.';
	}

	async function updateQrDataUrl(): Promise<void> {
		const qrPayload = typeof presentation.qrData === 'string' ? presentation.qrData.trim() : '';
		if (!qrPayload) {
			qrDataUrl = '';
			return;
		}
		try {
			qrDataUrl = await QRCode.toDataURL(qrPayload, {
				errorCorrectionLevel: 'M',
				margin: 1,
				width: 360
			});
		} catch {
			qrDataUrl = '';
		}
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
		const token = getAuthToken();
		if (!token) {
			paymentAccountLinks = [];
			accountLinksLoaded = true;
			return;
		}
		accountLinksLoading = true;
		try {
			paymentAccountLinks = await listPaymentAccountLinks(token);
			accountLinksLoaded = true;
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Failed to load saved payment references';
		} finally {
			accountLinksLoading = false;
		}
	}

	async function refreshAccessStatus(): Promise<void> {
		const token = getAuthToken();
		accessLoading = true;
		try {
			const access = await getPaymentAccess(token);
			accessStatus = access.actor;
		} catch {
			accessStatus = null;
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
		const token = getAuthToken();
		if (!token) {
			actionError = 'You must be logged in to view payment status.';
			return;
		}
		try {
			const payload = await getPaymentIntent(token, intentId, {
				refresh,
				includeEvents: true,
				eventLimit: 50
			});
			activeIntent = payload.intent;
			activeEvents = payload.events;
			if (payload.providerRefreshError) {
				actionInfo = `Provider refresh warning: ${payload.providerRefreshError}`;
			}
			if (terminalStatuses.has(payload.intent.status)) {
				stopPolling();
			}
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

	function getTargetKindLabel(): string {
		if (defaultTargetKind === 'dm') return 'Direct message';
		if (defaultTargetKind === 'group') return 'Group';
		if (defaultTargetKind === 'workspace') return 'Server-wide';
		return 'Channel';
	}

	function getTargetDisplayLabel(): string {
		const explicitLabel = String(defaultTargetLabel || '').trim();
		if (explicitLabel) return explicitLabel;
		const fallbackId = String(channelId || '').trim();
		return fallbackId || 'No conversation attached';
	}

	function shouldShowProviderPicker(): boolean {
		return (routePresets.length === 0 || showAdvancedRouting) && providers.length > 1;
	}

	function shouldShowMethodPicker(): boolean {
		return (routePresets.length === 0 || showAdvancedRouting) && eligibleProviderMethods.length > 1;
	}

	function shouldShowCurrencyPicker(): boolean {
		const manualMode = routePresets.length === 0 || showAdvancedRouting;
		if (!manualMode) return false;
		return providerCurrencyOptions.length > 1 || (routePresets.length === 0 && providerCurrencyOptions.length === 0);
	}

	function shouldShowCountryPicker(): boolean {
		const manualMode = routePresets.length === 0 || showAdvancedRouting;
		if (!manualMode) return false;
		return providerCountryOptions.length > 1 || (routePresets.length === 0 && providerCountryOptions.length === 0);
	}

	function getSheetTitle(): string {
		if (isThaiQrIntent) return 'PromptPay QR';
		if (isBitcoinQrIntent) return 'Bitcoin QR';
		return 'New Payment Request';
	}

	function getSheetIntro(): string {
		if (isThaiPromptPayDraft) {
			return isServerDonationDraft
				? 'Enter the amount. Wabi will build a PromptPay donation QR for this server.'
				: 'Enter the amount. Wabi will build a PromptPay QR from your saved PromptPay number.';
		}
		if (isBitcoinQrDraft) {
			return isServerDonationDraft
				? 'Enter the amount. Wabi will build a Bitcoin donation QR for this server.'
				: 'Enter the amount. Wabi will build a Bitcoin QR from your saved Bitcoin address.';
		}
		if (isThaiQrIntent) {
			return 'Share or save the QR, then wait for confirmation.';
		}
		if (isBitcoinQrIntent) {
			return 'Share or save the QR, then wait for on-chain confirmation.';
		}
		return 'Create a non-custodial payment request. Wabi does not store cards or bank credentials and does not move the money itself.';
	}

	function getTargetHeaderLabel(): string {
		const target = String(defaultTargetLabel || '').trim();
		if (target) return target;
		if (channelId.trim()) return channelId.trim();
		return '';
	}

	function maskReference(reference: string): string {
		const trimmed = String(reference || '').trim();
		if (!trimmed) return '';
		const digits = trimmed.replace(/\D/g, '');
		if (digits.length >= 6) {
			return `${digits.slice(0, 3)}***${digits.slice(-4)}`;
		}
		if (trimmed.length <= 4) return trimmed;
		return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
	}

	function formatExpiryTimestamp(value: number | null | undefined): string | null {
		if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
		return new Date(value).toLocaleTimeString([], {
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function getCreateButtonLabel(): string {
		if (creatingIntent) {
			return isThaiPromptPayDraft || isBitcoinQrDraft ? 'Creating QR...' : 'Creating...';
		}
		return isThaiPromptPayDraft || isBitcoinQrDraft ? 'Create QR' : 'Create payment request';
	}

	function getDraftMethodBehaviorNote(): string | null {
		if (!selectedProvider || !selectedMethod) return null;
		if (selectedProvider.pluginId === 'th-payments' && selectedMethod.id === 'promptpay_qr') {
			if (isServerDonationDraft) {
				return 'PromptPay QR creates a donation request using the server donation PromptPay number. Wabi does not mark it paid just because the app returned.';
			}
			return 'PromptPay QR creates a payment request using your saved PromptPay number or a one-off PromptPay number. Wabi does not mark it paid just because the app returned.';
		}
		if (selectedProvider.pluginId === 'th-payments' && selectedMethod.id === 'psp_checkout') {
			return 'This route can become fully verified when a Thai PSP adapter is configured. Without that adapter, PromptPay QR is the safer fallback.';
		}
		if (selectedProvider.pluginId === 'btc-payments' && selectedMethod.id === 'bitcoin_qr') {
			if (isServerDonationDraft) {
				return 'Bitcoin QR creates a donation request using the server donation Bitcoin address. Wabi does not mark it paid just because a wallet opened or returned.';
			}
			return 'Bitcoin QR creates a payment request using your saved Bitcoin address or a one-off Bitcoin address. Wabi does not mark it paid just because a wallet opened or returned.';
		}
		if (selectedProvider.pluginId === 'btc-payments' && selectedMethod.id === 'lightning_checkout') {
			if (String(selectedMethod.notes || '').toLowerCase().includes('local test')) {
				return 'This server is currently using Lightning local test mode. It exercises the request flow without moving money.';
			}
			return 'Lightning can become provider-verified when a Bitcoin adapter is configured.';
		}
		if (selectedProvider.pluginId === 'western-payments' && String(selectedProvider.notes || '').toLowerCase().includes('local test')) {
			return 'This server is currently using western local test mode. It exercises the request flow without moving money.';
		}
		return null;
	}

	function isDirectReferenceDraft(): boolean {
		return isThaiPromptPayDraft || isBitcoinQrDraft;
	}

	function getDirectReferenceTitle(): string {
		if (isThaiPromptPayDraft) return 'PromptPay number';
		if (isBitcoinQrDraft) return 'Bitcoin address';
		return 'Payment reference';
	}

	function getDirectReferencePlaceholder(): string {
		if (isThaiPromptPayDraft) return 'Thai mobile number or PromptPay ID';
		if (isBitcoinQrDraft) return 'bc1... or 1... / 3...';
		return 'Payment reference';
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

	function getQrExternalConfirmationHint(): string {
		if (activeIntent?.pluginId === 'btc-payments') {
			return 'Scanning or copying this QR opens the wallet flow. Wabi keeps the request pending until it gets real confirmation or the request expires.';
		}
		return 'Scanning this QR opens the bank/payment app flow. Wabi keeps the request pending until it gets real confirmation or the request expires.';
	}
</script>

<BaseModal isOpen={isOpen} onClose={handleClose} width="680px" {overlayZIndex}>
	<div slot="header" class="sheet-header">
		<h2>{getSheetTitle()}</h2>
		{#if getTargetHeaderLabel()}
			<div class="sheet-target">{getTargetHeaderLabel()}</div>
		{/if}
		<p>{getSheetIntro()}</p>
	</div>

	<div class="sheet-body">
		{#if loadingProviders}
			<p class="hint">Loading payment providers...</p>
		{/if}

		{#if providersError}
			<p class="error">{providersError}</p>
		{/if}

		{#if accessStatus && !accessStatus.canCreate}
			<p class="error">{accessStatus.reason || 'Your account cannot create payments on this server.'}</p>
		{/if}

		{#if !loadingProviders && providers.length === 0}
			<p class="hint">
				No payment provider plugins are loaded. Enable plugins and install a payment plugin (for example
				`th-payments`).
			</p>
		{/if}

		{#if routePresets.length > 1}
			<div class="route-picker">
				<div class="route-picker-header">
					<h3>Pay with</h3>
					<button class="action subtle" type="button" on:click={() => (showAdvancedRouting = !showAdvancedRouting)}>
						{showAdvancedRouting ? 'Hide manual routing' : 'Adjust manually'}
					</button>
				</div>
				<div class="route-preset-list">
					{#each routePresets as preset}
						<button
							type="button"
							class="route-preset"
							class:active={selectedRoutePreset?.key === preset.key}
							on:click={() => applyRoutePreset(preset)}
						>
							<span class="route-flag">{preset.flag}</span>
							<span class="route-label">{preset.label}</span>
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<div class="grid">
			{#if shouldShowProviderPicker()}
				<label>
					<span>Provider</span>
					<select bind:value={selectedProviderId} disabled={providers.length === 0}>
						{#each providers as provider}
							<option value={provider.pluginId}>{provider.providerName}</option>
						{/each}
					</select>
				</label>
			{/if}

			{#if shouldShowMethodPicker()}
				<label>
					<span>Method</span>
					<select bind:value={selectedMethodId} disabled={eligibleProviderMethods.length === 0}>
						{#each eligibleProviderMethods as method}
							<option value={method.id}>{method.label}</option>
						{/each}
					</select>
				</label>
			{/if}

			<label>
				<span>Amount</span>
				<input class="amount-input" type="text" bind:value={amountInput} placeholder="100.00" />
			</label>

			{#if shouldShowCurrencyPicker()}
				<label>
					<span>Currency</span>
					{#if providerCurrencyOptions.length > 0}
						<select bind:value={currency} disabled={providerCurrencyOptions.length <= 1}>
							{#each providerCurrencyOptions as providerCurrency}
								<option value={providerCurrency}>{providerCurrency}</option>
							{/each}
						</select>
					{:else}
						<input type="text" bind:value={currency} maxlength="3" placeholder="Auto" />
					{/if}
				</label>
			{/if}

			{#if shouldShowCountryPicker()}
				<label>
					<span>Country</span>
					{#if providerCountryOptions.length > 0}
						<select bind:value={countryCode} disabled={providerCountryOptions.length <= 1}>
							{#each providerCountryOptions as providerCountry}
								<option value={providerCountry}>{providerCountry}</option>
							{/each}
						</select>
					{:else}
						<input type="text" bind:value={countryCode} maxlength="2" placeholder="Auto" />
					{/if}
				</label>
			{/if}
		</div>

		{#if !shouldShowCurrencyPicker() || !shouldShowCountryPicker() || !shouldShowMethodPicker()}
			<div class="compact-summary">
				{#if selectedProvider}
					<span>{selectedProvider.providerName}</span>
				{/if}
				{#if selectedMethod}
					<span>{selectedMethod.label}</span>
				{/if}
				{#if currency}
					<span>{currency}</span>
				{/if}
				{#if countryCode}
					<span>{countryCode}</span>
				{/if}
			</div>
		{/if}

		{#if selectedProvider?.notes && !isThaiPromptPayDraft}
			<p class="hint">{selectedProvider.notes}</p>
		{/if}

		{#if selectedMethod?.notes && !isThaiPromptPayDraft}
			<p class="hint">Method note: {selectedMethod.notes}</p>
		{/if}

		{#if getDraftMethodBehaviorNote() && !isThaiPromptPayDraft}
			<p class="hint emphasis">{getDraftMethodBehaviorNote()}</p>
		{/if}

		{#if selectedProvider && eligibleProviderMethods.length === 0}
			<p class="hint">No method is currently eligible for this amount and provider combination. Try a different amount or provider.</p>
		{/if}

		{#if isDirectReferenceDraft() && !isServerDonationDraft}
			<div class="intent-card">
				<h3>{getDirectReferenceTitle()}</h3>
				{#if accountLinksLoading}
					<p class="hint">Loading your saved {getDirectReferenceTitle().toLowerCase()}...</p>
				{:else if selectedAccountLink && !showCustomCustomerRef}
					<p class="hint">Using {maskReference(selectedAccountLink.providerAccountRef)} for this QR request.</p>
				{:else}
					<p class="hint">
						{#if isThaiPromptPayDraft}
							Enter your own PromptPay number or registered PromptPay ID for this request.
						{:else if isBitcoinQrDraft}
							Enter your own Bitcoin address for this request.
						{/if}
					</p>
				{/if}
				{#if !selectedAccountLink || showCustomCustomerRef}
					<label class="wide-field">
						<span>{getDirectReferenceTitle()}</span>
						<input
							type="text"
							bind:value={customerRef}
							maxlength="120"
							placeholder={getDirectReferencePlaceholder()}
						/>
					</label>
				{/if}
				<div class="actions">
					{#if selectedAccountLink}
						<button class="action" on:click={() => (showCustomCustomerRef = !showCustomCustomerRef)}>
							{#if isThaiPromptPayDraft}
								{showCustomCustomerRef ? 'Use saved PromptPay number' : 'Use different number'}
							{:else}
								{showCustomCustomerRef ? 'Use saved Bitcoin address' : 'Use different address'}
							{/if}
						</button>
					{/if}
					<button class="action" on:click={handleManageConnections}>
						{selectedAccountLink ? 'Edit in Saved References' : `Add ${getDirectReferenceTitle()}`}
					</button>
				</div>
			</div>
		{:else}
			<div class="intent-card">
				<h3>Saved payment reference</h3>
				{#if accountLinksLoading}
					<p class="hint">Loading your saved payment references...</p>
				{:else if selectedAccountLink}
					<p class="hint">
						Wabi will reuse
						<code>{selectedAccountLink.displayLabel || selectedAccountLink.providerAccountRef}</code>
						for this provider unless you turn on the one-off override below.
					</p>
				{:else}
					<p class="hint">
						No saved reference is attached to this provider yet. Add one in Settings only if this provider needs a reusable destination reference.
					</p>
				{/if}
				<div class="actions">
					<button class="action" on:click={handleManageConnections}>
						{selectedAccountLink ? 'Manage Saved References' : 'Add Reference in Settings'}
					</button>
				</div>
			</div>

			<div class="intent-card">
				<label class="checkbox-row">
					<input type="checkbox" bind:checked={showCustomCustomerRef} />
					<span>Use a one-off payment reference</span>
				</label>
				{#if showCustomCustomerRef}
					<label class="wide-field">
						<span>One-off payment reference</span>
						<input
							type="text"
							bind:value={customerRef}
							maxlength="120"
							placeholder="PromptPay number / wallet handle / PSP customer id"
						/>
					</label>
				{/if}
			</div>
		{/if}

		{#if !isThaiPromptPayDraft}
			<label class="checkbox-row">
				<input type="checkbox" bind:checked={showOptionalNote} />
				<span>Add a note</span>
			</label>
		{:else}
			<label class="checkbox-row">
				<input type="checkbox" bind:checked={showOptionalNote} />
				<span>Add a private note to this request</span>
			</label>
		{/if}

		{#if showOptionalNote}
			<label class="wide-field">
				<span>Note</span>
				<input type="text" bind:value={description} maxlength="200" placeholder="Optional" />
			</label>
		{/if}

		{#if missingRequiredThaiPromptPayReference || missingRequiredBitcoinAddress}
			<p class="hint emphasis">
				{getMissingDirectReferenceMessage()}
			</p>
		{/if}

		<div class="actions">
			<button class="action" on:click={loadProviders} disabled={loadingProviders}>
				Refresh providers
			</button>
			<button
				class="action primary"
				on:click={handleCreateIntent}
				disabled={creatingIntent || providers.length === 0 || Boolean(accessStatus && !accessStatus.canCreate) || missingRequiredThaiPromptPayReference || missingRequiredBitcoinAddress}
			>
				{getCreateButtonLabel()}
			</button>
		</div>

		{#if actionInfo}
			<p class="info">{actionInfo}</p>
		{/if}
		{#if actionError}
			<p class="error">{actionError}</p>
		{/if}

		{#if activeIntent}
			<div class="intent-card">
				<div class="intent-header">
					<div class="intent-heading">
						<span class="status-light status-light-{activeIntent.status}"></span>
						<h3>{isThaiQrIntent ? 'PromptPay QR' : `Request ${activeIntent.intentId}`}</h3>
					</div>
					<span class="status status-{activeIntent.status}">{getPaymentIntentStatusLabel(activeIntent)}</span>
				</div>
				<p class="intent-meta">
					{formatMinorAmount(activeIntent.amountMinor, activeIntent.currency)} via {activeIntent.providerName}
					{#if getTargetHeaderLabel()}
						• {getTargetHeaderLabel()}
					{/if}
				</p>
				{#if formatExpiryTimestamp(activeIntent.expiresAt) && !terminalStatuses.has(activeIntent.status)}
					<p class="hint">Auto-expires at {formatExpiryTimestamp(activeIntent.expiresAt)}.</p>
				{/if}
				{#if getPaymentIntentStatusHelp(activeIntent)}
					<p class="hint emphasis">{getPaymentIntentStatusHelp(activeIntent)}</p>
				{/if}
				{#if activeIntent.failureMessage}
					<p class="error">{activeIntent.failureMessage}</p>
				{/if}

				{#if presentationMode === 'qr'}
					<div class="qr-block">
						{#if typeof presentation.qrImageUrl === 'string' && presentation.qrImageUrl}
							<img src={presentation.qrImageUrl} alt="Payment QR" class="qr-image" />
						{:else if qrDataUrl}
							<img src={qrDataUrl} alt="Payment QR" class="qr-image" />
						{:else}
							<p class="hint">QR payload available, image render failed.</p>
						{/if}
						<div class="link-actions">
							<button class="action" on:click={saveQrImage} disabled={!getQrImageSource()}>Save QR</button>
							<button class="action" on:click={sharePaymentTarget}>Share payment</button>
						</div>
						{#if getPaymentVerificationMode(activeIntent) === 'external_confirmation'}
							<p class="hint emphasis">{getQrExternalConfirmationHint()}</p>
						{/if}
					</div>
				{:else if presentationMode === 'payment_link' || presentationMode === 'redirect'}
					{#if typeof presentation.url === 'string' && presentation.url}
						<div class="link-actions">
							<button class="action primary" on:click={() => openSheetUrl(String(presentation.url))}>Open checkout link</button>
							<button class="action" on:click={() => copyToClipboard(String(presentation.url))}>Copy link</button>
							<button class="action" on:click={sharePaymentTarget}>Share payment</button>
						</div>
					{/if}
				{:else if presentationMode === 'app_switch'}
					<div class="link-actions">
						{#if typeof presentation.deepLinkUrl === 'string' && presentation.deepLinkUrl}
							<button class="action primary" on:click={() => openSheetUrl(String(presentation.deepLinkUrl))}>Open payment app</button>
						{/if}
						{#if typeof presentation.fallbackUrl === 'string' && presentation.fallbackUrl}
							<button class="action" on:click={() => openSheetUrl(String(presentation.fallbackUrl))}>Open fallback link</button>
						{/if}
					</div>
				{:else if presentationMode === 'tap_to_pay'}
					<p class="hint">
						Tap-to-pay session:
						{typeof presentation.providerSessionId === 'string' ? presentation.providerSessionId : 'unknown'}
					</p>
				{/if}

				<div class="actions">
					<button class="action" on:click={() => refreshIntent(activeIntent.intentId, true)}>Refresh status</button>
					<button class="action" on:click={handleCancelIntent} disabled={terminalStatuses.has(activeIntent.status)}>
						Cancel request
					</button>
					<button class="action" on:click={resetForNewIntent}>New request</button>
				</div>

				{#if activeEvents.length > 0}
					<div class="events">
						<h4>Events</h4>
						<ul>
							{#each activeEvents as event}
								<li>
									<span>{event.eventType}</span>
									<span>{event.status || 'n/a'}</span>
									<time>{new Date(event.createdAt).toLocaleString()}</time>
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</BaseModal>

