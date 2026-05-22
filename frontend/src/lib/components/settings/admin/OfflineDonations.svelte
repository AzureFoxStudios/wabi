<script lang="ts">
	import type { OfflineDonationLedgerEntry } from '$lib/api';

	export let canManageAdmin: boolean;
	export let adminOfflineDonationAudit: OfflineDonationLedgerEntry[];
	export let adminOfflineDonationAuditLoading: boolean;
	export let adminOfflineDonationAuditLoaded: boolean;
	export let adminOfflineDonationVoidingSettlementId: string;
	export let adminOfflineDonationSaving: boolean;
	export let offlineDonationAmountInput: string;
	export let offlineDonationCurrency: string;
	export let offlineDonationDonorLabel: string;
	export let offlineDonationDescription: string;
	export let onCreateOfflineDonation: () => void;
	export let onRefreshAudit: () => void;
	export let onVoid: (entry: OfflineDonationLedgerEntry) => void;
	export let onAmountInput: (value: string) => void;
	export let onCurrencyInput: (value: string) => void;
	export let onDonorLabelInput: (value: string) => void;
	export let onDescriptionInput: (value: string) => void;
	export let formatDonationAuditAmount: (amountMinor: number, currency: string) => string;
	export let formatDonationAuditWhen: (entry: OfflineDonationLedgerEntry) => string;
</script>

<div class="donation-audit-panel">
	<div class="donation-audit-header">
		<div>
			<h5>Offline / Manual Donations</h5>
			<p class="admin-help">Record in-person cash or off-platform donations here. These are visible in server donation transparency, but they are not provider-verified.</p>
		</div>
		<button
			class="action-btn"
			on:click={onRefreshAudit}
			disabled={adminOfflineDonationAuditLoading || adminOfflineDonationVoidingSettlementId !== '' || adminOfflineDonationSaving}
		>
			{adminOfflineDonationAuditLoading ? 'Refreshing...' : 'Refresh Offline Log'}
		</button>
	</div>
	<div class="offline-donation-form">
		<label class="upload-limit-row">
			<span>Amount</span>
			<input
				type="text"
				placeholder="10.00"
				value={offlineDonationAmountInput}
				on:input={(e) => onAmountInput((e.currentTarget as HTMLInputElement).value)}
				disabled={!canManageAdmin || adminOfflineDonationSaving}
			/>
		</label>
		<label class="upload-limit-row">
			<span>Currency</span>
			<input
				type="text"
				maxlength="3"
				placeholder="USD"
				value={offlineDonationCurrency}
				on:input={(e) => onCurrencyInput((e.currentTarget as HTMLInputElement).value)}
				disabled={!canManageAdmin || adminOfflineDonationSaving}
			/>
		</label>
		<label class="upload-limit-row">
			<span>Masked Donor Label</span>
			<input
				type="text"
				maxlength="120"
				placeholder="Dot"
				value={offlineDonationDonorLabel}
				on:input={(e) => onDonorLabelInput((e.currentTarget as HTMLInputElement).value)}
				disabled={!canManageAdmin || adminOfflineDonationSaving}
			/>
		</label>
		<label class="upload-limit-row">
			<span>Note</span>
			<input
				type="text"
				maxlength="280"
				placeholder="Paid in cash after local meetup"
				value={offlineDonationDescription}
				on:input={(e) => onDescriptionInput((e.currentTarget as HTMLInputElement).value)}
				disabled={!canManageAdmin || adminOfflineDonationSaving}
			/>
		</label>
	</div>
	<button class="action-btn" on:click={onCreateOfflineDonation} disabled={!canManageAdmin || adminOfflineDonationSaving}>
		{adminOfflineDonationSaving ? 'Recording...' : 'Record Offline Donation'}
	</button>
	{#if adminOfflineDonationAuditLoading && adminOfflineDonationAudit.length === 0}
		<p class="admin-help">Loading offline donation log...</p>
	{:else if adminOfflineDonationAudit.length === 0}
		<p class="admin-help">No offline donations recorded yet.</p>
	{:else}
		<div class="donation-audit-list">
			{#each adminOfflineDonationAudit as entry (entry.settlementId)}
				<div class="donation-audit-item">
					<div class="donation-audit-copy">
						<strong>{entry.donorLabel}</strong>
						<span>{formatDonationAuditAmount(entry.amountMinor, entry.currency)}</span>
						<small>{formatDonationAuditWhen(entry)} | {entry.status} | {entry.recordedByLabel || 'Admin record'}</small>
						{#if entry.description}
							<small>{entry.description}</small>
						{/if}
					</div>
					<button
						class="action-btn"
						disabled={!entry.canVoid || adminOfflineDonationVoidingSettlementId !== '' || !canManageAdmin}
						on:click={() => onVoid(entry)}
					>
						{adminOfflineDonationVoidingSettlementId === entry.settlementId ? 'Voiding...' : (entry.canVoid ? 'Void' : 'Closed')}
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>
