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
		background-color: rgba(15, 12, 41, 0.85);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		backdrop-filter: blur(8px);
	}

	.modal-content {
		background: linear-gradient(135deg, #1a1535 0%, #2a2050 100%);
		border: 1px solid rgba(179, 179, 255, 0.2);
		border-radius: 12px;
		width: 90%;
		max-width: 450px;
		box-shadow: 0 8px 32px rgba(255, 0, 255, 0.15);
		overflow: hidden;
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1.5rem;
		border-bottom: 1px solid rgba(179, 179, 255, 0.15);
		background: rgba(48, 43, 99, 0.3);
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.close-btn {
		background: none;
		border: none;
		font-size: 2rem;
		color: var(--text-secondary);
		cursor: pointer;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		transition: all 0.2s;
	}

	.close-btn:hover {
		background-color: rgba(255, 0, 255, 0.2);
		color: var(--text-primary);
	}

	.modal-body {
		padding: 1.5rem;
	}

	.modal-body p {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.9375rem;
		line-height: 1.6;
	}

	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		padding: 1.5rem;
		border-top: 1px solid rgba(179, 179, 255, 0.15);
		background-color: rgba(48, 43, 99, 0.2);
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
		background: rgba(48, 43, 99, 0.5);
		border: 1px solid rgba(179, 179, 255, 0.2);
		color: var(--text-primary);
	}

	.cancel-btn:hover {
		background-color: rgba(48, 43, 99, 0.8);
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
