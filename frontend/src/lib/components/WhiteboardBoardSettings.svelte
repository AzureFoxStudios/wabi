<script lang="ts">
	import { get } from 'svelte/store';
	import { boardStore, policy } from '$lib/whiteboard/boardStore';
	import type { WhiteboardPolicy } from '$lib/whiteboard/boardTypes';

	export let open = false;
	export let onClose: () => void = () => {};

	let draftAccess: WhiteboardPolicy['access'] = 'open';
	let draftWriteAccess: WhiteboardPolicy['writeAccess'] = 'anyone';

	$: if (open) {
		const current = get(policy);
		draftAccess = current?.access || 'open';
		draftWriteAccess = current?.writeAccess || 'anyone';
	}

	function handleSave(): void {
		boardStore.setWhiteboardPolicy({ access: draftAccess, writeAccess: draftWriteAccess });
		onClose();
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (open && event.key === 'Escape') {
			event.preventDefault();
			onClose();
		}
	}
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div class="wb-settings-backdrop" on:click={onClose}></div>
	<div
		class="wb-settings-popover"
		role="dialog"
		aria-modal="true"
		aria-labelledby="wb-settings-title"
	>
		<div class="wb-settings-head">
			<h3 id="wb-settings-title" class="wb-settings-title">Board settings</h3>
			<button type="button" class="wb-settings-close" aria-label="Close board settings" on:click={onClose}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
			</button>
		</div>

		<div class="wb-settings-section">
			<span class="wb-settings-label">Board access</span>
			<div class="wb-settings-segmented" role="radiogroup" aria-label="Board access">
				<button
					type="button"
					class:active={draftAccess === 'open'}
					class="wb-settings-seg-btn"
					role="radio"
					aria-checked={draftAccess === 'open'}
					on:click={() => (draftAccess = 'open')}
				>
					Anyone with channel access
				</button>
				<button
					type="button"
					class:active={draftAccess === 'desktop_only'}
					class="wb-settings-seg-btn"
					role="radio"
					aria-checked={draftAccess === 'desktop_only'}
					on:click={() => (draftAccess = 'desktop_only')}
				>
					Desktop app only
				</button>
			</div>
			<span class="wb-settings-description">
				{draftAccess === 'open'
					? 'View and edit from web or desktop.'
					: 'Requires the Wabi desktop app to view or edit.'}
			</span>
		</div>

		<div class="wb-settings-section">
			<span class="wb-settings-label">Who can edit</span>
			<div class="wb-settings-segmented" role="radiogroup" aria-label="Who can edit">
				<button
					type="button"
					class:active={draftWriteAccess === 'anyone'}
					class="wb-settings-seg-btn"
					role="radio"
					aria-checked={draftWriteAccess === 'anyone'}
					on:click={() => (draftWriteAccess = 'anyone')}
				>
					Anyone
				</button>
				<button
					type="button"
					class:active={draftWriteAccess === 'desktop'}
					class="wb-settings-seg-btn"
					role="radio"
					aria-checked={draftWriteAccess === 'desktop'}
					on:click={() => (draftWriteAccess = 'desktop')}
				>
					Desktop only
				</button>
			</div>
			<span class="wb-settings-description">
				{draftWriteAccess === 'anyone'
					? 'Web and desktop users can draw.'
					: 'Web users can view, only desktop users can draw.'}
			</span>
		</div>

		<div class="wb-settings-note">Changes sync to all users on the next save.</div>

		<div class="wb-settings-actions">
			<button type="button" class="wb-settings-save" on:click={handleSave}>Save</button>
			<button type="button" class="wb-settings-cancel" on:click={onClose}>Cancel</button>
		</div>
	</div>
{/if}

