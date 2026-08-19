<script lang="ts">
	import type {
		PaymentMethodCapability,
		PaymentProviderCapability
	} from '$lib/api';
	import type { RoutePreset } from '$lib/payments/paymentSheetHelpers';

	let {
		routePresets = [],
		selectedRoutePreset = null,
		showAdvancedRouting = $bindable(false),
		providers = [],
		selectedProviderId = $bindable(''),
		eligibleProviderMethods = [],
		selectedMethodId = $bindable(''),
		amountInput = $bindable(''),
		providerCurrencyOptions = [],
		currency = $bindable(''),
		providerCountryOptions = [],
		countryCode = $bindable(''),
		selectedProvider = null,
		selectedMethod = null,
		isThaiPromptPayDraft = false,
		shouldShowProviderPicker = false,
		shouldShowMethodPicker = false,
		shouldShowCurrencyPicker = false,
		shouldShowCountryPicker = false,
		draftMethodBehaviorNote = null,
		onApplyRoutePreset
	}: {
		routePresets?: RoutePreset[];
		selectedRoutePreset?: RoutePreset | null;
		showAdvancedRouting?: boolean;
		providers?: PaymentProviderCapability[];
		selectedProviderId?: string;
		eligibleProviderMethods?: PaymentMethodCapability[];
		selectedMethodId?: string;
		amountInput?: string;
		providerCurrencyOptions?: string[];
		currency?: string;
		providerCountryOptions?: string[];
		countryCode?: string;
		selectedProvider?: PaymentProviderCapability | null;
		selectedMethod?: PaymentMethodCapability | null;
		isThaiPromptPayDraft?: boolean;
		shouldShowProviderPicker?: boolean;
		shouldShowMethodPicker?: boolean;
		shouldShowCurrencyPicker?: boolean;
		shouldShowCountryPicker?: boolean;
		draftMethodBehaviorNote?: string | null;
		onApplyRoutePreset?: (preset: RoutePreset) => void;
	} = $props();
</script>

{#if routePresets.length > 1}
	<div class="route-picker">
		<div class="route-picker-header">
			<h3>Pay with</h3>
			<button class="action subtle" type="button" onclick={() => (showAdvancedRouting = !showAdvancedRouting)}>
				{showAdvancedRouting ? 'Hide manual routing' : 'Adjust manually'}
			</button>
		</div>
		<div class="route-preset-list">
			{#each routePresets as preset (preset.key)}
				<button
					type="button"
					class="route-preset"
					class:active={selectedRoutePreset?.key === preset.key}
					onclick={() => onApplyRoutePreset?.(preset)}
				>
					<span class="route-flag">{preset.flag}</span>
					<span class="route-label">{preset.label}</span>
				</button>
			{/each}
		</div>
	</div>
{/if}

<div class="grid">
	{#if shouldShowProviderPicker}
		<label>
			<span>Provider</span>
			<select bind:value={selectedProviderId} disabled={providers.length === 0}>
				{#each providers as provider (provider.pluginId)}
					<option value={provider.pluginId}>{provider.providerName}</option>
				{/each}
			</select>
		</label>
	{/if}

	{#if shouldShowMethodPicker}
		<label>
			<span>Method</span>
			<select bind:value={selectedMethodId} disabled={eligibleProviderMethods.length === 0}>
				{#each eligibleProviderMethods as method (method.id)}
					<option value={method.id}>{method.label}</option>
				{/each}
			</select>
		</label>
	{/if}

	<label>
		<span>Amount</span>
		<input class="amount-input" type="text" bind:value={amountInput} placeholder="100.00" inputmode="decimal" />
	</label>

	{#if shouldShowCurrencyPicker}
		<label>
			<span>Currency</span>
			{#if providerCurrencyOptions.length > 0}
				<select bind:value={currency} disabled={providerCurrencyOptions.length <= 1}>
					{#each providerCurrencyOptions as providerCurrency (providerCurrency)}
						<option value={providerCurrency}>{providerCurrency}</option>
					{/each}
				</select>
			{:else}
				<input type="text" bind:value={currency} maxlength="3" placeholder="Auto" />
			{/if}
		</label>
	{/if}

	{#if shouldShowCountryPicker}
		<label>
			<span>Country</span>
			{#if providerCountryOptions.length > 0}
				<select bind:value={countryCode} disabled={providerCountryOptions.length <= 1}>
					{#each providerCountryOptions as providerCountry (providerCountry)}
						<option value={providerCountry}>{providerCountry}</option>
					{/each}
				</select>
			{:else}
				<input type="text" bind:value={countryCode} maxlength="2" placeholder="Auto" />
			{/if}
		</label>
	{/if}
</div>

{#if !shouldShowCurrencyPicker || !shouldShowCountryPicker || !shouldShowMethodPicker}
	<div class="compact-summary">
		{#if selectedProvider}
			<span>{selectedProvider.providerName}</span>
		{/if}
		{#if selectedMethod}
			<span>{selectedMethod.label}</span>
		{/if}
		{#if currency}
			<span>{currency}</span>
		{/if}
		{#if countryCode}
			<span>{countryCode}</span>
		{/if}
	</div>
{/if}

{#if selectedProvider?.notes && !isThaiPromptPayDraft}
	<p class="hint">{selectedProvider.notes}</p>
{/if}

{#if selectedMethod?.notes && !isThaiPromptPayDraft}
	<p class="hint">Method note: {selectedMethod.notes}</p>
{/if}

{#if draftMethodBehaviorNote && !isThaiPromptPayDraft}
	<p class="hint emphasis">{draftMethodBehaviorNote}</p>
{/if}

{#if selectedProvider && eligibleProviderMethods.length === 0}
	<p class="hint">No method is currently eligible for this amount and provider combination. Try a different amount or provider.</p>
{/if}
