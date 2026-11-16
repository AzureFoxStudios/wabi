<script lang="ts">
	import { _ } from '$lib/i18n';
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
			<h5>{$_('offline_donations.title')}</h5>
			<p class="admin-help">{$_('offline_donations.help')}</p>
		</div>
		<button
			class="action-btn"
			on:click={onRefreshAudit}
			disabled={adminOfflineDonationAuditLoading || adminOfflineDonationVoidingSettlementId !== '' || adminOfflineDonationSaving}
		>
			{adminOfflineDonationAuditLoading ? $_('offline_donations.refreshing') : $_('offline_donations.refresh_log')}
		</button>
	</div>
	<div class="offline-donation-form">
		<label class="upload-limit-row">
			<span>{$_('offline_donations.amount')}</span>
			<input
				type="text"
				placeholder="10.00"
				value={offlineDonationAmountInput}
				on:input={(e) => onAmountInput((e.currentTarget as HTMLInputElement).value)}
				disabled={!canManageAdmin || adminOfflineDonationSaving}
			/>
		</label>
		<label class="upload-limit-row">
			<span>{$_('offline_donations.currency')}</span>
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
			<span>{$_('offline_donations.donor_label')}</span>
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
			<span>{$_('user.popout.note')}</span>
			<input
				type="text"
				maxlength="280"
				placeholder={$_('offline_donations.note_placeholder')}
				value={offlineDonationDescription}
				on:input={(e) => onDescriptionInput((e.currentTarget as HTMLInputElement).value)}
				disabled={!canManageAdmin || adminOfflineDonationSaving}
			/>
		</label>
	</div>
	<button class="action-btn" on:click={onCreateOfflineDonation} disabled={!canManageAdmin || adminOfflineDonationSaving}>
		{adminOfflineDonationSaving ? $_('offline_donations.recording') : $_('offline_donations.record_btn')}
	</button>
	{#if adminOfflineDonationAuditLoading && adminOfflineDonationAudit.length === 0}
		<p class="admin-help">{$_('offline_donations.loading_log')}</p>
	{:else if adminOfflineDonationAudit.length === 0}
		<p class="admin-help">{$_('offline_donations.empty')}</p>
	{:else}
		<div class="donation-audit-list">
			{#each adminOfflineDonationAudit as entry (entry.settlementId)}
				<div class="donation-audit-item">
					<div class="donation-audit-copy">
						<strong>{entry.donorLabel}</strong>
						<span>{formatDonationAuditAmount(entry.amountMinor, entry.currency)}</span>
						<small>{formatDonationAuditWhen(entry)} | {entry.status} | {entry.recordedByLabel || $_('offline_donations.admin_record')}</small>
						{#if entry.description}
							<small>{entry.description}</small>
						{/if}
					</div>
					<button
						class="action-btn"
						disabled={!entry.canVoid || adminOfflineDonationVoidingSettlementId !== '' || !canManageAdmin}
						on:click={() => onVoid(entry)}
					>
						{adminOfflineDonationVoidingSettlementId === entry.settlementId ? $_('offline_donations.voiding') : (entry.canVoid ? $_('offline_donations.void') : $_('login.wizard.join_closed_label'))}
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>
