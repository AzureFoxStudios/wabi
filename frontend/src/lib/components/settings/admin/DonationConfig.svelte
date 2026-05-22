<script lang="ts">
	import type {
		PaymentDonationConfig,
		PaymentProviderCapability,
		PaymentMethodCapability,
		PaymentDonationLedgerEntry
	} from '$lib/api';

	export let adminDonationConfig: PaymentDonationConfig;
	export let canManageAdmin: boolean;
	export let adminDonationConfigLoading: boolean;
	export let adminDonationConfigSaving: boolean;
	export let paymentProviderCapabilities: PaymentProviderCapability[];
	export let donationSuggestedAmountsInput: string;
	export let adminDonationSelectedProvider: PaymentProviderCapability | null;
	export let adminDonationMethods: PaymentMethodCapability[];
	export let adminDonationSelectedMethod: PaymentMethodCapability | null;
	export let adminDonationCurrencyOptions: string[];
	export let adminDonationCountryOptions: string[];
	export let donationRoutePreviewReady: boolean;
	export let adminDonationAudit: PaymentDonationLedgerEntry[];
	export let adminDonationAuditLoading: boolean;
	export let adminDonationAuditLoaded: boolean;
	export let adminDonationRefundingIntentId: string;
	export let onConfigChange: (config: PaymentDonationConfig) => void;
	export let onDonationAmountsInput: (value: string) => void;
	export let onSaveDonationConfig: () => void;
	export let onOpenServerDonation: () => void;
	export let onRefreshAudit: () => void;
	export let onRefund: (entry: PaymentDonationLedgerEntry) => void;
	export let formatDonationAuditAmount: (amountMinor: number, currency: string) => string;
	export let formatDonationAuditWhen: (entry: PaymentDonationLedgerEntry | { refundedAt?: number; completedAt?: number; createdAt?: number; status?: string }) => string;
	export let getDonationRouteSummaryList: (values: number[]) => string;
	export let parseSuggestedAmountsInput: (value: string) => number[];
	export let minorToMajorInput: (amountMinor: number, currency?: string) => string;
</script>

