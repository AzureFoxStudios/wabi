<script lang="ts">
	import {
		getPaymentIntentStatusHelp,
		getPaymentIntentStatusLabel,
		getPaymentVerificationMode
	} from '$lib/payments/paymentRequestPresentation';
	import { formatMinorAmount } from '$lib/payments/paymentAmounts';
	import { formatExpiryTimestamp } from '$lib/payments/paymentSheetHelpers';
	import type { PaymentEvent, PaymentIntent, PaymentIntentStatus } from '$lib/api';

	export let activeIntent: PaymentIntent;
	export let activeEvents: PaymentEvent[] = [];
	export let presentation: Record<string, unknown> = {};
	export let presentationMode = '';
	export let qrDataUrl = '';
	export let isThaiQrIntent = false;
	export let targetHeaderLabel = '';
	export let terminalStatuses: Set<PaymentIntentStatus> = new Set();
	export let qrExternalConfirmationHint = '';
	export let onSaveQrImage: () => void = () => {};
	export let onSharePaymentTarget: () => void = () => {};
	export let onOpenSheetUrl: (url: string) => void = () => {};
	export let onCopyToClipboard: (text: string) => void = () => {};
	export let onRefreshIntent: (intentId: string, refresh: boolean) => void = () => {};
	export let onCancelIntent: () => void = () => {};
	export let onResetForNewIntent: () => void = () => {};

	$: qrImageSource =
		(typeof presentation.qrImageUrl === 'string' && presentation.qrImageUrl) || qrDataUrl || '';
</script>

<div class="intent-card">
	<div class="intent-header">
		<div class="intent-heading">
			<span class="status-light status-light-{activeIntent.status}"></span>
			<h3>{isThaiQrIntent ? 'PromptPay QR' : `Request ${activeIntent.intentId}`}</h3>
		</div>
		<span class="status status-{activeIntent.status}">{getPaymentIntentStatusLabel(activeIntent)}</span>
	</div>
	<p class="intent-meta">
		{formatMinorAmount(activeIntent.amountMinor, activeIntent.currency)} via {activeIntent.providerName}
		{#if targetHeaderLabel}
			• {targetHeaderLabel}
		{/if}
	</p>
	{#if formatExpiryTimestamp(activeIntent.expiresAt) && !terminalStatuses.has(activeIntent.status)}
		<p class="hint">Auto-expires at {formatExpiryTimestamp(activeIntent.expiresAt)}.</p>
	{/if}
	{#if getPaymentIntentStatusHelp(activeIntent)}
		<p class="hint emphasis">{getPaymentIntentStatusHelp(activeIntent)}</p>
	{/if}
	{#if activeIntent.failureMessage}
		<p class="error">{activeIntent.failureMessage}</p>
	{/if}

	{#if presentationMode === 'qr'}
		<div class="qr-block">
			{#if typeof presentation.qrImageUrl === 'string' && presentation.qrImageUrl}
				<img src={presentation.qrImageUrl} alt="Payment QR" class="qr-image" />
			{:else if qrDataUrl}
				<img src={qrDataUrl} alt="Payment QR" class="qr-image" />
			{:else}
				<p class="hint">QR payload available, image render failed.</p>
			{/if}
			<div class="link-actions">
				<button class="action" on:click={onSaveQrImage} disabled={!qrImageSource}>Save QR</button>
				<button class="action" on:click={onSharePaymentTarget}>Share payment</button>
			</div>
			{#if getPaymentVerificationMode(activeIntent) === 'external_confirmation'}
				<p class="hint emphasis">{qrExternalConfirmationHint}</p>
			{/if}
		</div>
	{:else if presentationMode === 'payment_link' || presentationMode === 'redirect'}
		{#if typeof presentation.url === 'string' && presentation.url}
			<div class="link-actions">
				<button class="action primary" on:click={() => onOpenSheetUrl(String(presentation.url))}>Open checkout link</button>
				<button class="action" on:click={() => onCopyToClipboard(String(presentation.url))}>Copy link</button>
				<button class="action" on:click={onSharePaymentTarget}>Share payment</button>
			</div>
		{/if}
	{:else if presentationMode === 'app_switch'}
		<div class="link-actions">
			{#if typeof presentation.deepLinkUrl === 'string' && presentation.deepLinkUrl}
				<button class="action primary" on:click={() => onOpenSheetUrl(String(presentation.deepLinkUrl))}>Open payment app</button>
			{/if}
			{#if typeof presentation.fallbackUrl === 'string' && presentation.fallbackUrl}
				<button class="action" on:click={() => onOpenSheetUrl(String(presentation.fallbackUrl))}>Open fallback link</button>
			{/if}
		</div>
	{:else if presentationMode === 'tap_to_pay'}
		<p class="hint">
			Tap-to-pay session:
			{typeof presentation.providerSessionId === 'string' ? presentation.providerSessionId : 'unknown'}
		</p>
	{/if}

	<div class="actions">
		<button class="action" on:click={() => onRefreshIntent(activeIntent.intentId, true)}>Refresh status</button>
		<button class="action" on:click={onCancelIntent} disabled={terminalStatuses.has(activeIntent.status)}>
			Cancel request
		</button>
		<button class="action" on:click={onResetForNewIntent}>New request</button>
	</div>

	{#if activeEvents.length > 0}
		<div class="events">
			<h4>Events</h4>
			<ul>
				{#each activeEvents as event}
					<li>
						<span>{event.eventType}</span>
						<span>{event.status || 'n/a'}</span>
						<time>{new Date(event.createdAt).toLocaleString()}</time>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
