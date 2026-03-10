<script lang="ts">
	import BaseModal from './BaseModal.svelte';
	import { getAuthToken } from '$lib/authSession';
	import {
		cancelManualCashSettlement,
		confirmManualCashSettlement,
		createManualCashSettlement,
		disputeManualCashSettlement,
		listManualCashSettlements,
		type ManualCashSettlement
	} from '$lib/api';

	export let isOpen = false;
	export let onClose: () => void = () => {};
	export let channelId: string;
	export let targetLabel = 'Direct message';
	export let counterpartyLabel = 'Other user';
	export let overlayZIndex: number | string | null = null;

	let loading = false;
	let loaded = false;
	let error = '';
	let actionInfo = '';
	let settlements: ManualCashSettlement[] = [];
	let amountInput = '10.00';
	let currency = 'USD';
	let description = '';
	let creating = false;
	let actingSettlementId = '';

	$: if (isOpen && !loaded) {
		void loadSettlements();
	}

	$: if (!isOpen) {
		loaded = false;
		error = '';
		actionInfo = '';
		actingSettlementId = '';
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

	function formatDate(timestamp: number | null): string {
		if (!timestamp || !Number.isFinite(timestamp)) return 'n/a';
		return new Date(timestamp).toLocaleString();
	}

	function parseAmountMinor(value: string): number {
		const normalized = Number.parseFloat(value);
		if (!Number.isFinite(normalized) || normalized <= 0) return 0;
		return Math.round(normalized * 100);
	}

	async function loadSettlements(): Promise<void> {
		const token = getAuthToken();
		if (!token) {
			error = 'Sign in with a registered account to use manual cash trade tracking.';
			settlements = [];
			loaded = true;
			return;
		}

		loading = true;
		error = '';
		try {
			const response = await listManualCashSettlements(token, channelId, 100);
			settlements = response.items;
			loaded = true;
		} catch (loadError) {
			error = loadError instanceof Error ? loadError.message : 'Failed to load manual cash trades';
		} finally {
			loading = false;
		}
	}

	async function handleCreate(): Promise<void> {
		const token = getAuthToken();
		if (!token) {
			error = 'Sign in with a registered account to create a manual cash trade.';
			return;
		}
		const amountMinor = parseAmountMinor(amountInput);
		if (amountMinor <= 0) {
			error = 'Enter a valid amount.';
			return;
		}
		if (!/^[A-Za-z]{3}$/.test(currency.trim())) {
			error = 'Enter a valid 3-letter currency code.';
			return;
		}

		creating = true;
		error = '';
		actionInfo = '';
		try {
			const created = await createManualCashSettlement(token, {
				channelId,
				amountMinor,
				currency: currency.trim().toUpperCase(),
				description: description.trim() || undefined,
				metadata: {
					mode: 'manual_cash'
				}
			});
			settlements = [created, ...settlements.filter((item) => item.settlementId !== created.settlementId)];
			actionInfo = 'Manual cash trade created. Both people must confirm after the exchange happens.';
			description = '';
		} catch (createError) {
			error = createError instanceof Error ? createError.message : 'Failed to create manual cash trade';
		} finally {
			creating = false;
		}
	}

	async function runAction(
		settlementId: string,
		action: 'confirm' | 'cancel' | 'dispute'
	): Promise<void> {
		const token = getAuthToken();
		if (!token) {
			error = 'Sign in with a registered account to update a manual cash trade.';
			return;
		}

		actingSettlementId = settlementId;
		error = '';
		actionInfo = '';
		try {
			const updated =
				action === 'confirm'
					? await confirmManualCashSettlement(token, settlementId)
					: action === 'cancel'
						? await cancelManualCashSettlement(token, settlementId, 'Canceled from manual cash modal')
						: await disputeManualCashSettlement(token, settlementId, 'Flagged from manual cash modal');
			settlements = settlements.map((item) => (item.settlementId === settlementId ? updated : item));
			actionInfo =
				action === 'confirm'
					? 'Manual cash trade updated.'
					: action === 'cancel'
						? 'Manual cash trade canceled.'
						: 'Manual cash trade marked disputed.';
		} catch (actionErrorValue) {
			error = actionErrorValue instanceof Error ? actionErrorValue.message : 'Failed to update manual cash trade';
		} finally {
			actingSettlementId = '';
		}
	}
</script>

<BaseModal isOpen={isOpen} onClose={onClose} width="760px" {overlayZIndex}>
	<div slot="header" class="sheet-header">
		<h2>Manual Cash Trade</h2>
		<p>
			Trust-based cash tracking for <strong>{targetLabel}</strong>. Wabi cannot verify physical exchange. Only mark it
			complete after cash changed hands.
		</p>
	</div>

	<div class="sheet-body">
		<div class="trade-card">
			<h3>New Cash Trade</h3>
			<p class="hint">This stays private to you and {counterpartyLabel}.</p>
			<div class="grid">
				<label>
					<span>Amount</span>
					<input type="text" bind:value={amountInput} placeholder="10.00" />
				</label>
				<label>
					<span>Currency</span>
					<input type="text" bind:value={currency} maxlength="3" placeholder="USD" />
				</label>
			</div>
			<label>
				<span>Note (optional)</span>
				<input type="text" bind:value={description} maxlength="240" placeholder="Art print pickup / ramen / local trade" />
			</label>
			<div class="actions">
				<button class="action primary" on:click={handleCreate} disabled={creating}>
					{creating ? 'Creating...' : 'Create Cash Trade'}
				</button>
				<button class="action" on:click={loadSettlements} disabled={loading}>
					{loading ? 'Refreshing...' : 'Refresh'}
				</button>
			</div>
		</div>

		{#if actionInfo}
			<p class="info">{actionInfo}</p>
		{/if}
		{#if error}
			<p class="error">{error}</p>
		{/if}

		{#if loading}
			<p class="hint">Loading manual cash trades...</p>
		{/if}

		{#if !loading && settlements.length === 0}
			<p class="hint">No manual cash trades yet.</p>
		{/if}

		{#if settlements.length > 0}
			<div class="trade-list">
				{#each settlements as settlement (settlement.settlementId)}
					<div class="trade-card">
						<div class="trade-header">
							<div>
								<h3>{formatMinorAmount(settlement.amountMinor, settlement.currency)}</h3>
								<p class="hint">{formatDate(settlement.createdAt)}</p>
							</div>
							<span class="status-pill status-{settlement.status}">{settlement.status}</span>
						</div>

						{#if settlement.description}
							<p class="trade-copy">{settlement.description}</p>
						{/if}

						<div class="confirmation-grid">
							<div>
								<span class="label">{settlement.creatorLabel}</span>
								<strong>{settlement.creatorConfirmedAt ? 'Confirmed' : 'Pending'}</strong>
							</div>
							<div>
								<span class="label">{settlement.counterpartyLabel}</span>
								<strong>{settlement.counterpartyConfirmedAt ? 'Confirmed' : 'Pending'}</strong>
							</div>
						</div>

						{#if settlement.completedAt}
							<p class="hint">Completed {formatDate(settlement.completedAt)}</p>
						{/if}

						<div class="actions">
							<button
								class="action primary"
								on:click={() => runAction(settlement.settlementId, 'confirm')}
								disabled={!settlement.canConfirm || actingSettlementId === settlement.settlementId}
							>
								{actingSettlementId === settlement.settlementId && settlement.canConfirm ? 'Working...' : 'Confirm Cash Exchanged'}
							</button>
							<button
								class="action"
								on:click={() => runAction(settlement.settlementId, 'cancel')}
								disabled={!settlement.canCancel || actingSettlementId === settlement.settlementId}
							>
								Cancel
							</button>
							<button
								class="action"
								on:click={() => runAction(settlement.settlementId, 'dispute')}
								disabled={!settlement.canDispute || actingSettlementId === settlement.settlementId}
							>
								Dispute
							</button>
						</div>
					</div>
				{/each}
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

	.trade-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.trade-card {
		border: 1px solid rgba(255, 255, 255, 0.13);
		border-radius: 0.75rem;
		padding: 0.9rem;
		background: rgba(255, 255, 255, 0.03);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.trade-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.trade-header h3 {
		margin: 0;
		font-size: 0.98rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
	}

	.confirmation-grid {
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

	input {
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 0.55rem;
		padding: 0.55rem 0.65rem;
		color: var(--text-primary);
		font-size: 0.9rem;
	}

	.label {
		display: block;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.trade-copy,
	.hint,
	.error,
	.info {
		margin: 0;
	}

	.hint {
		font-size: 0.84rem;
		color: var(--text-secondary);
	}

	.error {
		color: #ff8585;
		font-size: 0.84rem;
	}

	.info {
		color: #7fd5ff;
		font-size: 0.84rem;
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

	.status-pill {
		font-size: 0.76rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 0.2rem 0.44rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.2);
	}

	.status-pending,
	.status-confirmed_by_creator,
	.status-confirmed_by_counterparty {
		color: #8cc7ff;
		border-color: rgba(140, 199, 255, 0.45);
	}

	.status-completed {
		color: #69e093;
		border-color: rgba(105, 224, 147, 0.45);
	}

	.status-canceled,
	.status-disputed {
		color: #ff8585;
		border-color: rgba(255, 133, 133, 0.45);
	}

	@media (max-width: 760px) {
		.grid,
		.confirmation-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
