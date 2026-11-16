<script lang="ts">
	import { _ } from '$lib/i18n';
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
	<h4>{$_('donation_config.title')}</h4>
	<p class="admin-help">{$_('donation_config.help')}</p>
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">{$_('donation_config.enable_label')}</span>
			<span class="setting-description">{$_('donation_config.enable_desc')}</span>
		</div>
		<button
			class="toggle-btn"
			class:active={adminDonationConfig.enabled}
			on:click={() => onConfigChange({ ...adminDonationConfig, enabled: !adminDonationConfig.enabled })}
		>
			{adminDonationConfig.enabled ? $_('donation_config.on') : $_('donation_config.off')}
		</button>
	</div>
	<div class="quality-mode-row">
		<label for="donation-provider-select">{$_('donation_config.provider_label')}</label>
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
			<option value="">{$_('donation_config.select_provider')}</option>
			{#each paymentProviderCapabilities as provider}
				<option value={provider.pluginId}>{provider.providerName} ({provider.pluginId})</option>
			{/each}
		</select>
	</div>
	<div class="quality-mode-row">
		<label for="donation-method-select">{$_('donation_config.method_label')}</label>
		<select
			id="donation-method-select"
			class="theme-select"
			value={adminDonationConfig.methodId || ''}
			on:change={(event) => onConfigChange({ ...adminDonationConfig, methodId: event.currentTarget.value || null })}
		>
			<option value="">{$_('donation_config.select_method')}</option>
			{#each adminDonationMethods as method}
				<option value={method.id}>{method.label}</option>
			{/each}
		</select>
	</div>
	<div class="quality-mode-row">
		<label for="donation-currency-select">{$_('donation_config.currency')}</label>
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
		<label for="donation-country-select">{$_('donation_config.country')}</label>
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
				<h5>{$_('donation_config.preview_title')}</h5>
				<p class="admin-help">{$_('donation_config.preview_help')}</p>
			</div>
			<button class="action-btn" on:click={onOpenServerDonation}>
				{$_('donation_config.preview_btn')}
			</button>
		</div>
		<div class="donation-audit-list">
			<div class="donation-audit-item">
				<div class="donation-audit-copy">
					<strong>{adminDonationSelectedProvider?.providerName || $_('donation_config.no_provider')}</strong>
					<span>{adminDonationSelectedMethod?.label || $_('donation_config.no_method')}</span>
					<small>{adminDonationConfig.countryCode || $_('donation_config.any_country')} - {adminDonationConfig.currency || $_('donation_config.any_currency')}</small>
					<small>{$_('donation_config.suggested_amounts')}: {getDonationRouteSummaryList(parseSuggestedAmountsInput(donationSuggestedAmountsInput))}</small>
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
					{donationRoutePreviewReady ? $_('donation_config.route_ready') : $_('donation_config.needs_setup')}
				</button>
			</div>
		</div>
	</div>
	<div class="quality-mode-row">
		<label for="donation-headline-input">{$_('donation_config.headline')}</label>
		<input
			id="donation-headline-input"
			class="emoji-name-input"
			maxlength="120"
			value={adminDonationConfig.headline}
			on:input={(event) => onConfigChange({ ...adminDonationConfig, headline: event.currentTarget.value })}
		/>
	</div>
	<div class="quality-mode-row">
		<label for="donation-description-input">{$_('donation_config.description')}</label>
		<input
			id="donation-description-input"
			class="emoji-name-input"
			maxlength="500"
			value={adminDonationConfig.description}
			on:input={(event) => onConfigChange({ ...adminDonationConfig, description: event.currentTarget.value })}
		/>
	</div>
	<div class="quality-mode-row">
		<label for="donation-amounts-input">{$_('donation_config.amounts_label')}</label>
		<input
			id="donation-amounts-input"
			class="emoji-name-input"
			placeholder="5, 10, 25"
			value={donationSuggestedAmountsInput}
			on:input={(event) => onDonationAmountsInput(event.currentTarget.value)}
		/>
	</div>
	<button class="action-btn" on:click={onSaveDonationConfig} disabled={!canManageAdmin || adminDonationConfigLoading || adminDonationConfigSaving}>
		{adminDonationConfigSaving ? $_('donation_config.saving') : $_('donation_config.save_btn')}
	</button>
	<div class="donation-audit-panel">
		<div class="donation-audit-header">
			<div>
				<h5>{$_('donation_config.audit_title')}</h5>
				<p class="admin-help">{$_('donation_config.audit_help')}</p>
			</div>
			<button
				class="action-btn"
				on:click={onRefreshAudit}
				disabled={adminDonationAuditLoading || adminDonationRefundingIntentId !== ''}
			>
				{adminDonationAuditLoading ? $_('donation_config.refreshing') : $_('donation_config.refresh_audit')}
			</button>
		</div>
		{#if adminDonationAuditLoading && adminDonationAudit.length === 0}
			<p class="admin-help">{$_('donation_config.audit_loading')}</p>
		{:else if adminDonationAudit.length === 0}
			<p class="admin-help">{$_('donation_config.audit_empty')}</p>
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
							{adminDonationRefundingIntentId === entry.intentId ? $_('donation_config.refunding') : (entry.canRefund ? $_('donation_config.refund') : $_('login.wizard.join_closed_label'))}
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
