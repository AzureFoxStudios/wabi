<script lang="ts">
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
		directReferenceTitle = 'Payment reference',
		directReferencePlaceholder = 'Payment reference',
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
			<p class="hint">Loading your saved {directReferenceTitle.toLowerCase()}...</p>
		{:else if selectedAccountLink && !showCustomCustomerRef}
			<p class="hint">Using {maskReference(selectedAccountLink.providerAccountRef)} for this QR request.</p>
		{:else}
			<p class="hint">
				{#if isThaiPromptPayDraft}
					Enter your own PromptPay number (Thai mobile or ID) for this request.
				{:else}
					Enter your own payment reference for this request.
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
					{showCustomCustomerRef ? 'Use saved PromptPay number' : 'Use different number'}
				</button>
			{/if}
			<button class="action" onclick={() => onManageConnections?.()}>
				{selectedAccountLink ? 'Edit in Saved References' : `Add ${directReferenceTitle}`}
			</button>
		</div>
	</div>
{:else}
	<div class="intent-card">
		<h3>Saved payment reference</h3>
		{#if accountLinksLoading}
			<p class="hint">Loading your saved payment references...</p>
		{:else if selectedAccountLink}
			<p class="hint">
				{brandName} will reuse
				<code>{selectedAccountLink.displayLabel || selectedAccountLink.providerAccountRef}</code>
				for this provider unless you turn on the one-off override below.
			</p>
		{:else}
			<p class="hint">
				No saved reference is attached to this provider yet. Add one in Settings only if this provider needs a reusable destination reference.
			</p>
		{/if}
		<div class="actions">
			<button class="action" onclick={() => onManageConnections?.()}>
				{selectedAccountLink ? 'Manage Saved References' : 'Add Reference in Settings'}
			</button>
		</div>
	</div>

	<div class="intent-card">
		<label class="checkbox-row">
			<input type="checkbox" bind:checked={showCustomCustomerRef} />
			<span>Use a one-off payment reference</span>
		</label>
		{#if showCustomCustomerRef}
			<label class="wide-field">
				<span>One-off payment reference</span>
				<input
					type="text"
					bind:value={customerRef}
					maxlength="120"
					placeholder="PromptPay number / wallet handle / PSP customer id"
				/>
			</label>
		{/if}
	</div>
{/if}
