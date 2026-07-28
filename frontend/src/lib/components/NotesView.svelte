<!-- Card N1 — Notes View + External Note App Integration -->
<!-- frontend/src/lib/components/NotesView.svelte -->
<!-- Purpose: Main notes view component rendered in the workspace when the Notes icon is clicked in the sidebar. -->

<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { readNotes, writeNotes, createEmptyNote, NOTE_COLORS, type LocalNote } from '$lib/notesStore';
	import { currentUser } from '$lib/socket';
	import ConfirmDialog from './ConfirmDialog.svelte';

	const dispatch = createEventDispatcher();

	let storageKey = $currentUser ? `wabi:keep-notes:v1:${$currentUser.id}` : 'wabi:keep-notes:v1:anon';
	$: notes = readNotes(storageKey);

	let editingNote: LocalNote | null = null;
	let editingText = '';
	let editingTitle = '';
	let editingColor = NOTE_COLORS[0];
	let showDeleteConfirm = false;
	let noteToDelete: string | null = null;
	let showNewNote = false;
	let newNoteText = '';
	let newNoteColor = NOTE_COLORS[0];

	function saveNotes() {
		writeNotes(storageKey, notes);
	}

	function startNewNote() {
		editingNote = createEmptyNote();
		editingTitle = '';
		editingText = '';
		editingColor = NOTE_COLORS[0];
		showNewNote = true;
	}

	function startEditNote(note: LocalNote) {
		editingNote = note;
		editingTitle = note.text.split('\n')[0].slice(0, 60) || 'Untitled';
		editingText = note.text;
		editingColor = note.color || NOTE_COLORS[0];
		showNewNote = true;
	}

	function saveEditNote() {
		if (!editingNote) return;
		const idx = notes.findIndex((n) => n.id === editingNote!.id);
		if (idx === -1) return;
		notes[idx] = { ...notes[idx], text: editingText, color: editingColor, updatedAt: Date.now() };
		saveNotes();
		cancelEdit();
	}

	function createNote() {
		const note = createEmptyNote();
		note.text = newNoteText || 'New note';
		note.color = newNoteColor;
		notes.unshift(note);
		saveNotes();
		cancelNew();
	}

	function togglePin(noteId: string) {
		const note = notes.find((n) => n.id === noteId);
		if (!note) return;
		note.pinned = !note.pinned;
		saveNotes();
	}

	function confirmDelete(noteId: string) {
		noteToDelete = noteId;
		showDeleteConfirm = true;
	}

	function executeDelete() {
		if (!noteToDelete) return;
		notes = notes.filter((n) => n.id !== noteToDelete);
		saveNotes();
		showDeleteConfirm = false;
		noteToDelete = null;
	}

	function cancelEdit() {
		editingNote = null;
		showNewNote = false;
		editingText = '';
		editingTitle = '';
	}

	function cancelNew() {
		newNoteText = '';
		newNoteColor = NOTE_COLORS[0];
		showNewNote = false;
	}

	function formatTime(ts: number): string {
		const d = new Date(ts);
		const now = new Date();
		const isToday = d.toDateString() === now.toDateString();
		const diffMs = now.getTime() - d.getTime();
		const diffMin = Math.floor(diffMs / 60000);
		if (isToday && diffMin < 60) return 'just now';
		if (isToday && diffMin < 1440) return `${diffMin}m ago`;
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	function getSnippet(text: string): string {
		const firstLine = text.split('\n')[0].trim();
		return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine || '(empty)';
	}
</script>

<div class="notes-view">
	<div class="notes-header">
		<h2>Notes</h2>
		{#if notes.length > 0}
			<span class="notes-count">{notes.length} note{notes.length !== 1 ? 's' : ''}</span>
		{/if}
		<button class="new-note-btn" type="button" on:click={startNewNote} title="New note">
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
			New Note
		</button>
	</div>

	{#if showNewNote && editingNote}
		<div class="note-editor">
			<input class="note-title-input" type="text" bind:value={editingTitle} placeholder="Note title..." aria-label="Note title" />
			<textarea class="note-textarea" bind:value={editingText} placeholder="Write your note here..." rows="6" aria-label="Note content" />
			<div class="note-editor-actions">
				<select class="note-color-select" bind:value={editingColor} aria-label="Note color">
					{#each NOTE_COLORS as color}
						<option value={color}>{color}</option>
					{/each}
				</select>
				<button class="btn-save" type="button" on:click={saveEditNote}>Save</button>
				<button class="btn-cancel" type="button" on:click={cancelEdit}>Cancel</button>
			</div>
		</div>
	{:else if showNewNote}
		<div class="note-editor">
			<textarea class="note-textarea" bind:value={newNoteText} placeholder="Write your note here..." rows="4" aria-label="Note content" />
			<div class="note-editor-actions">
				<select class="note-color-select" bind:value={newNoteColor} aria-label="Note color">
					{#each NOTE_COLORS as color}
						<option value={color}>{color}</option>
					{/each}
				</select>
				<button class="btn-save" type="button" on:click={createNote}>Create</button>
				<button class="btn-cancel" type="button" on:click={cancelNew}>Cancel</button>
			</div>
		</div>
	{/if}

	{#if notes.length === 0 && !showNewNote}
		<div class="notes-empty">
			<p>No notes yet.</p>
			<button type="button" class="btn-create" on:click={startNewNote}>Create your first note</button>
		</div>
	{:else}
		<ul class="notes-list">
			{#each notes as note (note.id)}
				<li class="note-item" class:pinned={note.pinned} style="--note-accent: {note.color || NOTE_COLORS[0]}">
					<div class="note-item-main" on:click={() => startEditNote(note)} role="button" tabindex="0" on:keydown={(e) => e.key === 'Enter' && startEditNote(note)}>
						<div class="note-item-dot" aria-hidden="true"></div>
						<div class="note-item-body">
							<div class="note-item-title">{getSnippet(note.text)}</div>
							<div class="note-item-time">{formatTime(note.updatedAt)}</div>
						</div>
					</div>
					<div class="note-item-actions">
						<button class="note-action-btn" type="button" on:click={() => togglePin(note.id)} title={note.pinned ? 'Unpin' : 'Pin'} aria-label={note.pinned ? 'Unpin note' : 'Pin note'}>
							{#if note.pinned}
								<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="none" width="14" height="14"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
							{:else}
								<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>
							{/if}
						</button>
						<button class="note-action-btn note-delete-btn" type="button" on:click={() => confirmDelete(note.id)} title="Delete" aria-label="Delete note">
							<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<ConfirmDialog isOpen={showDeleteConfirm} title="Delete Note" message="Delete this note? This cannot be undone." confirmText="Delete" variant="danger" onConfirm={executeDelete} onCancel={() => { showDeleteConfirm = false; noteToDelete = null; }} />

<style>
	.notes-view {
		padding: 1rem;
		max-width: 640px;
		margin: 0 auto;
	}
	.notes-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		justify-content: space-between;
		margin-bottom: 0.75rem;
	}
	.notes-count {
		font-size: 0.75rem;
		color: var(--text-secondary, #8a8aa3);
	}
	.notes-header h2 {
		font-size: 1.25rem;
		font-weight: 700;
		margin: 0;
		color: var(--text-primary, #e8e8ea);
	}
	.new-note-btn {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.4rem 0.75rem;
		border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.1));
		border-radius: 0.5rem;
		background: var(--accent-primary-color, rgba(99, 140, 255, 0.15));
		color: var(--text-primary, #e8e8ea);
		font-size: 0.82rem;
		font-weight: 600;
		cursor: pointer;
	}
	.new-note-btn svg {
		width: 0.85rem;
		height: 0.85rem;
	}
	.notes-empty {
		text-align: center;
		padding: 2rem 1rem;
		color: var(--text-secondary, #8a8aa3);
	}
	.notes-empty p {
		margin-bottom: 0.75rem;
	}
	.btn-create {
		padding: 0.4rem 1rem;
		border-radius: 0.5rem;
		background: var(--accent-primary-color, rgba(99, 140, 255, 0.15));
		color: var(--text-primary, #e8e8ea);
		border: none;
		cursor: pointer;
		font-size: 0.85rem;
		font-weight: 600;
	}
	.notes-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.note-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 0.65rem;
		border-radius: 0.5rem;
		background: var(--surface-raised, rgba(255, 255, 255, 0.03));
		border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.06));
		transition: background 0.12s ease;
	}
	.note-item:hover {
		background: var(--surface-hover, rgba(255, 255, 255, 0.06));
	}
	.note-item.pinned {
		border-left: 3px solid var(--note-accent, var(--accent-primary-color));
	}
	.note-item-main {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		min-width: 0;
	}
	.note-item-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--note-accent, var(--accent-primary-color));
		flex-shrink: 0;
	}
	.note-item-body {
		flex: 1;
		min-width: 0;
	}
	.note-item-title {
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-primary, #e8e8ea);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.note-item-time {
		font-size: 0.72rem;
		color: var(--text-secondary, #8a8aa3);
		margin-top: 0.1rem;
	}
	.note-item-actions {
		display: flex;
		gap: 0.2rem;
		flex-shrink: 0;
	}
	.note-action-btn {
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.2rem;
		border-radius: 0.3rem;
		color: var(--text-secondary, #8a8aa3);
		display: flex;
		align-items: center;
		transition: color 0.12s ease, background 0.12s ease;
	}
	.note-action-btn:hover {
		color: var(--text-primary, #e8e8ea);
		background: var(--surface-hover, rgba(255, 255, 255, 0.06));
	}
	.note-delete-btn:hover {
		color: var(--color-danger, #ef4444);
	}
	.note-editor {
		margin-bottom: 1rem;
		padding: 0.75rem;
		border-radius: 0.5rem;
		background: var(--surface-raised, rgba(255, 255, 255, 0.03));
		border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.06));
	}
	.note-title-input {
		width: 100%;
		padding: 0.4rem 0.6rem;
		border-radius: 0.4rem;
		border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.08));
		background: var(--surface-base, rgba(255, 255, 255, 0.02));
		color: var(--text-primary, #e8e8ea);
		font-size: 0.9rem;
		margin-bottom: 0.5rem;
	}
	.note-textarea {
		width: 100%;
		padding: 0.5rem 0.6rem;
		border-radius: 0.4rem;
		border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.08));
		background: var(--surface-base, rgba(255, 255, 255, 0.02));
		color: var(--text-primary, #e8e8ea);
		font-size: 0.85rem;
		resize: vertical;
		font-family: inherit;
		margin-bottom: 0.5rem;
	}
	.note-editor-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.note-color-select {
		padding: 0.3rem 0.4rem;
		border-radius: 0.3rem;
		border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.08));
		background: var(--surface-base, rgba(255, 255, 255, 0.02));
		color: var(--text-primary, #e8e8ea);
		font-size: 0.78rem;
	}
	.btn-save {
		padding: 0.35rem 0.75rem;
		border-radius: 0.4rem;
		background: var(--accent-primary-color, rgba(99, 140, 255, 0.2));
		color: var(--text-primary, #e8e8ea);
		border: none;
		cursor: pointer;
		font-size: 0.82rem;
		font-weight: 600;
	}
	.btn-cancel {
		padding: 0.35rem 0.75rem;
		border-radius: 0.4rem;
		background: transparent;
		color: var(--text-secondary, #8a8aa3);
		border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.08));
		cursor: pointer;
		font-size: 0.82rem;
	}
</style>