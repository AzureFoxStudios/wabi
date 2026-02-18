<script lang="ts">
	import { createEmptyNote, readNotes, writeNotes, type LocalNote } from '$lib/notesStore';

	export let storageKey: string;
	export let title = 'Notes';
	export let emptyMessage = 'No notes yet.';
	export let placeholder = 'Write your note...';

	let notes: LocalNote[] = [];
	let selectedNoteId: string | null = null;

	$: loadFromStorage(storageKey);
	$: selectedNote = notes.find((note) => note.id === selectedNoteId) || null;

	function loadFromStorage(key: string) {
		if (!key) {
			notes = [];
			selectedNoteId = null;
			return;
		}
		const next = readNotes(key);
		const hadSelection = next.some((note) => note.id === selectedNoteId);
		notes = next;
		if (!hadSelection) {
			selectedNoteId = notes[0]?.id || null;
		}
	}

	function addNote() {
		const note = createEmptyNote();
		notes = [note, ...notes];
		selectedNoteId = note.id;
		writeNotes(storageKey, notes);
	}

	function deleteSelected() {
		if (!selectedNote) return;
		notes = notes.filter((note) => note.id !== selectedNote.id);
		selectedNoteId = notes[0]?.id || null;
		writeNotes(storageKey, notes);
	}

	function updateSelectedText(nextText: string) {
		if (!selectedNote) return;
		notes = notes.map((note) => {
			if (note.id !== selectedNote.id) return note;
			return {
				...note,
				text: nextText,
				updatedAt: Date.now()
			};
		});
		writeNotes(storageKey, notes);
	}

	function formatTs(ts: number): string {
		return new Date(ts).toLocaleString([], {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function previewText(note: LocalNote): string {
		const trimmed = note.text.trim();
		if (!trimmed) return '(Empty note)';
		return trimmed.length > 70 ? `${trimmed.slice(0, 70)}...` : trimmed;
	}
</script>

<div class="notes-workspace">
	<div class="notes-sidebar">
		<div class="notes-header">
			<span class="notes-title">{title}</span>
			<button class="notes-add-btn" on:click={addNote} title="New note">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
			</button>
		</div>
		<div class="notes-list">
			{#each notes as note (note.id)}
				<button
					class="notes-item"
					class:active={note.id === selectedNoteId}
					on:click={() => selectedNoteId = note.id}
				>
					<div class="notes-item-top">
						<span class="notes-item-time">{formatTs(note.updatedAt)}</span>
					</div>
					<span class="notes-item-preview">{previewText(note)}</span>
				</button>
			{:else}
				<div class="notes-empty">{emptyMessage}</div>
			{/each}
		</div>
	</div>
	<div class="notes-editor">
		{#if selectedNote}
			<div class="notes-editor-toolbar">
				<span class="notes-editor-time">Updated {formatTs(selectedNote.updatedAt)}</span>
				<button class="notes-delete-btn" on:click={deleteSelected} title="Delete note">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>
			<textarea
				class="notes-input"
				value={selectedNote.text}
				on:input={(e) => updateSelectedText((e.currentTarget as HTMLTextAreaElement).value)}
				placeholder={placeholder}
			></textarea>
		{:else}
			<div class="notes-editor-empty">
				<button class="notes-add-first-btn" on:click={addNote}>Create your first note</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.notes-workspace {
		height: 100%;
		min-height: 0;
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr);
	}

	.notes-sidebar {
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--bg-secondary);
	}

	.notes-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem;
		border-bottom: 1px solid var(--border);
	}

	.notes-title {
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-secondary);
		font-weight: 600;
	}

	.notes-add-btn {
		width: 26px;
		height: 26px;
		border-radius: 6px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}

	.notes-add-btn:hover {
		color: var(--text-primary);
		background: var(--bg-hover);
	}

	.notes-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.25rem;
	}

	.notes-item {
		width: 100%;
		border: none;
		background: none;
		padding: 0.5rem;
		border-radius: 6px;
		text-align: left;
		color: var(--text-primary);
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.notes-item:hover {
		background: var(--bg-hover);
	}

	.notes-item.active {
		background: rgba(88, 101, 242, 0.12);
	}

	.notes-item-time {
		font-size: 0.65rem;
		color: var(--text-secondary);
	}

	.notes-item-preview {
		font-size: 0.76rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.notes-empty {
		font-size: 0.8rem;
		color: var(--text-secondary);
		text-align: center;
		padding: 1rem 0.5rem;
	}

	.notes-editor {
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.notes-editor-toolbar {
		height: 38px;
		padding: 0 0.625rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		border-bottom: 1px solid var(--border);
		background: var(--bg-secondary);
	}

	.notes-editor-time {
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.notes-delete-btn {
		width: 22px;
		height: 22px;
		border-radius: 4px;
		border: none;
		background: none;
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}

	.notes-delete-btn:hover {
		color: #f44336;
		background: rgba(244, 67, 54, 0.1);
	}

	.notes-input {
		flex: 1;
		min-height: 0;
		border: none;
		background: var(--bg-primary);
		color: var(--text-primary);
		padding: 0.75rem;
		resize: none;
		font: inherit;
		line-height: 1.45;
	}

	.notes-input:focus {
		outline: none;
	}

	.notes-editor-empty {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.notes-add-first-btn {
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
		border-radius: 8px;
		padding: 0.5rem 0.75rem;
		cursor: pointer;
	}

	@media (max-width: 900px) {
		.notes-workspace {
			grid-template-columns: 1fr;
			grid-template-rows: 180px minmax(0, 1fr);
		}

		.notes-sidebar {
			border-right: none;
			border-bottom: 1px solid var(--border);
		}
	}
</style>