<div class="upload-limits-panel">
	<h4>Server Donations</h4>
	<p class="admin-help">Configure a single server donation route. Users will see transparency totals and a donate flow based on this setup.</p>
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Enable Donations</span>
			<span class="setting-description">Show the server donation entry and allow donation-tagged payment requests.</span>
		</div>
		<button
			class="toggle-btn"
			class:active={adminDonationConfig.enabled}
			on:click={() => onConfigChange({ ...adminDonationConfig, enabled: !adminDonationConfig.enabled })}
		>
			{adminDonationConfig.enabled ? 'ON' : 'OFF'}
		</button>
	</div>
	<div class="quality-mode-row">
		<label for="donation-provider-select">Donation Provider</label>
		<select
			id="donation-provider-select"
			class="theme-select"
			value={adminDonationConfig.providerPluginId || ''}
			on:change={(event) => {
				const providerPluginId = event.currentTarget.value || null;
				const selectedProvider = paymentProviderCapabilities.find((provider) => provider.pluginId === providerPluginId) || null;
				onConfigChange({
					...adminDonationConfig,
					providerPluginId,
					methodId: selectedProvider?.methods[0]?.id || null
				});
			}}
		>
			<option value="">Select provider</option>
			{#each paymentProviderCapabilities as provider}
				<option value={provider.pluginId}>{provider.providerName} ({provider.pluginId})</option>
			{/each}
		</select>
	</div>
	<div class="quality-mode-row">
		<label for="donation-method-select">Donation Method</label>
		<select
			id="donation-method-select"
			class="theme-select"
			value={adminDonationConfig.methodId || ''}
			on:change={(event) => onConfigChange({ ...adminDonationConfig, methodId: event.currentTarget.value || null })}
		>
			<option value="">Select method</option>
			{#each adminDonationMethods as method}
				<option value={method.id}>{method.label}</option>
			{/each}
		</select>
	</div>
	<div class="quality-mode-row">
		<label for="donation-currency-select">Currency</label>
		{#if adminDonationCurrencyOptions.length > 0}
			<select
				id="donation-currency-select"
				class="theme-select"
				value={adminDonationConfig.currency}
				on:change={(event) => onConfigChange({ ...adminDonationConfig, currency: event.currentTarget.value.toUpperCase() })}
			>
				{#each adminDonationCurrencyOptions as option}
					<option value={option}>{option}</option>
				{/each}
			</select>
		{:else}
			<input
				id="donation-currency-select"
				class="emoji-name-input"
				maxlength="3"
				value={adminDonationConfig.currency}
				on:input={(event) => onConfigChange({ ...adminDonationConfig, currency: event.currentTarget.value.toUpperCase() })}
			/>
		{/if}
	</div>
	<div class="quality-mode-row">
		<label for="donation-country-select">Country</label>
		{#if adminDonationCountryOptions.length > 0}
			<select
				id="donation-country-select"
				class="theme-select"
				value={adminDonationConfig.countryCode || ''}
				on:change={(event) => onConfigChange({ ...adminDonationConfig, countryCode: event.currentTarget.value.toUpperCase() || null })}
			>
				{#each adminDonationCountryOptions as option}
					<option value={option}>{option}</option>
				{/each}
			</select>
		{:else}
			<input
				id="donation-country-select"
				class="emoji-name-input"
				maxlength="2"
				value={adminDonationConfig.countryCode || ''}
				on:input={(event) => onConfigChange({ ...adminDonationConfig, countryCode: event.currentTarget.value.toUpperCase() || null })}
			/>
		{/if}
	</div>
	<div class="donation-audit-panel">
		<div class="donation-audit-header">
			<div>
				<h5>Public Donation Route Preview</h5>
				<p class="admin-help">This is the exact route the public donation sheet will use.</p>
			</div>
			<button class="action-btn" on:click={onOpenServerDonation}>
				Preview Public View
			</button>
		</div>
		<div class="donation-audit-list">
			<div class="donation-audit-item">
				<div class="donation-audit-copy">
					<strong>{adminDonationSelectedProvider?.providerName || 'No provider selected'}</strong>
					<span>{adminDonationSelectedMethod?.label || 'No method selected'}</span>
					<small>{adminDonationConfig.countryCode || 'Any country'} - {adminDonationConfig.currency || 'Any currency'}</small>
					<small>Suggested amounts: {getDonationRouteSummaryList(parseSuggestedAmountsInput(donationSuggestedAmountsInput))}</small>
					{#if adminDonationSelectedProvider?.notes}
						<small>{adminDonationSelectedProvider.notes}</small>
					{/if}
					{#if adminDonationSelectedMethod?.notes}
						<small>{adminDonationSelectedMethod.notes}</small>
					{/if}
				</div>
				<button
					class="action-btn"
					disabled={!donationRoutePreviewReady}
					on:click={onOpenServerDonation}
				>
					{donationRoutePreviewReady ? 'Route Ready' : 'Needs Setup'}
				</button>
			</div>
		</div>
	</div>
	<div class="quality-mode-row">
		<label for="donation-headline-input">Headline</label>
		<input
			id="donation-headline-input"
			class="emoji-name-input"
			maxlength="120"
			value={adminDonationConfig.headline}
			on:input={(event) => onConfigChange({ ...adminDonationConfig, headline: event.currentTarget.value })}
		/>
	</div>
	<div class="quality-mode-row">
		<label for="donation-description-input">Description</label>
		<input
			id="donation-description-input"
			class="emoji-name-input"
			maxlength="500"
			value={adminDonationConfig.description}
			on:input={(event) => onConfigChange({ ...adminDonationConfig, description: event.currentTarget.value })}
		/>
	</div>
	<div class="quality-mode-row">
		<label for="donation-amounts-input">Suggested Amounts</label>
		<input
			id="donation-amounts-input"
			class="emoji-name-input"
			placeholder="5, 10, 25"
			value={donationSuggestedAmountsInput}
			on:input={(event) => onDonationAmountsInput(event.currentTarget.value)}
		/>
	</div>
	<button class="action-btn" on:click={onSaveDonationConfig} disabled={!canManageAdmin || adminDonationConfigLoading || adminDonationConfigSaving}>
		{adminDonationConfigSaving ? 'Saving...' : 'Save Donation Settings'}
	</button>
	<div class="donation-audit-panel">
		<div class="donation-audit-header">
			<div>
				<h5>Donation Audit Trail</h5>
				<p class="admin-help">This covers server donations only. Direct user-to-user payments stay private.</p>
			</div>
			<button
				class="action-btn"
				on:click={onRefreshAudit}
				disabled={adminDonationAuditLoading || adminDonationRefundingIntentId !== ''}
			>
				{adminDonationAuditLoading ? 'Refreshing...' : 'Refresh Audit'}
			</button>
		</div>
		{#if adminDonationAuditLoading && adminDonationAudit.length === 0}
			<p class="admin-help">Loading donation audit trail...</p>
		{:else if adminDonationAudit.length === 0}
			<p class="admin-help">No donation activity yet.</p>
		{:else}
			<div class="donation-audit-list">
				{#each adminDonationAudit as entry (entry.intentId)}
					<div class="donation-audit-item">
						<div class="donation-audit-copy">
							<strong>{entry.donorLabel}</strong>
							<span>{formatDonationAuditAmount(entry.amountMinor, entry.currency)}</span>
							<small>{formatDonationAuditWhen(entry)} | {entry.status}</small>
						</div>
						<button
							class="action-btn"
							disabled={!entry.canRefund || adminDonationRefundingIntentId !== '' || !canManageAdmin}
							on:click={() => onRefund(entry)}
						>
							{adminDonationRefundingIntentId === entry.intentId ? 'Refunding...' : (entry.canRefund ? 'Refund' : 'Closed')}
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
