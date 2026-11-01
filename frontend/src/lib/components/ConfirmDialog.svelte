<!--
	Confirm (design contract §7.13): a small dialog that asks one question.

	- Title states the action as a question ("Delete this message?"); one sentence of consequence;
	  a quiet "Cancel", then the action as verb + object ("Delete message"): outlined danger for
	  destructive actions, the ink primary otherwise.
	- role=alertdialog, named by the title and described by the sentence. Esc, the scrim and
	  Cancel all cancel. A destructive confirm opens with focus on Cancel, any other on the action.
	- `cancelText={null}` leaves a single acknowledgement button (a replacement for alert()).

	Prefer the promise service in $lib/confirm (`await confirmAction({...})`), which mounts this
	component on demand; render it directly only where a page already owns the open state.
-->
<script module lang="ts">
	let confirmCounter = 0;
</script>

<script lang="ts">
	import BaseModal from './BaseModal.svelte';

	export let isOpen = false;
	export let title = 'Continue?';
	export let message = '';
	export let confirmText = 'Continue';
	export let cancelText: string | null = 'Cancel';
	export let variant: 'info' | 'warning' | 'danger' = 'warning';
	export let onConfirm: () => void = () => {};
	export let onCancel: () => void = () => {};
	export let secondaryText: string | null = null;
	export let onSecondary: () => void = () => {};
	export let overlayZIndex: number | string | null = null;
	/** The action is running: buttons are disabled and the action reads as busy. */
	export let busy = false;

	const bodyId = `confirm-dialog-${++confirmCounter}-body`;

	$: danger = variant === 'danger';
	$: initialFocus = danger && cancelText ? '[data-confirm-cancel]' : '[data-confirm-action]';

	function handleConfirm() {
		if (!busy) onConfirm();
	}

	function handleCancel() {
		if (!busy) onCancel();
	}
</script>

<BaseModal
	{isOpen}
	{overlayZIndex}
	onClose={handleCancel}
	size="sm"
	role="alertdialog"
	{title}
	showCloseButton={false}
	padded
	describedBy={message ? bodyId : null}
	{initialFocus}
	panelClass="confirm-dialog"
>
	{#if message}
		<p class="confirm-dialog__body" id={bodyId}>{message}</p>
	{/if}

	<div slot="footer" class="w-dialog__foot confirm-dialog__foot">
		{#if cancelText}
			<button type="button" class="w-btn w-btn--quiet" data-confirm-cancel disabled={busy} on:click={handleCancel}>
				{cancelText}
			</button>
		{/if}
		{#if secondaryText}
			<button type="button" class="w-btn" class:w-btn--danger={danger} disabled={busy} on:click={onSecondary}>
				{secondaryText}
			</button>
		{/if}
		<button
			type="button"
			class="w-btn {danger ? 'w-btn--danger' : 'w-btn--primary'}"
			data-confirm-action
			aria-busy={busy ? 'true' : undefined}
			disabled={busy}
			on:click={handleConfirm}
		>
			{confirmText}
		</button>
	</div>
</BaseModal>

<style>
	.confirm-dialog__body {
		margin: 0;
		color: var(--w-mute);
		font: var(--w-t-ui);
		text-wrap: pretty;
	}

	/* Three buttons never squeeze below the label width; on a phone they wrap, action last. */
	.confirm-dialog__foot {
		flex-wrap: wrap;
	}
</style>
