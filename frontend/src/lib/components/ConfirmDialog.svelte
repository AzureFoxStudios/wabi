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
		box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
		overflow: hidden;
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1.5rem;
		border-bottom: 1px solid #e5e7eb;
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
		color: #111827;
	}

	.close-btn {
		background: none;
		border: none;
		font-size: 2rem;
		color: #6b7280;
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
		background-color: #f3f4f6;
		color: #111827;
	}

	.modal-body {
		padding: 1.5rem;
	}

	.modal-body p {
		margin: 0;
		color: #374151;
		font-size: 0.9375rem;
		line-height: 1.6;
	}

	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		padding: 1.5rem;
		border-top: 1px solid #e5e7eb;
		background-color: #f9fafb;
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
		background: white;
		border: 1px solid #d1d5db;
		color: #374151;
	}

	.cancel-btn:hover {
		background-color: #f3f4f6;
		border-color: #9ca3af;
	}

	.confirm-btn {
		color: white;
	}

	.confirm-btn.info {
		background-color: #3b82f6;
	}

	.confirm-btn.info:hover {
		background-color: #2563eb;
	}

	.confirm-btn.warning {
		background-color: #f59e0b;
	}

	.confirm-btn.warning:hover {
		background-color: #d97706;
	}

	.confirm-btn.danger {
		background-color: #ef4444;
	}

	.confirm-btn.danger:hover {
		background-color: #dc2626;
	}
</style>
