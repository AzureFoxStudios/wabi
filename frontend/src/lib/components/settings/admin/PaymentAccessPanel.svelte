<script lang="ts">
	import type { PaymentAccessPolicy } from '$lib/api';
	import { canConfirmDisable, DISABLE_CONFIRM_PHRASE } from '$lib/payments/paymentAccessStore';

	export let canManageAdmin: boolean;
	export let accessPolicy: PaymentAccessPolicy | null;
	export let accessLoading: boolean;
	export let accessSaving: boolean;
	export let onEnable: () => void;
	export let onDisable: () => void;

	let ackChecked = false;
	let phraseInput = '';

	$: disableReady = canConfirmDisable(ackChecked, phraseInput);
	$: enabled = Boolean(accessPolicy?.enabled);
</script>

<div class="upload-limits-panel">
	<h4>Payments Access</h4>
	<p class="admin-help">
		Master switch for the payments UI. When disabled, every payment button and entry point is hidden
		for all users; existing intents and history remain visible. When enabled, users can create
		payment intents (crypto, EU SEPA, US app-switch) on rails this server has compiled in.
	</p>
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">Payments Enabled</span>
			<span class="setting-description">
				{#if accessLoading}
					Loading policy…
				{:else if enabled}
					Payment buttons are visible to everyone on this server.
				{:else}
					Payment entry points are omitted from the UI. No one sees an empty payment button.
				{/if}
			</span>
		</div>
		<button
			class="toggle-btn"
			class:active={enabled}
			disabled={!canManageAdmin || accessLoading || accessSaving}
			on:click={() => (enabled ? undefined : onEnable())}
		>
			{enabled ? 'ON' : 'OFF'}
		</button>
	</div>

	{#if enabled}
		<div class="setting-item danger-zone">
			<div class="setting-info">
				<span class="setting-label">Disable Payments</span>
				<span class="setting-description">
					Hiding payments is a deliberate act: every payment button will disappear for all users.
					Confirm the acknowledgment and type <code>{DISABLE_CONFIRM_PHRASE}</code> to unlock the button.
				</span>
			</div>
			<label class="ack-row">
				<input type="checkbox" bind:checked={ackChecked} disabled={!canManageAdmin || accessSaving} />
				<span>I understand payment buttons will disappear for everyone until re-enabled.</span>
			</label>
			<div class="ack-row">
				<input
					type="text"
					placeholder={`Type ${DISABLE_CONFIRM_PHRASE} to confirm`}
					bind:value={phraseInput}
					disabled={!canManageAdmin || accessSaving}
				/>
				<button
					class="action-btn danger"
					disabled={!canManageAdmin || accessSaving || !disableReady}
					on:click={onDisable}
				>
					{accessSaving ? 'Saving…' : 'Disable Payments'}
				</button>
			</div>
		</div>
	{/if}
</div>