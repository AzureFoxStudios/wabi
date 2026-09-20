<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { notebookOwner } from '$lib/notes/scope';
	import { LocalNotebook } from '$lib/notes/db';
	import { parseReaderNoteSource } from '$lib/notes/readerBridge';
	import { openNotesSurface } from '$lib/notesWorkspace';
	import ReaderTabImpl from './ReaderTabImpl.svelte';
	import {
		openReaderStableDocument,
		readerSelection,
		updateReaderSelectionDocument,
		type ReaderDocumentSelection
	} from '$lib/readerWorkspace';
	import {
		acceptReaderSuggestion,
		addReaderDocumentComment,
		discardReaderDocument,
		ensureReaderDocument,
		findReaderDocumentForSelection,
		flushReaderDocument,
		hydrateReaderDocuments,
		promoteReaderDocument,
		readerDocuments,
		readerDocumentsHydrated,
		readerDocumentSaveState,
		readerDocumentScope,
		readerStoragePersistent,
		readerStorageError,
		readerRecoveryAvailable,
		exportReaderRecoverySources,
		retryReaderDocumentStorage,
		rejectReaderSuggestion,
		removeReaderDocumentComment,
		setReaderDocumentCommentResolved,
		updateReaderDocument,
		updateReaderSuggestion,
		type ReaderLocalDocument,
		type ReaderWorkMode
	} from '$lib/readerDocuments';

	let mode: ReaderWorkMode = 'read';
	let activeDocumentId: string | null = null;
	let editorTitle = '';
	let editorText = '';
	let activeSuggestionId: string | null = null;
	let commentDraft = '';
	let documentsOpen = false;
	let remoteNotice = '';
	let online = typeof navigator === 'undefined' ? true : navigator.onLine;
	let lastSelectionIdentity = '';
	let showingLocalDraft = false;

	$: selection = $readerSelection;
	$: documentMap = $readerDocuments;
	$: activeDocument = activeDocumentId ? documentMap[activeDocumentId] || null : null;
	$: localDocuments = Object.values(documentMap).sort((a, b) => b.updatedAt - a.updatedAt);
	$: saveState = activeDocumentId ? ($readerDocumentSaveState[activeDocumentId] || 'idle') : 'idle';
	$: openSuggestionCount = activeDocument?.suggestions.filter((suggestion) => suggestion.status === 'open').length || 0;
	$: unresolvedCommentCount = activeDocument?.comments.filter((comment) => !comment.resolved).length || 0;
	$: canWork = Boolean(selection && selection.contentType !== 'images');
	$: sourceNote = parseReaderNoteSource(selection?.sourceDocKey || activeDocument?.sourceDocKey);
	$: canReturnToNote = sourceNote && sourceNote.scopeId === $notebookOwner.owner?.scopeId;
	$: selectionIdentity = selection
		? `${selection.id}|${selection.documentId || selection.docKey}`
		: '';

	$: if (selectionIdentity !== lastSelectionIdentity) {
		lastSelectionIdentity = selectionIdentity;
		mode = 'read';
		activeSuggestionId = null;
		commentDraft = '';
		documentsOpen = false;
		remoteNotice = '';
		showingLocalDraft = selection?.source === 'document';
		activeDocumentId = selection?.documentId || null;
	}

	$: if (selection && $readerDocumentsHydrated) {
		// Reference the store reactively, then use the common lookup helper.
		documentMap;
		const existing = findReaderDocumentForSelection(selection);
		if (existing && activeDocumentId !== existing.documentId) activeDocumentId = existing.documentId;
		if (selection.source === 'document' && existing && mode === 'read' &&
			(selection.content !== existing.content || selection.title !== existing.title)) {
			updateReaderSelectionDocument({ title: existing.title, content: existing.content });
			showingLocalDraft = true;
		}
	}

	onMount(() => {
		void hydrateReaderDocuments();
		const updateOnline = () => { online = navigator.onLine; };
		window.addEventListener('online', updateOnline);
		window.addEventListener('offline', updateOnline);
		return () => {
			window.removeEventListener('online', updateOnline);
			window.removeEventListener('offline', updateOnline);
		};
	});

	onDestroy(() => {
		if (activeDocumentId) void flushReaderDocument(activeDocumentId);
	});

	function saveLabel(): string {
		if (!activeDocument) return 'Read only';
		if (saveState === 'dirty' || saveState === 'saving') return 'Saving locally…';
		if (saveState === 'error') return 'Local save needs attention';
		const base = saveState === 'saved' ? 'Saved locally' : 'Local draft';
		return online ? base : `${base} · Offline`;
	}

	function kindLabel(document: ReaderLocalDocument): string {
		return document.kind === 'native' ? 'Wabi document' : 'Local draft';
	}

	function syncPreview(title: string, content: string): void {
		updateReaderSelectionDocument({ title, content });
	}

	async function documentForCurrentSelection(): Promise<ReaderLocalDocument | null> {
		if (!selection || selection.contentType === 'images') return null;
		const current = selection;
		const document = await ensureReaderDocument(current);
		if (get(readerSelection)?.id !== current.id) return null;
		activeDocumentId = document.documentId;
		return document;
	}

	async function enterMode(nextMode: ReaderWorkMode): Promise<void> {
		if (nextMode === 'read') {
			const current = selection?.id;
			if (activeDocumentId) await flushReaderDocument(activeDocumentId);
			if (get(readerSelection)?.id !== current) return;
			const document = activeDocumentId ? documentMap[activeDocumentId] : null;
			if (document && showingLocalDraft) syncPreview(document.title, document.content);
			mode = 'read';
			activeSuggestionId = null;
			return;
		}
		if (!canWork) return;
		const document = await documentForCurrentSelection();
		if (!document) return;
		showingLocalDraft = true;
		if (nextMode === 'suggest') {
			const openSuggestion = [...document.suggestions].reverse().find((suggestion) => suggestion.status === 'open');
			activeSuggestionId = openSuggestion?.id || null;
			editorTitle = openSuggestion?.title || document.title;
			editorText = openSuggestion?.content || document.content;
			syncPreview(editorTitle, editorText);
		} else {
			activeSuggestionId = null;
			editorTitle = document.title;
			editorText = document.content;
			syncPreview(document.title, document.content);
		}
		mode = nextMode;
	}

	function handleEditorChange(): void {
		if (!activeDocumentId) return;
		if (mode === 'edit') {
			const next = updateReaderDocument(activeDocumentId, { title: editorTitle, content: editorText });
			if (next) syncPreview(next.title, next.content);
			return;
		}
		if (mode === 'suggest') {
			const suggestion = updateReaderSuggestion(activeDocumentId, activeSuggestionId, {
				title: editorTitle,
				content: editorText
			});
			if (suggestion) {
				activeSuggestionId = suggestion.id;
				syncPreview(suggestion.title, suggestion.content);
			}
		}
	}

	function applySuggestion(suggestionId: string): void {
		if (!activeDocumentId) return;
		const next = acceptReaderSuggestion(activeDocumentId, suggestionId);
		if (!next) return;
		activeSuggestionId = null;
		showingLocalDraft = true;
		syncPreview(next.title, next.content);
		mode = 'read';
	}

	function discardSuggestion(suggestionId: string): void {
		if (!activeDocumentId) return;
		const next = rejectReaderSuggestion(activeDocumentId, suggestionId);
		if (!next) return;
		if (activeSuggestionId === suggestionId) activeSuggestionId = null;
		syncPreview(next.title, next.content);
		mode = 'read';
	}

	function addComment(): void {
		if (!activeDocumentId || !commentDraft.trim()) return;
		addReaderDocumentComment(activeDocumentId, commentDraft);
		commentDraft = '';
	}

	async function promoteCurrentDocument(): Promise<void> {
		if (!activeDocumentId) return;
		const current = selection?.id;
		const promoted = promoteReaderDocument(activeDocumentId);
		if (!promoted) return;
		await flushReaderDocument(promoted.documentId);
		if (get(readerSelection)?.id !== current) return;
		openLocalDocument(promoted);
	}

	async function discardCurrentWorkingCopy(): Promise<void> {
		if (!activeDocument || activeDocument.kind !== 'working-copy') return;
		const current = selection?.id;
		const title = activeDocument.originalTitle;
		const content = activeDocument.originalContent;
		const id = activeDocument.documentId;
		await discardReaderDocument(id);
		if (get(readerSelection)?.id !== current || get(readerDocuments)[id]) return;
		activeDocumentId = null;
		mode = 'read';
		showingLocalDraft = false;
		activeSuggestionId = null;
		syncPreview(title, content);
	}

	function viewSourceSnapshot(): void {
		if (!activeDocument || activeDocument.kind !== 'working-copy') return;
		showingLocalDraft = false;
		mode = 'read';
		syncPreview(activeDocument.originalTitle, activeDocument.originalContent);
	}

	function resumeLocalDraft(): void {
		if (!activeDocument) return;
		showingLocalDraft = true;
		syncPreview(activeDocument.title, activeDocument.content);
	}

	function openLocalDocument(document: ReaderLocalDocument): void {
		activeDocumentId = document.documentId;
		showingLocalDraft = true;
		mode = 'read';
		activeSuggestionId = null;
		documentsOpen = false;
		openReaderStableDocument({
			documentId: document.documentId,
			title: document.title,
			content: document.content,
			format: document.format,
			language: document.language,
			sourceDocKey: document.sourceDocKey
		});
	}

	function explainRemoteState(action: 'share' | 'live'): void {
		remoteNotice = action === 'live'
			? 'Live collaboration is not being faked: this V1 currently keeps the document private and local until the real replication transport is connected.'
			: 'Sharing is intentionally gated until Reader has a real local-first replication transport. Nothing was uploaded or exposed.';
	}

	function formatUpdated(timestamp: number): string {
		const age = Math.max(0, Date.now() - timestamp);
		if (age < 60_000) return 'just now';
		if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
		if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
		return new Date(timestamp).toLocaleDateString();
	}
	async function returnToNote(): Promise<void> {
		const target = sourceNote, owner = $notebookOwner.owner, current = selection?.id;
		if (!target || !owner || owner.scopeId !== target.scopeId) return;
		if (activeDocumentId) {
			const id = activeDocumentId;
			await flushReaderDocument(id);
			if (get(readerDocumentSaveState)[id] === 'error') { remoteNotice = 'Your Reader copy has unsaved changes. Download it or retry saving before returning to Notes.'; return; }
		}
		if (get(readerSelection)?.id !== current || !owner.isCurrent()) return;
		try {
			const note = await new LocalNotebook(owner).get(target.noteId);
			if (get(readerSelection)?.id !== current || !owner.isCurrent()) return;
			if (!note) { remoteNotice = 'The original note was deleted. This Reader copy is still available.'; return; }
			openNotesSurface(target);
		} catch (error) { remoteNotice = error instanceof Error ? error.message : 'Could not reopen the original note.'; }
	}
	async function downloadRecovery(): Promise<void> {
		const scope = get(readerDocumentScope), identity = get(notebookOwner);
		try {
			const raw = await exportReaderRecoverySources();
			if (get(readerDocumentScope) !== scope || get(notebookOwner) !== identity) return;
			const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
			const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'wabi-reader-recovery.json'; anchor.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (error) { remoteNotice = error instanceof Error ? error.message : 'Could not export Reader recovery sources.'; }
	}
</script>

<div class="reader-workbench" class:has-selection={Boolean(selection)}>
	<div class="reader-document-bar" class:reader-document-bar--home={!selection}>
		<div class="reader-document-identity">
			{#if activeDocument}
				<span class="reader-document-kind">{kindLabel(activeDocument)}</span>
				<span class="reader-document-privacy">Private · this device</span>
			{:else if selection}
				<span class="reader-document-kind">Reader</span>
				<span class="reader-document-privacy">Source unchanged</span>
			{:else}
				<span class="reader-document-kind">Documents</span>
				<span class="reader-document-privacy">Local first</span>
			{/if}
		</div>

		{#if selection && canWork}
			<div class="reader-work-modes" role="group" aria-label="Document mode">
				<button type="button" class:active={mode === 'read'} on:click={() => enterMode('read')}>Read</button>
				<button type="button" class:active={mode === 'edit'} on:click={() => enterMode('edit')}>Edit</button>
				<button type="button" class:active={mode === 'suggest'} on:click={() => enterMode('suggest')}>
					Suggest{openSuggestionCount ? ` ${openSuggestionCount}` : ''}
				</button>
				<button type="button" class:active={mode === 'comment'} on:click={() => enterMode('comment')}>
					Comment{unresolvedCommentCount ? ` ${unresolvedCommentCount}` : ''}
				</button>
			</div>
		{/if}

		<div class="reader-document-actions">
			{#if canReturnToNote}<button type="button" class="reader-action-emphasis" on:click={returnToNote}>Return to note</button>{/if}
			{#if activeDocument}
				<span class="reader-local-save" class:error={saveState === 'error'}>{saveLabel()}</span>
				{#if activeDocument.kind === 'working-copy'}
					<button type="button" class="reader-action-emphasis" on:click={promoteCurrentDocument}>Save as Wabi Document</button>
					{#if showingLocalDraft}
						<button type="button" on:click={viewSourceSnapshot}>View source</button>
					{:else}
						<button type="button" on:click={resumeLocalDraft}>Resume local</button>
					{/if}
					<button type="button" class="reader-action-danger" on:click={discardCurrentWorkingCopy}>Discard draft</button>
				{/if}
				<button type="button" on:click={() => explainRemoteState('share')}>Share</button>
				<button type="button" on:click={() => explainRemoteState('live')}>Go Live</button>
			{/if}
			<div class="reader-documents-menu-wrap">
				<button type="button" class:active={documentsOpen} on:click={() => (documentsOpen = !documentsOpen)}>
					Documents{localDocuments.length ? ` ${localDocuments.length}` : ''}
				</button>
				{#if documentsOpen}
					<div class="reader-documents-menu">
						<div class="reader-documents-menu-head">
							<strong>Local documents</strong>
							<span>{localDocuments.length} on this device</span>
						</div>
						{#if localDocuments.length === 0}
							<p>Edit anything in Reader and the first change becomes a private local draft.</p>
						{:else}
							{#each localDocuments as document (document.documentId)}
								<button type="button" class="reader-document-row" on:click={() => openLocalDocument(document)}>
									<span class="reader-document-row-main">
										<strong>{document.title}</strong>
										<small>{kindLabel(document)} · {document.format}</small>
									</span>
									<span class="reader-document-row-time">{formatUpdated(document.updatedAt)}</span>
								</button>
							{/each}
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>
	{#if $readerStorageError}
		<div class="reader-storage-notice" role="alert"><span>{$readerStorageError}</span><button type="button" on:click={() => retryReaderDocumentStorage()}>Retry device storage</button><button type="button" on:click={downloadRecovery}>Download recovery sources</button></div>
	{/if}
	{#if $readerRecoveryAvailable.legacyDocuments || $readerRecoveryAvailable.localSources}
		<div class="reader-storage-notice"><span>Older Reader writing is preserved. Unassigned records need an explicit account choice before import.</span><button type="button" on:click={downloadRecovery}>Download older writing</button></div>
	{/if}

	{#if remoteNotice}
		<div class="reader-remote-notice" role="status">
			<span>{remoteNotice}</span>
			<button type="button" aria-label="Dismiss" on:click={() => (remoteNotice = '')}>×</button>
		</div>
	{/if}

	<div class="reader-workbench-body" class:editing={mode === 'edit' || mode === 'suggest'} class:commenting={mode === 'comment'}>
		{#if (mode === 'edit' || mode === 'suggest') && activeDocument}
			<section class="reader-editor-pane" aria-label={mode === 'suggest' ? 'Suggestion editor' : 'Document editor'}>
				<div class="reader-editor-head">
					<div>
						<strong>{mode === 'suggest' ? 'Suggestion' : 'Local editor'}</strong>
						<small>{mode === 'suggest' ? 'Canonical document is unchanged until this suggestion is applied.' : 'Every change is persisted locally before sync exists.'}</small>
					</div>
					<span>{activeDocument.format}{activeDocument.language ? ` · ${activeDocument.language}` : ''}</span>
				</div>
				<label class="reader-editor-title">
					<span>Title</span>
					<input bind:value={editorTitle} on:input={handleEditorChange} />
				</label>
				<textarea
					class:code-editor={activeDocument.format === 'code'}
					bind:value={editorText}
					on:input={handleEditorChange}
					spellcheck={activeDocument.format !== 'code'}
					aria-label="Document content"
				></textarea>
				<div class="reader-editor-foot">
					<span>{editorText.length.toLocaleString()} characters · {saveLabel()}</span>
					{#if mode === 'suggest' && activeSuggestionId}
						<div class="reader-suggestion-actions">
							<button type="button" class="reader-action-emphasis" on:click={() => applySuggestion(activeSuggestionId!)}>Apply suggestion</button>
							<button type="button" on:click={() => discardSuggestion(activeSuggestionId!)}>Reject</button>
						</div>
					{/if}
				</div>
				{#if mode === 'suggest' && openSuggestionCount > 0}
					<div class="reader-open-suggestions">
						<strong>Open suggestions</strong>
						{#each activeDocument.suggestions.filter((suggestion) => suggestion.status === 'open') as suggestion (suggestion.id)}
							<div class="reader-suggestion-row" class:active={suggestion.id === activeSuggestionId}>
								<button type="button" class="reader-suggestion-copy" on:click={() => {
									activeSuggestionId = suggestion.id;
									editorTitle = suggestion.title;
									editorText = suggestion.content;
									syncPreview(suggestion.title, suggestion.content);
								}}>
									<span>Revision {suggestion.baseRevision + 1}</span>
									<small>{formatUpdated(suggestion.updatedAt)}</small>
								</button>
								<button type="button" on:click={() => applySuggestion(suggestion.id)}>Apply</button>
								<button type="button" on:click={() => discardSuggestion(suggestion.id)}>Reject</button>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		{/if}

		<div class="reader-workbench-reader">
			<ReaderTabImpl />
		</div>

		{#if mode === 'comment' && activeDocument}
			<aside class="reader-comments-pane" aria-label="Document comments">
				<div class="reader-comments-head">
					<div>
						<strong>Comments</strong>
						<small>Stored locally with this document.</small>
					</div>
					<span>{unresolvedCommentCount} open</span>
				</div>
				<div class="reader-comment-compose">
					<textarea bind:value={commentDraft} placeholder="Add a comment about this document…"></textarea>
					<button type="button" class="reader-action-emphasis" disabled={!commentDraft.trim()} on:click={addComment}>Add comment</button>
				</div>
				<div class="reader-comments-list">
					{#if activeDocument.comments.length === 0}
						<p>No comments yet.</p>
					{:else}
						{#each [...activeDocument.comments].reverse() as comment (comment.id)}
							<article class:resolved={comment.resolved}>
								<div class="reader-comment-meta">
									<span>{comment.resolved ? 'Resolved' : 'Open'} · {formatUpdated(comment.updatedAt)}</span>
									<button type="button" on:click={() => removeReaderDocumentComment(activeDocument.documentId, comment.id)}>×</button>
								</div>
								<p>{comment.body}</p>
								<button type="button" on:click={() => setReaderDocumentCommentResolved(activeDocument.documentId, comment.id, !comment.resolved)}>
									{comment.resolved ? 'Reopen' : 'Resolve'}
								</button>
							</article>
						{/each}
					{/if}
				</div>
			</aside>
		{/if}
	</div>

	{#if activeDocument && $readerStoragePersistent === false}
		<div class="reader-storage-caveat">Browser storage is not marked persistent. Your draft is still saved locally, but the browser may evict site data under storage pressure.</div>
	{/if}
</div>

<style>
	.reader-storage-notice { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px 16px; color: var(--text-primary); background: var(--surface-raised); border-bottom: 1px solid var(--border-subtle); font-size: .85rem; line-height: 1.5; }
	.reader-storage-notice span { flex: 1 1 240px; }
	.reader-storage-notice button { min-height: 36px; padding: 6px 10px; color: inherit; background: var(--surface-base); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); cursor: pointer; }
	.reader-storage-notice button:focus-visible { outline: 2px solid var(--accent-primary-color); }
	@media (pointer: coarse) { .reader-storage-notice button { min-height: 44px; } }
	.reader-workbench {
		height: 100%;
		min-height: 0;
		container: reader-workbench / inline-size;
		display: flex;
		flex-direction: column;
		position: relative;
		background: var(--bg-primary, #0f1020);
	}

	.reader-document-bar {
		min-height: 46px;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 10px;
		border-bottom: 1px solid color-mix(in srgb, var(--border, #303450) 82%, transparent);
		background: color-mix(in srgb, var(--bg-secondary, #17192a) 92%, transparent);
		z-index: 20;
	}

	.reader-document-bar--home .reader-document-identity { margin-right: auto; }
	.reader-document-identity { min-width: 118px; display: flex; flex-direction: column; line-height: 1.15; }
	.reader-document-kind { color: var(--text-primary, #f5f6fb); font-size: 12px; font-weight: 750; }
	.reader-document-privacy { color: var(--text-muted, #9399ae); font-size: 10px; margin-top: 2px; }

	.reader-work-modes {
		display: inline-flex;
		align-items: center;
		padding: 2px;
		border: 1px solid var(--border, #303450);
		border-radius: 10px;
		background: color-mix(in srgb, var(--bg-primary, #0f1020) 70%, transparent);
	}

	.reader-work-modes button,
	.reader-document-actions button,
	.reader-suggestion-actions button,
	.reader-comment-compose button,
	.reader-editor-foot button,
	.reader-comment-meta button,
	.reader-comments-list article > button {
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-secondary, #c8cbda);
		font: inherit;
		font-size: 11px;
		padding: 6px 9px;
		cursor: pointer;
	}

	.reader-work-modes button:hover,
	.reader-document-actions button:hover,
	.reader-editor-foot button:hover,
	.reader-comments-list article > button:hover { background: rgba(255,255,255,0.07); color: var(--text-primary, #fff); }
	.reader-work-modes button.active,
	.reader-document-actions button.active { background: rgba(255,255,255,0.11); color: var(--text-primary, #fff); }

	.reader-document-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; min-width: 0; }
	.reader-local-save { font-size: 10px; color: var(--text-muted, #9399ae); white-space: nowrap; margin-right: 4px; }
	.reader-local-save.error { color: var(--color-danger, #ef7b7b); }
	button.reader-action-emphasis { background: color-mix(in srgb, var(--accent, #8f8cff) 22%, transparent); color: var(--text-primary, #fff); }
	button.reader-action-danger { color: var(--color-danger, #ef8d8d); }

	.reader-documents-menu-wrap { position: relative; }
	.reader-documents-menu {
		position: absolute;
		right: 0;
		top: calc(100% + 8px);
		width: min(360px, calc(100vw - 24px));
		max-height: 430px;
		overflow: auto;
		padding: 8px;
		border: 1px solid var(--border, #303450);
		border-radius: 12px;
		background: var(--bg-secondary, #17192a);
		box-shadow: 0 18px 48px rgba(0,0,0,0.38);
		z-index: 60;
	}
	.reader-documents-menu-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 4px 6px 9px; }
	.reader-documents-menu-head strong { font-size: 12px; }
	.reader-documents-menu-head span, .reader-documents-menu p { color: var(--text-muted, #9399ae); font-size: 10px; }
	.reader-document-row { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px; text-align: left; }
	.reader-document-row + .reader-document-row { border-top: 1px solid color-mix(in srgb, var(--border, #303450) 65%, transparent); }
	.reader-document-row-main { min-width: 0; display: flex; flex-direction: column; }
	.reader-document-row-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.reader-document-row-main small, .reader-document-row-time { color: var(--text-muted, #9399ae); font-size: 10px; }
	.reader-document-row-time { flex-shrink: 0; }

	.reader-remote-notice,
	.reader-storage-caveat {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 7px 12px;
		background: color-mix(in srgb, var(--accent, #8f8cff) 11%, var(--bg-secondary, #17192a));
		border-bottom: 1px solid color-mix(in srgb, var(--accent, #8f8cff) 30%, transparent);
		color: var(--text-secondary, #c8cbda);
		font-size: 11px;
		z-index: 15;
	}
	.reader-remote-notice button { margin-left: auto; border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 16px; }
	.reader-storage-caveat { border-top: 1px solid var(--border, #303450); border-bottom: 0; background: color-mix(in srgb, #d29922 10%, var(--bg-secondary, #17192a)); }

	.reader-workbench-body { flex: 1; min-height: 0; display: flex; position: relative; overflow: hidden; }
	.reader-workbench-reader { flex: 1 1 auto; min-width: 0; min-height: 0; }

	.reader-editor-pane {
		flex: 0 1 46%;
		min-width: 320px;
		max-width: 720px;
		min-height: 0;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--border, #303450);
		background: var(--bg-primary, #0f1020);
	}
	.reader-editor-head, .reader-comments-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px 9px; border-bottom: 1px solid var(--border, #303450); }
	.reader-editor-head > div, .reader-comments-head > div { display: flex; flex-direction: column; }
	.reader-editor-head strong, .reader-comments-head strong { font-size: 12px; }
	.reader-editor-head small, .reader-comments-head small, .reader-editor-head > span, .reader-comments-head > span { color: var(--text-muted, #9399ae); font-size: 10px; }
	.reader-editor-title { display: flex; flex-direction: column; gap: 5px; padding: 10px 14px 0; }
	.reader-editor-title span { color: var(--text-muted, #9399ae); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
	.reader-editor-title input { width: 100%; box-sizing: border-box; border: 1px solid var(--border, #303450); border-radius: 8px; background: var(--bg-secondary, #17192a); color: var(--text-primary, #fff); padding: 8px 10px; font: inherit; font-weight: 700; }
	.reader-editor-pane > textarea { flex: 1; min-height: 0; max-height: none; resize: none; margin: 10px 14px; padding: 14px; border: 1px solid var(--border, #303450); border-radius: 10px; outline: none; background: color-mix(in srgb, var(--bg-secondary, #17192a) 86%, black); color: var(--text-primary, #f5f6fb); font: 14px/1.65 ui-sans-serif, system-ui, sans-serif; tab-size: 4; }
	.reader-editor-pane > textarea:focus, .reader-editor-title input:focus { border-color: color-mix(in srgb, var(--accent, #8f8cff) 68%, var(--border, #303450)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #8f8cff) 15%, transparent); }
	.reader-editor-pane > textarea.code-editor { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; overflow: auto; }
	.reader-editor-foot { min-height: 42px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 12px; border-top: 1px solid var(--border, #303450); color: var(--text-muted, #9399ae); font-size: 10px; }
	.reader-suggestion-actions { display: flex; gap: 4px; }

	.reader-open-suggestions { max-height: 180px; overflow: auto; border-top: 1px solid var(--border, #303450); padding: 8px 10px; }
	.reader-open-suggestions > strong { display: block; color: var(--text-muted, #9399ae); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; padding: 2px 4px 6px; }
	.reader-suggestion-row { display: flex; align-items: center; gap: 4px; border-radius: 8px; }
	.reader-suggestion-row.active { background: rgba(255,255,255,.05); }
	.reader-suggestion-copy { flex: 1; display: flex; justify-content: space-between; text-align: left; }
	.reader-suggestion-copy small { color: var(--text-muted, #9399ae); }

	.reader-comments-pane { flex: 0 0 340px; min-height: 0; display: flex; flex-direction: column; border-left: 1px solid var(--border, #303450); background: var(--bg-primary, #0f1020); }
	.reader-comment-compose { padding: 10px; border-bottom: 1px solid var(--border, #303450); }
	.reader-comment-compose textarea { width: 100%; min-height: 86px; box-sizing: border-box; resize: vertical; border: 1px solid var(--border, #303450); border-radius: 9px; background: var(--bg-secondary, #17192a); color: var(--text-primary, #fff); padding: 9px; font: inherit; }
	.reader-comment-compose button { margin-top: 7px; }
	.reader-comments-list { flex: 1; min-height: 0; overflow: auto; padding: 9px; }
	.reader-comments-list > p { color: var(--text-muted, #9399ae); font-size: 11px; }
	.reader-comments-list article { margin-bottom: 8px; padding: 9px; border: 1px solid var(--border, #303450); border-radius: 9px; background: var(--bg-secondary, #17192a); }
	.reader-comments-list article.resolved { opacity: .58; }
	.reader-comments-list article p { margin: 7px 0; white-space: pre-wrap; font-size: 12px; line-height: 1.5; }
	.reader-comment-meta { display: flex; justify-content: space-between; align-items: center; color: var(--text-muted, #9399ae); font-size: 9px; }
	.reader-comment-meta button { padding: 0 4px; font-size: 15px; }

	@media (max-width: 1050px) {
		.reader-document-identity { display: none; }
		.reader-local-save { display: none; }
		.reader-document-bar { overflow-x: auto; }
		.reader-document-actions { margin-left: 0; }
	}

	@media (max-width: 760px) {
		.reader-document-bar { align-items: flex-start; flex-wrap: wrap; padding: 6px; }
		.reader-work-modes { order: 1; }
		.reader-document-actions { order: 2; margin-left: auto; }
		.reader-document-actions > button:not(.reader-action-emphasis), .reader-action-danger { display: none; }
	}

	/* Editor geometry follows the space left by the shell and optional docks. */
	@container reader-workbench (max-width: 760px) {
		.reader-workbench-body.editing { flex-direction: column; }
		.reader-workbench-body.editing .reader-editor-pane { flex: 0 0 52%; width: 100%; max-width: none; min-width: 0; border-right: 0; border-bottom: 1px solid var(--border, #303450); }
		.reader-workbench-body.editing .reader-workbench-reader { flex: 1 1 48%; }
		.reader-workbench-body.commenting { flex-direction: column; }
		.reader-workbench-body.commenting .reader-comments-pane { flex: 0 0 42%; width: 100%; border-left: 0; border-top: 1px solid var(--border, #303450); }
	}
</style>
