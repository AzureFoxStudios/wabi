<script lang="ts">
	import BaseModal from '../components/BaseModal.svelte';
	import { brandName } from '$lib/branding';
	import PaymentIntentCard from './PaymentIntentCard.svelte';
	import PaymentReferencePanel from './PaymentReferencePanel.svelte';
	import PaymentRouteControls from './PaymentRouteControls.svelte';
	import type { RoutePreset } from '$lib/payments/paymentSheetHelpers';
	import type {
		PaymentAccessActorStatus,
		PaymentAccountLink,
		PaymentCheckoutMode,
		PaymentEvent,
		PaymentIntent,
		PaymentIntentStatus,
		PaymentMethodCapability,
		PaymentProviderCapability
	} from '$lib/api';

	let {
		isOpen = false,
		onClose = () => {},
		overlayZIndex = null,
		defaultTargetLabel = null,
		channelId = $bindable(''),
		loadingProviders = false,
		providersLoaded = false,
		providersError = '',
		accessStatus: accessStatus = null,
		providers = [],
		routePresets = [],
		selectedRoutePreset = null,
		selectedProvider = null,
		selectedMethod = null,
		selectedAccountLink = null,
		eligibleProviderMethods = [],
		providerCurrencyOptions = [],
		providerCountryOptions = [],
		selectedProviderId = $bindable(''),
		selectedMethodId = $bindable(''),
		amountInput = $bindable('100.00'),
		currency = $bindable(''),
		countryCode = $bindable(''),
		showAdvancedRouting = $bindable(false),
		showCustomCustomerRef = $bindable(false),
		customerRef = $bindable(''),
		showOptionalNote = $bindable(false),
		description = $bindable(''),
		accountLinksLoading = false,
		isServerDonationDraft = false,
		isThaiPromptPayDraft = false,
		isThaiQrIntent = false,
		missingRequiredThaiPromptPayReference = false,
		creatingIntent = false,
		actionInfo = '',
		actionError = '',
		activeIntent: activeIntent = null,
		activeEvents = [],
		presentation = {},
		presentationMode = 'redirect',
		qrDataUrl = '',
		terminalStatuses,
		onLoadProviders,
		onApplyRoutePreset,
		onManageConnections,
		onCreateIntent,
		onSaveQrImage,
		onSharePaymentTarget,
		onOpenSheetUrl,
		onCopyToClipboard,
		onRefreshIntent,
		onResetForNewIntent
	}: {
		isOpen?: boolean;
		onClose?: () => void;
		overlayZIndex?: number | string | null;
		defaultTargetLabel?: string | null;
		channelId?: string;
		loadingProviders?: boolean;
		providersLoaded?: boolean;
		providersError?: string;
		accessStatus?: PaymentAccessActorStatus | null;
		providers?: PaymentProviderCapability[];
		routePresets?: RoutePreset[];
		selectedRoutePreset?: RoutePreset | null;
		selectedProvider?: PaymentProviderCapability | null;
		selectedMethod?: PaymentMethodCapability | null;
		selectedAccountLink?: PaymentAccountLink | null;
		eligibleProviderMethods?: PaymentMethodCapability[];
		providerCurrencyOptions?: string[];
		providerCountryOptions?: string[];
		selectedProviderId?: string;
		selectedMethodId?: string;
		amountInput?: string;
		currency?: string;
		countryCode?: string;
		showAdvancedRouting?: boolean;
		showCustomCustomerRef?: boolean;
		customerRef?: string;
		showOptionalNote?: boolean;
		description?: string;
		accountLinksLoading?: boolean;
		isServerDonationDraft?: boolean;
		isThaiPromptPayDraft?: boolean;
		isThaiQrIntent?: boolean;
		missingRequiredThaiPromptPayReference?: boolean;
		creatingIntent?: boolean;
		actionInfo?: string;
		actionError?: string;
		activeIntent?: PaymentIntent | null;
		activeEvents?: PaymentEvent[];
		presentation?: Record<string, unknown>;
		presentationMode?: PaymentCheckoutMode;
		qrDataUrl?: string;
		terminalStatuses: Set<PaymentIntentStatus>;
		onLoadProviders?: () => void;
		onApplyRoutePreset?: (preset: RoutePreset) => void;
		onManageConnections?: () => void;
		onCreateIntent?: () => void;
		onSaveQrImage?: () => void;
		onSharePaymentTarget?: () => void;
		onOpenSheetUrl?: (url: string) => void;
		onCopyToClipboard?: (text: string) => void;
		onRefreshIntent?: (intentId: string, refresh?: boolean) => void;
		onResetForNewIntent?: () => void;
	} = $props();

	const shouldShowProviderPicker = $derived(
		(routePresets.length === 0 || showAdvancedRouting) && providers.length > 1
	);
	const shouldShowMethodPicker = $derived(
		(routePresets.length === 0 || showAdvancedRouting) && eligibleProviderMethods.length > 1
	);
	const shouldShowCurrencyPicker = $derived.by(() => {
		const manualMode = routePresets.length === 0 || showAdvancedRouting;
		if (!manualMode) return false;
		return (
			providerCurrencyOptions.length > 1 ||
			(routePresets.length === 0 && providerCurrencyOptions.length === 0)
		);
	});
	const shouldShowCountryPicker = $derived.by(() => {
		const manualMode = routePresets.length === 0 || showAdvancedRouting;
		if (!manualMode) return false;
		return (
			providerCountryOptions.length > 1 ||
			(routePresets.length === 0 && providerCountryOptions.length === 0)
		);
	});
	const sheetTitle = $derived(
		isThaiQrIntent ? 'PromptPay QR' : 'New Payment Request'
	);
	const sheetIntro = $derived.by(() => {
		if (isThaiPromptPayDraft) {
			return isServerDonationDraft
				? `Enter the amount. ${brandName} will build a PromptPay donation QR for this server.`
				: `Enter the amount. ${brandName} will build a PromptPay QR from your saved PromptPay number.`;
		}
		if (isThaiQrIntent) return 'Share or save the QR, then wait for confirmation.';
		return `Create a non-custodial payment request. ${brandName} does not store cards or bank credentials and does not move the money itself.`;
	});
	const targetHeaderLabel = $derived.by(() => {
		const target = String(defaultTargetLabel || '').trim();
		if (target) return target;
		if (channelId.trim()) return channelId.trim();
		return '';
	});
	const createButtonLabel = $derived.by(() => {
		if (creatingIntent) return isThaiPromptPayDraft ? 'Creating QR...' : 'Creating...';
		return isThaiPromptPayDraft ? 'Create QR' : 'Create payment request';
	});
	const draftMethodBehaviorNote = $derived.by(() => {
		if (!selectedProvider || !selectedMethod) return null;
		if (selectedProvider.pluginId === 'promptpay' && selectedMethod.id === 'promptpay_qr') {
			if (isServerDonationDraft) {
				return `PromptPay QR creates a donation request using the server donation PromptPay number. ${brandName} does not mark it paid just because the app returned.`;
			}
			return `PromptPay QR creates a payment request using your saved PromptPay number or a one-off PromptPay number. ${brandName} does not mark it paid just because the app returned.`;
		}
		return null;
	});
	const qrExternalConfirmationHint = $derived.by(() => {
		const pluginId = activeIntent?.pluginId || '';
		if (pluginId === 'payments-crypto') {
			return `Scanning this QR opens the payer's crypto wallet. ${brandName} keeps the request pending until it gets real confirmation or the request expires.`;
		}
		if (pluginId === 'payments-eu') {
			return `Scanning this QR opens the payer's EU banking app for a SEPA Instant transfer. ${brandName} keeps the request pending until it gets real confirmation or the request expires.`;
		}
		return `Scanning this QR opens the payer's banking app. ${brandName} keeps the request pending until it gets real confirmation or the request expires.`;
	});
