<script lang="ts">
	import { onMount } from 'svelte';
	import { createEmptyNote, readNotes, writeNotes, sortNotesWithPin, NOTE_COLORS, type LocalNote } from '$lib/notesStore';
	import { openReaderDocument } from '$lib/readerWorkspace';

	export let storageKey: string;
	export let title = 'Notes';
	export let emptyMessage = 'No notes yet.';
	export let placeholder = 'Write your note...';
	export let showHeader = true;
	export let compact = false;

	let view: 'list' | 'editor' = 'list';

	$: if (view === 'editor' && !selectedNote) {
		view = 'list';
	}

	const SIDEBAR_MIN_WIDTH = 0;
	const SIDEBAR_COLLAPSED_WIDTH = 0;
	const SPLITTER_WIDTH = 7;
	const SIDEBAR_REOPEN_WIDTH = 220;
	const MIN_WORKSPACE_WIDTH = 320;

	let sidebarWidth = 220;
	let isResizingSidebar = false;
	let resizeStartX = 0;
	let resizeStartWidth = 220;
	let workspaceElement: HTMLDivElement | null = null;
	let workspaceWidth = 0;

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
		const next = sortNotesWithPin(readNotes(key));
		const hadSelection = next.some((note) => note.id === selectedNoteId);
		notes = next;
		if (!hadSelection) {
			selectedNoteId = notes[0]?.id || null;
		}
	}

	function addNote() {
		const note = createEmptyNote();
		notes = sortNotesWithPin([note, ...notes]);
		selectedNoteId = note.id;
		writeNotes(storageKey, notes);
	}

	function deleteSelected() {
		if (!selectedNote) return;
		notes = notes.filter((note) => note.id !== selectedNote.id);
		selectedNoteId = notes[0]?.id || null;
		writeNotes(storageKey, notes);
	}

	function openNote(id: string): void {
		selectedNoteId = id;
		view = 'editor';
	}

	function addNoteAndOpen(): void {
		addNote();
		view = 'editor';
	}

	function updateSelectedText(nextText: string) {
		if (!selectedNote) return;
		notes = sortNotesWithPin(
			notes.map((note) => {
				if (note.id !== selectedNote.id) return note;
				return {
					...note,
					text: nextText,
					updatedAt: Date.now()
				};
			})
		);
		writeNotes(storageKey, notes);
	}

	function togglePinSelected(): void {
		if (!selectedNote) return;
		const nextPinned = !selectedNote.pinned;
		notes = sortNotesWithPin(
			notes.map((note) => (note.id === selectedNote.id ? { ...note, pinned: nextPinned } : note))
		);
		writeNotes(storageKey, notes);
	}

	function updateSelectedColor(nextColor: string | undefined): void {
		if (!selectedNote) return;
		notes = sortNotesWithPin(
			notes.map((note) => (note.id === selectedNote.id ? { ...note, color: nextColor } : note))
		);
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

	function buildReaderTitle(note: LocalNote): string {
		const firstLine =
			note.text
				.split('\n')
				.map((line) => line.trim())
				.find(Boolean) || '';
		if (!firstLine) return `${title} Note`;
		const normalized = firstLine.replace(/^#+\s*/, '').trim();
		if (!normalized) return `${title} Note`;
		return normalized.length > 80 ? `${normalized.slice(0, 80).trim()}...` : normalized;
	}

	function openSelectedInReader(): void {
		if (!selectedNote) return;
		openReaderDocument(
			buildReaderTitle(selectedNote),
			selectedNote.text,
			'markdown',
			'notes'
		);
	}

	function handleSidebarResizeStart(event: MouseEvent): void {
		event.preventDefault();
		isResizingSidebar = true;
		resizeStartX = event.clientX;
		resizeStartWidth = sidebarWidth;
		window.addEventListener('mousemove', handleSidebarResizeMove);
		window.addEventListener('mouseup', handleSidebarResizeStop);
	}

	function handleSidebarResizeMove(event: MouseEvent): void {
		if (!isResizingSidebar) return;
		const delta = event.clientX - resizeStartX;
		const maxSidebarWidth = Math.max(
			SIDEBAR_MIN_WIDTH,
			Math.max(workspaceWidth || MIN_WORKSPACE_WIDTH, MIN_WORKSPACE_WIDTH) - SPLITTER_WIDTH
		);
		const nextWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxSidebarWidth, resizeStartWidth + delta));
		sidebarWidth = nextWidth <= 26 ? SIDEBAR_COLLAPSED_WIDTH : nextWidth;
	}

	function handleSidebarResizeStop(): void {
		isResizingSidebar = false;
		window.removeEventListener('mousemove', handleSidebarResizeMove);
		window.removeEventListener('mouseup', handleSidebarResizeStop);
	}

	function openSidebar(): void {
		sidebarWidth = SIDEBAR_REOPEN_WIDTH;
	}

	function recalcWorkspaceWidth(): void {
		if (!workspaceElement) return;
		workspaceWidth = Math.max(MIN_WORKSPACE_WIDTH, workspaceElement.clientWidth);
		const maxSidebarWidth = Math.max(SIDEBAR_MIN_WIDTH, workspaceWidth - SPLITTER_WIDTH);
		if (sidebarWidth > maxSidebarWidth) {
			sidebarWidth = maxSidebarWidth;
		}
	}

	onMount(() => {
		recalcWorkspaceWidth();
	});
