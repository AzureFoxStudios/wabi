<script lang="ts">
	import { _ } from '$lib/i18n';
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
	<h4>{$_('payment_access_panel.title')}</h4>
	<p class="admin-help">
		{$_('payment_access_panel.help')}
	</p>
	<div class="setting-item">
		<div class="setting-info">
			<span class="setting-label">{$_('payment_access_panel.enabled_label')}</span>
			<span class="setting-description">
				{#if accessLoading}
					{$_('payment_access_panel.loading')}
				{:else if enabled}
					{$_('payment_access_panel.on_desc')}
				{:else}
					{$_('payment_access_panel.off_desc')}
				{/if}
			</span>
		</div>
		<button
			class="toggle-btn"
			class:active={enabled}
			disabled={!canManageAdmin || accessLoading || accessSaving}
			on:click={() => (enabled ? undefined : onEnable())}
		>
			{enabled ? $_('payment_access_panel.on') : $_('payment_access_panel.off')}
		</button>
	</div>

	{#if enabled}
		<div class="setting-item danger-zone">
			<div class="setting-info">
				<span class="setting-label">{$_('payment_access_panel.disable_title')}</span>
				<span class="setting-description">
					{$_('payment_access_panel.disable_desc')}
					{$_('payment_access_panel.confirm_type')} <code>{DISABLE_CONFIRM_PHRASE}</code> {$_('payment_access_panel.to_unlock')}
				</span>
			</div>
			<label class="ack-row">
				<input type="checkbox" bind:checked={ackChecked} disabled={!canManageAdmin || accessSaving} />
				<span>{$_('payment_access_panel.ack')}</span>
			</label>
			<div class="ack-row">
				<input
					type="text"
					placeholder={$_('payment_access_panel.type_to_confirm', { values: { phrase: DISABLE_CONFIRM_PHRASE } })}
					bind:value={phraseInput}
					disabled={!canManageAdmin || accessSaving}
				/>
				<button
					class="action-btn danger"
					disabled={!canManageAdmin || accessSaving || !disableReady}
					on:click={onDisable}
				>
					{accessSaving ? $_('payment_access_panel.saving') : $_('payment_access_panel.disable_title')}
				</button>
			</div>
		</div>
	{/if}
</div>