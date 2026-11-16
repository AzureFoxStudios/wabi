<script lang="ts">
	import { _ } from '$lib/i18n';
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
		isThaiQrIntent ? 'PromptPay QR' : $_('payment_sheet.new_request')
	);
	const sheetIntro = $derived.by(() => {
		if (isThaiPromptPayDraft) {
			return isServerDonationDraft
				? $_('payment_sheet.intro_donation', { values: { brand: brandName } })
				: $_('payment_sheet.intro_saved', { values: { brand: brandName } });
		}
		if (isThaiQrIntent) return $_('payment_sheet.qr_intro');
		return $_('payment_sheet.intro_default', { values: { brand: brandName } });
	});
	const targetHeaderLabel = $derived.by(() => {
		const target = String(defaultTargetLabel || '').trim();
		if (target) return target;
		if (channelId.trim()) return channelId.trim();
		return '';
	});
	const createButtonLabel = $derived.by(() => {
		if (creatingIntent) return isThaiPromptPayDraft ? $_('payment_sheet.creating_qr') : $_('payment_sheet.creating');
		return isThaiPromptPayDraft ? $_('payment_sheet.create_qr') : $_('payment_sheet.create_request');
	});
	const draftMethodBehaviorNote = $derived.by(() => {
		if (!selectedProvider || !selectedMethod) return null;
		if (selectedProvider.pluginId === 'promptpay' && selectedMethod.id === 'promptpay_qr') {
			if (isServerDonationDraft) {
				return $_('payment_sheet.qr_donation_note', { values: { brand: brandName } });
			}
			return $_('payment_sheet.qr_request_note', { values: { brand: brandName } });
		}
		return null;
	});
	const qrExternalConfirmationHint = $derived.by(() => {
		const pluginId = activeIntent?.pluginId || '';
		if (pluginId === 'payments-crypto') {
			return $_('payment_sheet.scan_crypto', { values: { brand: brandName } });
		}
		if (pluginId === 'payments-eu') {
			return $_('payment_sheet.scan_eu', { values: { brand: brandName } });
		}
		return $_('payment_sheet.scan_bank', { values: { brand: brandName } });
	});
</script>

<BaseModal {isOpen} onClose={onClose} width="680px" {overlayZIndex} title={sheetTitle} subtitle={sheetIntro} headerTag={targetHeaderLabel}>
	<div class="sheet-body">
		{#if loadingProviders}
			<p class="hint">{$_('payment_sheet.loading')}</p>
		{/if}
		{#if providersError}
			<p class="error">{providersError}</p>
		{/if}
		{#if accessStatus && !accessStatus.canCreate}
			<p class="error">{accessStatus.reason || $_('payment_sheet.cannot_create')}</p>
		{/if}
		{#if !loadingProviders && providersLoaded && providers.length === 0}
			<p class="hint">
				{$_('payment_sheet.no_rails')}
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
			directReferenceTitle={isThaiPromptPayDraft ? $_('payment_sheet.reference_title') : $_('payment_sheet.reference')}
			directReferencePlaceholder={isThaiPromptPayDraft ? $_('payment_sheet.reference_ph') : $_('payment_sheet.reference')}
			{onManageConnections}
		/>

		{#if isThaiPromptPayDraft && !isServerDonationDraft}
			<p class="hint privacy-note">
				{$_('payment_sheet.privacy_note', { values: { brand: brandName } })}
			</p>
		{/if}

		<label class="checkbox-row">
			<input type="checkbox" bind:checked={showOptionalNote} />
			<span>{isThaiPromptPayDraft ? $_('payment_sheet.note_private') : $_('payment_sheet.note')}</span>
		</label>

		{#if showOptionalNote}
			<label class="wide-field">
				<span>{$_('payment_sheet.note_label')}</span>
				<input type="text" bind:value={description} maxlength="200" placeholder={$_('payment_sheet.optional')} />
			</label>
		{/if}

		{#if missingRequiredThaiPromptPayReference}
			<p class="hint emphasis">
				{$_('payment_sheet.thai_ref_needed', { values: { brand: brandName } })}
			</p>
		{/if}

		<div class="actions">
			<button class="action" onclick={() => onLoadProviders?.()} disabled={loadingProviders}>{$_('payment_sheet.refresh_providers')}</button>
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
