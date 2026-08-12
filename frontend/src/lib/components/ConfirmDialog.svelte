<script lang="ts">
	import BaseModal from './BaseModal.svelte';

	export let isOpen = false;
	export let title = 'Confirm Action';
	export let message = 'Are you sure you want to proceed?';
	export let confirmText = 'Confirm';
	export let cancelText = 'Cancel';
	export let variant: 'info' | 'warning' | 'danger' = 'warning';
	export let onConfirm: () => void = () => {};
	export let onCancel: () => void = () => {};
	export let secondaryText: string | null = null;
	export let onSecondary: () => void = () => {};
	export let overlayZIndex: number | string | null = null;

	function handleConfirm() {
		onConfirm();
	}

	function handleCancel() {
		onCancel();
	}
</script>

<BaseModal {isOpen} {overlayZIndex} onClose={handleCancel} variant="center" width="480px">
	<div slot="header" class="confirm-header">
		<h2>{title}</h2>
	</div>

	<div class="confirm-body">
		<p>{message}</p>
	</div>

	<div slot="footer" class="confirm-actions">
		<button class="cancel-btn" on:click={handleCancel}>{cancelText}</button>
		{#if secondaryText}<button class="cancel-btn" on:click={onSecondary}>{secondaryText}</button>{/if}
		<button class="confirm-btn {variant}" on:click={handleConfirm}>{confirmText}</button>
	</div>
</BaseModal>

<style>
	.confirm-header {
		padding: 1.5rem;
		border-bottom: 1px solid rgba(179, 179, 255, 0.15);
		background: rgba(var(--surface-raised-rgb, 48, 43, 99), 0.3);
	}

	.confirm-header h2 {
		margin: 0;
		font-size: var(--text-xl);
		font-weight: 600;
		color: var(--text-heading);
	}

	.confirm-body {
		padding: 1.5rem;
	}

	.confirm-body p {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--text-base);
		line-height: 1.6;
	}

	.confirm-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		padding: 1.5rem;
		border-top: 1px solid rgba(179, 179, 255, 0.15);
		background-color: rgba(var(--surface-raised-rgb, 48, 43, 99), 0.2);
	}

	.cancel-btn,
	.confirm-btn {
		padding: 0.625rem 1.25rem;
		border-radius: 8px;
		font-weight: 500;
		font-size: var(--text-base);
		cursor: pointer;
		transition: all 0.2s;
		border: none;
	}

	.cancel-btn {
		background: rgba(var(--surface-raised-rgb, 48, 43, 99), 0.5);
		border: 1px solid rgba(179, 179, 255, 0.2);
		color: var(--text-heading);
	}

	.cancel-btn:hover {
		background-color: rgba(var(--surface-raised-rgb, 48, 43, 99), 0.8);
		border-color: rgba(179, 179, 255, 0.4);
	}

	.confirm-btn {
		color: white;
	}

	.confirm-btn.info {
		background-color: var(--color-info);
	}

	.confirm-btn.info:hover {
		background-color: var(--color-info-hover);
	}

	.confirm-btn.warning {
		background-color: var(--color-warning);
	}

	.confirm-btn.warning:hover {
		background-color: var(--color-warning-hover);
	}

	.confirm-btn.danger {
		background-color: var(--color-danger);
	}

	.confirm-btn.danger:hover {
		background-color: var(--color-danger-hover);
	}
</style>
