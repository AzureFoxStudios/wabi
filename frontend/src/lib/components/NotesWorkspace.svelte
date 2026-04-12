<script lang="ts">
	import { onMount } from 'svelte';
	import { createEmptyNote, readNotes, writeNotes, type LocalNote } from '$lib/notesStore';
	import { openReaderDocument } from '$lib/readerWorkspace';

	export let storageKey: string;
	export let title = 'Notes';
	export let emptyMessage = 'No notes yet.';
	export let placeholder = 'Write your note...';
	export let showHeader = true;

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
		const next = readNotes(key).slice().sort((a, b) => b.updatedAt - a.updatedAt);
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
		notes = notes
			.map((note) => {
				if (note.id !== selectedNote.id) return note;
				return {
					...note,
					text: nextText,
					updatedAt: Date.now()
				};
			})
			.sort((a, b) => b.updatedAt - a.updatedAt);
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

<style>
	.notes-workspace {
		height: 100%;
		min-height: 0;
		display: grid;
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
		color: var(--text-primary);
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
		border-left: 1px solid var(--border);
		border-right: 1px solid var(--border);
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		cursor: ew-resize;
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
		color: var(--text-primary);
		background: var(--bg-hover);
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
		padding: 1.5rem;
	}

	.notes-empty-card {
		width: min(100%, 340px);
		display: grid;
		gap: 0.55rem;
		padding: 1.1rem;
		border: 1px solid var(--border);
		border-radius: 14px;
		background: var(--bg-secondary);
		text-align: center;
	}

	.notes-empty-card strong {
		font-size: 0.95rem;
		color: var(--text-primary);
	}

	.notes-empty-card span {
		font-size: 0.8rem;
		color: var(--text-secondary);
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

		.notes-sidebar-resizer {
			display: none;
		}
	}
</style>
