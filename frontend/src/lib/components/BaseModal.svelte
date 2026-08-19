<script lang="ts">
	export let isOpen: boolean = false;
	export let onClose: () => void;
	export let variant: 'center' | 'right-panel' | 'full-screen' = 'center';
	export let width: string = '540px';
	export let showCloseButton: boolean = true;
	export let overlayZIndex: number | string | null = null;
	// Optional plain-text header. When set, it replaces the header slot so
	// runes-mode callers don't need snippet/slot interop.
	export let title: string = '';
	export let subtitle: string = '';
	export let headerTag: string = '';

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
		aria-label={title || undefined}
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

			{#if title}
				<div class="modal-text-header">
					<h2>{title}</h2>
					{#if headerTag}
						<div class="modal-header-tag">{headerTag}</div>
					{/if}
					{#if subtitle}
						<p>{subtitle}</p>
					{/if}
				</div>
			{:else}
				<slot name="header" />
			{/if}
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
		background: var(--surface-overlay, rgba(0, 0, 0, 0.6));
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
		background: var(--surface-modal, #0f0c29);
		border-radius: var(--radius-lg);
		max-width: var(--modal-width);
		width: 100%;
		max-height: 90dvh;
		overflow-y: auto;
		position: relative;
		animation: modalEnter var(--duration-normal, 250ms) var(--ease-out, cubic-bezier(0, 0, 0.2, 1));
		border: 1px solid var(--border-default, rgba(179, 179, 255, 0.15));
		box-shadow: var(--shadow-xl);
	}

	.right-panel .modal-content {
		width: 400px;
		height: 100vh;
		height: 100dvh;
		max-height: none;
		border-radius: 0;
		animation: slideIn var(--duration-normal, 250ms) var(--ease-out, cubic-bezier(0, 0, 0.2, 1));
	}

	.modal-close {
		position: absolute;
		top: var(--space-4, 1rem);
		right: var(--space-4, 1rem);
		background: transparent;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		width: var(--space-8, 32px);
		height: var(--space-8, 32px);
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-md, 8px);
		transition: all var(--duration-fast, 150ms);
		padding: 0;
		z-index: var(--z-dropdown, 200);
	}

	.modal-close svg {
		width: var(--icon-lg, 24px);
		height: var(--icon-lg, 24px);
		stroke: currentColor;
		stroke-width: 2;
	}

	.modal-close:hover {
		background: var(--surface-hover, #302b63);
		color: var(--text-heading);
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

	.modal-text-header {
		padding: 1.25rem 1.5rem 0.5rem;
	}

	.modal-text-header h2 {
		margin: 0;
		font-size: 1.2rem;
		color: var(--text-heading);
	}

	.modal-header-tag {
		margin-top: 0.35rem;
		font-size: 0.88rem;
		font-weight: 600;
		color: var(--text-heading);
	}

	.modal-text-header p {
		margin: 0.25rem 0 0;
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	@media (max-width: 768px) {
		.modal-content {
			max-width: calc(100vw - var(--space-8, 2rem));
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
