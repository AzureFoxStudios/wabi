<script lang="ts">
	import { onDestroy } from 'svelte';
	import QRCode from 'qrcode';
	import BaseModal from './BaseModal.svelte';
	import { getAuthToken } from '$lib/authSession';
	import {
		cancelPaymentIntent,
		createPaymentIntent,
		getPaymentAccess,
		getPaymentIntent,
		listPaymentAccountLinks,
		listPaymentProviders,
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

	$: selectedProvider = providers.find((provider) => provider.pluginId === selectedProviderId) || null;
	$: providerMethods = selectedProvider?.methods || [];
	$: providerCountryOptions = normalizeProviderOptions(selectedProvider?.countries || []);
	$: providerCurrencyOptions = normalizeProviderOptions(selectedProvider?.currencies || []);
	$: selectedAccountLink = paymentAccountLinks.find((link) => link.pluginId === selectedProviderId) || null;
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
		lastAppliedOpenSeed = -1;
	}

	onDestroy(() => {
		stopPolling();
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
		const normalized = Number.parseFloat(value);
		if (!Number.isFinite(normalized) || normalized <= 0) return 0;
		return Math.round(normalized * 100);
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
			providers = await listPaymentProviders();
			providersLoaded = true;
			if (providers.length > 0 && !selectedProviderId) {
				selectedProviderId = getPreferredProviderId();
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
			actionError = error instanceof Error ? error.message : 'Failed to load linked payment accounts';
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

		creatingIntent = true;
		try {
			const response = await createPaymentIntent(token, {
				pluginId: selectedProviderId,
				methodId: selectedMethodId,
				amountMinor,
				currency: normalizedCurrency,
				countryCode: normalizedCountryCode || undefined,
				channelId: channelId.trim() || undefined,
				description: description.trim() || undefined,
				customerRef: showCustomCustomerRef ? customerRef.trim() || undefined : undefined,
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

	function formatMinorAmount(amountMinor: number, amountCurrency: string): string {
		const value = amountMinor / 100;
		try {
			return new Intl.NumberFormat(undefined, {
				style: 'currency',
				currency: amountCurrency || 'USD',
				maximumFractionDigits: 2
			}).format(value);
		} catch {
			return `${value.toFixed(2)} ${amountCurrency || ''}`.trim();
		}
	}

	function getTargetKindLabel(): string {
		if (defaultTargetKind === 'dm') return 'Direct message';
		if (defaultTargetKind === 'group') return 'Group';
		if (defaultTargetKind === 'workspace') return 'Workspace';
		return 'Channel';
	}

	function getTargetDisplayLabel(): string {
		const explicitLabel = String(defaultTargetLabel || '').trim();
		if (explicitLabel) return explicitLabel;
		const fallbackId = String(channelId || '').trim();
		return fallbackId || 'No conversation attached';
	}
</script>

<BaseModal isOpen={isOpen} onClose={handleClose} width="680px" {overlayZIndex}>
	<div slot="header" class="sheet-header">
		<h2>Payments</h2>
		<p>Create a non-custodial payment request using the providers active on this server.</p>
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

		<div class="intent-card">
			<h3>Destination</h3>
			{#if channelId || defaultTargetLabel}
				<p class="hint">This request will stay attached to the conversation that opened the payment sheet.</p>
				<div class="target-summary">
					<span class="status target-kind">{getTargetKindLabel()}</span>
					<strong>{getTargetDisplayLabel()}</strong>
					{#if channelId}
						<code>{channelId}</code>
					{/if}
				</div>
			{:else}
				<p class="hint">No conversation context was passed in. You can still create a request and share it manually.</p>
			{/if}
		</div>

		<div class="grid">
			<label>
				<span>Provider</span>
				<select bind:value={selectedProviderId} disabled={providers.length === 0}>
					{#each providers as provider}
						<option value={provider.pluginId}>{provider.providerName} ({provider.pluginId})</option>
					{/each}
				</select>
			</label>

			<label>
				<span>Method</span>
				<select bind:value={selectedMethodId} disabled={eligibleProviderMethods.length === 0}>
					{#each eligibleProviderMethods as method}
						<option value={method.id}>{method.label}</option>
					{/each}
				</select>
			</label>

			<label>
				<span>Amount</span>
				<input type="text" bind:value={amountInput} placeholder="100.00" />
			</label>

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
		</div>

		{#if selectedProvider?.notes}
			<p class="hint">{selectedProvider.notes}</p>
		{/if}

		{#if selectedMethod?.notes}
			<p class="hint">Method note: {selectedMethod.notes}</p>
		{/if}

		{#if selectedProvider && eligibleProviderMethods.length === 0}
			<p class="hint">No method is currently eligible for this amount and provider combination. Try a different amount or provider.</p>
		{/if}

		<label class="wide-field">
			<span>Description (optional)</span>
			<input type="text" bind:value={description} maxlength="200" />
		</label>

		<div class="intent-card">
			<h3>Linked account</h3>
			{#if accountLinksLoading}
				<p class="hint">Loading your saved payment connections...</p>
			{:else if selectedAccountLink}
				<p class="hint">
					Wabi will reuse
					<code>{selectedAccountLink.displayLabel || selectedAccountLink.providerAccountRef}</code>
					for this provider unless you override it below.
				</p>
			{:else}
				<p class="hint">
					No saved connection is attached to this provider yet. Add one in Settings if this provider needs a
					reusable account or wallet reference.
				</p>
			{/if}
			<div class="actions">
				<button class="action" on:click={handleManageConnections}>
					{selectedAccountLink ? 'Manage Connections' : 'Add Connection in Settings'}
				</button>
			</div>
		</div>

		<div class="intent-card">
			<label class="checkbox-row">
				<input type="checkbox" bind:checked={showCustomCustomerRef} />
				<span>Use a custom customer/account reference</span>
			</label>
			<p class="hint">
				Most users can leave this off. Turn it on only if the provider needs a one-off account reference instead of
				your saved connection.
			</p>
			{#if showCustomCustomerRef}
				<label class="wide-field">
					<span>Customer/account reference</span>
					<input type="text" bind:value={customerRef} maxlength="120" placeholder="wallet handle / customer id / account ref" />
				</label>
			{/if}
		</div>

		<div class="actions">
			<button class="action" on:click={loadProviders} disabled={loadingProviders}>
				Refresh providers
			</button>
			<button
				class="action primary"
				on:click={handleCreateIntent}
				disabled={creatingIntent || providers.length === 0 || Boolean(accessStatus && !accessStatus.canCreate)}
			>
				{creatingIntent ? 'Creating...' : 'Create payment request'}
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
					<h3>Request {activeIntent.intentId}</h3>
					<span class="status status-{activeIntent.status}">{activeIntent.status}</span>
				</div>
				<p class="intent-meta">
					{formatMinorAmount(activeIntent.amountMinor, activeIntent.currency)} via {activeIntent.providerName}
				</p>
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
						{#if typeof presentation.qrData === 'string' && presentation.qrData}
							<textarea readonly rows="3">{presentation.qrData}</textarea>
							<button class="action" on:click={() => copyToClipboard(String(presentation.qrData))}>
								Copy QR payload
							</button>
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

<style>
	.sheet-header {
		padding: 1.25rem 1.5rem 0.5rem;
	}

	.sheet-header h2 {
		margin: 0;
		font-size: 1.2rem;
	}

	.sheet-header p {
		margin: 0.25rem 0 0;
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.sheet-body {
		padding: 0.75rem 1.5rem 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	input,
	select,
	textarea {
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 0.55rem;
		padding: 0.55rem 0.65rem;
		color: var(--text-primary);
		font-size: 0.9rem;
	}

	textarea {
		resize: vertical;
		min-height: 72px;
	}

	.wide-field {
		width: 100%;
	}

	.actions {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}

	.action {
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 0.55rem;
		background: rgba(255, 255, 255, 0.04);
		color: var(--text-primary);
		padding: 0.5rem 0.8rem;
		cursor: pointer;
	}

	.action.primary {
		background: rgba(0, 210, 255, 0.18);
		border-color: rgba(0, 210, 255, 0.45);
	}

	.action:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.hint {
		margin: 0;
		font-size: 0.84rem;
		color: var(--text-secondary);
	}

	.error {
		margin: 0;
		color: #ff8585;
		font-size: 0.84rem;
	}

	.info {
		margin: 0;
		color: #7fd5ff;
		font-size: 0.84rem;
	}

	.intent-card {
		border: 1px solid rgba(255, 255, 255, 0.13);
		border-radius: 0.75rem;
		padding: 0.9rem;
		background: rgba(255, 255, 255, 0.03);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.target-summary {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.target-summary strong {
		font-size: 0.95rem;
	}

	.target-kind {
		width: fit-content;
	}

	.checkbox-row {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 0.55rem;
		color: var(--text-primary);
	}

	.checkbox-row input {
		width: 1rem;
		height: 1rem;
	}

	.intent-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
	}

	.intent-header h3 {
		margin: 0;
		font-size: 0.95rem;
	}

	.status {
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 0.22rem 0.46rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.2);
	}

	.status-succeeded {
		color: #69e093;
		border-color: rgba(105, 224, 147, 0.45);
	}

	.status-failed,
	.status-expired,
	.status-disputed {
		color: #ff8585;
		border-color: rgba(255, 133, 133, 0.45);
	}

	.status-pending,
	.status-draft {
		color: #8cc7ff;
		border-color: rgba(140, 199, 255, 0.45);
	}

	.intent-meta {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.qr-block {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.qr-image {
		width: min(280px, 100%);
		border-radius: 0.6rem;
		border: 1px solid rgba(255, 255, 255, 0.15);
		background: #fff;
		padding: 0.35rem;
	}

	.link-actions {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}

	.events h4 {
		margin: 0 0 0.4rem;
		font-size: 0.88rem;
	}

	.events ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.events li {
		display: grid;
		grid-template-columns: minmax(120px, 1fr) 90px 1fr;
		gap: 0.45rem;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.events time {
		justify-self: end;
	}

	@media (max-width: 760px) {
		.grid {
			grid-template-columns: 1fr;
		}

		.events li {
			grid-template-columns: 1fr;
		}

		.events time {
			justify-self: start;
		}
	}
</style>
