<script lang="ts">
	export let isOpen: boolean = false;
	export let onClose: () => void;
	export let variant: 'center' | 'right-panel' | 'full-screen' = 'center';
	export let width: string = '540px';
	export let showCloseButton: boolean = true;
	export let overlayZIndex: number | string | null = null;

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && isOpen) {
			onClose();
		}
	}

	function handleOverlayClick(event: MouseEvent) {
		if (event.target === event.currentTarget) {
			onClose();
		}
	}

</script>

<svelte:window on:keydown={handleKeydown} />

{#if isOpen}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div
		class="modal-overlay {variant}"
		style={overlayZIndex != null ? `--modal-z-index: ${overlayZIndex};` : undefined}
		on:click={handleOverlayClick}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div
			class="modal-content"
			style="--modal-width: {width}"
			on:click|stopPropagation
		>
			{#if showCloseButton}
				<button class="modal-close" on:click={onClose} aria-label="Close modal">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
				</button>
			{/if}

			<slot name="header" />
			<slot />
			<slot name="footer" />
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
		background: var(--modal-overlay, rgba(15, 12, 41, 0.85));
		z-index: var(--modal-z-index, var(--z-modal));
		display: flex;
		backdrop-filter: blur(8px);
	}

	.modal-overlay.center {
		align-items: center;
		justify-content: center;
	}

	.modal-overlay.right-panel {
		justify-content: flex-end;
	}

	.modal-overlay.full-screen .modal-content {
		width: 100%;
		height: 100%;
		max-width: none;
	}

	.modal-content {
		background: var(--modal-bg, var(--gradient-dialog-dark));
		border-radius: var(--radius-lg);
		max-width: var(--modal-width);
		width: 100%;
		max-height: 90vh;
		overflow-y: auto;
		position: relative;
		animation: modalEnter 0.2s ease-out;
		border: 1px solid rgba(179, 179, 255, 0.2);
		box-shadow: 0 8px 32px rgba(255, 0, 255, 0.15);
	}

	.right-panel .modal-content {
		width: 400px;
		height: 100vh;
		height: 100dvh;
		max-height: none;
		border-radius: 0;
		animation: slideIn 0.25s ease-out;
	}

	.modal-close {
		position: absolute;
		top: 1rem;
		right: 1rem;
		background: transparent;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		transition: all 0.2s;
		padding: 0;
		z-index: 10;
	}

	.modal-close svg {
		width: 24px;
		height: 24px;
		stroke: currentColor;
		stroke-width: 2;
	}

	.modal-close:hover {
		background: var(--bg-hover, rgba(255, 0, 255, 0.2));
		color: var(--text-primary);
	}

	@keyframes modalEnter {
		from {
			opacity: 0;
			transform: scale(0.95) translateY(-10px);
		}
		to {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}

	@keyframes slideIn {
		from {
			transform: translateX(100%);
		}
		to {
			transform: translateX(0);
		}
	}

	@media (max-width: 768px) {
		.modal-content {
			max-width: calc(100vw - 2rem);
			max-height: 85dvh;
		}

		.right-panel .modal-content {
			width: 100%;
		}

		.modal-close {
			width: 44px;
			height: 44px;
		}
	}
</style>
