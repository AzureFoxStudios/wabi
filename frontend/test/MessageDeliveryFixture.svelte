<script lang="ts">
	import MessageDeliveryRow from '../src/lib/components/message/MessageDeliveryRow.svelte';
	import MessagePersistenceRow from '../src/lib/components/message/MessagePersistenceRow.svelte';

	let deliveryState = $state<'queued' | 'sending' | 'failed' | undefined>('sending');
	let deliveryError = $state<string | undefined>();
	let ownMessage = $state(true);

	export function setDelivery(state: 'queued' | 'sending' | 'failed' | undefined, error?: string, own = true) {
		deliveryState = state;
		deliveryError = error;
		ownMessage = own;
	}
</script>

<main>
	<h1>Message delivery</h1>
	<div class="fixture-message" id="changing-message">
		<div class="fixture-author">You <small>09:41</small></div>
		<div>I’ll bring the project notes to our call.</div>
		<MessageDeliveryRow {ownMessage} {deliveryState} {deliveryError} />
	</div>
	<div class="fixture-message">
		<div class="fixture-author">You <small>09:42</small></div>
		<div>The latest mockup is ready to review.</div>
		<MessageDeliveryRow ownMessage={true} deliveryState="failed" deliveryError="Delivery not confirmed — the connection closed before the server replied. Check this conversation before sending again." />
	</div>
	<div class="fixture-message" id="legacy-failed">
		<div class="fixture-author">You <small>Yesterday</small></div>
		<div>This older message has a retained save warning.</div>
		<MessagePersistenceRow persistenceState="failed" persistenceError="The previous connection ended before saving was confirmed." />
	</div>
	<div class="fixture-message" id="legacy-retrying">
		<div class="fixture-author">You <small>Yesterday</small></div>
		<div>This older message was once marked as retrying.</div>
		<MessagePersistenceRow persistenceState="retrying" />
	</div>
	<div class="fixture-message" id="confirmed-message">
		<div class="fixture-author">You <small>09:40</small></div>
		<div>A confirmed message stays uncluttered.</div>
		<MessageDeliveryRow ownMessage={true} />
	</div>
	<div class="fixture-message" id="received-message">
		<div class="fixture-author">Teammate <small>09:40</small></div>
		<div>Received messages do not expose local delivery diagnostics.</div>
		<MessageDeliveryRow ownMessage={false} deliveryState="failed" deliveryError="Private sender diagnostic" />
	</div>
</main>

<style>
	:global(body) {
		margin: 0;
		background: var(--surface-base);
		color: var(--text-heading);
		font-family: var(--font-sans, system-ui);
	}
	main {
		box-sizing: border-box;
		width: min(100%, 680px);
		margin-inline: auto;
		padding: var(--space-4, 16px);
	}
	h1 { font-size: var(--text-lg); margin-block: 0 var(--space-4, 16px); }
	.fixture-message { margin-block-end: var(--space-5, 20px); min-width: 0; line-height: 1.5; }
	.fixture-author { font-weight: 600; }
	small { color: var(--text-secondary); font-size: var(--text-sm); font-weight: 400; }
</style>
