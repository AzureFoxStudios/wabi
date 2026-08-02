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

	export let isOpen = false;
	export let onClose: () => void = () => {};
	export let overlayZIndex: number | string | null = null;
	export let defaultTargetLabel: string | null = null;
	export let channelId = '';
	export let loadingProviders = false;
	export let providersLoaded = false;
	export let providersError = '';
	export let accessStatus: PaymentAccessActorStatus | null = null;
	export let providers: PaymentProviderCapability[] = [];
	export let routePresets: RoutePreset[] = [];
	export let selectedRoutePreset: RoutePreset | null = null;
	export let selectedProvider: PaymentProviderCapability | null = null;
	export let selectedMethod: PaymentMethodCapability | null = null;
	export let selectedAccountLink: PaymentAccountLink | null = null;
	export let eligibleProviderMethods: PaymentMethodCapability[] = [];
	export let providerCurrencyOptions: string[] = [];
	export let providerCountryOptions: string[] = [];
	export let selectedProviderId = '';
	export let selectedMethodId = '';
	export let amountInput = '100.00';
	export let currency = '';
	export let countryCode = '';
	export let showAdvancedRouting = false;
	export let showCustomCustomerRef = false;
	export let customerRef = '';
	export let showOptionalNote = false;
	export let description = '';
	export let accountLinksLoading = false;
	export let isServerDonationDraft = false;
	export let isThaiPromptPayDraft = false;
	export let isBitcoinQrDraft = false;
	export let isThaiQrIntent = false;
	export let isBitcoinQrIntent = false;
	export let missingRequiredThaiPromptPayReference = false;
	export let missingRequiredBitcoinAddress = false;
	export let creatingIntent = false;
	export let actionInfo = '';
	export let actionError = '';
	export let activeIntent: PaymentIntent | null = null;
	export let activeEvents: PaymentEvent[] = [];
	export let presentation: Record<string, unknown> = {};
	export let presentationMode: PaymentCheckoutMode = 'redirect';
	export let qrDataUrl = '';
	export let terminalStatuses: Set<PaymentIntentStatus>;
	export let onLoadProviders: () => void = () => {};
	export let onApplyRoutePreset: (preset: RoutePreset) => void = () => {};
	export let onManageConnections: () => void = () => {};
	export let onCreateIntent: () => void = () => {};
	export let onSaveQrImage: () => void = () => {};
	export let onSharePaymentTarget: () => void = () => {};
	export let onOpenSheetUrl: (url: string) => void = () => {};
	export let onCopyToClipboard: (text: string) => void = () => {};
	export let onRefreshIntent: (intentId: string, refresh?: boolean) => void = () => {};
	export let onCancelIntent: () => void = () => {};
	export let onResetForNewIntent: () => void = () => {};

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
				? `Enter the amount. ${brandName} will build a PromptPay donation QR for this server.`
				: `Enter the amount. ${brandName} will build a PromptPay QR from your saved PromptPay number.`;
		}
		if (isBitcoinQrDraft) {
			return isServerDonationDraft
				? `Enter the amount. ${brandName} will build a Bitcoin donation QR for this server.`
				: `Enter the amount. ${brandName} will build a Bitcoin QR from your saved Bitcoin address.`;
		}
		if (isThaiQrIntent) return 'Share or save the QR, then wait for confirmation.';
		if (isBitcoinQrIntent) return 'Share or save the QR, then wait for on-chain confirmation.';
		return `Create a non-custodial payment request. ${brandName} does not store cards or bank credentials and does not move the money itself.`;
	}

	function getTargetHeaderLabel(): string {
		const target = String(defaultTargetLabel || '').trim();
		if (target) return target;
		if (channelId.trim()) return channelId.trim();
		return '';
	}

	function getCreateButtonLabel(): string {
		if (creatingIntent) return isThaiPromptPayDraft || isBitcoinQrDraft ? 'Creating QR...' : 'Creating...';
		return isThaiPromptPayDraft || isBitcoinQrDraft ? 'Create QR' : 'Create payment request';
	}

	function getDraftMethodBehaviorNote(): string | null {
		if (!selectedProvider || !selectedMethod) return null;
		if (selectedProvider.pluginId === 'th-payments' && selectedMethod.id === 'promptpay_qr') {
			if (isServerDonationDraft) {
				return `PromptPay QR creates a donation request using the server donation PromptPay number. ${brandName} does not mark it paid just because the app returned.`;
			}
			return `PromptPay QR creates a payment request using your saved PromptPay number or a one-off PromptPay number. ${brandName} does not mark it paid just because the app returned.`;
		}
		if (selectedProvider.pluginId === 'th-payments' && selectedMethod.id === 'psp_checkout') {
			return 'This route can become fully verified when a Thai PSP adapter is configured. Without that adapter, PromptPay QR is the safer fallback.';
		}
		if (selectedProvider.pluginId === 'btc-payments' && selectedMethod.id === 'bitcoin_qr') {
			if (isServerDonationDraft) {
				return `Bitcoin QR creates a donation request using the server donation Bitcoin address. ${brandName} does not mark it paid just because a wallet opened or returned.`;
			}
			return `Bitcoin QR creates a payment request using your saved Bitcoin address or a one-off Bitcoin address. ${brandName} does not mark it paid just because a wallet opened or returned.`;
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

	function getMissingDirectReferenceMessage(): string {
		if (isThaiPromptPayDraft) {
			return `Thai PromptPay requests need your own PromptPay number before ${brandName} can build the QR. Save it in Saved Payment References or enter it as a one-off number.`;
		}
		if (isBitcoinQrDraft) {
			return `Bitcoin QR requests need your own Bitcoin address before ${brandName} can build the QR. Save it in Saved Payment References or enter it as a one-off address.`;
		}
		return 'A saved payment reference is required for this request.';
	}

	function getQrExternalConfirmationHint(): string {
		if (activeIntent?.pluginId === 'btc-payments') {
			return `Scanning or copying this QR opens the wallet flow. ${brandName} keeps the request pending until it gets real confirmation or the request expires.`;
		}
		return `Scanning this QR opens the bank/payment app flow. ${brandName} keeps the request pending until it gets real confirmation or the request expires.`;
	}
</script>

<BaseModal {isOpen} onClose={onClose} width="680px" {overlayZIndex}>
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
		{#if !loadingProviders && providersLoaded && providers.length === 0}
			<p class="hint">
				No payment provider plugins are loaded. Enable plugins and install a payment plugin (for example
				`th-payments`).
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
			shouldShowProviderPicker={shouldShowProviderPicker()}
			shouldShowMethodPicker={shouldShowMethodPicker()}
			shouldShowCurrencyPicker={shouldShowCurrencyPicker()}
			shouldShowCountryPicker={shouldShowCountryPicker()}
			draftMethodBehaviorNote={getDraftMethodBehaviorNote()}
			onApplyRoutePreset={onApplyRoutePreset}
		/>

		<PaymentReferencePanel
			{selectedAccountLink}
			{accountLinksLoading}
			isDirectReferenceDraft={isThaiPromptPayDraft || isBitcoinQrDraft}
			{isServerDonationDraft}
			{isThaiPromptPayDraft}
			{isBitcoinQrDraft}
			bind:showCustomCustomerRef
			bind:customerRef
			directReferenceTitle={isThaiPromptPayDraft ? 'PromptPay number' : isBitcoinQrDraft ? 'Bitcoin address' : 'Payment reference'}
			directReferencePlaceholder={isThaiPromptPayDraft ? 'Thai mobile number or PromptPay ID' : isBitcoinQrDraft ? 'bc1... or 1... / 3...' : 'Payment reference'}
			onManageConnections={onManageConnections}
		/>

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

		{#if missingRequiredThaiPromptPayReference || missingRequiredBitcoinAddress}
			<p class="hint emphasis">
				{getMissingDirectReferenceMessage()}
			</p>
		{/if}

		<div class="actions">
			<button class="action" on:click={onLoadProviders} disabled={loadingProviders}>Refresh providers</button>
			<button
				class="action primary"
				on:click={onCreateIntent}
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
			<PaymentIntentCard
				{activeIntent}
				{activeEvents}
				{presentation}
				{presentationMode}
				{qrDataUrl}
				{isThaiQrIntent}
				targetHeaderLabel={getTargetHeaderLabel()}
				{terminalStatuses}
				qrExternalConfirmationHint={getQrExternalConfirmationHint()}
				onSaveQrImage={onSaveQrImage}
				onSharePaymentTarget={onSharePaymentTarget}
				onOpenSheetUrl={onOpenSheetUrl}
				onCopyToClipboard={onCopyToClipboard}
				onRefreshIntent={onRefreshIntent}
				onCancelIntent={onCancelIntent}
				onResetForNewIntent={onResetForNewIntent}
			/>
		{/if}
	</div>
</BaseModal>