</script>

<BaseModal {isOpen} onClose={onClose} width="680px" {overlayZIndex} title={sheetTitle} subtitle={sheetIntro} headerTag={targetHeaderLabel}>
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
		{#if !loadingProviders && providersLoaded && providers.length === 0}
			<p class="hint">
				No payment rails are enabled on this server yet.
			</p>
		{/if}

		<PaymentRouteControls
			{routePresets}
			{selectedRoutePreset}
			bind:showAdvancedRouting
			{providers}
			bind:selectedProviderId
			{eligibleProviderMethods}
			bind:selectedMethodId
			bind:amountInput
			{providerCurrencyOptions}
			bind:currency
			{providerCountryOptions}
			bind:countryCode
			{selectedProvider}
			{selectedMethod}
			{isThaiPromptPayDraft}
			shouldShowProviderPicker={shouldShowProviderPicker}
			shouldShowMethodPicker={shouldShowMethodPicker}
			shouldShowCurrencyPicker={shouldShowCurrencyPicker}
			shouldShowCountryPicker={shouldShowCountryPicker}
			{draftMethodBehaviorNote}
			{onApplyRoutePreset}
		/>

		<PaymentReferencePanel
			{selectedAccountLink}
			{accountLinksLoading}
			isDirectReferenceDraft={isThaiPromptPayDraft}
			{isServerDonationDraft}
			{isThaiPromptPayDraft}
			bind:showCustomCustomerRef
			bind:customerRef
			directReferenceTitle={isThaiPromptPayDraft ? 'PromptPay number' : 'Payment reference'}
			directReferencePlaceholder={isThaiPromptPayDraft ? 'Thai mobile number or PromptPay ID' : 'Payment reference'}
			{onManageConnections}
		/>

		{#if isThaiPromptPayDraft && !isServerDonationDraft}
			<p class="hint privacy-note">
				Privacy: the payer's banking app will show your PromptPay-registered name when they scan. {brandName} itself never sees the payment.
			</p>
		{/if}

		<label class="checkbox-row">
			<input type="checkbox" bind:checked={showOptionalNote} />
			<span>{isThaiPromptPayDraft ? 'Add a private note to this request' : 'Add a note'}</span>
		</label>

		{#if showOptionalNote}
			<label class="wide-field">
				<span>Note</span>
				<input type="text" bind:value={description} maxlength="200" placeholder="Optional" />
			</label>
		{/if}

		{#if missingRequiredThaiPromptPayReference}
			<p class="hint emphasis">
				Thai PromptPay requests need your own PromptPay number before {brandName} can build the QR. Save it in Saved Payment References or enter it as a one-off number.
			</p>
		{/if}

		<div class="actions">
			<button class="action" onclick={() => onLoadProviders?.()} disabled={loadingProviders}>Refresh providers</button>
			<button
				class="action primary"
				onclick={() => onCreateIntent?.()}
				disabled={creatingIntent || providers.length === 0 || Boolean(accessStatus && !accessStatus.canCreate) || missingRequiredThaiPromptPayReference}
			>
				{createButtonLabel}
			</button>
		</div>

		{#if actionInfo}
			<p class="info">{actionInfo}</p>
		{/if}
		{#if actionError}
			<p class="error">{actionError}</p>
		{/if}

		{#if activeIntent}
			<PaymentIntentCard
				{activeIntent}
				{activeEvents}
				{presentation}
				{presentationMode}
				{qrDataUrl}
				{isThaiQrIntent}
				targetHeaderLabel={targetHeaderLabel}
				{terminalStatuses}
				qrExternalConfirmationHint={qrExternalConfirmationHint}
				onSaveQrImage={() => onSaveQrImage?.()}
				onSharePaymentTarget={() => onSharePaymentTarget?.()}
				onOpenSheetUrl={(url) => onOpenSheetUrl?.(url)}
				onCopyToClipboard={(text) => onCopyToClipboard?.(text)}
				onRefreshIntent={(intentId, refresh) => onRefreshIntent?.(intentId, refresh)}
				onResetForNewIntent={() => onResetForNewIntent?.()}
			/>
		{/if}
	</div>
</BaseModal>
