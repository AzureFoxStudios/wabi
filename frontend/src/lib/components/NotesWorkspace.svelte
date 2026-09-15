<script lang="ts">
	import { untrack } from 'svelte';
	import { writable, get } from 'svelte/store';
	import { notebookOwner, chooseOfflineNotebook } from '$lib/notes/scope';
	import { LocalNotebook } from '$lib/notes/db';
	import { NoteEditor, announceNotebookChange, subscribeNotebookChanges, retainedNoteEditors, type NoteDraft } from '$lib/notes/editor';
	import { discoverLegacyNotes, type LegacyNotePreview } from '$lib/notes/migration';
	import type { NotebookNote, NotebookLink, RecoveredNoteDraft } from '$lib/notes/types';
	import { openReaderDocument } from '$lib/readerWorkspace';
	import { NOTE_COLORS } from '$lib/notesStore';
	import { notesOpenRequest } from '$lib/notesWorkspace';
	import { parseNotebookBackup, serializeNotebookBackup, MAX_NOTEBOOK_BACKUP_BYTES, type NotebookBackup } from '$lib/notes/backup';

	let { title = 'Notes', emptyMessage = 'Keep personal notes, links, and reminders on this device.', placeholder = 'Write a note…', showHeader = true, compact = false, contextChannelId }:
		{ title?: string; emptyMessage?: string; placeholder?: string; showHeader?: boolean; compact?: boolean; contextChannelId?: string } = $props();
	let book = $state<LocalNotebook | null>(null);
	let notes = $state<NotebookNote[]>([]);
	let editor = $state<NoteEditor | null>(null);
	const emptyDraft = writable<NoteDraft | null>(null);
	const draftStore = $derived(editor?.state ?? emptyDraft);
	let error = $state('');
	let loading = $state(true);
	let busy = $state(false);
	let opening = $state(false);
	let search = $state('');
	let trash = $state(false);
	let showList = $state(true);
	let width = $state(0);
	let sidebarWidth = $state(240);
	let outgoing = $state<NotebookLink[]>([]);
	let incoming = $state<NotebookLink[]>([]);
	let legacy = $state<LegacyNotePreview[]>([]);
	let recoverOpen = $state(false);
	let recoveredMessage = $state('');
	let selectedLegacy = $state('');
	let backupRaw = $state('');
	let backupPreview = $state<NotebookBackup | null>(null);
	let recoveryDrafts = $state<NoteEditor[]>([]);
	let recoveredDrafts = $state<RecoveredNoteDraft[]>([]);
	let history = $state<string[]>([]);
	const colorNames = ['Accent', 'Green', 'Amber', 'Red', 'Purple', 'Muted'];
	let actionMenu = $state<HTMLDetailsElement | null>(null);
	let openSequence = 0;
	let importSequence = 0;
	const narrow = $derived(compact || width < 620);
	const visible = $derived(notes.filter(note => (note.trashedAt !== null) === trash && (!contextChannelId || note.contextChannelId === contextChannelId) && `${note.title}\n${note.text}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt));
	const legacySelection = $derived(legacy.find(source => source.key === selectedLegacy));
	$effect(() => {
		const request = $notesOpenRequest;
		const current = book;
		if (!compact && !contextChannelId && request && current?.owner.scopeId === request.scopeId) untrack(() => { void openNote(request.noteId); });
	});

	$effect(() => {
		const owner = $notebookOwner.owner;
		untrack(() => {
			editor?.dispose(); editor = null; notes = []; recoveryDrafts = []; recoveredDrafts = []; error = ''; loading = true;
			backupPreview = null; backupRaw = ''; legacy = []; selectedLegacy = ''; recoveredMessage = ''; history = []; search = ''; recoverOpen = false; opening = false; importSequence++;
			book = owner ? new LocalNotebook(owner) : null;
			if (book) void refresh(book);
		});
		if (!owner) return;
		const current = untrack(() => book!);
		const stop = subscribeNotebookChanges(owner.scopeId, () => { void refresh(current); });
		return () => { stop(); untrack(() => editor?.dispose()); openSequence++; };
	});

	async function refresh(current = book) {
		if (!current) return;
		if (book === current) recoveryDrafts = retainedNoteEditors(current).filter(draft => draft !== editor);
		try {
			const [rows, recovered] = await Promise.all([current.list(), current.listRecoveredDrafts()]);
			if (book !== current || !current.owner.isCurrent()) return;
			notes = rows; loading = false; error = '';
			recoveryDrafts = retainedNoteEditors(current).filter(draft => draft !== editor);
			const runtime = retainedNoteEditors(current);
			recoveredDrafts = recovered.filter(draft => !runtime.some(active => draft.id === `draft:${current.owner.scopeId}:${active.id}`));
			try { legacy = discoverLegacyNotes(localStorage); } catch { error = 'Existing note recovery sources could not be read. Your notebook is still available.'; }
			if (editor) await loadLinks(current, editor);
		} catch (failure) { if (book === current) { recoveryDrafts = retainedNoteEditors(current).filter(draft => draft !== editor); loading = false; error = failure instanceof Error ? failure.message : 'Could not read local Notes.'; } }
	}

	async function loadLinks(current: LocalNotebook, active: NoteEditor) {
		let id = '';
		const stop = active.state.subscribe(draft => { id = draft.note.id; }); stop();
		const [links, backlinks] = await Promise.all([current.outgoing(id), current.backlinks(id)]);
		if (book === current && editor === active) { outgoing = links; incoming = backlinks; }
	}

	async function openNote(id: string, remember = true) {
		if (!book) return;
		actionMenu?.removeAttribute('open');
		const current = book;
		const ticket = ++openSequence;
		opening = true;
		try {
			const note = await current.get(id);
			if (ticket !== openSequence || book !== current || !note) return;
			if (remember && $draftStore?.note.id && $draftStore.note.id !== id) history = [...history, $draftStore.note.id];
			editor?.dispose(); editor = new NoteEditor(current, note); showList = false; error = '';
			await loadLinks(current, editor);
		} catch (failure) { if (book === current) error = failure instanceof Error ? failure.message : 'Could not open this note.'; }
		finally { if (ticket === openSequence) opening = false; }
	}

	function nextTitle(base: string): string {
		let candidate = base, suffix = 2;
		while (notes.some(note => note.normalizedTitle === candidate.normalize('NFKC').toLowerCase())) candidate = `${base} ${suffix++}`;
		return candidate;
	}
	async function createNote() {
		if (!book || busy) return;
		busy = true;
		const current = book;
		try {
			const note = await current.create(nextTitle('Untitled note'), '', contextChannelId);
			if (book !== current) return;
			trash = false; search = ''; announceNotebookChange(current.owner.scopeId); await openNote(note.id);
		} catch (failure) { error = failure instanceof Error ? failure.message : 'Could not create this note.'; }
		finally { busy = false; }
	}
	async function changeNote(action: 'trash' | 'restore' | 'pin' | 'delete', color?: string) {
		if (!book || !editor || !$draftStore || busy) return;
		const current = book, active = editor;
		busy = true;
		try {
			if (get(active.state).dirty && !await active.save()) return;
			if (book !== current || editor !== active || !current.owner.isCurrent()) return;
			const note = get(active.state).note;
			if (action === 'delete') {
				if (!window.confirm(`Permanently delete “${note.title}”? This cannot be undone. Export a copy first if you need it.`)) return;
				await current.permanentlyDelete(note.id, note.revision);
				if (editor === active) { editor.dispose(); editor = null; showList = true; }
			} else if (action === 'trash' || action === 'restore') await current.setTrashed(note.id, note.revision, action === 'trash');
			else await current.save(note.id, note.revision, color === undefined ? { pinned: !note.pinned } : { color });
			await active.refresh(); actionMenu?.removeAttribute('open'); announceNotebookChange(current.owner.scopeId);
		} catch (failure) { error = failure instanceof Error ? failure.message : 'Could not save this change.'; }
		finally { busy = false; }
	}
	function download(name: string, text: string, type = 'text/markdown') {
		const url = URL.createObjectURL(new Blob([text], { type }));
		const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	async function recoverDraft(active = editor) {
		if (!active || busy) return;
		busy = true;
		try {
			const note = await active.saveRecoveryCopy(nextTitle('Recovered note'), book ?? active.book);
			if (active === editor) await openNote(note.id);
			await refresh();
		} catch (failure) { error = failure instanceof Error ? failure.message : 'Could not save the recovery copy. Download the draft before leaving.'; }
		finally { busy = false; }
	}
	async function importSelected() {
		if (!book || !legacySelection || busy) return;
		busy = true;
		const current = book;
		try {
			const result = await current.importLegacy(legacySelection.key, legacySelection.raw);
			if (book !== current) return;
			recoveredMessage = `${result.alreadyImported ? 'Already recovered' : 'Recovered'} ${result.noteIds.length} notes. Original source kept. ${result.issues.join(' ')}`;
			announceNotebookChange(current.owner.scopeId);
		} catch (failure) { error = failure instanceof Error ? failure.message : 'Could not recover this source. Download its original bytes.'; }
		finally { busy = false; }
	}
	async function recoverStored(draft: RecoveredNoteDraft) {
		if (!book || busy) return;
		busy = true;
		const current = book;
		try {
			const note = await current.create(nextTitle('Recovered note'), draft.text);
			await current.removeRecoveredDraft(draft.id);
			announceNotebookChange(current.owner.scopeId);
			if (book === current) await openNote(note.id);
		} catch (failure) { error = (failure as Error).message; }
		finally { busy = false; }
	}
	async function exportNotebook() {
		if (!book) return;
		const current = book;
		try {
			const backup = await current.exportBackup();
			if (book === current && current.owner.isCurrent()) download('wabi-notebook.json', serializeNotebookBackup(backup), 'application/json');
		}
		catch (failure) { error = (failure as Error).message; }
	}
	async function previewBackup(event: Event) {
		const ticket = ++importSequence, current = book;
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		backupPreview = null; backupRaw = '';
		if (!file) return;
		try {
			if (file.size > MAX_NOTEBOOK_BACKUP_BYTES) throw new Error('Choose a notebook backup smaller than 20 MB.');
			const raw = await file.text();
			if (ticket !== importSequence || book !== current || !current?.owner.isCurrent()) return;
			backupPreview = parseNotebookBackup(raw); backupRaw = raw;
		} catch (failure) { error = (failure as Error).message; }
	}
	async function importBackup() {
		if (!book || !backupPreview || busy) return;
		busy = true;
		const current = book;
		try {
			const result = await current.importBackup(backupRaw);
			if (book !== current) return;
			recoveredMessage = `${result.alreadyImported ? 'Already imported' : 'Imported'} ${result.noteIds.length} notes. Existing notes were kept.`;
			announceNotebookChange(current.owner.scopeId);
		} catch (failure) { error = (failure as Error).message; }
		finally { busy = false; }
	}
	function resizeSidebar(event: PointerEvent) {
		const target = event.currentTarget as HTMLElement;
		const start = event.clientX, original = sidebarWidth;
		target.setPointerCapture(event.pointerId);
		const move = (e: PointerEvent) => { sidebarWidth = Math.max(160, Math.min(width - 280, original + e.clientX - start)); };
		const stop = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', stop); target.removeEventListener('lostpointercapture', stop); };
		target.addEventListener('pointermove', move); target.addEventListener('pointerup', stop); target.addEventListener('lostpointercapture', stop);
	}
</script>

<div class="notes-host" bind:clientWidth={width}>
	<div class="notes-workspace" class:narrow style:--note-list-width={`${sidebarWidth}px`}>
		{#if showHeader}<header><div><h2>{title}</h2><p>Personal notes · saved on this device</p></div><button onclick={createNote} disabled={!book || loading || busy}>New note</button></header>{/if}
		{#if !$notebookOwner.owner}
			<div class="notebook-empty"><h3>Your personal notebook</h3><p>{$notebookOwner.error || 'Opening your notebook…'}</p>{#if $notebookOwner.error}<button onclick={() => chooseOfflineNotebook().catch(failure => { error = failure.message; })}>Use a separate offline notebook</button>{/if}</div>
			{#if error}<p role="alert">{error}</p>{/if}
		{:else}
			{#if error}<div class="notice" role="alert"><span>{error}</span><button onclick={() => refresh()}>Retry</button></div>{/if}
			{#if recoveryDrafts.length}<div class="notice"><span>{recoveryDrafts.length} unsaved drafts are still in this window.</span>{#each recoveryDrafts as draft}<button onclick={() => recoverDraft(draft)}>Save recovery copy</button><button onclick={() => download('unsaved-note.md', draft.downloadText())}>Download draft</button>{/each}</div>{/if}
			{#each recoveredDrafts as draft}<div class="notice"><span>Recovered unsaved draft: {draft.title}</span><button disabled={busy} onclick={() => recoverStored(draft)}>Save as a new note</button><button onclick={() => download('recovered-draft.md', `# ${draft.title}\n\n${draft.text}`)}>Download draft</button></div>{/each}
			<div class="notebook-body">
				{#if !narrow || showList || !editor}
					<aside class="note-list" aria-label="Notebook">
						<div class="list-tools"><label class="sr-only" for={`notes-search-${contextChannelId || (compact ? 'panel' : 'center')}`}>Search notes</label><input id={`notes-search-${contextChannelId || (compact ? 'panel' : 'center')}`} type="search" bind:value={search} placeholder="Search notes"/><button onclick={createNote} disabled={busy || loading} aria-label="New note">+</button></div>
						<div class="list-tabs"><button class:active={!trash} onclick={() => { trash = false; }}>Notes</button><button class:active={trash} onclick={() => { trash = true; }}>Trash</button></div>
						<div class="note-rows">
							{#if loading}<p class="list-empty">Opening local notes…</p>{:else if !visible.length}<div class="list-empty"><p>{trash ? 'Trash is empty.' : search ? 'No matching notes.' : emptyMessage}</p>{#if !trash && !search}<button onclick={createNote} disabled={busy}>Create your first note</button>{/if}</div>{/if}
							{#each visible as note (note.id)}<button class="note-row" class:selected={$draftStore?.note.id === note.id} onclick={() => openNote(note.id)} style:border-left-color={note.color || 'transparent'}><strong>{note.pinned ? '• ' : ''}{note.title}</strong><span>{note.text.trim().slice(0, 90) || 'Empty note'}</span><small>{new Date(note.updatedAt).toLocaleDateString()}</small></button>{/each}
						</div>
						<div class="notebook-transfer"><button onclick={exportNotebook}>Back up saved notes</button><button onclick={() => { recoverOpen = !recoverOpen; }}>Import and recovery</button></div>
					</aside>
				{/if}
				{#if !narrow}<!-- Keyboard-adjustable WAI-ARIA window splitter. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
				<div class="note-splitter" role="separator" aria-label="Resize note list" aria-orientation="vertical" aria-valuemin="160" aria-valuemax={Math.max(160, width - 280)} aria-valuenow={sidebarWidth} tabindex="0" onpointerdown={resizeSidebar} onkeydown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); sidebarWidth = Math.max(160, Math.min(width - 280, sidebarWidth + (event.key === 'ArrowRight' ? 20 : -20))); } }}></div>{/if}
				{#if !narrow || (!showList && editor)}
					<main class="note-editor" aria-label="Note editor" aria-busy={opening} inert={opening}>
						{#if editor && $draftStore}
							<div class="editor-tools">{#if narrow}<button onclick={() => { showList = true; }}>All notes</button>{/if}{#if history.length}<button onclick={() => { const id = history.at(-1)!; history = history.slice(0, -1); void openNote(id, false); }}>Back</button>{/if}<span class="save-status" role="status">{$draftStore.status === 'saved' ? 'Saved on this device' : $draftStore.status === 'saving' ? 'Saving…' : $draftStore.status === 'conflict' ? 'Conflicting changes' : $draftStore.status === 'failed' ? 'Could not save' : 'Unsaved changes'}</span><button onclick={() => download('note.md', editor!.downloadText())}>Download</button></div>
							{#if $draftStore.error}<div class="notice" role="alert"><span>{$draftStore.error}</span><button disabled={busy} onclick={() => recoverDraft()}>Save recovery copy</button>{#if $draftStore.status === 'failed'}<button onclick={() => editor?.save()}>Retry save</button>{/if}<button onclick={async () => { if (window.confirm('Replace this draft with the saved version? Download or save a recovery copy first to keep your changes.')) try { await editor?.useSavedVersion(); } catch (failure) { error = (failure as Error).message; } }}>Use saved version</button></div>{/if}
							{#if $draftStore.note.trashedAt !== null}<div class="notice"><span>This note is in Trash.</span><button onclick={() => changeNote('restore')}>Restore note</button><button onclick={() => changeNote('delete')}>Delete permanently</button></div>{/if}
							<input class="note-title" aria-label="Note title" value={$draftStore.title} maxlength="200" disabled={busy || opening || $draftStore.note.trashedAt !== null} oninput={event => editor?.update({ title: event.currentTarget.value })}/>
							<textarea class="note-text" aria-label="Note text" value={$draftStore.text} {placeholder} spellcheck="true" disabled={busy || opening || $draftStore.note.trashedAt !== null} oninput={event => editor?.update({ text: event.currentTarget.value })}></textarea>
							<div class="note-links"><span>Link notes with [[Title]]</span>{#each outgoing as link}{@const target = notes.find(note => note.id === link.targetId)}<button disabled={!target || target.trashedAt !== null} onclick={() => target && openNote(target.id)}>{target?.title || link.normalizedTitle}{!target ? ' · missing' : target.trashedAt !== null ? ' · in Trash' : ''}</button>{/each}{#if incoming.length}<span>Linked from</span>{#each incoming as link}{@const source = notes.find(note => note.id === link.sourceId)}{#if source && source.trashedAt === null}<button onclick={() => openNote(source.id)}>{source.title}</button>{/if}{/each}{/if}</div>
							<footer><details class="note-actions" bind:this={actionMenu}><summary>Note actions</summary><div class="note-actions-menu"><button disabled={busy || opening || $draftStore.note.trashedAt !== null} onclick={() => changeNote('pin')}>{$draftStore.note.pinned ? 'Unpin' : 'Pin'}</button><select aria-label="Note color" value={$draftStore.note.color || ''} disabled={busy || opening || $draftStore.note.trashedAt !== null} onchange={event => changeNote('pin', event.currentTarget.value)}><option value="">No color</option>{#each NOTE_COLORS as color, index}<option value={color}>{colorNames[index]}</option>{/each}</select><button onclick={() => openReaderDocument($draftStore!.title, $draftStore!.text, 'markdown', 'notes', undefined, `wabi-note:${book!.owner.scopeId}:${$draftStore!.note.id}`)}>Open a copy in Reader</button><button disabled={busy || opening || $draftStore.note.trashedAt !== null} onclick={() => changeNote('trash')}>Move to Trash</button></div></details></footer>
						{:else}<div class="notebook-empty"><h3>A place to think</h3><p>Open a note or start a new one. Your writing stays in this browser, separate from shared conversations.</p></div>{/if}
					</main>
				{/if}
			</div>
			{#if recoverOpen}<section class="recovery-panel" aria-label="Import and recovery"><h3>Import a notebook backup</h3><p>Copies notes into this account’s notebook. Existing notes stay intact. Conversation associations from other notebooks stay detached. Backups contain saved notes; download unsaved drafts separately.</p><label>Wabi notebook backup <input type="file" accept=".json,application/json" onchange={previewBackup}/></label>{#if backupPreview}<p>{backupPreview.notes.length} notes, including Trash. Conflicting titles receive a suffix.</p><button disabled={busy} onclick={importBackup}>Import into this notebook</button>{/if}{#if legacy.length}<h3>Recover older notes</h3><p>Older storage does not identify its server reliably. Choose a source you own to copy into this account’s local notebook. Conversation notes are recovered without assigning a conversation. Originals stay intact.</p><select aria-label="Older notes source" bind:value={selectedLegacy}><option value="">Choose a source</option>{#each legacy as source}<option value={source.key}>{source.key} · {source.rows.length} notes</option>{/each}</select>{#if legacySelection}<p>{legacySelection.rows.slice(0, 3).map(row => row.title).join(' · ')}</p>{#each legacySelection.issues as issue}<p>{issue}</p>{/each}<button onclick={() => download('original-notes.json', legacySelection!.raw, 'application/json')}>Download original</button><button disabled={busy || legacySelection.kind === 'profile'} onclick={importSelected}>Copy into this notebook</button>{/if}{/if}{#if recoveredMessage}<p role="status">{recoveredMessage}</p>{/if}<button onclick={() => { recoverOpen = false; }}>Close recovery</button></section>{/if}
		{/if}
	</div>
</div>

<style>
	.notes-host { height: 100%; min-height: 0; width: 100%; min-width: 0; }
	.notes-workspace { height: 100%; min-height: 0; display: flex; flex-direction: column; color: var(--text-primary); background: var(--surface-base); overflow: hidden; }
	header { display: flex; justify-content: space-between; align-items: center; padding: 18px 24px; border-bottom: 1px solid var(--border-subtle); gap: 12px; }
	h2, h3, p { margin: 0; } h2 { font-size: 1.2rem; } header p { margin-top: 4px; font-size: .8rem; color: var(--text-secondary); }
	button, input, select { font: inherit; color: inherit; } button, select { min-height: 36px; border: 1px solid var(--border-subtle); background: var(--surface-raised); border-radius: var(--radius-md); padding: 6px 10px; cursor: pointer; font-size: .8rem; }
	button:hover:not(:disabled) { background: var(--surface-hover); } button:disabled { opacity: .5; cursor: default; }
	button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, .note-splitter:focus-visible { outline: 2px solid var(--accent-primary-color); outline-offset: -2px; }
	.notebook-body { display: flex; flex: 1; min-height: 0; min-width: 0; }
	.note-list { flex: 0 0 var(--note-list-width); min-height: 0; display: flex; flex-direction: column; background: var(--surface-sunken); }
	.list-tools { display: flex; gap: 6px; padding: 12px; } .list-tools input { width: 100%; min-width: 0; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 8px; background: var(--surface-base); font-size: .85rem; }
	.list-tabs { display: flex; gap: 6px; padding: 0 12px 12px; } .list-tabs button { flex: 1; background: transparent; } .list-tabs button.active { background: var(--surface-raised); color: var(--text-heading); }
	.note-rows { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 8px; }
	.note-row { display: flex; flex-direction: column; width: 100%; align-items: flex-start; text-align: left; gap: 5px; margin: 3px 0; border: 1px solid transparent; border-left-width: 3px; background: transparent; padding: 12px; overflow-wrap: anywhere; }
	.note-row strong { font-size: .9rem; color: var(--text-heading); } .note-row span { font-size: .8rem; color: var(--text-secondary); display: -webkit-box; line-clamp: 2; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; } .note-row small { font-size: .7rem; color: var(--text-secondary); } .note-row.selected { background: var(--surface-raised); border-top-color: var(--border-subtle); border-right-color: var(--border-subtle); border-bottom-color: var(--border-subtle); }
	.note-splitter { flex: 0 0 7px; cursor: col-resize; touch-action: none; border-inline-start: 1px solid var(--border-subtle); }
	.note-editor { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
	.editor-tools, footer { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 18px; flex-shrink: 0; } .save-status { flex: 1; font-size: .75rem; color: var(--text-secondary); }
	.note-title { flex-shrink: 0; width: 100%; border: 0; border-radius: 0; background: transparent; padding: 14px 24px 12px; font-size: 1.6rem; font-weight: 650; color: var(--text-heading); }
	.note-text { flex: 1; min-height: 120px; max-height: none; resize: none; width: 100%; border: 0; border-radius: 0; background: transparent; color: var(--text-primary); padding: 8px 24px 24px; font: 1rem/1.7 var(--font-sans, sans-serif); }
	.note-links { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; max-height: 110px; overflow-y: auto; padding: 10px 18px; border-top: 1px solid var(--border-subtle); font-size: .75rem; color: var(--text-secondary); } footer { border-top: 1px solid var(--border-subtle); }
	.note-actions { position: relative; } .note-actions summary { cursor: pointer; min-height: 36px; padding: 8px 12px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); font-size: .8rem; } .note-actions summary:focus-visible { outline: 2px solid var(--accent-primary-color); } .note-actions-menu { position: absolute; bottom: calc(100% + 8px); left: 0; display: flex; flex-direction: column; align-items: stretch; gap: 6px; width: min(250px, 75vw); padding: 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--surface-raised); box-shadow: var(--shadow-lg); z-index: var(--z-dropdown, 20); }
	.notebook-empty { margin: auto; padding: 32px; max-width: 450px; text-align: center; } .notebook-empty p { color: var(--text-secondary); margin-top: 12px; line-height: 1.6; } .notebook-empty button { margin-top: 16px; }
	.list-empty { padding: 20px 12px; color: var(--text-secondary); font-size: .85rem; line-height: 1.6; } .list-empty button { margin-top: 12px; }
	.notice { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 18px; background: var(--surface-raised); border-bottom: 1px solid var(--border-subtle); font-size: .85rem; line-height: 1.5; } .notice span { flex: 1 1 200px; }
	.notebook-transfer { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; } .recovery-panel { max-height: 50%; overflow-y: auto; border-top: 1px solid var(--border-subtle); padding: 18px; line-height: 1.6; font-size: .85rem; } .recovery-panel p { margin: 10px 0; } .recovery-panel select, .recovery-panel input { max-width: 100%; } .recovery-panel button { margin: 6px 6px 0 0; }
	.narrow header { padding: 12px 16px; } .narrow .note-list { flex: 1; min-width: 0; } .narrow .note-title { font-size: 1.25rem; padding: 12px 16px; } .narrow .note-text { padding: 8px 16px 16px; } .narrow .editor-tools, .narrow footer { padding: 8px 12px; } .narrow .note-actions summary { min-height: 44px; display: flex; align-items: center; } .narrow button, .narrow select { min-height: 44px; }
	@media (min-width: 901px) { :global(.chat-surface) .notes-workspace { padding-inline-end: 48px; } }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
