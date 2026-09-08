<script lang="ts">
	import { currentUser } from '$lib/presenceIdentity';
	import { getKeepNotesStorageKey } from '$lib/notesStore';
	import { openNotesSurface } from '$lib/notesWorkspace';
	import NotesWorkspace from './NotesWorkspace.svelte';

	/** N2: right-panel notes uses compact layout; center/full can omit. */
	let { compact = false }: { compact?: boolean } = $props();

	const storageKey = $derived(getKeepNotesStorageKey($currentUser?.id));
</script>

{#if compact}
	<div class="keep-notes-compact-wrap">
		<div class="keep-notes-compact-bar">
			<button
				type="button"
				class="keep-notes-expand"
				onclick={openNotesSurface}
				title="Open Notes workspace"
			>
				Open workspace
			</button>
		</div>
		<div class="keep-notes-compact-body">
			<NotesWorkspace
				title="Notes"
				showHeader={false}
				{storageKey}
				compact
				emptyMessage="Keep personal notes, links, and reminders on this device."
				placeholder="Write a note…"
			/>
		</div>
	</div>
{:else}
	<NotesWorkspace
		title="Notes"
		showHeader
		{storageKey}
		emptyMessage="Keep personal notes, links, and reminders on this device."
		placeholder="Write a note…"
	/>
{/if}

<style>
	.keep-notes-compact-wrap {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.keep-notes-compact-bar {
		display: flex;
		justify-content: flex-end;
		padding: 0.35rem 0.5rem 0;
		flex-shrink: 0;
	}

	.keep-notes-expand {
		min-height: 40px;
		padding: 0.25rem 0.55rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.12));
		background: transparent;
		color: var(--text-secondary, #94a3b8);
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.keep-notes-expand:hover,
	.keep-notes-expand:focus-visible {
		background: var(--surface-hover, rgba(255, 255, 255, 0.08));
		color: var(--text-heading, #e8eef7);
	}

	@media (pointer: coarse) {
		.keep-notes-expand { min-height: 44px; }
	}

	.keep-notes-compact-body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
</style>