</script>

<svelte:window on:resize={recalcWorkspaceWidth} />

{#if compact}
	<div class="notes-workspace notes-compact">
		{#if view === 'editor' && selectedNote}
			<div class="notes-editor">
				<div class="notes-editor-toolbar">
				<div class="notes-toolbar-leading">
					<button class="notes-open-sidebar-btn" type="button" on:click={() => (view = 'list')} title="Back to notes" aria-label="Back to notes">
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
					</button>
					<button
						class="notes-pin-btn"
						class:active={selectedNote.pinned}
						type="button"
						on:click={togglePinSelected}
						title={selectedNote.pinned ? 'Unpin note' : 'Pin to top'}
						aria-label={selectedNote.pinned ? 'Unpin note' : 'Pin to top'}
						aria-pressed={selectedNote.pinned ? 'true' : 'false'}
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
					</button>
					<div class="notes-color-row" role="group" aria-label="Note color">
						{#each NOTE_COLORS as color}
							<button
								class="notes-color-dot"
								class:active={selectedNote.color === color}
								type="button"
								style={`--swatch: ${color}`}
								on:click={() => updateSelectedColor(selectedNote.color === color ? undefined : color)}
								title="Set note color"
								aria-label="Set note color"
							></button>
						{/each}
					</div>
					<span class="notes-editor-time">Updated {formatTs(selectedNote.updatedAt)}</span>
				</div>
					<div class="notes-toolbar-actions">
						<button class="notes-reader-btn" on:click={openSelectedInReader} title="Open in Reader">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
								<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
								<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 0 4 24V4.5A2.5 2.5 0 0 1 6.5 2z"></path>
							</svg>
						</button>
						<button class="notes-add-btn editor-add" on:click={addNote} title="Create note">
							<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v14h-2zM5 11h14v2H5z" fill="currentColor"/></svg>
						</button>
						<button class="notes-delete-btn" on:click={deleteSelected} title="Delete note">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
						</button>
					</div>
				</div>
				<textarea
					class="notes-input"
					value={selectedNote.text}
					on:input={(e) => updateSelectedText((e.currentTarget as HTMLTextAreaElement).value)}
					placeholder={placeholder}
				></textarea>
			</div>
		{:else}
			<div class="notes-compact-header">
				<span class="notes-title">{title}</span>
				<button class="notes-add-btn" on:click={addNoteAndOpen} title="Create note">
					<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v14h-2zM5 11h14v2H5z" fill="currentColor"/></svg>
				</button>
			</div>
			<div class="notes-list notes-list-cards">
				{#each notes as note (note.id)}
					<button
						class="notes-card"
						class:active={note.id === selectedNoteId}
						class:has-color={Boolean(note.color)}
						style={note.color ? `--note-color: ${note.color}` : ''}
						on:click={() => openNote(note.id)}
					>
						<div class="notes-item-top">
							{#if note.pinned}
								<svg class="notes-item-pin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-label="Pinned"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
							{/if}
							<span class="notes-item-time">{formatTs(note.updatedAt)}</span>
						</div>
						<span class="notes-item-preview">{previewText(note)}</span>
					</button>
				{:else}
					<div class="notes-empty">{emptyMessage}</div>
				{/each}
			</div>
		{/if}
	</div>
{:else}
	<div
		class="notes-workspace"
		class:sidebar-collapsed={sidebarWidth === SIDEBAR_COLLAPSED_WIDTH}
		style={`grid-template-columns: ${sidebarWidth}px ${SPLITTER_WIDTH}px minmax(0, 1fr);`}
		bind:this={workspaceElement}
	>
	<div class="notes-sidebar" class:collapsed={sidebarWidth === SIDEBAR_COLLAPSED_WIDTH}>
		{#if showHeader}
			<div class="notes-header">
				<span class="notes-title">{title}</span>
				<button class="notes-add-btn" on:click={addNote} title="Create note">
					<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v14h-2zM5 11h14v2H5z" fill="currentColor"/></svg>
				</button>
			</div>
		{/if}
		<div class="notes-list">
			{#each notes as note (note.id)}
				<button
					class="notes-item"
					class:active={note.id === selectedNoteId}
					class:has-color={Boolean(note.color)}
					style={note.color ? `--note-color: ${note.color}` : ''}
					on:click={() => selectedNoteId = note.id}
				>
					<div class="notes-item-top">
						{#if note.pinned}
							<svg class="notes-item-pin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-label="Pinned"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
						{/if}
						<span class="notes-item-time">{formatTs(note.updatedAt)}</span>
					</div>
					<span class="notes-item-preview">{previewText(note)}</span>
				</button>
			{:else}
				<div class="notes-empty">{emptyMessage}</div>
			{/each}
		</div>
	</div>
	<button
		class="notes-sidebar-resizer"
		type="button"
		on:mousedown={handleSidebarResizeStart}
		aria-label="Resize notes list"
		title="Resize notes list"
	></button>
	<div class="notes-editor">
		{#if selectedNote}
			<div class="notes-editor-toolbar">
				<div class="notes-toolbar-leading">
					{#if sidebarWidth === SIDEBAR_COLLAPSED_WIDTH}
						<button class="notes-open-sidebar-btn" type="button" on:click={openSidebar} title="Show note list" aria-label="Show note list">
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
						</button>
					{/if}
					<button
						class="notes-pin-btn"
						class:active={selectedNote.pinned}
						type="button"
						on:click={togglePinSelected}
						title={selectedNote.pinned ? 'Unpin note' : 'Pin to top'}
						aria-label={selectedNote.pinned ? 'Unpin note' : 'Pin to top'}
						aria-pressed={selectedNote.pinned ? 'true' : 'false'}
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
					</button>
					<div class="notes-color-row" role="group" aria-label="Note color">
						{#each NOTE_COLORS as color}
							<button
								class="notes-color-dot"
								class:active={selectedNote.color === color}
								type="button"
								style={`--swatch: ${color}`}
								on:click={() => updateSelectedColor(selectedNote.color === color ? undefined : color)}
								title="Set note color"
								aria-label="Set note color"
							></button>
						{/each}
					</div>
					<span class="notes-editor-time">Updated {formatTs(selectedNote.updatedAt)}</span>
				</div>
				<div class="notes-toolbar-actions">
					<button class="notes-reader-btn" on:click={openSelectedInReader} title="Open in Reader">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
							<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
							<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 0 4 24V4.5A2.5 2.5 0 0 1 6.5 2z"></path>
						</svg>
					</button>
					<button class="notes-add-btn editor-add" on:click={addNote} title="Create note">
						<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v14h-2zM5 11h14v2H5z" fill="currentColor"/></svg>
					</button>
					<button class="notes-delete-btn" on:click={deleteSelected} title="Delete note">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
				</div>
			</div>
			<textarea
				class="notes-input"
				value={selectedNote.text}
				on:input={(e) => updateSelectedText((e.currentTarget as HTMLTextAreaElement).value)}
				placeholder={placeholder}
			></textarea>
		{:else}
			<div class="notes-editor-empty">
				<div class="notes-empty-card">
					<strong>{emptyMessage}</strong>
					<span>Start a note and it will open here immediately.</span>
					<button class="notes-add-first-btn" on:click={addNote}>Create your first note</button>
				</div>
			</div>
		{/if}
	</div>
</div>
{/if}

<style>
	.notes-workspace {
		height: 100%;
		min-height: 0;
		display: grid;
	}

	.notes-sidebar {
		border-right: 1px solid var(--border-subtle);
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--surface-base);
	}

	.notes-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem;
		border-bottom: 1px solid var(--border-subtle);
	}

	.notes-title {
		font-size: 0.78rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-secondary);
		font-weight: 600;
	}

	.notes-reader-btn,
	.notes-add-btn {
		width: 26px;
		height: 26px;
		border-radius: 6px;
		border: none;
		background: transparent;
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		opacity: 0.72;
	}

	.notes-sidebar.collapsed {
		border-right: none;
		overflow: hidden;
	}

	.notes-reader-btn svg,
	.notes-add-btn svg {
		display: block;
		width: 14px;
		height: 14px;
		transform: translateY(-0.5px);
	}

	.notes-reader-btn:hover,
	.notes-add-btn:hover {
		color: var(--text-heading);
		background: transparent;
		opacity: 1;
	}

	.notes-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.25rem;
	}

	.notes-sidebar-resizer {
		padding: 0;
		border: none;
		border-left: 1px solid var(--border-subtle);
		border-right: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--accent-primary-color) 12%, transparent);
		cursor: ew-resize;
	}

	.notes-item {
		width: 100%;
		border: none;
		background: none;
		padding: 0.5rem;
		border-radius: 6px;
		text-align: left;
		color: var(--text-heading);
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.notes-item:hover {
		background: var(--surface-hover);
	}

	.notes-item.active {
		background: rgba(var(--accent-primary-rgb, 88, 101, 242), 0.12);
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
		border-bottom: 1px solid var(--border-subtle);
		background: var(--surface-base);
	}

	.notes-toolbar-leading {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
	}

	.notes-toolbar-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
	}

	.editor-add {
		width: 22px;
		height: 22px;
		border-radius: 4px;
	}

	.notes-open-sidebar-btn {
		width: 22px;
		height: 22px;
		border: none;
		background: transparent;
		color: var(--text-secondary);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		cursor: pointer;
	}

	.notes-open-sidebar-btn:hover {
		color: var(--text-heading);
		background: var(--surface-hover);
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
		color: var(--color-danger, #f44336);
		background: rgba(var(--color-danger-rgb, 244, 67, 54), 0.1);
	}

	.notes-input {
		flex: 1;
		min-height: 0;
		border: none;
		background: var(--surface-app);
		color: var(--text-heading);
		padding: 0.75rem;
		resize: none;
		font: inherit;
		line-height: 1.45;
	}

	.notes-input:focus {
		outline: none;
	}

	/* Pin + color controls (compact + full editor) */
	.notes-pin-btn {
		width: 22px;
		height: 22px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--text-secondary);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		flex: none;
	}

	.notes-pin-btn:hover {
		color: var(--text-heading);
		background: var(--surface-hover);
	}

	.notes-pin-btn.active {
		color: var(--accent-primary-color);
	}

	.notes-color-row {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: none;
	}

	.notes-color-dot {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 1px solid var(--border-subtle);
		background: var(--swatch);
		padding: 0;
		cursor: pointer;
		transition: transform 0.1s, box-shadow 0.1s;
	}

	.notes-color-dot:hover {
		transform: scale(1.12);
	}

	.notes-color-dot.active {
		box-shadow: 0 0 0 2px var(--surface-base), 0 0 0 3px var(--swatch);
	}

	.notes-item-pin {
		color: var(--accent-primary-color);
		flex: none;
	}

	.notes-card.has-color,
	.notes-item.has-color {
		border-left: 3px solid var(--note-color, transparent);
	}

	.notes-editor-empty {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
	}

	.notes-empty-card {
		width: min(100%, 340px);
		display: grid;
		gap: 0.55rem;
		padding: 1.1rem;
		border: 1px solid var(--border-subtle);
		border-radius: 14px;
		background: var(--surface-base);
		text-align: center;
	}

	.notes-empty-card strong {
		font-size: 0.95rem;
		color: var(--text-heading);
	}

	.notes-empty-card span {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.notes-add-first-btn {
		border: 1px solid var(--border-subtle);
		background: var(--surface-base);
		color: var(--text-heading);
		border-radius: 8px;
		padding: 0.5rem 0.75rem;
		cursor: pointer;
	}

	/* Compact (right dock) mode: single-column list OR editor view state */
	.notes-compact {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.notes-compact-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 0.55rem;
		border-bottom: 1px solid var(--border-subtle);
		flex-shrink: 0;
	}

	.notes-list-cards {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.4rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.notes-card {
		width: 100%;
		border: 1px solid var(--border-subtle);
		border-radius: 10px;
		background: var(--surface-base);
		padding: 0.55rem 0.65rem;
		text-align: left;
		color: var(--text-heading);
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		transition: background 0.1s, border-color 0.1s;
	}

	.notes-card:hover {
		background: var(--surface-hover);
	}

	.notes-card.active {
		background: rgba(var(--accent-primary-rgb, 88, 101, 242), 0.14);
		border-color: rgba(var(--accent-primary-rgb, 88, 101, 242), 0.4);
	}

	@media (max-width: 900px) {
		.notes-workspace {
			grid-template-columns: 1fr;
			grid-template-rows: 180px minmax(0, 1fr);
		}

		.notes-sidebar {
			border-right: none;
			border-bottom: 1px solid var(--border-subtle);
		}

		.notes-sidebar-resizer {
			display: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.notes-color-dot, .notes-card { transition: none; }
		.notes-color-dot:hover { transform: none; }
	}
</style>
