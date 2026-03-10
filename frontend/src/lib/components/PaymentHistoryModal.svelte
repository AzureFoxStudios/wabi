<script lang="ts">
	import BaseModal from './BaseModal.svelte';
	import { getAuthToken } from '$lib/authSession';
	import { listPaymentHistory, type PaymentIntent } from '$lib/api';

	export let isOpen = false;
	export let onClose: () => void = () => {};
	export let onCreatePayment: () => void = () => {};
	export let overlayZIndex: number | string | null = null;

	let loading = false;
	let loaded = false;
	let error = '';
	let intents: PaymentIntent[] = [];

	$: if (isOpen && !loaded) {
		void loadHistory();
	}

	$: if (!isOpen) {
		loaded = false;
		error = '';
	}

	function formatAmount(intent: PaymentIntent): string {
		const value = intent.amountMinor / 100;
		try {
			return new Intl.NumberFormat(undefined, {
				style: 'currency',
				currency: intent.currency || 'USD',
				maximumFractionDigits: 2
			}).format(value);
		} catch {
			return `${value.toFixed(2)} ${intent.currency || ''}`.trim();
		}
	}

	function formatDate(timestamp: number | null): string {
		if (!timestamp || !Number.isFinite(timestamp)) return 'n/a';
		return new Date(timestamp).toLocaleString();
	}

	function escapeCsv(value: unknown): string {
		const normalized = value == null ? '' : String(value);
		if (/[",\n]/.test(normalized)) {
			return `"${normalized.replace(/"/g, '""')}"`;
		}
		return normalized;
	}

	function downloadFile(filename: string, content: string, mimeType: string): void {
		const blob = new Blob([content], { type: mimeType });
		const objectUrl = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = objectUrl;
		anchor.download = filename;
		anchor.click();
		URL.revokeObjectURL(objectUrl);
	}

	async function loadHistory(): Promise<void> {
		const token = getAuthToken();
		if (!token) {
			error = 'Sign in with a registered account to view payment history.';
			intents = [];
			loaded = true;
			return;
		}

		loading = true;
		error = '';
		try {
			const response = await listPaymentHistory(token, 250);
			intents = response.intents;
			loaded = true;
		} catch (loadError) {
			error = loadError instanceof Error ? loadError.message : 'Failed to load payment history';
		} finally {
			loading = false;
		}
	}

	function exportJson(): void {
		downloadFile(
			`wabi-payments-${Date.now()}.json`,
			JSON.stringify(intents, null, 2),
			'application/json;charset=utf-8'
		);
	}

	function exportCsv(): void {
		const headers = [
			'intentId',
			'status',
			'amountMinor',
			'currency',
			'providerName',
			'pluginId',
			'countryCode',
			'channelId',
			'description',
			'customerRef',
			'createdAt',
			'completedAt',
			'refundedAt',
			'failureMessage'
		];
		const rows = intents.map((intent) =>
			[
				intent.intentId,
				intent.status,
				intent.amountMinor,
				intent.currency,
				intent.providerName,
				intent.pluginId,
				intent.countryCode || '',
				intent.channelId || '',
				intent.description || '',
				intent.customerRef || '',
				intent.createdAt,
				intent.completedAt || '',
				intent.refundedAt || '',
				intent.failureMessage || ''
			]
				.map(escapeCsv)
				.join(',')
		);
		downloadFile(
			`wabi-payments-${Date.now()}.csv`,
			`${headers.join(',')}\n${rows.join('\n')}`,
			'text/csv;charset=utf-8'
		);
	}
</script>

<BaseModal isOpen={isOpen} onClose={onClose} width="820px" {overlayZIndex}>
	<div slot="header" class="sheet-header">
		<h2>My Payments</h2>
		<p>History of payment requests you created from this account, with export for record-keeping.</p>
	</div>

	<div class="sheet-body">
		<div class="actions">
			<button class="action" on:click={loadHistory} disabled={loading}>
				{loading ? 'Refreshing...' : 'Refresh'}
			</button>
			<button class="action" on:click={exportJson} disabled={intents.length === 0}>
				Export JSON
			</button>
			<button class="action" on:click={exportCsv} disabled={intents.length === 0}>
				Export CSV
			</button>
			<button class="action primary" on:click={onCreatePayment}>
				New Payment Request
			</button>
		</div>

		{#if loading}
			<p class="hint">Loading payment history...</p>
		{/if}

		{#if error}
			<p class="error">{error}</p>
		{/if}

		{#if !loading && !error && intents.length === 0}
			<p class="hint">No payment requests yet. When you create one, it will appear here.</p>
		{/if}

		{#if intents.length > 0}
			<p class="hint">{intents.length} payment request{intents.length === 1 ? '' : 's'} loaded.</p>
			<div class="history-list">
				{#each intents as intent (intent.intentId)}
					<div class="history-card">
						<div class="history-header">
							<div>
								<h3>{formatAmount(intent)}</h3>
								<p class="history-meta">
									{intent.providerName} · {intent.pluginId} · {formatDate(intent.createdAt)}
								</p>
							</div>
							<span class="status-pill status-{intent.status}">{intent.status}</span>
						</div>

						<div class="history-grid">
							<div>
								<span class="label">Intent</span>
								<code>{intent.intentId}</code>
							</div>
							<div>
								<span class="label">Channel</span>
								<span>{intent.channelId || 'Direct / none'}</span>
							</div>
							<div>
								<span class="label">Country</span>
								<span>{intent.countryCode || 'n/a'}</span>
							</div>
							<div>
								<span class="label">Customer Ref</span>
								<span>{intent.customerRef || 'n/a'}</span>
							</div>
						</div>

						{#if intent.description}
							<p class="history-copy">{intent.description}</p>
						{/if}

						{#if intent.failureMessage}
							<p class="error">{intent.failureMessage}</p>
						{/if}
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

	.history-list {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}

	.history-card {
		border: 1px solid rgba(255, 255, 255, 0.13);
		border-radius: 0.75rem;
		padding: 0.9rem;
		background: rgba(255, 255, 255, 0.03);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.history-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
	}

	.history-header h3 {
		margin: 0;
		font-size: 1rem;
	}

	.history-meta {
		margin: 0.2rem 0 0;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.history-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
	}

	.history-grid div {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.84rem;
	}

	.label {
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-size: 0.74rem;
	}

	.history-copy {
		margin: 0;
		font-size: 0.88rem;
		color: var(--text-primary);
	}

	.status-pill {
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
	.status-disputed,
	.status-canceled {
		color: #ff8585;
		border-color: rgba(255, 133, 133, 0.45);
	}

	.status-pending,
	.status-draft,
	.status-refunded {
		color: #8cc7ff;
		border-color: rgba(140, 199, 255, 0.45);
	}

	@media (max-width: 760px) {
		.history-header {
			flex-direction: column;
			align-items: flex-start;
		}

		.history-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
