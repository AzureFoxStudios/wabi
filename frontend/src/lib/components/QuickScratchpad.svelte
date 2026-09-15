<script lang="ts">
	import { untrack } from 'svelte';
	import { writable } from 'svelte/store';
	import { notebookOwner } from '$lib/notes/scope';
	import { LocalNotebook } from '$lib/notes/db';
	import { NoteEditor, announceNotebookChange, type NoteDraft } from '$lib/notes/editor';
	import { openNotesSurface } from '$lib/notesWorkspace';
	let { showFull = true }: { showFull?: boolean } = $props();
	let editor = $state<NoteEditor | null>(null);
	let error = $state('');
	let loading = $state(true);
	const empty = writable<NoteDraft | null>(null);
	const draftStore = $derived(editor?.state ?? empty);
	$effect(() => {
		const owner = $notebookOwner.owner;
		let disposed = false;
		untrack(() => { editor?.dispose(); editor = null; error = ''; loading = true; });
		if (owner) {
			const book = new LocalNotebook(owner);
			void book.getScratchpad().then(note => {
				if (disposed || !owner.isCurrent()) return;
				editor = new NoteEditor(book, note); loading = false;
				announceNotebookChange(owner.scopeId);
			}, failure => { if (!disposed) { error = failure.message; loading = false; } });
		}
		return () => { disposed = true; untrack(() => editor?.dispose()); };
	});
	export function openFull(): void {
		if (editor && $draftStore) openNotesSurface({ scopeId: editor.book.owner.scopeId, noteId: $draftStore.note.id });
		else openNotesSurface();
	}
	function download() {
		if (!editor) return;
		const url = URL.createObjectURL(new Blob([editor.downloadText()], { type: 'text/markdown' }));
		const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'scratchpad-draft.md'; anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	async function recover() {
		if (!editor) return;
		try { await editor.saveRecoveryCopy(`Recovered scratchpad ${new Date().toISOString()}`); }
		catch (failure) { error = (failure as Error).message; }
	}
</script>

<section class="quick-scratchpad" aria-label="Scratchpad">
	{#if $draftStore && editor}
		{#if $draftStore.error}<div class="scratchpad-notice" role="alert">{$draftStore.error}<button onclick={recover}>Save recovery copy</button><button onclick={download}>Download draft</button>{#if $draftStore.status === 'failed'}<button onclick={() => editor?.save()}>Retry</button>{/if}</div>{/if}
		{#if $draftStore.note.trashedAt !== null}<div class="scratchpad-notice">This scratchpad is in Trash. Open Notes to restore it or reopen this panel to start a new scratchpad.</div>{/if}
		<textarea class="scratchpad-input" aria-label="Scratchpad text" value={$draftStore.text} disabled={$draftStore.note.trashedAt !== null} oninput={event => editor?.update({ text: event.currentTarget.value })} placeholder="Type or paste notes here." spellcheck="true"></textarea>
		<div class="scratchpad-footer"><span role="status">{$draftStore.status === 'saved' ? 'Saved on this device' : $draftStore.status === 'saving' ? 'Saving…' : $draftStore.status === 'conflict' ? 'Conflicting changes' : $draftStore.status === 'failed' ? 'Could not save' : 'Unsaved changes'}</span>{#if showFull}<button onclick={openFull}>Open full note</button>{/if}</div>
	{:else}<div class="scratchpad-notice">{error || $notebookOwner.error || (loading ? 'Opening scratchpad…' : 'Scratchpad unavailable.')}<button onclick={openFull}>Open Notes</button></div>{/if}
	{#if error && $draftStore}<div class="scratchpad-notice" role="alert">{error}</div>{/if}
</section>

<style>
	.quick-scratchpad { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--surface-base); }
	.scratchpad-input { flex: 1; width: 100%; min-height: 40px; max-height: none; resize: none; border: none; background: transparent; color: var(--text-primary); padding: 14px; font: .9rem/1.6 var(--font-sans, sans-serif); }
	.scratchpad-input:focus-visible { outline: 2px solid var(--accent-primary-color); outline-offset: -2px; }
	.scratchpad-input::placeholder { color: var(--text-secondary); }
	.scratchpad-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; padding: 8px 12px; font-size: .72rem; color: var(--text-secondary); border-top: 1px solid var(--border-subtle); }
	.scratchpad-notice { padding: 12px; font-size: .8rem; line-height: 1.5; color: var(--text-secondary); overflow-y: auto; }
	button { min-height: 36px; margin: 2px; padding: 6px 10px; font: inherit; color: var(--text-primary); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-raised); cursor: pointer; }
	button:focus-visible { outline: 2px solid var(--accent-primary-color); }
	@media (pointer: coarse) { button { min-height: 44px; } }
</style>
