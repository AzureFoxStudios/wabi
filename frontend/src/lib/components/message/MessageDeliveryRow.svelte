<script lang="ts">
	import type { Message } from '$lib/socket-types';

	let {
		ownMessage,
		deliveryState,
		deliveryError
	}: {
		ownMessage: boolean;
		deliveryState?: Message['deliveryState'];
		deliveryError?: string;
	} = $props();

	let statusText = $derived(
		deliveryState === 'queued'
			? 'Queued — will send when online'
			: deliveryState === 'sending'
			? 'Sending…'
			: deliveryState === 'failed'
				? deliveryError?.trim()
					? deliveryError
					: 'Delivery not confirmed. Check this conversation before sending again.'
				: null
	);
</script>

{#if ownMessage && statusText}
	<div
		class="message-delivery-row"
		class:is-failed={deliveryState === 'failed'}
		role="status"
		aria-live="polite"
		aria-atomic="true"
	>
		{statusText}
	</div>
{/if}

<style>
	.message-delivery-row {
		min-width: 0;
		max-width: 100%;
		margin-block: var(--space-1, 4px);
		color: var(--text-secondary);
		font-size: var(--text-sm, 0.8125rem);
		font-weight: 500;
		line-height: 1.45;
		white-space: normal;
		overflow-wrap: anywhere;
		text-wrap: pretty;
	}

	.message-delivery-row.is-failed {
		color: color-mix(in srgb, var(--text-danger) 65%, var(--text-heading));
	}
</style>
