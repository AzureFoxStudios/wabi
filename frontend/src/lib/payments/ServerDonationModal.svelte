<script lang="ts">
	import { onDestroy } from 'svelte';
	import BaseModal from '../components/BaseModal.svelte';
	import {
		getPaymentDonationSummary,
		listPaymentProviders,
		type PaymentDonationConfig,
		type PaymentDonationLedgerEntry,
		type OfflineDonationLedgerEntry,
		type PaymentDonationTotal,
		type PaymentProviderCapability
	} from '$lib/api';
	import { formatMinorAmount, minorToMajorInput } from '$lib/payments/paymentAmounts';
	import { subscribePaymentRealtimeEvent } from '$lib/payments/paymentRealtime';

	interface DonationPrefillPayload {
		amountInput: string;
		providerPluginId: string;
		methodId: string;
		currency: string;
		countryCode: string | null;
		description: string;
		metadata: Record<string, unknown>;
	}

	export let isOpen = false;
	export let onClose: () => void = () => {};
	export let onDonate: (payload: DonationPrefillPayload) => void = () => {};
	export let overlayZIndex: number | string | null = null;

	let loading = false;
	let loaded = false;
	let error = '';
	let config: PaymentDonationConfig | null = null;
	let totals: PaymentDonationTotal[] = [];
	let offlineTotals: PaymentDonationTotal[] = [];
	let recentDonations: PaymentDonationLedgerEntry[] = [];
	let recentOfflineDonations: OfflineDonationLedgerEntry[] = [];
	let providerCatalog: PaymentProviderCapability[] = [];
	let providerCatalogLoaded = false;
	let amountInput = '10.00';
	$: donationRouteReady = Boolean(config?.enabled && config?.providerPluginId && config?.methodId);
	$: donationRouteProvider =
		providerCatalog.find((provider) => provider.pluginId === config?.providerPluginId) || null;
	$: donationRouteMethod =
		donationRouteProvider?.methods.find((method) => method.id === config?.methodId) || null;

	$: if (isOpen && !loaded) {
		void loadDonationSummary();
	}

	$: if (isOpen && !providerCatalogLoaded) {
		void loadProviderCatalog();
	}

	$: if (!isOpen) {
		loaded = false;
		error = '';
		providerCatalogLoaded = false;
	}

	const unsubscribeDonationRealtime = subscribePaymentRealtimeEvent('payments:donations-updated', () => {
		if (!isOpen) return;
		void loadDonationSummary();
	});

	onDestroy(() => {
		unsubscribeDonationRealtime();
	});

	function formatRelativeTime(timestamp: number | null): string {
		if (!timestamp || !Number.isFinite(timestamp)) return 'just now';
		const deltaMs = Math.max(0, Date.now() - timestamp);
		const deltaMinutes = Math.floor(deltaMs / 60_000);
		if (deltaMinutes < 1) return 'just now';
		if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
		const deltaHours = Math.floor(deltaMinutes / 60);
		if (deltaHours < 48) return `${deltaHours}h ago`;
		const deltaDays = Math.floor(deltaHours / 24);
		if (deltaDays < 30) return `${deltaDays}d ago`;
		const deltaMonths = Math.floor(deltaDays / 30);
		if (deltaMonths < 12) return `${deltaMonths}mo ago`;
		const deltaYears = Math.floor(deltaMonths / 12);
		return `${deltaYears}y ago`;
	}

	async function loadDonationSummary(): Promise<void> {
		loading = true;
		error = '';
		try {
			const response = await getPaymentDonationSummary();
			config = response.config;
			totals = response.totals;
			offlineTotals = response.offlineTotals;
			recentDonations = response.recentDonations;
			recentOfflineDonations = response.recentOfflineDonations;
			loaded = true;
			const firstSuggested = response.config.suggestedAmountsMinor[0];
			if (typeof firstSuggested === 'number' && Number.isFinite(firstSuggested) && firstSuggested > 0) {
				amountInput = minorToMajorInput(firstSuggested, response.config.currency);
			}
		} catch (loadError) {
			error = loadError instanceof Error ? loadError.message : 'Failed to load server donations';
		} finally {
			loading = false;
		}
	}

	async function loadProviderCatalog(): Promise<void> {
		try {
			providerCatalog = await listPaymentProviders();
			providerCatalogLoaded = true;
		} catch {
			providerCatalog = [];
			providerCatalogLoaded = true;
		}
	}

	function chooseSuggestedAmount(amountMinor: number): void {
		amountInput = minorToMajorInput(amountMinor, config?.currency || 'USD');
	}

	function handleDonate(): void {
		if (!config?.enabled || !config.providerPluginId || !config.methodId) {
			return;
		}
		onDonate({
			amountInput,
			providerPluginId: config.providerPluginId,
			methodId: config.methodId,
			currency: config.currency,
			countryCode: config.countryCode,
			description: config.headline,
			metadata: {
				kind: 'server_donation',
				target: 'default_workspace'
			}
		});
	}
