<script lang="ts">
	import BaseModal from './BaseModal.svelte';

	let {
		open = false,
		channelName = '',
		memberCount = 0,
		onCreate,
		onClose
	}: {
		open?: boolean;
		channelName?: string;
		memberCount?: number;
		onCreate: (roomCount: number, autoAssign: boolean) => void;
		onClose: () => void;
	} = $props();

	let suggestedCount = $derived(Math.max(2, Math.ceil(Math.max(memberCount, 2) / 2)));
	let roomCount = $state(0);
	let autoAssign = $state(true);

	// Re-seed the input each time the modal opens.
	$effect(() => {
		if (open) {
			roomCount = suggestedCount;
			autoAssign = true;
		}
	});

	let isValid = $derived(
		Number.isInteger(roomCount) && roomCount >= 2 && roomCount <= 20
	);

	function submit() {
		if (!isValid) return;
		onCreate(roomCount, autoAssign);
	}
</script>

<BaseModal isOpen={open} onClose={onClose} width="400px" showCloseButton={true}>
	<div slot="header" class="modal-header">
		<h3>Create Breakout Rooms</h3>
		<p>{channelName ? `Split ${channelName} into temporary voice rooms.` : 'Split this channel into temporary voice rooms.'}</p>
	</div>

	<div class="modal-body">
		<label class="field">
			<span class="field-label">Number of rooms (2&ndash;20)</span>
			<input
				type="number"
				min="2"
				max="20"
				step="1"
				bind:value={roomCount}
				onkeydown={(event) => {
					if (event.key === 'Enter') submit();
				}}
			/>
			{#if memberCount > 0}
				<span class="field-hint">{memberCount} {memberCount === 1 ? 'person' : 'people'} in channel</span>
			{/if}
		</label>

		<label class="field checkbox-field">
			<input type="checkbox" bind:checked={autoAssign} />
			<span>Automatically distribute members across rooms</span>
		</label>
	</div>

	<div slot="footer" class="modal-footer">
		<button class="btn-secondary" onclick={onClose}>Cancel</button>
		<button class="btn-primary" disabled={!isValid} onclick={submit}>Create Rooms</button>
	</div>
</BaseModal>

<style>
	.modal-header {
		padding: var(--space-5, 1.25rem) var(--space-5, 1.25rem) 0;
	}

	.modal-header h3 {
		margin: 0 0 var(--space-2, 0.5rem);
		font-size: var(--font-lg, 1.125rem);
		font-weight: 600;
		color: var(--text-heading);
	}

	.modal-header p {
		margin: 0;
		font-size: var(--font-sm, 0.875rem);
		color: var(--text-secondary);
	}

	.modal-body {
		padding: var(--space-5, 1.25rem);
		display: flex;
		flex-direction: column;
		gap: var(--space-4, 1rem);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-2, 0.5rem);
	}

	.field-label {
		font-size: var(--font-sm, 0.875rem);
		font-weight: 500;
		color: var(--text-primary);
	}

	.field input[type='number'] {
		background: var(--surface-input, rgba(0, 0, 0, 0.3));
		border: 1px solid var(--border-default, rgba(179, 179, 255, 0.15));
		border-radius: var(--radius-md, 8px);
		color: var(--text-primary);
		padding: var(--space-2, 0.5rem) var(--space-3, 0.75rem);
		font-size: var(--font-md, 1rem);
		width: 100%;
	}

	.field-hint {
		font-size: var(--font-xs, 0.75rem);
		color: var(--text-tertiary);
	}

	.checkbox-field {
		flex-direction: row;
		align-items: center;
		gap: var(--space-3, 0.75rem);
		font-size: var(--font-sm, 0.875rem);
		color: var(--text-primary);
	}

	.modal-footer {
		padding: 0 var(--space-5, 1.25rem) var(--space-5, 1.25rem);
		display: flex;
		justify-content: flex-end;
		gap: var(--space-3, 0.75rem);
	}

	.modal-footer button {
		padding: var(--space-2, 0.5rem) var(--space-4, 1rem);
		border-radius: var(--radius-md, 8px);
		border: none;
		font-size: var(--font-sm, 0.875rem);
		font-weight: 500;
		cursor: pointer;
	}

	.btn-secondary {
		background: var(--surface-hover, #302b63);
		color: var(--text-primary);
	}

	.btn-primary {
		background: var(--accent, #98d8c8);
		color: var(--text-on-accent, #10131a);
	}

	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
