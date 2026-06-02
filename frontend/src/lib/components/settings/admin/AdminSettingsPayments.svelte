<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import {
		createAdminOfflineDonation,
		getAdminPaymentDonationConfig,
		listAdminOfflineDonations,
		listAdminPaymentDonationAudit,
		listPaymentProviders,
		refundAdminPaymentDonation,
		saveAdminPaymentDonationConfig,
		voidAdminOfflineDonation,
		type OfflineDonationLedgerEntry,
		type PaymentDonationConfig,
		type PaymentDonationLedgerEntry,
		type PaymentProviderCapability
	} from '$lib/api';
	import { getAuthToken } from '$lib/authSession';
	import { subscribePaymentRealtimeEvent } from '$lib/payments/paymentRealtime';
	import DonationConfig from './DonationConfig.svelte';
	import OfflineDonations from './OfflineDonations.svelte';
	import {
		formatDonationAuditAmount,
		formatDonationAuditWhen,
		getDonationRouteOptions,
		minorToMajorInput as formatMinorToMajorInput,
		parseMajorAmountInput,
		parseSuggestedAmountsInput as parseSuggestedAmounts,
		reconcileDonationRouteSelection
	} from './adminSettingsHelpers';

	export let canManageAdmin = false;

	const dispatch = createEventDispatcher<{ openServerDonation: void }>();

	let adminDonationConfigLoaded = false;
	let adminDonationConfigLoading = false;
	let adminDonationConfigSaving = false;
	let adminDonationAuditLoaded = false;
	let adminDonationAuditLoading = false;
	let adminDonationRefundingIntentId = '';
	let adminDonationAudit: PaymentDonationLedgerEntry[] = [];
	let adminOfflineDonationAuditLoaded = false;
	let adminOfflineDonationAuditLoading = false;
	let adminOfflineDonationSaving = false;
	let adminOfflineDonationVoidingSettlementId = '';
	let adminOfflineDonationAudit: OfflineDonationLedgerEntry[] = [];
	let offlineDonationAmountInput = '10.00';
	let offlineDonationCurrency = 'USD';
	let offlineDonationDonorLabel = '';
	let offlineDonationDescription = '';
	let adminDonationConfig: PaymentDonationConfig = {
		enabled: false,
		providerPluginId: null,
		methodId: null,
		currency: 'USD',
		countryCode: null,
		suggestedAmountsMinor: [500, 1000, 2500],
		headline: 'Support This Server',
		description: 'Contribute to server hosting and maintenance.'
	};
	let donationSuggestedAmountsInput = '5, 10, 25';
	let paymentProviderCapabilities: PaymentProviderCapability[] = [];
	let paymentProviderCapabilitiesLoaded = false;

	$: adminDonationSelectedProvider =
		paymentProviderCapabilities.find((provider) => provider.pluginId === adminDonationConfig.providerPluginId) || null;
	$: adminDonationMethods = adminDonationSelectedProvider?.methods || [];
	$: adminDonationSelectedMethod =
		adminDonationMethods.find((method) => method.id === adminDonationConfig.methodId) || null;
	$: adminDonationCurrencyOptions = getDonationRouteOptions(
		adminDonationSelectedProvider?.currencies || [],
		adminDonationSelectedMethod?.currencies || []
	);
	$: adminDonationCountryOptions = getDonationRouteOptions(
		adminDonationSelectedProvider?.countries || [],
		adminDonationSelectedMethod?.countries || []
	);
	$: donationRoutePreviewReady = Boolean(
		adminDonationConfig.enabled &&
		adminDonationConfig.providerPluginId &&
		adminDonationConfig.methodId
	);
	$: if (canManageAdmin && !adminDonationConfigLoaded) void loadAdminDonationConfig();
	$: if (canManageAdmin && !adminDonationAuditLoaded) void loadAdminDonationAudit();
	$: if (canManageAdmin && !adminOfflineDonationAuditLoaded) void loadAdminOfflineDonationAudit();

	onMount(() => {
		const unsubscribeDonationRealtime = subscribePaymentRealtimeEvent('payments:donations-admin-updated', () => {
			if (!canManageAdmin) return;
			adminDonationAuditLoaded = false;
			adminOfflineDonationAuditLoaded = false;
			void loadAdminDonationAudit();
			void loadAdminOfflineDonationAudit();
		});
		const unsubscribeAccessRealtime = subscribePaymentRealtimeEvent('payments:access-updated', () => {
			if (!canManageAdmin) return;
			adminDonationConfigLoaded = false;
			void loadAdminDonationConfig();
		});
		return () => {
			unsubscribeDonationRealtime();
			unsubscribeAccessRealtime();
		};
	});

	function minorToMajorInput(amountMinor: number, currency = adminDonationConfig.currency || 'USD'): string {
		return formatMinorToMajorInput(amountMinor, currency);
	}

	function parseSuggestedAmountsInput(value: string): number[] {
		return parseSuggestedAmounts(value, adminDonationConfig.currency || 'USD');
	}

	function getDonationRouteSummaryList(values: number[]): string {
		if (values.length === 0) return 'No suggested amounts';
		return values.map((amountMinor) => minorToMajorInput(amountMinor, adminDonationConfig.currency || 'USD')).join(', ');
	}

	function normalizeAdminDonationMethodSelection(): void {
		const selectedProvider = paymentProviderCapabilities.find((provider) => provider.pluginId === adminDonationConfig.providerPluginId) || null;
		const nextConfig = reconcileDonationRouteSelection(
			adminDonationConfig,
			selectedProvider,
			selectedProvider?.methods || []
		) as PaymentDonationConfig;
		if (nextConfig !== adminDonationConfig) adminDonationConfig = nextConfig;
	}

	async function loadPaymentProviderCapabilities(): Promise<void> {
		if (paymentProviderCapabilitiesLoaded) return;
		try {
			paymentProviderCapabilities = await listPaymentProviders();
			paymentProviderCapabilitiesLoaded = true;
			normalizeAdminDonationMethodSelection();
		} catch (error) {
			console.error('[Payments] Failed to load provider capabilities for settings:', error);
		}
	}

	async function loadAdminDonationConfig(): Promise<void> {
		if (adminDonationConfigLoaded || adminDonationConfigLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		adminDonationConfigLoading = true;
		try {
			adminDonationConfig = await getAdminPaymentDonationConfig(token);
			donationSuggestedAmountsInput = adminDonationConfig.suggestedAmountsMinor
				.map((amountMinor) => minorToMajorInput(amountMinor, adminDonationConfig.currency || 'USD'))
				.join(', ');
			offlineDonationCurrency = adminDonationConfig.currency || offlineDonationCurrency;
			adminDonationConfigLoaded = true;
			await loadPaymentProviderCapabilities();
			normalizeAdminDonationMethodSelection();
		} catch (error) {
			console.error('[Payments] Failed to load donation config:', error);
		} finally {
			adminDonationConfigLoading = false;
		}
	}

	async function loadAdminDonationAudit(): Promise<void> {
		if (adminDonationAuditLoaded || adminDonationAuditLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		adminDonationAuditLoading = true;
		try {
			const response = await listAdminPaymentDonationAudit(token, 100);
			adminDonationAudit = response.donations;
			adminDonationAuditLoaded = true;
		} catch (error) {
			console.error('[Payments] Failed to load donation audit trail:', error);
		} finally {
			adminDonationAuditLoading = false;
		}
	}

	async function loadAdminOfflineDonationAudit(): Promise<void> {
		if (adminOfflineDonationAuditLoaded || adminOfflineDonationAuditLoading || !canManageAdmin) return;
		const token = getAuthToken();
		if (!token) return;
		adminOfflineDonationAuditLoading = true;
		try {
			const response = await listAdminOfflineDonations(token, 100);
			adminOfflineDonationAudit = response.donations;
			adminOfflineDonationAuditLoaded = true;
		} catch (error) {
			console.error('[Payments] Failed to load offline donation audit trail:', error);
		} finally {
			adminOfflineDonationAuditLoading = false;
		}
	}

	async function saveDonationConfig(): Promise<void> {
		if (adminDonationConfigSaving) return;
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}
		const nextConfig: PaymentDonationConfig = {
			...adminDonationConfig,
			suggestedAmountsMinor: parseSuggestedAmountsInput(donationSuggestedAmountsInput)
		};
		adminDonationConfigSaving = true;
		try {
			adminDonationConfig = await saveAdminPaymentDonationConfig(token, nextConfig);
			donationSuggestedAmountsInput = adminDonationConfig.suggestedAmountsMinor
				.map((amountMinor) => minorToMajorInput(amountMinor, adminDonationConfig.currency || 'USD'))
				.join(', ');
			alert('Donation settings saved.');
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to save donation settings.');
		} finally {
			adminDonationConfigSaving = false;
		}
	}

	async function createOfflineDonationRecord(): Promise<void> {
		if (adminOfflineDonationSaving) return;
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}
		const amountMinor = parseMajorAmountInput(offlineDonationAmountInput, offlineDonationCurrency);
		if (amountMinor <= 0) {
			alert('Enter a valid offline donation amount.');
			return;
		}
		const currency = offlineDonationCurrency.trim().toUpperCase();
		if (!/^[A-Z]{3}$/.test(currency)) {
			alert('Enter a valid 3-letter currency code.');
			return;
		}
		adminOfflineDonationSaving = true;
		try {
			const donation = await createAdminOfflineDonation(token, {
				amountMinor,
				currency,
				donorLabel: offlineDonationDonorLabel.trim() || undefined,
				description: offlineDonationDescription.trim() || undefined,
				metadata: { source: 'settings_admin_manual_entry' }
			});
			adminOfflineDonationAudit = [donation, ...adminOfflineDonationAudit.filter((entry) => entry.settlementId !== donation.settlementId)];
			adminOfflineDonationAuditLoaded = true;
			offlineDonationAmountInput = minorToMajorInput(amountMinor, currency);
			offlineDonationCurrency = currency;
			offlineDonationDonorLabel = '';
			offlineDonationDescription = '';
			alert('Offline donation recorded.');
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to record offline donation.');
		} finally {
			adminOfflineDonationSaving = false;
		}
	}

	async function refundDonation(entry: PaymentDonationLedgerEntry): Promise<void> {
		if (!canManageAdmin || adminDonationRefundingIntentId || !entry.canRefund) return;
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}
		const reason = window.prompt(`Refund ${formatDonationAuditAmount(entry.amountMinor, entry.currency)} from ${entry.donorLabel}.`, 'Refund requested by donor');
		if (reason === null) return;
		const normalizedReason = reason.trim() || 'Refund requested by donor';
		const confirmed = window.confirm(`Issue a donation refund for ${entry.donorLabel}?\n\n${formatDonationAuditAmount(entry.amountMinor, entry.currency)}\nReason: ${normalizedReason}`);
		if (!confirmed) return;
		adminDonationRefundingIntentId = entry.intentId;
		try {
			await refundAdminPaymentDonation(token, entry.intentId, normalizedReason);
			adminDonationAuditLoaded = false;
			await loadAdminDonationAudit();
			alert('Donation refund submitted.');
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to refund donation.');
		} finally {
			adminDonationRefundingIntentId = '';
		}
	}

	async function voidOfflineDonation(entry: OfflineDonationLedgerEntry): Promise<void> {
		if (!canManageAdmin || adminOfflineDonationVoidingSettlementId || !entry.canVoid) return;
		const token = getAuthToken();
		if (!token) {
			alert('You must be logged in as admin/owner.');
			return;
		}
		const reason = window.prompt(`Void offline donation from ${entry.donorLabel}?`, 'Recorded in error');
		if (reason === null) return;
		const normalizedReason = reason.trim() || 'Recorded in error';
		const confirmed = window.confirm(`Void offline donation for ${entry.donorLabel}?\n\n${formatDonationAuditAmount(entry.amountMinor, entry.currency)}\nReason: ${normalizedReason}`);
		if (!confirmed) return;
		adminOfflineDonationVoidingSettlementId = entry.settlementId;
		try {
			const updated = await voidAdminOfflineDonation(token, entry.settlementId, normalizedReason);
			adminOfflineDonationAudit = adminOfflineDonationAudit.map((item) => item.settlementId === entry.settlementId ? updated : item);
			alert('Offline donation voided.');
		} catch (error) {
			alert(error instanceof Error ? error.message : 'Failed to void offline donation.');
		} finally {
			adminOfflineDonationVoidingSettlementId = '';
		}
	}
