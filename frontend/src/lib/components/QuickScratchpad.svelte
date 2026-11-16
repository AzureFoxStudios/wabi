<script lang="ts">
	import { _ } from '$lib/i18n';
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
		if (!draft || !editor) return loading ? $_('lore_viewer.opening') : loadFailed || $notebookOwner.error ? $_('server_health.not_available') : '';
		if (draft.status === 'saved') return $_('locality.saved_on_device');
		if (draft.status === 'saving') return $_('payment_access_panel.saving');
		if (draft.status === 'conflict') return $_('qsp.conflict');
		if (draft.status === 'failed') return $_('qsp.failed');
		return $_('common.unsaved_changes');
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
			error = $_('qsp.recovery_fail');
		}
	}
</script>

<section class="quick-scratchpad" class:embedded aria-label={$_('shell.scratchpad')}>
	{#if $draftStore && editor}
		{#if $draftStore.error}
			<div class="w-notice scratchpad-notice" role="alert">
				<Icon name="alert" size={16} />
				<p class="w-notice__title">{$draftStore.status === 'conflict' ? $_('qsp.changed_elsewhere') : $_('qsp.could_not_save_pad')}</p>
				<p class="w-notice__text">{$draftStore.error}</p>
				<div class="w-notice__actions">
					<button type="button" class="w-btn w-btn--sm" onclick={recover}>{$_('notebook.save_recovery')}</button>
					<button type="button" class="w-btn w-btn--sm" onclick={download}>{$_('notebook.download_draft')}</button>
					{#if $draftStore.status === 'failed'}<button type="button" class="w-btn w-btn--sm" onclick={() => editor?.save()}>{$_('common.retry')}</button>{/if}
				</div>
			</div>
		{/if}
		{#if $draftStore.note.trashedAt !== null}
			<div class="w-notice w-notice--info scratchpad-notice" role="status">
				<Icon name="info" size={16} />
				<p class="w-notice__title">{$_('qsp.in_trash')}</p>
				<p class="w-notice__text">{$_('qsp.trash_desc')}</p>
			</div>
		{/if}
		<textarea class="scratchpad-input" aria-label={$_('qsp.text_aria')} value={$draftStore.text} disabled={$draftStore.note.trashedAt !== null} oninput={event => editor?.update({ text: event.currentTarget.value })} placeholder={$_('qsp.text_ph')} spellcheck="true"></textarea>
		{#if showStatus || showFull}
			<div class="scratchpad-footer">
				{#if showStatus}<span role="status">{statusLabel}</span>{/if}
				{#if showFull}<button type="button" class="w-btn w-btn--quiet w-btn--sm" onclick={openFull}>{$_('qsp.open_full')}</button>{/if}
			</div>
		{/if}
	{:else if loading && !$notebookOwner.error}
		<p class="scratchpad-loading" role="status">{$_('qsp.opening_pad')}</p>
	{:else}
		<div class="w-notice w-notice--warn scratchpad-notice" role="status">
			<Icon name="warn" size={16} />
			<p class="w-notice__title">{$_('qsp.not_avail_title')}</p>
			<p class="w-notice__text">{$notebookOwner.error || $_('qsp.notes_unchanged')}</p>
			<div class="w-notice__actions"><button type="button" class="w-btn w-btn--sm" onclick={openFull}>{$_('qsp.open_notes')}</button></div>
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