<style>
	.wb-settings-backdrop {
		position: absolute;
		inset: 0;
		z-index: 39;
		background: rgba(var(--surface-app-rgb, 15, 23, 42), 0.32);
		backdrop-filter: blur(2px);
	}

	.wb-settings-popover {
		position: absolute;
		top: 4.3rem;
		right: 0.9rem;
		z-index: 40;
		width: min(360px, calc(100% - 1.8rem));
		padding: var(--space-4);
		border-radius: var(--radius-lg, 12px);
		background: color-mix(in srgb, var(--surface-raised, #302b63) 82%, transparent);
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 22%, transparent);
		backdrop-filter: blur(14px);
		box-shadow: 0 18px 40px rgba(var(--surface-app-rgb, 15, 23, 42), 0.28);
		animation: wb-settings-pop 0.16s ease-out;
	}

	@keyframes wb-settings-pop {
		from {
			opacity: 0;
			transform: translateY(-6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.wb-settings-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-bottom: var(--space-3);
	}

	.wb-settings-title {
		margin: 0;
		font-size: var(--font-size-base, 0.875rem);
		font-weight: var(--font-weight-bold, 700);
		color: var(--text-heading, #e0e0ff);
	}

	.wb-settings-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm, 4px);
		background: transparent;
		color: var(--text-muted, #9999ff);
		cursor: pointer;
		transition: background 0.14s ease, color 0.14s ease;
	}

	.wb-settings-close:hover {
		background: color-mix(in srgb, var(--text-muted, #9999ff) 14%, transparent);
		color: var(--text-heading, #e0e0ff);
	}

	.wb-settings-close svg {
		width: 14px;
		height: 14px;
	}

	.wb-settings-section {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		padding: var(--space-3) 0;
	}

	.wb-settings-section + .wb-settings-section {
		border-top: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 16%, transparent);
	}

	.wb-settings-label {
		font-size: var(--font-size-sm, 0.8125rem);
		font-weight: 650;
		color: var(--text-heading, #e0e0ff);
	}

	.wb-settings-segmented {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}

	.wb-settings-seg-btn {
		flex: 1 1 auto;
		min-width: 0;
		padding: 0.4rem 0.6rem;
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 20%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-sunken, #0f0c29) 55%, transparent);
		color: var(--text-secondary, #b3b3ff);
		font-size: var(--font-size-sm, 0.8125rem);
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
	}

	.wb-settings-seg-btn:hover {
		background: color-mix(in srgb, var(--surface-base, #24243e) 60%, transparent);
	}

	.wb-settings-seg-btn.active {
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 22%, transparent);
		border-color: color-mix(in srgb, var(--accent-primary, #6366f1) 40%, transparent);
		color: var(--text-heading, #e0e0ff);
	}

	.wb-settings-description {
		font-size: var(--font-size-xs, 0.6875rem);
		line-height: 1.4;
		color: var(--text-muted, #9999ff);
	}

	.wb-settings-note {
		margin: var(--space-1) 0 var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-sm, 4px);
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent-primary, #6366f1) 22%, transparent);
		font-size: var(--font-size-xs, 0.6875rem);
		color: var(--text-secondary, #b3b3ff);
	}

	.wb-settings-actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}

	.wb-settings-save,
	.wb-settings-cancel {
		padding: 0.42rem 0.95rem;
		border-radius: 999px;
		font-size: var(--font-size-sm, 0.8125rem);
		font-weight: 700;
		cursor: pointer;
		transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
	}

	.wb-settings-save {
		border: 1px solid color-mix(in srgb, var(--accent-primary, #6366f1) 34%, transparent);
		background: color-mix(in srgb, var(--accent-primary, #6366f1) 82%, transparent);
		color: var(--text-heading, #e0e0ff);
	}

	.wb-settings-save:hover {
		background: var(--accent-primary, #6366f1);
	}

	.wb-settings-cancel {
		border: 1px solid color-mix(in srgb, var(--text-muted, #9999ff) 24%, transparent);
		background: transparent;
		color: var(--text-secondary, #b3b3ff);
	}

	.wb-settings-cancel:hover {
		background: color-mix(in srgb, var(--text-muted, #9999ff) 12%, transparent);
		color: var(--text-heading, #e0e0ff);
	}

	@media (prefers-reduced-motion: reduce) {
		.wb-settings-popover {
			animation: none;
		}
	}
</style>
