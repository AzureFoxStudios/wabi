<script lang="ts">
	import { _ } from '$lib/i18n';
	import { onMount, untrack } from 'svelte';
	import { currentUser, serverMembers } from '$lib/presenceIdentity';
	import { getSocket } from '$lib/socketConnection';
	import { getE2eeRoomStatus } from '$lib/e2ee';
	import { keepSharedNoteDraft, listSharedNotes, removeSharedNote, saveSharedNote, sharedNoteErrorText, takeSharedNoteDraft, type SharedNote } from '$lib/notes/sharedConversationNotes';

	let { channelId, surface = 'center' }: { channelId: string; surface?: 'center' | 'right' } = $props();
	let notes = $state<SharedNote[]>([]);
	let selectedId = $state<string | null>(null);
	let title = $state('');
	let text = $state('');
	let savedTitle = $state('');
	let savedText = $state('');
	let baselineRevision = $state(0);
	let loading = $state(true);
	let busy = $state(false);
	let error = $state('');
	let status = $state('');
	let remoteChange = $state(false);
	let privacyMode = $state<'encrypted' | 'pending' | 'readable' | 'unconfirmed' | 'unknown'>('unknown');
	let requestSequence = 0;
	let previousChannel: string | null = null;
	const selected = $derived(notes.find((note) => note.id === selectedId));
	const changed = $derived(title !== savedTitle || text !== savedText);
	const myUserId = $derived($currentUser?.dbUserId || Number(String($currentUser?.id || '').replace(/^user-/, '')) || 0);
	const canEdit = $derived(selectedId === 'new' || Boolean(selected && selected.authorUserId === myUserId));

	function displayAuthor(note: SharedNote): string {
		if (note.authorUserId === myUserId) return $_('admin.you');
		const member = $serverMembers.find((user) => user.dbUserId === note.authorUserId || user.id === `user-${note.authorUserId}`);
		return member?.username || $_('shared_notes.member', { values: { id: note.authorUserId } });
	}

	function useNote(note: SharedNote) {
		selectedId = note.id;
		title = note.title;
		text = note.text;
		savedTitle = note.title;
		savedText = note.text;
		baselineRevision = note.revision;
		remoteChange = false;
		status = '';
	}

	function leaveDraft(): boolean {
		return !changed || window.confirm($_('shared_notes.confirm_discard'));
	}

	function select(note: SharedNote) {
		if (!leaveDraft()) return;
		useNote(note);
	}

	function startNew() {
		if (!leaveDraft()) return;
		selectedId = 'new';
		title = '';
		text = '';
		savedTitle = '';
		savedText = '';
		baselineRevision = 0;
		remoteChange = false;
		status = $_('shared_notes.draft_device');
	}

	async function load() {
		const sequence = ++requestSequence;
		const room = channelId;
		try {
			const [rows, mode] = await Promise.all([listSharedNotes(room), getE2eeRoomStatus(room).catch(() => null)]);
			if (sequence !== requestSequence || room !== channelId) return;
			notes = rows;
			privacyMode = mode?.enabled ? 'encrypted' : mode?.pendingDefault ? 'pending'
				: mode?.serverReadableSelected && !mode?.serverReadableAllowedByMe ? 'unconfirmed'
				: mode ? 'readable' : 'unknown';
			loading = false;
			error = '';
			const next = selectedId && selectedId !== 'new' ? rows.find((note) => note.id === selectedId) : null;
			if (next) {
				if (changed) {
					remoteChange = next.revision !== baselineRevision;
				} else {
					useNote(next);
				}
			} else if (selectedId && selectedId !== 'new' && !next) {
				selectedId = null;
				status = $_('shared_notes.removed_convo');
			}
		} catch (failure) {
			if (sequence !== requestSequence || room !== channelId) return;
			loading = false;
			error = sharedNoteErrorText(failure, $_('shared_notes.err_load'));
		}
	}

	async function save() {
		if (!canEdit || busy || !changed || !title.trim()) return;
		const room = channelId;
		const prior = selectedId === 'new' ? undefined : selected;
		busy = true;
		status = $_('shared_notes.saving_everyone');
		error = '';
		try {
			const note = await saveSharedNote(room, { title, text }, prior);
			if (room !== channelId) return;
			notes = [note, ...notes.filter((item) => item.id !== note.id)]
				.sort((a, b) => b.updatedAt - a.updatedAt);
			useNote(note);
			keepSharedNoteDraft(room, surface, { selectedId, title, text, savedTitle, savedText, baselineRevision });
			status = $_('shared_notes.saved_everyone');
		} catch (failure) {
			if (room !== channelId) return;
			error = sharedNoteErrorText(failure, $_('shared_notes.err_share'));
			status = $_('shared_notes.not_saved');
		} finally { busy = false; }
	}

	async function remove() {
		if (!selected || !canEdit || busy || !window.confirm($_('shared_notes.confirm_remove'))) return;
		const room = channelId;
		busy = true;
		try {
			await removeSharedNote(room, selected);
			if (room !== channelId) return;
			notes = notes.filter((note) => note.id !== selected?.id);
			selectedId = null;
			status = $_('shared_notes.removed_everyone');
			error = '';
		} catch (failure) {
			if (room === channelId) error = sharedNoteErrorText(failure, $_('shared_notes.err_remove'));
		} finally { busy = false; }
	}

	function remember(channel: string) {
		keepSharedNoteDraft(channel, surface, { selectedId, title, text, savedTitle, savedText, baselineRevision });
	}

	$effect(() => {
		const room = channelId;
		untrack(() => {
			if (previousChannel && previousChannel !== room) remember(previousChannel);
			previousChannel = room;
			notes = [];
			const restored = takeSharedNoteDraft(room, surface);
			selectedId = restored?.selectedId || null;
			title = restored?.title || '';
			text = restored?.text || '';
			savedTitle = restored?.savedTitle || '';
			savedText = restored?.savedText || '';
			baselineRevision = restored?.baselineRevision || 0;
			loading = true;
			error = '';
			status = restored ? $_('shared_notes.restored') : '';
			privacyMode = 'unknown';
			void load();
		});
	});

	onMount(() => {
		let socket: ReturnType<typeof getSocket> = null;
		const updated = (event: { channelId?: string }) => { if (event?.channelId === channelId) void load(); };
		const connected = () => { void load(); };
		const attach = (next = getSocket()) => {
			if (socket === next) return;
			socket?.off('conversation-note-updated', updated);
			socket?.off('e2ee-room-updated', updated);
			socket?.off('connect', connected);
			socket = next;
			socket?.on('conversation-note-updated', updated);
			socket?.on('e2ee-room-updated', updated);
			socket?.on('connect', connected);
		};
		attach();
		const onFocus = () => { attach(); void load(); };
		window.addEventListener('focus', onFocus);
		const timer = window.setInterval(() => { attach(); if (!socket?.connected) void load(); }, 15_000);
		return () => {
			if (previousChannel) remember(previousChannel);
			window.clearInterval(timer);
			window.removeEventListener('focus', onFocus);
			socket?.off('conversation-note-updated', updated);
			socket?.off('e2ee-room-updated', updated);
			socket?.off('connect', connected);
			requestSequence++;
		};
	});
