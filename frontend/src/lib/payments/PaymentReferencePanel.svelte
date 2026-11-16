<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { PaymentAccountLink } from '$lib/api';
	import { brandName } from '$lib/branding';
	import { maskReference } from '$lib/payments/paymentSheetHelpers';

	let {
		selectedAccountLink = null,
		accountLinksLoading = false,
		isDirectReferenceDraft = false,
		isServerDonationDraft = false,
		isThaiPromptPayDraft = false,
		showCustomCustomerRef = $bindable(false),
		customerRef = $bindable(''),
		directReferenceTitle = $_('payment_ref.title'),
		directReferencePlaceholder = $_('payment_ref.title'),
		onManageConnections
	}: {
		selectedAccountLink?: PaymentAccountLink | null;
		accountLinksLoading?: boolean;
		isDirectReferenceDraft?: boolean;
		isServerDonationDraft?: boolean;
		isThaiPromptPayDraft?: boolean;
		showCustomCustomerRef?: boolean;
		customerRef?: string;
		directReferenceTitle?: string;
		directReferencePlaceholder?: string;
		onManageConnections?: () => void;
	} = $props();
</script>

{#if isDirectReferenceDraft && !isServerDonationDraft}
	<div class="intent-card">
		<h3>{directReferenceTitle}</h3>
		{#if accountLinksLoading}
			<p class="hint">{$_('payment_ref.loading_saved', { values: { title: directReferenceTitle.toLowerCase() } })}</p>
		{:else if selectedAccountLink && !showCustomCustomerRef}
			<p class="hint">{$_('payment_ref.using', { values: { ref: maskReference(selectedAccountLink.providerAccountRef) } })}</p>
		{:else}
			<p class="hint">
				{#if isThaiPromptPayDraft}
					{$_('payment_ref.enter_promptpay')}
				{:else}
					{$_('payment_ref.enter_reference')}
				{/if}
			</p>
		{/if}
		{#if !selectedAccountLink || showCustomCustomerRef}
			<label class="wide-field">
				<span>{directReferenceTitle}</span>
				<input
					type="text"
					bind:value={customerRef}
					maxlength="120"
					placeholder={directReferencePlaceholder}
				/>
			</label>
		{/if}
		<div class="actions">
			{#if selectedAccountLink}
				<button class="action" onclick={() => (showCustomCustomerRef = !showCustomCustomerRef)}>
					{showCustomCustomerRef ? $_('payment_ref.use_saved_promptpay') : $_('payment_ref.use_different')}
				</button>
			{/if}
			<button class="action" onclick={() => onManageConnections?.()}>
				{selectedAccountLink ? $_('payment_ref.edit_saved') : $_('payment_ref.add', { values: { title: directReferenceTitle } })}
			</button>
		</div>
	</div>
{:else}
	<div class="intent-card">
		<h3>{$_('payment_ref.saved_heading')}</h3>
		{#if accountLinksLoading}
			<p class="hint">{$_('payment_ref.loading_refs')}</p>
		{:else if selectedAccountLink}
			<p class="hint">
				{$_('payment_ref.reuse_intro', { values: { brand: brandName } })}
				<code>{selectedAccountLink.displayLabel || selectedAccountLink.providerAccountRef}</code>
				{$_('payment_ref.reuse_rest')}
			</p>
		{:else}
			<p class="hint">
				{$_('payment_ref.none_attached')}
			</p>
		{/if}
		<div class="actions">
			<button class="action" onclick={() => onManageConnections?.()}>
				{selectedAccountLink ? $_('payment_ref.manage_saved') : $_('payment_ref.add_in_settings')}
			</button>
		</div>
	</div>

	<div class="intent-card">
		<label class="checkbox-row">
			<input type="checkbox" bind:checked={showCustomCustomerRef} />
			<span>{$_('payment_ref.one_off_toggle')}</span>
		</label>
		{#if showCustomCustomerRef}
			<label class="wide-field">
				<span>{$_('payment_ref.one_off_label')}</span>
				<input
					type="text"
					bind:value={customerRef}
					maxlength="120"
					placeholder={$_('payment_ref.one_off_placeholder')}
				/>
			</label>
		{/if}
	</div>
{/if}
