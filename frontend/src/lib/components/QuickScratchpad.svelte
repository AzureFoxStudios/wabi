<script lang="ts">
	import { untrack } from 'svelte';
	import { writable } from 'svelte/store';
	import { notebookOwner } from '$lib/notes/scope';
	import { LocalNotebook } from '$lib/notes/db';
	import { NoteEditor, announceNotebookChange, type NoteDraft } from '$lib/notes/editor';
	import { openNotesSurface } from '$lib/notesWorkspace';
	import Icon from '$lib/components/ui/Icon.svelte';
	let {
		showFull = true,
		showStatus = true,
		embedded = false,
		status = $bindable('')
	}: {
		showFull?: boolean;
		/** Inside a host that paints the surface (the companion's tray): no background of its own. */
		embedded?: boolean;
		/** The save line under the editor; a host that shows the state itself (the tray band) turns it off. */
		showStatus?: boolean;
		/** The save state in words ("Saved on this device", "Saving…"), for a host to show. */
		status?: string;
	} = $props();
	let editor = $state<NoteEditor | null>(null);
	let loadFailed = $state(false);
	let error = $state('');
	let loading = $state(true);
	const empty = writable<NoteDraft | null>(null);
	const draftStore = $derived(editor?.state ?? empty);
	// Locality is stated in the words themselves: this scratchpad never leaves the device (§9.3).
	const statusLabel = $derived.by(() => {
		const draft = $draftStore;
		if (!draft || !editor) return loading ? 'Opening…' : loadFailed || $notebookOwner.error ? 'Not available' : '';
		if (draft.status === 'saved') return 'Saved on this device';
		if (draft.status === 'saving') return 'Saving…';
		if (draft.status === 'conflict') return 'Conflicting changes';
		if (draft.status === 'failed') return 'Could not save';
		return 'Unsaved changes';
	});
	$effect(() => {
		status = statusLabel;
	});
	$effect(() => {
		const owner = $notebookOwner.owner;
		let disposed = false;
		untrack(() => { editor?.dispose(); editor = null; error = ''; loadFailed = false; loading = true; });
		if (owner) {
			const book = new LocalNotebook(owner);
			void book.getScratchpad().then(note => {
				if (disposed || !owner.isCurrent()) return;
				editor = new NoteEditor(book, note); loading = false;
				announceNotebookChange(owner.scopeId);
			}, failure => {
				if (disposed) return;
				console.error('[scratchpad] could not open the scratchpad', failure);
				loadFailed = true; loading = false;
			});
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
		try { await editor.saveRecoveryCopy(`Recovered scratchpad ${new Date().toISOString()}`); error = ''; }
		catch (failure) {
			console.error('[scratchpad] could not save a recovery copy', failure);
			error = 'Could not save a recovery copy. Download the draft to keep it.';
		}
	}
</script>

<section class="quick-scratchpad" class:embedded aria-label="Scratchpad">
	{#if $draftStore && editor}
		{#if $draftStore.error}
			<div class="w-notice scratchpad-notice" role="alert">
				<Icon name="alert" size={16} />
				<p class="w-notice__title">{$draftStore.status === 'conflict' ? 'This scratchpad changed elsewhere' : 'Could not save the scratchpad'}</p>
				<p class="w-notice__text">{$draftStore.error}</p>
				<div class="w-notice__actions">
					<button type="button" class="w-btn w-btn--sm" onclick={recover}>Save recovery copy</button>
					<button type="button" class="w-btn w-btn--sm" onclick={download}>Download draft</button>
					{#if $draftStore.status === 'failed'}<button type="button" class="w-btn w-btn--sm" onclick={() => editor?.save()}>Retry</button>{/if}
				</div>
			</div>
		{/if}
		{#if $draftStore.note.trashedAt !== null}
			<div class="w-notice w-notice--info scratchpad-notice" role="status">
				<Icon name="info" size={16} />
				<p class="w-notice__title">This scratchpad is in Trash</p>
				<p class="w-notice__text">Open Notes to restore it, or reopen this panel to start a new scratchpad.</p>
			</div>
		{/if}
		<textarea class="scratchpad-input" aria-label="Scratchpad text" value={$draftStore.text} disabled={$draftStore.note.trashedAt !== null} oninput={event => editor?.update({ text: event.currentTarget.value })} placeholder="Type or paste notes here." spellcheck="true"></textarea>
		{#if showStatus || showFull}
			<div class="scratchpad-footer">
				{#if showStatus}<span role="status">{statusLabel}</span>{/if}
				{#if showFull}<button type="button" class="w-btn w-btn--quiet w-btn--sm" onclick={openFull}>Open full note</button>{/if}
			</div>
		{/if}
	{:else if loading && !$notebookOwner.error}
		<p class="scratchpad-loading" role="status">Opening the scratchpad…</p>
	{:else}
		<div class="w-notice w-notice--warn scratchpad-notice" role="status">
			<Icon name="warn" size={16} />
			<p class="w-notice__title">The scratchpad isn't available</p>
			<p class="w-notice__text">{$notebookOwner.error || 'Your notes on this device are unchanged.'}</p>
			<div class="w-notice__actions"><button type="button" class="w-btn w-btn--sm" onclick={openFull}>Open Notes</button></div>
		</div>
	{/if}
	{#if error && $draftStore}<p class="scratchpad-error" role="alert">{error}</p>{/if}
</section>

<style>
	.quick-scratchpad {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--w-bg2);
		color: var(--w-text);
	}
	:global(:root[data-mode='light']) .quick-scratchpad:not(.embedded) {
		background: var(--w-lift);
	}
	.quick-scratchpad.embedded {
		background: transparent;
	}
	.scratchpad-input {
		flex: 1;
		box-sizing: border-box;
		width: 100%;
		min-height: 40px;
		max-height: none;
		margin: 0;
		padding: 12px 20px;
		border: 0;
		border-radius: 0;
		background: transparent;
		color: var(--w-text);
		font: var(--w-t-chat);
		resize: none;
	}
	.scratchpad-input:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: -2px;
	}
	.scratchpad-input::placeholder {
		color: var(--w-faint);
		opacity: 1;
	}
	.scratchpad-input:disabled {
		color: var(--w-mute);
	}
	.scratchpad-footer {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 12px 8px 20px;
		border-top: var(--w-bw) solid var(--w-line);
		color: var(--w-faint);
		font: var(--w-t-micro);
	}
	/* Narrow notice: the actions wrap under the words instead of squeezing them. */
	.scratchpad-notice {
		grid-template-columns: 16px minmax(0, 1fr);
		margin: 12px 16px 0;
	}
	.scratchpad-notice .w-notice__actions {
		grid-column: 1 / -1;
		grid-row: auto;
		flex-wrap: wrap;
		margin-top: 8px;
	}
	.scratchpad-loading,
	.scratchpad-error {
		margin: 0;
		padding: 12px 20px;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	.scratchpad-error {
		color: var(--w-danger);
	}
	.scratchpad-footer .w-btn:focus-visible,
	.scratchpad-notice .w-btn:focus-visible {
		outline: 2px solid var(--w-accent);
		outline-offset: 2px;
	}
</style>
