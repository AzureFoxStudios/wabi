<script lang="ts">
	import { _ } from '$lib/i18n';
	import {
		getPaymentIntentStatusHelp,
		getPaymentIntentStatusLabel,
		getPaymentVerificationMode
	} from '$lib/payments/paymentRequestPresentation';
	import { formatMinorAmount } from '$lib/payments/paymentAmounts';
	import { formatExpiryTimestamp } from '$lib/payments/paymentSheetHelpers';
	import type { PaymentEvent, PaymentIntent, PaymentIntentStatus } from '$lib/api';

	let {
		activeIntent,
		activeEvents = [],
		presentation = {},
		presentationMode = '',
		qrDataUrl = '',
		isThaiQrIntent = false,
		targetHeaderLabel = '',
		terminalStatuses = new Set<PaymentIntentStatus>(),
		qrExternalConfirmationHint = '',
		onSaveQrImage,
		onSharePaymentTarget,
		onOpenSheetUrl,
		onCopyToClipboard,
		onRefreshIntent,
		onResetForNewIntent
	}: {
		activeIntent: PaymentIntent;
		activeEvents?: PaymentEvent[];
		presentation?: Record<string, unknown>;
		presentationMode?: string;
		qrDataUrl?: string;
		isThaiQrIntent?: boolean;
		targetHeaderLabel?: string;
		terminalStatuses?: Set<PaymentIntentStatus>;
		qrExternalConfirmationHint?: string;
		onSaveQrImage?: () => void;
		onSharePaymentTarget?: () => void;
		onOpenSheetUrl?: (url: string) => void;
		onCopyToClipboard?: (text: string) => void;
		onRefreshIntent?: (intentId: string, refresh: boolean) => void;
		onResetForNewIntent?: () => void;
	} = $props();

	const qrImageSource = $derived(
		(typeof presentation.qrImageUrl === 'string' && presentation.qrImageUrl) || qrDataUrl || ''
	);
</script>

<div class="intent-card">
	<div class="intent-header">
		<div class="intent-heading">
			<span class="status-light status-light-{activeIntent.status}"></span>
			<h3>{isThaiQrIntent ? 'PromptPay QR' : $_('payment_intent.request_title', { values: { id: activeIntent.intentId } })}</h3>
		</div>
		<span class="status status-{activeIntent.status}">{getPaymentIntentStatusLabel(activeIntent)}</span>
	</div>
	<p class="intent-meta">
		{formatMinorAmount(activeIntent.amountMinor, activeIntent.currency)} {$_('payment_intent.via', { values: { provider: activeIntent.providerName } })}
		{#if targetHeaderLabel}
			• {targetHeaderLabel}
		{/if}
	</p>
	{#if formatExpiryTimestamp(activeIntent.expiresAt) && !terminalStatuses.has(activeIntent.status)}
		<p class="hint">{$_('payment_intent.auto_expires', { values: { time: formatExpiryTimestamp(activeIntent.expiresAt) } })}</p>
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
				<img src={presentation.qrImageUrl} alt={$_('payment_intent.qr_alt')} class="qr-image" />
			{:else if qrDataUrl}
				<img src={qrDataUrl} alt={$_('payment_intent.qr_alt')} class="qr-image" />
			{:else}
				<p class="hint">{$_('payment_intent.qr_unavailable')}</p>
			{/if}
			<div class="link-actions">
				<button class="action" onclick={() => onSaveQrImage?.()} disabled={!qrImageSource}>{$_('payment_intent.save_qr')}</button>
				<button class="action" onclick={() => onSharePaymentTarget?.()}>{$_('payment_intent.share_payment')}</button>
			</div>
			{#if getPaymentVerificationMode(activeIntent) === 'external_confirmation'}
				<p class="hint emphasis">{qrExternalConfirmationHint}</p>
			{/if}
		</div>
	{:else if presentationMode === 'payment_link' || presentationMode === 'redirect'}
		{#if typeof presentation.url === 'string' && presentation.url}
			<div class="link-actions">
				<button class="action primary" onclick={() => onOpenSheetUrl?.(String(presentation.url))}>{$_('payment_intent.open_checkout')}</button>
				<button class="action" onclick={() => onCopyToClipboard?.(String(presentation.url))}>{$_('payment_intent.copy_link')}</button>
				<button class="action" onclick={() => onSharePaymentTarget?.()}>{$_('payment_intent.share_payment')}</button>
			</div>
		{/if}
	{:else if presentationMode === 'app_switch'}
		<div class="link-actions">
			{#if typeof presentation.deepLinkUrl === 'string' && presentation.deepLinkUrl}
				<button class="action primary" onclick={() => onOpenSheetUrl?.(String(presentation.deepLinkUrl))}>{$_('payment_intent.open_app')}</button>
			{/if}
			{#if typeof presentation.fallbackUrl === 'string' && presentation.fallbackUrl}
				<button class="action" onclick={() => onOpenSheetUrl?.(String(presentation.fallbackUrl))}>{$_('payment_intent.open_fallback')}</button>
			{/if}
			{#if typeof presentation.pointer === 'string' && presentation.pointer}
				<button
					class="action"
					onclick={() => onCopyToClipboard?.(String(presentation.pointer))}
				>
					{$_('payment_intent.copy')} {typeof presentation.pointerLabel === 'string' && presentation.pointerLabel ? String(presentation.pointerLabel) : $_('payment_intent.payment_handle')}
				</button>
			{/if}
		</div>
		{#if typeof presentation.referenceCode === 'string' && presentation.referenceCode}
			<p class="hint emphasis">
				{$_('payment_intent.reference', { values: { code: presentation.referenceCode } })}
			</p>
		{/if}
		{#if typeof presentation.disclosure === 'string' && presentation.disclosure}
			<p class="hint emphasis">{presentation.disclosure}</p>
		{/if}
	{:else if presentationMode === 'tap_to_pay'}
		<p class="hint">
			{$_('payment_intent.tap_session')}
			{typeof presentation.providerSessionId === 'string' ? presentation.providerSessionId : $_('payment_intent.unknown')}
		</p>
	{/if}

	<div class="actions">
		<button class="action" onclick={() => onRefreshIntent?.(activeIntent.intentId, true)}>{$_('payment_intent.refresh_status')}</button>
		<button class="action" onclick={() => onResetForNewIntent?.()}>{$_('payment_intent.new_request')}</button>
	</div>

	{#if activeEvents.length > 0}
		<div class="events">
			<h4>{$_('payment_intent.events')}</h4>
			<ul>
				{#each activeEvents as event (event.eventId)}
					<li>
						<span>{event.eventType}</span>
						<span>{event.status || $_('payment_intent.na')}</span>
						<time>{new Date(event.createdAt).toLocaleString()}</time>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
