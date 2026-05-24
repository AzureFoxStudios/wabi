<script lang="ts">
	import type { PaymentAccountLink } from '$lib/api';
	import { maskReference } from '$lib/payments/paymentSheetHelpers';

	export let selectedAccountLink: PaymentAccountLink | null = null;
	export let accountLinksLoading = false;
	export let isDirectReferenceDraft = false;
	export let isServerDonationDraft = false;
	export let isThaiPromptPayDraft = false;
	export let isBitcoinQrDraft = false;
	export let showCustomCustomerRef = false;
	export let customerRef = '';
	export let directReferenceTitle = 'Payment reference';
	export let directReferencePlaceholder = 'Payment reference';
	export let onManageConnections: () => void = () => {};
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
					Enter your own PromptPay number or registered PromptPay ID for this request.
				{:else if isBitcoinQrDraft}
					Enter your own Bitcoin address for this request.
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
				<button class="action" on:click={() => (showCustomCustomerRef = !showCustomCustomerRef)}>
					{#if isThaiPromptPayDraft}
						{showCustomCustomerRef ? 'Use saved PromptPay number' : 'Use different number'}
					{:else}
						{showCustomCustomerRef ? 'Use saved Bitcoin address' : 'Use different address'}
					{/if}
				</button>
			{/if}
			<button class="action" on:click={onManageConnections}>
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
				Wabi will reuse
				<code>{selectedAccountLink.displayLabel || selectedAccountLink.providerAccountRef}</code>
				for this provider unless you turn on the one-off override below.
			</p>
		{:else}
			<p class="hint">
				No saved reference is attached to this provider yet. Add one in Settings only if this provider needs a reusable destination reference.
			</p>
		{/if}
		<div class="actions">
			<button class="action" on:click={onManageConnections}>
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
