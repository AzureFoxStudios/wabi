<script lang="ts">
	import type {
		PaymentMethodCapability,
		PaymentProviderCapability
	} from '$lib/api';
	import type { RoutePreset } from '$lib/payments/paymentSheetHelpers';

	export let routePresets: RoutePreset[] = [];
	export let selectedRoutePreset: RoutePreset | null = null;
	export let showAdvancedRouting = false;
	export let providers: PaymentProviderCapability[] = [];
	export let selectedProviderId = '';
	export let eligibleProviderMethods: PaymentMethodCapability[] = [];
	export let selectedMethodId = '';
	export let amountInput = '';
	export let providerCurrencyOptions: string[] = [];
	export let currency = '';
	export let providerCountryOptions: string[] = [];
	export let countryCode = '';
	export let selectedProvider: PaymentProviderCapability | null = null;
	export let selectedMethod: PaymentMethodCapability | null = null;
	export let isThaiPromptPayDraft = false;
	export let shouldShowProviderPicker = false;
	export let shouldShowMethodPicker = false;
	export let shouldShowCurrencyPicker = false;
	export let shouldShowCountryPicker = false;
	export let draftMethodBehaviorNote: string | null = null;
	export let onApplyRoutePreset: (preset: RoutePreset) => void = () => {};
</script>

{#if routePresets.length > 1}
	<div class="route-picker">
		<div class="route-picker-header">
			<h3>Pay with</h3>
			<button class="action subtle" type="button" on:click={() => (showAdvancedRouting = !showAdvancedRouting)}>
				{showAdvancedRouting ? 'Hide manual routing' : 'Adjust manually'}
			</button>
		</div>
		<div class="route-preset-list">
			{#each routePresets as preset}
				<button
					type="button"
					class="route-preset"
					class:active={selectedRoutePreset?.key === preset.key}
					on:click={() => onApplyRoutePreset(preset)}
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
				{#each providers as provider}
					<option value={provider.pluginId}>{provider.providerName}</option>
				{/each}
			</select>
		</label>
	{/if}

	{#if shouldShowMethodPicker}
		<label>
			<span>Method</span>
			<select bind:value={selectedMethodId} disabled={eligibleProviderMethods.length === 0}>
				{#each eligibleProviderMethods as method}
					<option value={method.id}>{method.label}</option>
				{/each}
			</select>
		</label>
	{/if}

	<label>
		<span>Amount</span>
		<input class="amount-input" type="text" bind:value={amountInput} placeholder="100.00" />
	</label>

	{#if shouldShowCurrencyPicker}
		<label>
			<span>Currency</span>
			{#if providerCurrencyOptions.length > 0}
				<select bind:value={currency} disabled={providerCurrencyOptions.length <= 1}>
					{#each providerCurrencyOptions as providerCurrency}
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
					{#each providerCountryOptions as providerCountry}
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
