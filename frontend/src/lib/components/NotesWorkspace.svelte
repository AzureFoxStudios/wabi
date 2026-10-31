<script lang="ts">
	/**
	 * Personal notes (design contract §8.7 Notes, §8.4, §9.3): a 280px list beside the note,
	 * written on the writing surface (WritingEditor). Center stage and the companion panel.
	 *
	 * - One creation control. On center stage it is row A's primary "New note" (setStageHeader,
	 *   with "Only you · this device" and the save word "Saved 09:41"); in the companion, row B of
	 *   the list (search + New note) carries it. The empty list points to it instead of adding a
	 *   second button.
	 * - The open note is a page: a borderless serif title, a quiet meta line, the writing surface
	 *   (or the Read view on .w-prose). One 44px tool row (40px row B in the companion): All notes
	 *   and Back where they apply, Write | Read, and the ⋯ "Note actions" menu (Pin, Color,
	 *   Add a drawing, Download, Open a copy in Reader, Move to Trash). No <details>, no native
	 *   select.
	 * - Ink (Pen | Eraser | Shapes) shows inside the note only when the note has a drawing layer;
	 *   a note without one starts its drawing from ⋯ › Add a drawing.
	 * - Truthful local wording: notes never leave this device; the save word never claims more.
	 * - Row A belongs to the center-stage instance only (stageHeader.ts): `stage` says so, or, when
	 *   a host does not pass it, the instance checks after mounting that it sits in center stage
	 *   (.main-content) and not in the companion panel.
	 * - Failures say a plain cause and what is unchanged (noteProblem); the error itself is only
	 *   logged by the Notice. Destructive steps ask through the confirm dialog (§7.13).
	 */
	import NoteInkEditor from './NoteInkEditor.svelte';
	import { readNoteInk, saveNoteInk, noteWritingText, replaceNoteWriting, type NoteInk } from '$lib/notes/ink';
	import BaseModal from './BaseModal.svelte';
	import { portal } from '$lib/actions/portal';
	import { onDestroy, tick, untrack } from 'svelte';
	import WritingEditor from './WritingEditor.svelte';
	import Icon from './ui/Icon.svelte';
	import Menu from './ui/Menu.svelte';
	import Notice from './ui/Notice.svelte';
	import Skeleton from './ui/Skeleton.svelte';
	import type { MenuEntry } from './context-menu/ContextMenu.svelte';
	import { _ } from '$lib/i18n';
	import { setStageHeader, clearStageHeader, type StageHeaderAction } from '$lib/stageHeader';
	import { isMobile } from '$lib/layoutStoreStates';
	import { exportPortableNotebook } from '$lib/notes/portable';
	import { markdownNotebook } from '$lib/notes/markdownImport';
	import { noteSnippet } from '$lib/notes/snippet';
	import { renderNote } from '$lib/notes/render';
	import { parseNoteLinks } from '$lib/notes/links';
	import { noteCompletionExtension } from '$lib/notes/completion';
	import { NOTE_COLOR_NAMES, noteColorIndex, noteListDate, noteProblem, noteSaveWord } from '$lib/notes/notesView';
	import { NotebookError } from '$lib/notes/types';
	import { confirmAction } from '$lib/confirm';
	import { writable, get } from 'svelte/store';
	import { notebookOwner, chooseOfflineNotebook } from '$lib/notes/scope';
	import { LocalNotebook } from '$lib/notes/db';
	import { NoteEditor, announceNotebookChange, subscribeNotebookChanges, retainedNoteEditors, type NoteDraft } from '$lib/notes/editor';
	import { discoverLegacyNotes, type LegacyNotePreview } from '$lib/notes/migration';
	import type { NotebookNote, NotebookLink, RecoveredNoteDraft } from '$lib/notes/types';
	import { openReaderDocument } from '$lib/readerWorkspace';
	import { NOTE_COLORS } from '$lib/notesStore';
	import { notesOpenRequest } from '$lib/notesWorkspace';
	import { readerNoteSourceId } from '$lib/notes/readerBridge';
	import { parseNotebookBackup, serializeNotebookBackup, MAX_NOTEBOOK_BACKUP_BYTES, type NotebookBackup } from '$lib/notes/backup';

	let { title = 'Notes', emptyMessage = 'Keep personal notes, links and reminders here.', placeholder = 'Write a note…', showHeader = true, compact = false, contextChannelId, stage }:
		{ title?: string; emptyMessage?: string; placeholder?: string; showHeader?: boolean; compact?: boolean; contextChannelId?: string;
		  /** This instance is the center-stage notebook (it sets row A). Omitted: detected after mount. */
		  stage?: boolean } = $props();
	let book = $state<LocalNotebook | null>(null);
	let notes = $state<NotebookNote[]>([]);
	const completion = noteCompletionExtension(() => notes);
	let editor = $state<NoteEditor | null>(null);
	const emptyDraft = writable<NoteDraft | null>(null);
	const draftStore = $derived(editor?.state ?? emptyDraft);
	let error = $state('');
	/** The failure behind `error`, handed to the Notice to log; never shown. */
	let errorDetail = $state<unknown>(null);
	function fail(failure: unknown, fallback: string) {
		error = noteProblem(failure, fallback);
		errorDetail = failure;
	}
	let loading = $state(true);
	let busy = $state(false);
	let opening = $state(false);
	let search = $state('');
	let reading = $state(false);
	const renderedNote = $derived(reading ? renderNote($draftStore?.text ?? '') : '');
	let trash = $state(false);
	let showList = $state(true);
	let width = $state(0);
	let pageWidth = $state(0);
	let sidebarWidth = $state(280);
	let outgoing = $state<NotebookLink[]>([]);
	let incoming = $state<NotebookLink[]>([]);
	let legacy = $state<LegacyNotePreview[]>([]);
	let recoverOpen = $state(false);
	let settingsOpen = $state(false);
	let inkOpen = $state(false);
	let inkTool = $state<'pen' | 'eraser' | 'line'>('pen');
	let inkTarget = $state<NoteEditor | null>(null);
	let inkInitial = $state<NoteInk | null>(null);
	function openInk(tool: 'pen' | 'eraser' | 'line' = 'pen') { inkTool = tool; if (!editor) return; inkTarget = editor; inkInitial = readNoteInk(get(editor.state).text); inkOpen = true; }
	function saveInk(ink: NoteInk, png: string) { if (!book?.owner.isCurrent() || editor !== inkTarget) { inkOpen = false; return; } const draft = get(editor!.state); editor!.update({ text: saveNoteInk(draft.text, ink, png) }); reading = true; inkOpen = false; }
	function closeSettings() { settingsOpen = false; recoverOpen = false; importSequence++; }
	let recoveredMessage = $state('');
	let selectedLegacy = $state('');
	let backupRaw = $state('');
	let backupPreview = $state<NotebookBackup | null>(null);
	let recoveryDrafts = $state<NoteEditor[]>([]);
	let recoveredDrafts = $state<RecoveredNoteDraft[]>([]);
	let history = $state<string[]>([]);
	let openSequence = 0;
	let importSequence = 0;
	const narrow = $derived(compact || width < 620);
	const visible = $derived(notes.filter(note => (note.trashedAt !== null) === trash && (!contextChannelId || note.contextChannelId === contextChannelId) && `${note.title}\n${note.text}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt));
	const legacySelection = $derived(legacy.find(source => source.key === selectedLegacy));
	// Row A carries the one "New note" on center stage; the companion's row B carries it there.
	// Only the center-stage instance sets row A (stageHeader.ts): a non-compact notebook mounted
	// elsewhere (a legacy DM tab in the panel, a review route) keeps its own list "+".
	let hostEl = $state<HTMLElement | null>(null);
	let headingEl = $state<HTMLInputElement | null>(null);
	let ownsHeader = $state(false);
	$effect(() => {
		const node = hostEl;
		if (!node) return;
		const onStage = stage ?? (node.closest('.main-content') !== null && node.closest('.right-panel, .right-panel-zone') === null);
		const owns = showHeader && !compact && onStage;
		untrack(() => { ownsHeader = owns; });
	});
	const idSuffix = untrack(() => contextChannelId || (compact ? 'panel' : 'center'));
	const locked = $derived(busy || opening || ($draftStore?.note.trashedAt ?? null) !== null);
	const hasDrawing = $derived($draftStore ? readNoteInk($draftStore.text) !== null : false);
	$effect(() => {
		const request = $notesOpenRequest;
		const current = book;
		if (!compact && !contextChannelId && request && current?.owner.scopeId === request.scopeId) untrack(() => { notesOpenRequest.set(null); void openNote(request.noteId); });
	});

	$effect(() => {
		const owner = $notebookOwner.owner;
		untrack(() => {
			editor?.dispose(); editor = null; notes = []; recoveryDrafts = []; recoveredDrafts = []; error = ''; loading = true;
			backupPreview = null; backupRaw = ''; legacy = []; selectedLegacy = ''; recoveredMessage = ''; history = []; search = ''; recoverOpen = false; settingsOpen = false; inkOpen = false; opening = false; importSequence++;
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
		} catch (failure) { if (book === current) { recoveryDrafts = retainedNoteEditors(current).filter(draft => draft !== editor); loading = false; fail(failure, 'Your notes could not be read from this browser. Nothing was changed.'); } }
	}

	async function loadLinks(current: LocalNotebook, active: NoteEditor) {
		let id = '';
		const stop = active.state.subscribe(draft => { id = draft.note.id; }); stop();
		const [links, backlinks] = await Promise.all([current.outgoing(id), current.backlinks(id)]);
		if (book === current && editor === active) { outgoing = links; incoming = backlinks; }
	}

	async function openNote(id: string, remember = true) {
		inkOpen = false;
		if (!book) return;
		const current = book;
		const ticket = ++openSequence;
		opening = true;
		try {
			const note = await current.get(id);
			if (ticket !== openSequence || book !== current || !note) return;
			if (remember && $draftStore?.note.id && $draftStore.note.id !== id) history = [...history, $draftStore.note.id];
			editor?.dispose(); editor = new NoteEditor(current, note); showList = false; error = '';
			await loadLinks(current, editor);
		} catch (failure) { if (book === current) fail(failure, 'This note could not be opened. Your notes are unchanged.'); }
		finally { if (ticket === openSequence) opening = false; }
	}

	function nextTitle(base: string): string {
		let candidate = base, suffix = 2;
		while (notes.some(note => note.normalizedTitle === candidate.normalize('NFKC').toLowerCase())) candidate = `${base} ${suffix++}`;
		return candidate;
	}
	async function createLinkedNote(link: NotebookLink) {
		if (!book || !editor || busy || link.targetId !== null) return;
		const current = book, active = editor;
		busy = true;
		try {
			if (get(active.state).dirty && !await active.save()) return;
			if (book !== current || editor !== active || !current.owner.isCurrent()) return;
			const reference = parseNoteLinks(get(active.state).note.text).find(reference => reference.normalizedTitle === link.normalizedTitle);
			if (!reference) return;
			const note = await current.create(reference.title, '', contextChannelId);
			announceNotebookChange(current.owner.scopeId);
			if (book === current && editor === active) await openNote(note.id);
		} catch (failure) { if (book === current) fail(failure, 'The linked note could not be created. This note is unchanged.'); }
		finally { busy = false; }
	}
	async function reconnectLink(link: NotebookLink, target: NotebookNote) {
		if (!book || !editor || busy) return;
		const current = book, active = editor;
		busy = true;
		try {
			if (get(active.state).dirty && !await active.save()) return;
			if (book !== current || editor !== active || !current.owner.isCurrent()) return;
			const note = get(active.state).note;
			await current.relink(note.id, note.revision, link.normalizedTitle, target.id);
			await active.refresh(); announceNotebookChange(current.owner.scopeId);
		} catch (failure) { if (book === current) fail(failure, 'This link could not be reconnected. The note is unchanged.'); }
		finally { busy = false; }
	}
	function followRenderedLink(event: MouseEvent) {
		const anchor = (event.target as HTMLElement).closest('a');
		if (!anchor) return;
		const href = anchor.getAttribute('href') || '';
		const match = /^#wabi-note-(\d+)$/.exec(href);
		if (!match) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; return; }
		event.preventDefault();
		const reference = parseNoteLinks($draftStore?.text ?? '')[Number(match[1])];
		const link = outgoing.find(link => link.normalizedTitle === reference?.normalizedTitle);
		const target = notes.find(note => note.id === link?.targetId);
		if (target && target.trashedAt === null) void openNote(target.id);
		else error = 'This link has no available saved note. Check its title or restore its target from Trash.';
	}
	async function createNote() {
		if (!book || busy) return;
		busy = true;
		const current = book;
		let created: string | null = null;
		try {
			const note = await current.create(nextTitle('Untitled note'), '', contextChannelId);
			if (book !== current) return;
			trash = false; search = ''; reading = false; announceNotebookChange(current.owner.scopeId); await openNote(note.id);
			created = note.id;
		} catch (failure) { fail(failure, 'A new note could not be created. Your other notes are unchanged.'); }
		finally { busy = false; }
		// Focus the new note's title (selected, so typing replaces 'Untitled note') instead of
		// leaving keyboard focus on <body>. It runs after busy clears: the field is disabled until then.
		if (!created || book !== current || $draftStore?.note.id !== created) return;
		await tick();
		headingEl?.focus();
		headingEl?.select();
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
				if (!await confirmAction({ title: 'Delete this note permanently?', body: `“${note.title}” cannot be restored. Download a copy first if you might need it.`, confirm: 'Delete note', danger: true })) return;
				if (book !== current || editor !== active || !current.owner.isCurrent()) return;
				await current.permanentlyDelete(note.id, note.revision);
				if (editor === active) { editor.dispose(); editor = null; showList = true; }
			} else if (action === 'trash' || action === 'restore') await current.setTrashed(note.id, note.revision, action === 'trash');
			else await current.save(note.id, note.revision, color === undefined ? { pinned: !note.pinned } : { color });
			await active.refresh(); announceNotebookChange(current.owner.scopeId);
		} catch (failure) { fail(failure, 'This change could not be saved. The note is unchanged.'); }
		finally { busy = false; }
	}
	function download(name: string, text: string | Uint8Array<ArrayBuffer>, type = 'text/markdown') {
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
		} catch (failure) { fail(failure, 'The recovery copy could not be saved. Download the draft before leaving.'); }
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
		} catch (failure) { fail(failure, 'This source could not be recovered. Download its original before trying again.'); }
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
		} catch (failure) { fail(failure, 'This draft could not be saved as a note. Download it to keep it.'); }
		finally { busy = false; }
	}
	async function exportNotebook(portable = false) {
		if (!book) return;
		const current = book;
		try {
			const backup = await current.exportBackup();
			if (book === current && current.owner.isCurrent()) {
				if (portable) download('wabi-notebook-markdown.tar', exportPortableNotebook(backup), 'application/x-tar');
				else download('wabi-notebook.json', serializeNotebookBackup(backup), 'application/json');
			}
		}
		catch (failure) { fail(failure, 'The backup could not be made. Your notes are unchanged.'); }
	}
	async function previewBackup(event: Event) {
		const ticket = ++importSequence, current = book;
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		backupPreview = null; backupRaw = '';
		if (!file) return;
		try {
			if (file.size > MAX_NOTEBOOK_BACKUP_BYTES) throw new NotebookError('invalid', 'Choose a notebook backup smaller than 20 MB. Nothing was imported.');
			const raw = await file.text();
			if (ticket !== importSequence || book !== current || !current?.owner.isCurrent()) return;
			backupPreview = parseNotebookBackup(raw); backupRaw = raw;
		} catch (failure) { fail(failure, 'This file could not be read. Nothing was imported.'); }
	}
	async function previewMarkdown(event: Event) {
		const ticket = ++importSequence, current = book;
		const files = [...((event.currentTarget as HTMLInputElement).files || [])].filter(file => /\.(md|markdown)$/i.test(file.name));
		backupPreview = null; backupRaw = '';
		try {
			if (files.length > 1000) throw new NotebookError('invalid', 'Choose at most 1,000 Markdown files. Nothing was imported.');
			if (files.reduce((size, file) => size + file.size, 0) > MAX_NOTEBOOK_BACKUP_BYTES) throw new NotebookError('invalid', 'Choose Markdown files totaling less than 20 MB. Nothing was imported.');
			const data = await Promise.all(files.map(async file => ({ name: file.webkitRelativePath || file.name, text: await file.text(), lastModified: file.lastModified })));
			const raw = await markdownNotebook(data);
			if (ticket !== importSequence || book !== current || !current?.owner.isCurrent()) return;
			backupRaw = raw; backupPreview = parseNotebookBackup(raw);
		} catch (failure) {
			if (ticket !== importSequence || book !== current || !current?.owner.isCurrent()) return;
			console.warn('[notes] Markdown import failed', failure);
			recoveredMessage = noteProblem(failure, 'These files could not be imported. Choose Markdown files (.md), up to 1,000 and under 20 MB in all. Nothing was imported.');
		}
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
		} catch (failure) { fail(failure, 'The backup could not be imported. Your notes are unchanged.'); }
		finally { busy = false; }
	}
	const listMin = 220;
	const listMax = $derived(Math.max(listMin, Math.min(400, width - 360)));
	function resizeSidebar(event: PointerEvent) {
		const target = event.currentTarget as HTMLElement;
		const start = event.clientX, original = sidebarWidth;
		target.setPointerCapture(event.pointerId);
		const move = (e: PointerEvent) => { sidebarWidth = Math.max(listMin, Math.min(listMax, original + e.clientX - start)); };
		const stop = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', stop); target.removeEventListener('lostpointercapture', stop); };
		target.addEventListener('pointermove', move); target.addEventListener('pointerup', stop); target.addEventListener('lostpointercapture', stop);
	}
	/** The list's window splitter (WAI-ARIA): drag, ←/→ by 16px (Shift 64px), double-click resets 280. */
	function splitter(node: HTMLElement) {
		const key = (event: KeyboardEvent) => {
			if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
			event.preventDefault();
			const step = event.shiftKey ? 64 : 16;
			sidebarWidth = Math.max(listMin, Math.min(listMax, sidebarWidth + (event.key === 'ArrowRight' ? step : -step)));
		};
		const reset = () => { sidebarWidth = 280; };
		node.addEventListener('pointerdown', resizeSidebar);
		node.addEventListener('keydown', key);
		node.addEventListener('dblclick', reset);
		return { destroy() { node.removeEventListener('pointerdown', resizeSidebar); node.removeEventListener('keydown', key); node.removeEventListener('dblclick', reset); } };
	}

	// ---- row A (center stage): Notes · Only you · this device · Saved 09:41 · New note ----
	const HEADER_OWNER = 'notes-workspace';
	const saveStatus = $derived($draftStore ? noteSaveWord($draftStore.status, $draftStore.note.updatedAt) : '');
	/** A failed save may carry a storage error's own text, so it is named here instead (§7.16). */
	const draftProblem = $derived.by(() => {
		const draft = $draftStore;
		if (!draft?.error) return null;
		if (draft.status === 'failed') return { title: 'This note could not be saved', text: 'Your writing is still here. Retry, save a recovery copy or download the draft.' };
		return { title: 'This note changed somewhere else', text: draft.error };
	});
	async function useSavedVersion() {
		if (!editor) return;
		const active = editor;
		const replace = await confirmAction({ title: 'Replace your draft with the saved version?', body: 'Your unsaved writing in this note will be lost. Download it or save a recovery copy first to keep it.', confirm: 'Use saved version', danger: true });
		if (!replace || editor !== active) return;
		try { await active.useSavedVersion(); } catch (failure) { fail(failure, 'The saved version could not be loaded. Your draft is still here.'); }
	}
	const headerActions = $derived<StageHeaderAction[]>([
		{ id: 'new-note', label: $_('panels.new_note'), icon: 'plus', variant: 'primary', iconOnly: $isMobile, disabled: !book || loading || busy, onSelect: () => void createNote() }
	]);
	$effect(() => {
		if (!ownsHeader) return;
		setStageHeader(HEADER_OWNER, { view: 'notes', title: $_('places.notes'), scope: $_('locality.only_you_device'), status: saveStatus, actions: headerActions });
	});
	onDestroy(() => { if (ownsHeader) clearStageHeader(HEADER_OWNER); });

	// ---- the open note's ⋯ ----
	const noteMenu = $derived.by<MenuEntry[]>(() => {
		const draft = $draftStore;
		if (!draft || !editor) return [];
		const inTrash = draft.note.trashedAt !== null;
		const colorIndex = noteColorIndex(draft.note.color, NOTE_COLORS);
		const items: MenuEntry[] = [
			{ id: 'pin', label: draft.note.pinned ? 'Unpin' : 'Pin to the top', icon: 'pin', disabled: locked, onSelect: () => void changeNote('pin') },
			...(hasDrawing ? [] : [{ id: 'draw', label: 'Add a drawing', icon: 'pencil' as const, disabled: locked || inkOpen, onSelect: () => openInk('pen') }]),
			{ id: 'download', label: 'Download as Markdown', icon: 'download', onSelect: () => editor && download('note.md', editor.downloadText()) },
			{ id: 'reader', label: 'Open a copy in Reader', icon: 'bookOpen', onSelect: () => book && openReaderDocument(draft.title, draft.text, 'markdown', 'notes', undefined, readerNoteSourceId(book.owner.scopeId, draft.note.id)) },
			{ id: 'color-kicker', type: 'kicker', label: 'Color' },
			{ id: 'color-none', label: 'No color', role: 'menuitemradio', checked: colorIndex < 0, disabled: locked, onSelect: () => void changeNote('pin', '') },
			...NOTE_COLORS.map((color, index): MenuEntry => ({ id: `color-${index}`, label: NOTE_COLOR_NAMES[index] ?? `Color ${index + 1}`, role: 'menuitemradio', checked: colorIndex === index, disabled: locked, onSelect: () => void changeNote('pin', color) }))
		];
		if (!inTrash) items.push({ id: 'trash-sep', type: 'separator' }, { id: 'trash', label: 'Move to Trash', icon: 'trash', danger: true, disabled: locked, onSelect: () => void changeNote('trash') });
		return items;
	});
</script>

{#snippet listTools()}
	<div class="note-list-tools">
		<label class="w-field w-field--chrome note-search">
			<Icon name="search" size={16} />
			<input id={`notes-search-${idSuffix}`} type="search" bind:value={search} placeholder={$_('panels.search_notes')} aria-label={$_('panels.search_notes')} />
		</label>
		{#if !ownsHeader}
			<button type="button" class="w-ibtn w-ibtn--edge" onclick={createNote} disabled={!book || busy || loading} aria-label={$_('panels.new_note')} title={$_('panels.new_note')}><Icon name="plus" /></button>
		{/if}
	</div>
{/snippet}

<div class="notes-host" bind:this={hostEl} bind:clientWidth={width}>
	<div class="notes-workspace" class:narrow class:compact class:centered={ownsHeader} style:--note-list-width={`${sidebarWidth}px`}>
		{#if !$notebookOwner.owner}
			<div class="note-blank">
				<h3 class="note-blank-title">Your personal notebook</h3>
				<p class="note-blank-text">{$notebookOwner.error || 'Opening your notebook…'}</p>
				{#if $notebookOwner.error}<button type="button" class="w-btn" onclick={() => chooseOfflineNotebook().catch(failure => fail(failure, 'A separate offline notebook could not be opened. Nothing was changed.'))}>Use a separate offline notebook</button>{/if}
				{#if error}<Notice title={error} error={errorDetail} />{/if}
			</div>
		{:else}
			{#if error || recoveryDrafts.length || recoveredDrafts.length}
				<div class="note-notices">
					{#if error}<Notice title={error} error={errorDetail} onretry={() => refresh()} ondismiss={() => { error = ''; errorDetail = null; }} />{/if}
					{#if recoveryDrafts.length}
						<Notice tone="warn" title={recoveryDrafts.length === 1 ? 'An unsaved draft is still in this window.' : `${recoveryDrafts.length} unsaved drafts are still in this window.`}>
							{#snippet actions()}
								{#each recoveryDrafts as draft}
									<button type="button" class="w-btn w-btn--sm" onclick={() => recoverDraft(draft)}>Save recovery copy</button>
									<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={() => download('unsaved-note.md', draft.downloadText())}>Download draft</button>
								{/each}
							{/snippet}
						</Notice>
					{/if}
					{#each recoveredDrafts as draft}
						<Notice tone="warn" title={`Recovered unsaved draft: ${draft.title}`}>
							{#snippet actions()}
								<button type="button" class="w-btn w-btn--sm" disabled={busy} onclick={() => recoverStored(draft)}>Save as a new note</button>
								<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={() => download('recovered-draft.md', `# ${draft.title}\n\n${draft.text}`)}>Download draft</button>
							{/snippet}
						</Notice>
					{/each}
				</div>
			{/if}
			<div class="notebook-body">
				{#if !narrow || showList || !editor}
					<aside class="note-list" aria-label="Notebook">
						{@render listTools()}
						<div class="note-tabs" role="group" aria-label="Show">
							<button type="button" class="note-tab" aria-pressed={!trash} onclick={() => { trash = false; }}>Notes</button>
							<button type="button" class="note-tab" aria-pressed={trash} onclick={() => { trash = true; }}><Icon name="trash" size={14} />Trash</button>
						</div>
						<div class="note-list-rows">
							{#if loading}
								<Skeleton variant="row" rows={3} label="Opening local notes" />
							{:else if !visible.length}
								<div class="note-list-empty">
									<p class="note-list-empty-title">{trash ? 'Trash is empty.' : search ? `No notes match “${search.trim()}”.` : 'No notes yet'}</p>
									{#if !trash && !search}<p class="note-list-empty-text">{emptyMessage} {ownsHeader ? 'Start one with New note.' : 'Start one with the + above.'}</p>{/if}
									{#if search}<button type="button" class="w-btn w-btn--quiet w-btn--sm" onclick={() => { search = ''; }}>Clear search</button>{/if}
								</div>
							{/if}
							{#each visible as note (note.id)}
								{@const colorIndex = noteColorIndex(note.color, NOTE_COLORS)}
								{@const selected = $draftStore?.note.id === note.id}
								<button type="button" class="note-row" class:selected aria-current={selected ? 'true' : undefined} onclick={() => openNote(note.id)}>
									<strong>
										{#if colorIndex >= 0}<i class="note-dot" style:--note-dot={NOTE_COLORS[colorIndex]} title={NOTE_COLOR_NAMES[colorIndex]} aria-hidden="true"></i>{/if}
										<span class="note-row-title">{note.title}</span>
										{#if note.pinned}<Icon name="pin" size={12} class="note-row-pin" label="Pinned" />{/if}
									</strong>
									<small>{noteListDate(note.updatedAt)}</small>
									<span class="note-row-snippet">{noteSnippet(note.text) || 'Empty note'}</span>
								</button>
							{/each}
						</div>
						<div class="note-list-foot">
							<button type="button" class="w-btn w-btn--quiet w-btn--sm note-settings-btn" aria-haspopup="dialog" onclick={() => settingsOpen = true}><Icon name="gear" size={14} />Notes settings</button>
						</div>
					</aside>
				{/if}
				{#if !narrow}<!-- Keyboard-adjustable WAI-ARIA window splitter. -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div class="note-splitter" role="separator" aria-label="Resize note list" aria-orientation="vertical" aria-valuemin={listMin} aria-valuemax={listMax} aria-valuenow={sidebarWidth} tabindex="0" use:splitter></div>{/if}
				{#if !narrow || (!showList && editor)}
					<main class="note-editor" class:ink-open={inkOpen} aria-label="Note editor" aria-busy={opening} inert={opening}>
						{#if editor && $draftStore}
							<div class="note-tools">
								{#if narrow}<button type="button" class="w-btn w-btn--quiet w-btn--sm" onclick={() => { showList = true; }}><Icon name="chevLeft" size={14} />All notes</button>{/if}
								{#if history.length}<button type="button" class="w-btn w-btn--quiet w-btn--sm" onclick={() => { const id = history.at(-1)!; history = history.slice(0, -1); void openNote(id, false); }}><Icon name="arrowLeft" size={14} />Back</button>{/if}
								<span class="note-tools-gap"></span>
								<div class="w-seg note-mode" role="group" aria-label="Writing mode">
									<button type="button" aria-pressed={!reading} disabled={inkOpen} onclick={() => { reading = false; }}>Write</button>
									<button type="button" aria-pressed={reading} disabled={inkOpen} onclick={() => { reading = true; }}>Read</button>
								</div>
								<Menu class="w-ibtn" label={$_('panels.note_actions')} triggerLabel={$_('panels.note_actions')} heading={$draftStore.title || 'Note'} align="end" items={noteMenu}><Icon name="more" /></Menu>
							</div>
							{#if draftProblem}
								<div class="note-notices note-notices--editor">
									<Notice title={draftProblem.title} text={draftProblem.text}>
										{#snippet actions()}
											<button type="button" class="w-btn w-btn--sm" disabled={busy} onclick={() => recoverDraft()}>Save recovery copy</button>
											{#if $draftStore.status === 'failed'}<button type="button" class="w-btn w-btn--sm" onclick={() => editor?.save()}>Retry save</button>{/if}
											<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={useSavedVersion}>Use saved version</button>
										{/snippet}
									</Notice>
								</div>
							{/if}
							{#if $draftStore.note.trashedAt !== null}
								<div class="note-notices note-notices--editor">
									<Notice tone="info" title="This note is in Trash.">
										{#snippet actions()}
											<button type="button" class="w-btn w-btn--sm" onclick={() => changeNote('restore')}>Restore note</button>
											<button type="button" class="w-btn w-btn--sm w-btn--danger" onclick={() => changeNote('delete')}>Delete permanently</button>
										{/snippet}
									</Notice>
								</div>
							{/if}
							<div class="note-page" bind:clientWidth={pageWidth}>
								<div class="note-column">
									<input class="note-heading" bind:this={headingEl} aria-label="Note title" placeholder="Give this note a title" value={$draftStore.title} maxlength="200" disabled={locked} oninput={event => editor?.update({ title: event.currentTarget.value })}/>
									<p class="note-meta">
										{#if $draftStore.note.pinned}<span class="note-meta-pin"><Icon name="pin" size={12} />Pinned</span><span aria-hidden="true">·</span>{/if}
										<span>Edited {noteListDate($draftStore.note.updatedAt)}</span>
									</p>
									{#if hasDrawing || inkOpen}
										<div class="note-ink" role="group" aria-label={$_('panels.ink')}>
											<span class="w-kicker">{$_('panels.ink')}</span>
											<div class="w-seg" role="group" aria-label="Drawing tools">
												<button type="button" aria-pressed={inkOpen && inkTool === 'pen'} disabled={locked} onclick={() => openInk('pen')}>Pen</button>
												<button type="button" aria-pressed={inkOpen && inkTool === 'eraser'} disabled={locked} onclick={() => openInk('eraser')}>Eraser</button>
												<button type="button" aria-pressed={inkOpen && inkTool === 'line'} disabled={locked} onclick={() => openInk('line')}>Shapes</button>
											</div>
										</div>
									{/if}
									{#if inkOpen && editor === inkTarget}<NoteInkEditor embedded initial={inkInitial} initialTool={inkTool} onsave={saveInk} oncancel={() => inkOpen = false}/>{/if}
									<div class="note-writing" class:reading>
										{#key editor?.id}
											<WritingEditor value={noteWritingText($draftStore.text)} ariaLabel="Note text" {placeholder} readonly={locked} hang={!narrow && pageWidth >= 800} extensions={completion} onchange={text => editor?.update({ text: replaceNoteWriting(get(editor.state).text, text) })} />
										{/key}
									</div>
									{#if reading}<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
									<article class="note-read w-prose" aria-label="Note reading view" onclick={followRenderedLink}>{@html renderedNote}</article>{/if}
									{#if outgoing.length || incoming.length}
									<div class="note-links-row">
										{#if outgoing.length}<span class="note-links-hint">Links</span>{/if}
										{#each outgoing as link}
											{@const target = notes.find(note => note.id === link.targetId)}
											<button type="button" class="w-btn w-btn--quiet w-btn--sm" disabled={!target || target.trashedAt !== null} onclick={() => target && openNote(target.id)}>{target?.title || link.normalizedTitle}{!target ? ' · missing' : target.trashedAt !== null ? ' · in Trash' : ''}</button>
											{#if !target && link.targetId === null}<button type="button" class="w-btn w-btn--quiet w-btn--sm" disabled={locked} onclick={() => createLinkedNote(link)}>Create {parseNoteLinks($draftStore.text).find(reference => reference.normalizedTitle === link.normalizedTitle)?.title ?? link.normalizedTitle}</button>{/if}
											{#if !target && link.targetId}{@const replacement = notes.find(note => note.normalizedTitle === link.normalizedTitle && note.trashedAt === null)}{#if replacement}<button type="button" class="w-btn w-btn--quiet w-btn--sm" disabled={locked} onclick={() => reconnectLink(link, replacement)}>Reconnect to {replacement.title}</button>{/if}{/if}
										{/each}
										{#if incoming.length}
											<span class="note-links-hint">Linked from</span>
											{#each incoming as link}{@const source = notes.find(note => note.id === link.sourceId)}{#if source && source.trashedAt === null}<button type="button" class="w-btn w-btn--quiet w-btn--sm" onclick={() => openNote(source.id)}>{source.title}</button>{/if}{/each}
										{/if}
									</div>
									{/if}
								</div>
							</div>
							<!-- The save word: row A says it on center stage; the companion shows it only while
							     the note is not settled (its Scratchpad band says "Saved on this device"). -->
							<div class="note-foot"><span class="save-status" data-status={$draftStore.status} role={compact ? 'status' : undefined}>{#if $draftStore.status === 'failed' || $draftStore.status === 'conflict'}<span class="w-dot w-dot--danger" aria-hidden="true"></span>{:else if $draftStore.status === 'unsaved'}<span class="w-dot w-dot--warn" aria-hidden="true"></span>{/if}{saveStatus}</span></div>
						{:else}
							<div class="note-blank note-blank--editor">
								<Icon name="note" size={28} />
								<h3 class="note-blank-title">A place to think</h3>
								<p class="note-blank-text">Open a note from the list, or start a new one with New note.</p>
							</div>
						{/if}
					</main>
				{/if}
			</div>

		{/if}
	</div>
</div>

{#if settingsOpen}
 <div use:portal>
  <BaseModal isOpen={settingsOpen} title="Notes settings" note="Saved on this device · not shared" size="md" padded overlayZIndex={1700} onClose={closeSettings}>
   <div class="notes-settings-body">
    <p class="notes-settings-lead">Backups include saved notes from this notebook. Export Markdown to use your writing in another notes app.</p>
    <div class="notebook-transfer"><button type="button" class="w-btn" onclick={() => exportNotebook()}><Icon name="download" size={16} />Back up saved notes</button><button type="button" class="w-btn" onclick={() => exportNotebook(true)}>Export Markdown archive</button></div>
    <button type="button" class="w-disclosure" aria-expanded={recoverOpen} onclick={() => { recoverOpen = !recoverOpen; }}><Icon name="chevRight" size={16} />Import and recovery</button>
    {#if recoverOpen}<section class="recovery-panel w-disclosure__body" aria-label="Import and recovery"><h4>Import notes</h4><p>Bring Markdown files from Obsidian or another notes app. This copies saved files; it does not watch or synchronize your vault. Wiki links by title are retained. Images and app plugins are not imported.</p><label class="recovery-file">Markdown files <input type="file" multiple accept=".md,.markdown" onchange={previewMarkdown}/></label><label class="recovery-file">Markdown folder <input type="file" webkitdirectory multiple onchange={previewMarkdown}/></label><h4>Restore a Wabi backup</h4><p>Copies notes into this account’s notebook. Existing notes stay intact. Conversation associations from other notebooks stay detached. Backups contain saved notes; download unsaved drafts separately.</p><label class="recovery-file">Wabi notebook backup <input type="file" accept=".json,application/json" onchange={previewBackup}/></label>{#if backupPreview}<p>{backupPreview.notes.length} notes, including Trash. Conflicting titles receive a suffix.</p><button type="button" class="w-btn w-btn--primary" disabled={busy} onclick={importBackup}>Import into this notebook</button>{/if}{#if legacy.length}<h4>Recover older notes</h4><p>Older storage does not identify its server reliably. Choose a source you own to copy into this account’s local notebook. Conversation notes are recovered without assigning a conversation. Originals stay intact.</p><select class="w-field" aria-label="Older notes source" bind:value={selectedLegacy}><option value="">Choose a source</option>{#each legacy as source}<option value={source.key}>{source.key} · {source.rows.length} notes</option>{/each}</select>{#if legacySelection}<p>{legacySelection.rows.slice(0, 3).map(row => row.title).join(' · ')}</p>{#each legacySelection.issues as issue}<p>{issue}</p>{/each}<div class="notebook-transfer"><button type="button" class="w-btn" onclick={() => download('original-notes.json', legacySelection!.raw, 'application/json')}>Download original</button><button type="button" class="w-btn" disabled={busy || legacySelection.kind === 'profile'} onclick={importSelected}>Copy into this notebook</button></div>{/if}{/if}{#if recoveredMessage}<p role="status">{recoveredMessage}</p>{/if}</section>{/if}
   </div>
  </BaseModal>
 </div>
{/if}


<style>
	.notes-host { height: 100%; min-height: 0; width: 100%; min-width: 0; }
	.notes-workspace {
		/* The note title (a field that is the page's title): 32/40, 24/30 narrow, 18/24 compact. */
		--note-title-fs: calc(32px * var(--w-fs));
		--note-title-lh: calc(40px * var(--w-fs));
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		overflow: hidden;
		background: var(--w-bg);
		color: var(--w-text);
		font: var(--w-t-ui);
	}
	/* Zero-weight reset, so every class below (the meta's air above and below its hairline) keeps
	   its own margins. */
	.notes-workspace :where(h3, h4, p) { margin: 0; }
	.notes-workspace.compact { background: transparent; }
	.notebook-body { display: flex; flex: 1; min-height: 0; min-width: 0; }

	/* ---------- notices: where the action was, above the notebook ---------- */
	.note-notices { display: flex; flex-direction: column; gap: 8px; flex: none; padding: 12px var(--w-gutter, 32px) 0; }
	.note-notices--editor { padding: 12px 24px 0; }
	.compact .note-notices { padding: 8px 12px 0 20px; }

	/* ---------- the list column (280): search, Notes | Trash, rows, settings ---------- */
	.note-list {
		display: flex;
		flex: 0 0 var(--note-list-width);
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		/* Part of the page, like the wiki tree and the forum list (plane 0); the splitter's
		   hairline separates it. */
		background: var(--w-bg);
	}
	.compact .note-list { background: transparent; }
	.narrow .note-list { flex: 1 1 auto; }
	.note-list-tools {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		box-sizing: border-box;
		height: 44px;
		padding: 6px 12px;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	/* The companion's row B: 40px on the masthead rule, like People and DMs. */
	.compact .note-list-tools { height: var(--w-head-b, 40px); padding: 0 12px 8px 20px; }
	.note-search { flex: 1 1 auto; }
	.note-tabs { display: flex; flex: none; gap: 18px; padding: 0 16px; border-bottom: var(--w-bw) solid var(--w-line); }
	.compact .note-tabs { padding: 0 12px 0 20px; }
	.note-tab {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		box-sizing: border-box;
		height: 36px;
		margin: 0 0 calc(-1 * var(--w-bw));
		padding: 0 2px;
		border: 0;
		border-bottom: 2px solid transparent;
		background: transparent;
		color: var(--w-mute);
		font: var(--w-t-label);
		cursor: pointer;
		transition: color var(--w-dur-1) var(--w-ease), border-color var(--w-dur-1) var(--w-ease);
	}
	.note-tab:hover { color: var(--w-text); }
	.note-tab[aria-pressed='true'] { color: var(--w-text); border-bottom-color: var(--w-sig); }
	.note-tab:focus-visible { outline: 2px solid var(--w-accent); outline-offset: -2px; }
	.note-list-rows { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 8px 12px; }

	/* Rows: title and date on the first line, a one-line excerpt below (the companion keeps the
	   title and date only). Selection grammar (§5.2): raise fill, text 500; no left bar; a
	   note's color is a 7px dot (§5.5). */
	.note-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas: 'title date' 'snippet snippet';
		align-items: baseline;
		column-gap: 12px;
		row-gap: 2px;
		box-sizing: border-box;
		width: 100%;
		margin: 0;
		padding: 9px 12px 10px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--w-text);
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--w-dur-1) var(--w-ease);
	}
	.note-row + .note-row { margin-top: 2px; }
	.note-row:hover { background: color-mix(in srgb, var(--w-raise) 70%, transparent); }
	.note-row.selected { background: var(--w-raise); }
	.note-row:focus-visible { outline: 2px solid var(--w-accent); outline-offset: -2px; }
	:global(:root[data-char='contrast']) .note-row:hover { background: transparent; box-shadow: inset 0 0 0 1px var(--w-line-strong); }
	:global(:root[data-char='contrast']) .note-row.selected { background: var(--w-raise); box-shadow: inset 0 0 0 1px var(--w-line-strong); }
	.note-row > strong {
		grid-area: title;
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		color: var(--w-text);
		font: var(--w-t-label);
		font-weight: 400;
	}
	.note-row.selected > strong { font-weight: 500; }
	.note-row-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.note-dot { flex: none; width: 7px; height: 7px; border-radius: var(--w-avr); background-color: var(--note-dot, var(--w-faint)); font-style: normal; }
	.note-row :global(.note-row-pin) { flex: none; color: var(--w-faint); }
	.note-row > small {
		grid-area: date;
		color: var(--w-faint);
		font: var(--w-t-micro);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.note-row-snippet {
		grid-area: snippet;
		min-width: 0;
		overflow: hidden;
		color: var(--w-mute);
		font: var(--w-t-small);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.compact .note-row { grid-template-areas: 'title date'; align-items: center; min-height: 44px; padding: 0 12px; }
	.compact .note-row-snippet { display: none; }
	.note-list-empty { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 16px 12px; }
	.note-list-empty-title { color: var(--w-text); font: 600 calc(16px * var(--w-fs)) / calc(22px * var(--w-fs)) var(--w-serif); }
	.note-list-empty-text { color: var(--w-mute); font: var(--w-t-small); text-wrap: pretty; }
	.note-list-foot { flex: none; padding: 8px; border-top: var(--w-bw) solid var(--w-line); }
	.note-settings-btn { width: 100%; justify-content: flex-start; }

	.note-splitter {
		position: relative;
		flex: 0 0 var(--w-bw);
		cursor: col-resize;
		touch-action: none;
		background: var(--w-line);
		transition: background-color var(--w-dur-1) var(--w-ease);
	}
	/* A wider invisible grip; the line turns accent on hover, and keyboard focus adds the kit's
	   2px accent outline (§4.6), never a shadow ring. */
	.note-splitter::before { content: ''; position: absolute; inset: 0 -4px; }
	.note-splitter:hover { background: var(--w-accent); }
	.note-splitter:focus-visible { background: var(--w-accent); outline: 2px solid var(--w-accent); outline-offset: 1px; }

	/* ---------- the open note: one tool row, then the page ---------- */
	.note-editor { position: relative; display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
	.note-tools {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		box-sizing: border-box;
		height: 44px;
		padding: 0 16px;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.compact .note-tools { height: var(--w-head-b, 40px); padding: 0 8px 8px 14px; }
	.note-tools-gap { flex: 1 1 auto; }
	.note-page { flex: 1; min-height: 0; overflow-y: auto; }
	.note-column { box-sizing: border-box; max-width: calc(720px + 2 * var(--w-gutter, 32px)); margin: 0 auto; padding: 40px var(--w-gutter, 32px) 48px; }
	.narrow .note-column { padding: 24px 16px 32px; }
	.compact .note-column { padding: 16px 20px 24px; }

	/* The title is the title: borderless serif on the page, accent underline while it has focus. */
	.note-heading {
		display: block;
		box-sizing: border-box;
		width: 100%;
		margin: 0;
		padding: 0 0 2px;
		border: 0;
		border-bottom: var(--w-bw) solid transparent;
		border-radius: 0;
		background: transparent;
		color: var(--w-text);
		font: 600 var(--note-title-fs) / var(--note-title-lh) var(--w-serif);
		letter-spacing: 0.005em;
		text-overflow: ellipsis;
		outline: none;
		transition: border-color var(--w-dur-1) var(--w-ease);
	}
	.note-heading::placeholder { color: var(--w-faint); opacity: 1; }
	.note-heading:focus-visible { border-bottom-color: var(--w-accent); }
	.note-heading:disabled { opacity: 1; color: var(--w-mute); }
	.narrow { --note-title-fs: calc(24px * var(--w-fs)); --note-title-lh: calc(30px * var(--w-fs)); }
	.compact { --note-title-fs: calc(18px * var(--w-fs)); --note-title-lh: calc(24px * var(--w-fs)); }
	/* mobile.css sets every input to 16px !important under 768px (iOS zoom). The note title is
	   the page title and at least 16px already, so it keeps its size: this !important defeats only
	   that rule, and max() never goes under 16px. */
	@media (max-width: 768px) {
		.note-heading { font-size: max(16px, var(--note-title-fs)) !important; }
	}
	.note-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		margin-top: 10px;
		padding-bottom: 20px;
		margin-bottom: 24px;
		border-bottom: var(--w-bw) solid var(--w-line);
		color: var(--w-faint);
		font: var(--w-t-small);
	}
	.compact .note-meta { margin-top: 6px; padding-bottom: 12px; margin-bottom: 16px; }
	.note-meta-pin { display: inline-flex; align-items: center; gap: 4px; }

	/* Ink: only for a note that has a drawing layer. */
	.note-ink { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 20px; }
	.note-editor :global(.ink-editor.embedded) { margin-bottom: 20px; }

	.note-writing.reading { display: none; }
	.compact .note-writing :global(.writing) {
		--writing-min: calc(160px * var(--w-fs));
	}
	.compact .note-writing :global(.writing .cm-editor-host .cm-content),
	.compact .note-read {
		font: 400 calc(15px * var(--w-fs)) / calc(26px * var(--w-fs)) var(--w-sans);
	}
	.note-read { min-height: 120px; padding-bottom: 32px; overflow-wrap: anywhere; }
	.note-read :global(img) { max-width: 100%; height: auto; }
	.ink-open .note-writing, .ink-open .note-read, .ink-open .note-links-row { display: none; }

	/* Links: quiet words under a hairline. */
	.note-links-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		margin-top: 8px;
		padding-top: 12px;
		border-top: var(--w-bw) solid var(--w-line);
		color: var(--w-faint);
		font: var(--w-t-small);
	}
	.note-links-hint { margin-right: 4px; }

	/* The save word is row A's on center stage (read once, there); the companion shows it while
	   the note is unsaved, saving, conflicting or failed. */
	.note-foot { flex: none; }
	.save-status { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
	.compact .note-foot:has(.save-status:not([data-status='saved'])) { padding: 6px 12px 8px 20px; border-top: var(--w-bw) solid var(--w-line); }
	.compact .save-status:not([data-status='saved']) { position: static; width: auto; height: auto; margin: 0; clip: auto; color: var(--w-mute); font: var(--w-t-micro); }
	.compact .save-status[data-status='failed'], .compact .save-status[data-status='conflict'] { color: var(--w-danger); }
	.save-status :global(.w-dot) { margin-right: 6px; vertical-align: 1px; }

	/* ---------- empty and opening states ---------- */
	.note-blank { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; max-width: 460px; padding: 48px var(--w-gutter, 32px); color: var(--w-faint); }
	.note-blank--editor { margin: 0 auto; width: 100%; box-sizing: border-box; max-width: calc(720px + 2 * var(--w-gutter, 32px)); padding-top: 64px; }
	.compact .note-blank { padding: 24px 20px; }
	.note-blank-title { color: var(--w-text); font: 600 calc(20px * var(--w-fs)) / calc(26px * var(--w-fs)) var(--w-serif); }
	.note-blank-text { max-width: 44ch; color: var(--w-mute); font: var(--w-t-ui); text-wrap: pretty; }

	/* ---------- Notes settings (dialog body) ---------- */
	.notes-settings-body { display: flex; flex-direction: column; gap: 16px; color: var(--w-text); font: var(--w-t-ui); }
	.notes-settings-lead { color: var(--w-mute); }
	.notebook-transfer { display: flex; flex-wrap: wrap; gap: 8px; }
	.recovery-panel { display: flex; flex-direction: column; gap: 10px; padding-top: 12px; color: var(--w-mute); font: var(--w-t-small); }
	.recovery-panel h4 { margin-top: 8px; color: var(--w-text); font: var(--w-t-label); }
	.recovery-file { display: flex; flex-direction: column; gap: 4px; color: var(--w-text); font: var(--w-t-label); }
	.recovery-file input { font: var(--w-t-small); color: var(--w-mute); }

	/* ---------- touch ---------- */
	@media (pointer: coarse) {
		.note-row { min-height: 52px; }
		.compact .note-row { min-height: 44px; }
		.note-tab { height: 44px; }
		/* The kit's 44px segmented keys sit inside the tool row with their track. */
		.note-tools, .compact .note-tools { height: auto; min-height: 52px; }
	}
	@media (prefers-reduced-motion: reduce) {
		.note-row, .note-tab, .note-splitter, .note-heading { transition: none; }
	}
</style>
