<script lang="ts">
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

	let {
		isOpen = false,
		onClose = () => {},
		onDonate,
		overlayZIndex = null
	}: {
		isOpen?: boolean;
		onClose?: () => void;
		onDonate?: (payload: DonationPrefillPayload) => void;
		overlayZIndex?: number | string | null;
	} = $props();

	let loading = $state(false);
	let loaded = $state(false);
	let error = $state('');
	let config = $state<PaymentDonationConfig | null>(null);
	let totals = $state<PaymentDonationTotal[]>([]);
	let offlineTotals = $state<PaymentDonationTotal[]>([]);
	let recentDonations = $state<PaymentDonationLedgerEntry[]>([]);
	let recentOfflineDonations = $state<OfflineDonationLedgerEntry[]>([]);
	let providerCatalog = $state<PaymentProviderCapability[]>([]);
	let providerCatalogLoaded = $state(false);
	let amountInput = $state('10.00');

	const donationRouteReady = $derived(
		Boolean(config?.enabled && config?.providerPluginId && config?.methodId)
	);
	const donationRouteProvider = $derived(
		providerCatalog.find((provider) => provider.pluginId === config?.providerPluginId) || null
	);
	const donationRouteMethod = $derived(
		donationRouteProvider?.methods.find((method) => method.id === config?.methodId) || null
	);

	const unsubscribeDonationRealtime = subscribePaymentRealtimeEvent('payments:donations-updated', () => {
		if (!isOpen) return;
		void loadDonationSummary();
	});

	$effect(() => () => unsubscribeDonationRealtime());

	$effect(() => {
		if (isOpen && !loaded) {
			void loadDonationSummary();
		}
	});

	$effect(() => {
		if (isOpen && !providerCatalogLoaded) {
			void loadProviderCatalog();
		}
	});

	$effect(() => {
		if (!isOpen) {
			loaded = false;
			error = '';
			providerCatalogLoaded = false;
		}
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
		} catch {
			providerCatalog = [];
		} finally {
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
		onDonate?.({
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

<BaseModal
	{isOpen}
	onClose={onClose}
	width="720px"
	{overlayZIndex}
	title={config?.headline || 'Support This Server'}
	subtitle={config?.description || 'Support server hosting and maintenance.'}
>
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
					{#each totals as total (total.currency)}
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
					{#each offlineTotals as total (total.currency)}
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
					{#each recentDonations as donation (donation.intentId)}
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
					{#each recentOfflineDonations as donation (donation.settlementId)}
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
						{#each config.suggestedAmountsMinor as amountMinor (amountMinor)}
							<button class="chip" onclick={() => chooseSuggestedAmount(amountMinor)}>
								{formatMinorAmount(amountMinor, config.currency)}
							</button>
						{/each}
					</div>
				{/if}

				<label>
					<span>Donation amount</span>
					<input type="text" bind:value={amountInput} placeholder="10.00" inputmode="decimal" />
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
						onclick={handleDonate}
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
	.sheet-body {
		padding: 0.75rem 1.5rem 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}

	.totals-card,
	.donation-card {
		border: 1px solid var(--border-default, rgba(255, 255, 255, 0.13));
		border-radius: var(--radius-lg, 0.75rem);
		padding: 0.9rem;
		background: var(--surface-raised, rgba(255, 255, 255, 0.03));
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
		color: var(--color-warning, #ffd700);
	}

	.suggestions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.chip,
	.action {
		border: 1px solid var(--border-default, rgba(255, 255, 255, 0.18));
		border-radius: var(--radius-md, 0.55rem);
		background: var(--surface-button, rgba(255, 255, 255, 0.04));
		color: var(--text-heading);
		padding: 0.5rem 0.8rem;
		cursor: pointer;
		font-size: 0.86rem;
		transition: background var(--duration-fast, 150ms) var(--ease-out, ease-out),
			border-color var(--duration-fast, 150ms) var(--ease-out, ease-out),
			transform var(--duration-fast, 150ms) var(--ease-out, ease-out);
	}

	.chip:hover:not(:disabled),
	.action:hover:not(:disabled) {
		background: var(--surface-hover, rgba(255, 255, 255, 0.08));
		border-color: rgba(255, 255, 255, 0.3);
	}

	.chip:active:not(:disabled),
	.action:active:not(:disabled) {
		transform: scale(0.97);
	}

	.chip:focus-visible,
	.action:focus-visible {
		outline: 2px solid rgba(0, 210, 255, 0.55);
		outline-offset: 2px;
	}

	.action.primary {
		background: rgba(0, 210, 255, 0.18);
		border-color: rgba(0, 210, 255, 0.45);
	}

	.action.primary:hover:not(:disabled) {
		background: rgba(0, 210, 255, 0.28);
	}

	.action:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	input {
		background: var(--surface-input, rgba(255, 255, 255, 0.05));
		border: 1px solid var(--border-default, rgba(255, 255, 255, 0.12));
		border-radius: var(--radius-md, 0.55rem);
		padding: 0.55rem 0.65rem;
		color: var(--text-heading);
		font-size: 0.9rem;
		transition: border-color var(--duration-fast, 150ms) var(--ease-out, ease-out);
	}

	input:focus-visible {
		outline: none;
		border-color: rgba(0, 210, 255, 0.55);
		box-shadow: 0 0 0 2px rgba(0, 210, 255, 0.18);
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
		color: var(--color-danger, #ef4444);
		font-size: 0.84rem;
	}
</style>
