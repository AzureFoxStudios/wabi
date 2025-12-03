<script lang="ts">
	import { onMount } from 'svelte';

	export let isOpen = false;
	export let title = 'Confirm Action';
	export let message = 'Are you sure you want to proceed?';
	export let confirmText = 'Confirm';
	export let cancelText = 'Cancel';
	export let variant: 'info' | 'warning' | 'danger' = 'warning';
	export let onConfirm: () => void = () => {};
	export let onCancel: () => void = () => {};

	function handleConfirm() {
		onConfirm();
	}

	function handleCancel() {
		onCancel();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && isOpen) {
			handleCancel();
		}
	}

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
		return () => {
			window.removeEventListener('keydown', handleKeydown);
		};
	});
</script>

{#if isOpen}
	<div class="modal-overlay" on:click={handleCancel}>
		<div class="modal-content" on:click|stopPropagation>
			<div class="modal-header">
				<h2>{title}</h2>
				<button class="close-btn" on:click={handleCancel}>&times;</button>
			</div>

			<div class="modal-body">
				<p>{message}</p>
			</div>

			<div class="modal-footer">
				<button class="cancel-btn" on:click={handleCancel}>{cancelText}</button>
				<button class="confirm-btn {variant}" on:click={handleConfirm}>{confirmText}</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		backdrop-filter: blur(4px);
	}

	.modal-content {
		background: white;
		border-radius: 12px;
		width: 90%;
		max-width: 450px;
		box-shadow: none;
		overflow: hidden;
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1.5rem;
		border-bottom: 1px solid var(--modal-border);
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--modal-text);
	}

	.close-btn {
		background: none;
		border: none;
		font-size: 2rem;
		color: var(--modal-text-secondary);
		cursor: pointer;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		transition: background-color 0.2s;
	}

	.close-btn:hover {
		background-color: var(--ui-bg-light);
		color: var(--modal-text);
	}

	.modal-body {
		padding: 1.5rem;
	}

	.modal-body p {
		margin: 0;
		color: var(--ui-text);
		font-size: 0.9375rem;
		line-height: 1.6;
	}

	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		padding: 1.5rem;
		border-top: 1px solid var(--modal-border);
		background-color: var(--modal-header-bg);
	}

	.cancel-btn,
	.confirm-btn {
		padding: 0.625rem 1.25rem;
		border-radius: 8px;
		font-weight: 500;
		font-size: 0.875rem;
		cursor: pointer;
		transition: all 0.2s;
		border: none;
	}

	.cancel-btn {
		background: var(--modal-bg);
		border: none;
		color: var(--ui-text);
	}

	.cancel-btn:hover {
		background-color: var(--ui-bg-light);
		border-color: var(--modal-text-muted);
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
