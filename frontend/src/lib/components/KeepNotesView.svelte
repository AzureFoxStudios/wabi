<script lang="ts">
	import { currentUser } from '$lib/socket';
	import { getKeepNotesStorageKey } from '$lib/notesStore';
	import { layoutStore } from '$lib/layoutStore';
	import NotesWorkspace from './NotesWorkspace.svelte';

	/** N2: right-panel notes uses compact layout; center/full can omit. */
	export let compact = false;

	$: storageKey = getKeepNotesStorageKey($currentUser?.id);
</script>

{#if compact}
	<div class="keep-notes-compact-wrap">
		<div class="keep-notes-compact-bar">
			<button
				type="button"
				class="keep-notes-expand"
				on:click={() => layoutStore.showNotesCenterStage()}
				title="Open notes full width"
			>
				Expand
			</button>
		</div>
		<div class="keep-notes-compact-body">
			<NotesWorkspace
				title="Notes"
				showHeader={false}
				{storageKey}
				compact
				emptyMessage="Keep quick personal notes, links, and reminders."
				placeholder="Drop anything here. This is your private notes space."
			/>
		</div>
	</div>
{:else}
	<NotesWorkspace
		title="Notes"
		showHeader={false}
		{storageKey}
		emptyMessage="Keep quick personal notes, links, and reminders."
		placeholder="Drop anything here. This is your private notes space."
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
		padding: 0.25rem 0.55rem;
		border-radius: 6px;
		border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.12));
		background: transparent;
		color: var(--text-secondary, #94a3b8);
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.keep-notes-expand:hover {
		background: var(--surface-hover, rgba(255, 255, 255, 0.08));
		color: var(--text-heading, #e8eef7);
	}

	.keep-notes-compact-body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
</style>