</script>

<BaseModal isOpen={isOpen} onClose={onClose} width="720px" {overlayZIndex}>
	<div slot="header" class="sheet-header">
		<h2>{config?.headline || 'Support This Server'}</h2>
		<p>{config?.description || 'Support server hosting and maintenance.'}</p>
	</div>

	<div class="sheet-body">
		{#if loading}
			<p class="hint">Loading donation options...</p>
		{/if}

		{#if error}
			<p class="error">{error}</p>
		{/if}

		{#if config && !config.enabled}
			<p class="hint">Server donations are not enabled right now.</p>
		{/if}

		{#if config?.enabled && !donationRouteReady}
			<p class="hint">Server donations are enabled, but the owner has not finished selecting the provider and payment method yet.</p>
		{/if}

		{#if totals.length > 0}
			<div class="totals-card">
				<h3>Verified Donations</h3>
				<ul>
					{#each totals as total}
						<li>
							<span>{formatMinorAmount(total.amountMinor, total.currency)}</span>
							<small>{total.paymentCount} completed donation{total.paymentCount === 1 ? '' : 's'}</small>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if offlineTotals.length > 0}
			<div class="totals-card">
				<h3>Offline / Manual Donations</h3>
				<ul>
					{#each offlineTotals as total}
						<li>
							<span>{formatMinorAmount(total.amountMinor, total.currency)}</span>
							<small>{total.paymentCount} recorded donation{total.paymentCount === 1 ? '' : 's'}</small>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if !loading && !error && totals.length === 0 && offlineTotals.length === 0}
			<p class="hint">No donations recorded yet.</p>
		{/if}

		{#if recentDonations.length > 0}
			<div class="totals-card">
				<h3>Recent Donations</h3>
				<ul>
					{#each recentDonations as donation}
						<li>
							<div class="ledger-copy">
								<strong>{donation.donorLabel}</strong>
								<small>{formatRelativeTime(donation.refundedAt || donation.completedAt || donation.createdAt)}</small>
							</div>
							<div class="ledger-value">
								<span>{formatMinorAmount(donation.amountMinor, donation.currency)}</span>
								{#if donation.status === 'refunded'}
									<small class="refund-pill">Refunded</small>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if recentOfflineDonations.length > 0}
			<div class="totals-card">
				<h3>Recent Offline Donations</h3>
				<ul>
					{#each recentOfflineDonations as donation}
						<li>
							<div class="ledger-copy">
								<strong>{donation.donorLabel}</strong>
								<small>{formatRelativeTime(donation.voidedAt || donation.completedAt || donation.createdAt)}</small>
							</div>
							<div class="ledger-value">
								<span>{formatMinorAmount(donation.amountMinor, donation.currency)}</span>
								{#if donation.status === 'voided'}
									<small class="refund-pill">Voided</small>
								{:else}
									<small>Offline</small>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if config?.enabled}
			<div class="donation-card">
				{#if config.suggestedAmountsMinor.length > 0}
					<div class="suggestions">
						{#each config.suggestedAmountsMinor as amountMinor}
							<button class="chip" on:click={() => chooseSuggestedAmount(amountMinor)}>
								{formatMinorAmount(amountMinor, config.currency)}
							</button>
						{/each}
					</div>
				{/if}

				<label>
					<span>Donation amount</span>
					<input type="text" bind:value={amountInput} placeholder="10.00" />
				</label>

				<p class="hint">
					This opens the normal payment flow using the server's configured donation route:
					<code>{donationRouteProvider?.providerName || config.providerPluginId || 'unset'}</code>
					/
					<code>{donationRouteMethod?.label || config.methodId || 'unset'}</code>
				</p>

				<div class="actions">
					<button
						class="action primary"
						on:click={handleDonate}
						disabled={!donationRouteReady}
					>
						Continue to Donate
					</button>
				</div>
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

	.totals-card,
	.donation-card {
		border: 1px solid rgba(255, 255, 255, 0.13);
		border-radius: 0.75rem;
		padding: 0.9rem;
		background: rgba(255, 255, 255, 0.03);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.totals-card h3 {
		margin: 0;
		font-size: 1rem;
	}

	.totals-card ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.totals-card li {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		font-size: 0.88rem;
	}

	.totals-card small {
		color: var(--text-secondary);
	}

	.ledger-copy,
	.ledger-value {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.ledger-value {
		align-items: flex-end;
	}

	.refund-pill {
		color: #ffb766;
	}

	.suggestions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.chip,
	.action {
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 0.55rem;
		background: rgba(255, 255, 255, 0.04);
		color: var(--text-heading);
		padding: 0.5rem 0.8rem;
		cursor: pointer;
	}

	.action.primary {
		background: rgba(0, 210, 255, 0.18);
		border-color: rgba(0, 210, 255, 0.45);
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	input {
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 0.55rem;
		padding: 0.55rem 0.65rem;
		color: var(--text-heading);
		font-size: 0.9rem;
	}

	.actions {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
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
 </style>