</script>

<section class="shared-notes" aria-label={$_('shared_notes.aria_section')}>
	<header class="notes-header">
		<div><h3>{$_('shared_notes.title')}</h3><p>{$_('shared_notes.subtitle')}</p></div>
		<button type="button" class="new-note" onclick={startNew}>{$_('panels.new_note')}</button>
	</header>
	{#if error}<div class="note-error" role="alert">{error} <button type="button" onclick={() => void load()}>{$_('common.retry')}</button></div>{/if}
	{#if status && !error}<p class="note-status" role="status">{status}</p>{/if}
	<div class="notes-body">
		<aside class="notes-list" aria-label={$_('shared_notes.aria_list')}>
			{#if loading}<p class="notes-empty">{$_('shared_notes.opening')}</p>
			{:else if !notes.length}<p class="notes-empty">{$_('shared_notes.empty_list')}</p>
			{/if}
			{#each notes as note (note.id)}
				<button type="button" class="note-row" class:selected={selectedId === note.id} onclick={() => select(note)}>
					<strong>{note.title}</strong>
					<span>{displayAuthor(note)} · {new Date(note.updatedAt).toLocaleDateString()}</span>
					<small>{note.locked ? $_('shared_notes.unavailable') : note.encrypted ? $_('privacy.state.experimental_encryption') : $_('shared_notes.server_readable_note')}</small>
				</button>
			{/each}
		</aside>
		<div class="note-detail">
			{#if selectedId === 'new' || selected}
				{#if selected?.locked}
					<div class="note-empty"><h4>{$_('shared_notes.cannot_open')}</h4><p>{selected.openError}</p></div>
				{:else}
					<div class="detail-top">
						<span class="scope-label">{selectedId === 'new' ? $_('shared_notes.private_draft') : selected?.encrypted ? $_('shared_notes.enc_conv') : $_('shared_notes.readable_shared')}</span>
						{#if remoteChange}<button type="button" onclick={() => selected && useNote(selected)}>{$_('shared_notes.load_newer')}</button>{/if}
					</div>
					<input class="note-title" aria-label={$_('shared_notes.title_aria')} placeholder={$_('notebook.note_title')} maxlength="120" bind:value={title} readonly={!canEdit || busy}/>
					<textarea aria-label={$_('shared_notes.text_aria')} placeholder={$_('shared_notes.text_placeholder')} maxlength="20000" bind:value={text} readonly={!canEdit || busy}></textarea>
					<footer>
						<span class="save-state" role="status">{busy ? $_('shared_notes.saving') : changed ? $_('common.unsaved_changes') : selectedId === 'new' ? $_('shared_notes.draft_device') : $_('shared_notes.saved_everyone')}</span>
						{#if canEdit}<button type="button" class="save-note" disabled={busy || !changed || !title.trim()} onclick={save}>{selectedId === 'new' ? $_('shared_notes.share_note') : $_('shared_notes.save_changes')}</button>{/if}
						{#if selected && canEdit}<button type="button" class="remove-note" disabled={busy} onclick={remove}>{$_('shared_notes.remove')}</button>{/if}
					</footer>
				{/if}
			{:else}
				<div class="note-empty"><h4>{$_('shared_notes.keep_title')}</h4><p>{$_('shared_notes.keep_body')}</p></div>
			{/if}
		</div>
	</div>
	<p class="privacy-hint">{privacyMode === 'encrypted' ? $_('shared_notes.privacy_encrypted') : privacyMode === 'pending' ? $_('shared_notes.privacy_pending') : privacyMode === 'unconfirmed' ? $_('shared_notes.privacy_unconfirmed') : privacyMode === 'readable' ? $_('shared_notes.privacy_readable') : $_('shared_notes.privacy_default')}</p>
</section>

<style>
	.shared-notes { height: 100%; min-height: 0; display: flex; flex-direction: column; container-type: inline-size; color: var(--w-text); background: var(--w-bg2); }
	.notes-header { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--w-line); }
	.notes-header h3 { margin: 0; font-size: 1rem; color: var(--w-text); }
	.notes-header p { margin: 3px 0 0; color: var(--w-mute); font-size: .75rem; line-height: 1.35; }
	button, input, textarea { font: inherit; color: inherit; }
	button { cursor: pointer; border: 1px solid var(--w-line); border-radius: calc(10px * var(--w-rs, 1)); background: var(--w-raise); padding: 7px 10px; }
	button:hover:not(:disabled) { background: var(--w-raise); }
	button:disabled { opacity: .5; cursor: default; }
	button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--w-accent); outline-offset: 1px; }
	.new-note, .save-note { color: var(--w-text); border-color: var(--w-accent); white-space: nowrap; }
	.notes-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(150px, 36%) minmax(0, 1fr); }
	.notes-list { min-width: 0; overflow-y: auto; border-right: 1px solid var(--w-line); background: var(--w-sink); padding: 8px; }
	.note-row { display: flex; flex-direction: column; align-items: flex-start; text-align: left; gap: 4px; width: 100%; border-color: transparent; background: transparent; margin-bottom: 4px; overflow-wrap: anywhere; }
	.note-row.selected { border-color: var(--w-line); background: var(--w-raise); }
	.note-row strong { color: var(--w-text); font-size: .84rem; }
	.note-row span, .note-row small { color: var(--w-mute); font-size: .7rem; }
	.notes-empty { color: var(--w-mute); font-size: .82rem; line-height: 1.5; padding: 14px 8px; margin: 0; }
	.note-detail { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
	.detail-top { padding: 12px 16px 0; display: flex; gap: 8px; align-items: center; justify-content: space-between; }
	.scope-label { color: var(--w-mute); font-size: .73rem; }
	.note-title { border: 0; border-bottom: 1px solid var(--w-line); background: transparent; padding: 12px 16px; font-size: 1.15rem; font-weight: 650; }
	.note-detail textarea { flex: 1; min-height: 100px; width: 100%; resize: none; border: 0; background: transparent; padding: 14px 16px; line-height: 1.55; }
	.note-detail footer { display: flex; gap: 8px; align-items: center; padding: 10px 16px; border-top: 1px solid var(--w-line); }
	.save-state { color: var(--w-mute); font-size: .73rem; margin-right: auto; }
	.remove-note { color: var(--w-mute); }
	.note-empty { margin: auto; padding: 24px; text-align: center; max-width: 320px; }
	.note-empty h4 { margin: 0 0 7px; color: var(--w-text); }
	.note-empty p { margin: 0; color: var(--w-mute); line-height: 1.5; font-size: .82rem; }
	.note-error, .note-status { margin: 0; padding: 8px 14px; font-size: .78rem; background: var(--w-raise); }
	.note-error { color: var(--w-danger); }
	.note-error button { margin-left: 8px; }
	.privacy-hint { margin: 0; padding: 8px 14px; color: var(--w-mute); border-top: 1px solid var(--w-line); font-size: .69rem; line-height: 1.4; }
	@container (max-width: 520px) {
		.notes-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
		.notes-list { display: flex; gap: 6px; overflow-x: auto; overflow-y: hidden; max-height: 100px; border-right: 0; border-bottom: 1px solid var(--w-line); }
		.note-row { flex: 0 0 145px; }
		.notes-empty { flex: 1; }
	}
</style>