</script>

<DonationConfig
	{adminDonationConfig}
	{canManageAdmin}
	{adminDonationConfigLoading}
	{adminDonationConfigSaving}
	{paymentProviderCapabilities}
	{donationSuggestedAmountsInput}
	{adminDonationSelectedProvider}
	{adminDonationMethods}
	{adminDonationSelectedMethod}
	{adminDonationCurrencyOptions}
	{adminDonationCountryOptions}
	{donationRoutePreviewReady}
	{adminDonationAudit}
	{adminDonationAuditLoading}
	{adminDonationAuditLoaded}
	{adminDonationRefundingIntentId}
	onConfigChange={(cfg) => adminDonationConfig = cfg}
	onDonationAmountsInput={(v) => donationSuggestedAmountsInput = v}
	onSaveDonationConfig={saveDonationConfig}
	onOpenServerDonation={() => dispatch('openServerDonation')}
	onRefreshAudit={() => { adminDonationAuditLoaded = false; void loadAdminDonationAudit(); }}
	onRefund={refundDonation}
	{formatDonationAuditAmount}
	{formatDonationAuditWhen}
	{getDonationRouteSummaryList}
	{parseSuggestedAmountsInput}
	{minorToMajorInput}
/>

<OfflineDonations
	{canManageAdmin}
	{adminOfflineDonationAudit}
	{adminOfflineDonationAuditLoading}
	{adminOfflineDonationAuditLoaded}
	{adminOfflineDonationVoidingSettlementId}
	{adminOfflineDonationSaving}
	{offlineDonationAmountInput}
	{offlineDonationCurrency}
	{offlineDonationDonorLabel}
	{offlineDonationDescription}
	onCreateOfflineDonation={createOfflineDonationRecord}
	onRefreshAudit={() => { adminOfflineDonationAuditLoaded = false; void loadAdminOfflineDonationAudit(); }}
	onVoid={voidOfflineDonation}
	onAmountInput={(v) => offlineDonationAmountInput = v}
	onCurrencyInput={(v) => offlineDonationCurrency = v}
	onDonorLabelInput={(v) => offlineDonationDonorLabel = v}
	onDescriptionInput={(v) => offlineDonationDescription = v}
	{formatDonationAuditAmount}
	{formatDonationAuditWhen}
/>
