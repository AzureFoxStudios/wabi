<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { currentUser, serverMembers } from '$lib/presenceIdentity';
	import { getSocket } from '$lib/socketConnection';
	import { getE2eeRoomStatus } from '$lib/e2ee';
	import { keepSharedNoteDraft, listSharedNotes, removeSharedNote, saveSharedNote, takeSharedNoteDraft, type SharedNote } from '$lib/notes/sharedConversationNotes';

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
		if (note.authorUserId === myUserId) return 'You';
		const member = $serverMembers.find((user) => user.dbUserId === note.authorUserId || user.id === `user-${note.authorUserId}`);
		return member?.username || `Member ${note.authorUserId}`;
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
		return !changed || window.confirm('Discard unsaved changes to this note?');
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
		status = 'Draft on this device';
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
				status = 'This note was removed from the conversation.';
			}
		} catch (failure) {
			if (sequence !== requestSequence || room !== channelId) return;
			loading = false;
			error = failure instanceof Error ? failure.message : 'Could not load shared notes.';
		}
	}

	async function save() {
		if (!canEdit || busy || !changed || !title.trim()) return;
		const room = channelId;
		const prior = selectedId === 'new' ? undefined : selected;
		busy = true;
		status = 'Saving for everyone…';
		error = '';
		try {
			const note = await saveSharedNote(room, { title, text }, prior);
			if (room !== channelId) return;
			notes = [note, ...notes.filter((item) => item.id !== note.id)]
				.sort((a, b) => b.updatedAt - a.updatedAt);
			useNote(note);
			keepSharedNoteDraft(room, surface, { selectedId, title, text, savedTitle, savedText, baselineRevision });
			status = 'Saved for everyone';
		} catch (failure) {
			if (room !== channelId) return;
			error = failure instanceof Error ? failure.message : 'Could not share this note.';
			status = 'Not saved';
		} finally { busy = false; }
	}

	async function remove() {
		if (!selected || !canEdit || busy || !window.confirm('Remove this shared note for everyone in the conversation?')) return;
		const room = channelId;
		busy = true;
		try {
			await removeSharedNote(room, selected);
			if (room !== channelId) return;
			notes = notes.filter((note) => note.id !== selected?.id);
			selectedId = null;
			status = 'Removed for everyone';
			error = '';
		} catch (failure) {
			if (room === channelId) error = failure instanceof Error ? failure.message : 'Could not remove this note.';
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
			status = restored ? 'Unsaved draft restored on this device' : '';
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

<section class="shared-notes" aria-label="Shared conversation notes">
	<header class="notes-header">
		<div><h3>Shared notes</h3><p>Everyone in this conversation can see saved notes.</p></div>
		<button type="button" class="new-note" onclick={startNew}>New note</button>
	</header>
	{#if error}<div class="note-error" role="alert">{error} <button type="button" onclick={() => void load()}>Retry</button></div>{/if}
	{#if status && !error}<p class="note-status" role="status">{status}</p>{/if}
	<div class="notes-body">
		<aside class="notes-list" aria-label="Shared notes list">
			{#if loading}<p class="notes-empty">Opening shared notes…</p>
			{:else if !notes.length}<p class="notes-empty">Nothing shared here yet. Create a note when there is something to keep together.</p>
			{/if}
			{#each notes as note (note.id)}
				<button type="button" class="note-row" class:selected={selectedId === note.id} onclick={() => select(note)}>
					<strong>{note.title}</strong>
					<span>{displayAuthor(note)} · {new Date(note.updatedAt).toLocaleDateString()}</span>
					<small>{note.locked ? 'Unavailable on this device' : note.encrypted ? 'Encrypted note' : 'Server-readable note'}</small>
				</button>
			{/each}
		</aside>
		<div class="note-detail">
			{#if selectedId === 'new' || selected}
				{#if selected?.locked}
					<div class="note-empty"><h4>Cannot open this note</h4><p>{selected.openError}</p></div>
				{:else}
					<div class="detail-top">
						<span class="scope-label">{selectedId === 'new' ? 'Private draft until saved' : selected?.encrypted ? 'Encrypted for this conversation' : 'Server-readable shared note'}</span>
						{#if remoteChange}<button type="button" onclick={() => selected && useNote(selected)}>Load newer version</button>{/if}
					</div>
					<input class="note-title" aria-label="Shared note title" placeholder="Note title" maxlength="120" bind:value={title} readonly={!canEdit || busy}/>
					<textarea aria-label="Shared note text" placeholder="Write something everyone in this conversation should have…" maxlength="20000" bind:value={text} readonly={!canEdit || busy}></textarea>
					<footer>
						<span class="save-state" role="status">{busy ? 'Saving…' : changed ? 'Unsaved changes' : selectedId === 'new' ? 'Draft on this device' : 'Saved for everyone'}</span>
						{#if canEdit}<button type="button" class="save-note" disabled={busy || !changed || !title.trim()} onclick={save}>{selectedId === 'new' ? 'Share note' : 'Save changes'}</button>{/if}
						{#if selected && canEdit}<button type="button" class="remove-note" disabled={busy} onclick={remove}>Remove</button>{/if}
					</footer>
				{/if}
			{:else}
				<div class="note-empty"><h4>Keep it together</h4><p>Open a shared note or create one. Your personal notebook stays private in Notes.</p></div>
			{/if}
		</div>
	</div>
	<p class="privacy-hint">{privacyMode === 'encrypted' ? 'Notes use this conversation’s experimental device encryption. The server stores ciphertext.' : privacyMode === 'pending' ? 'Encryption setup is pending. Notes cannot be shared yet.' : privacyMode === 'unconfirmed' ? 'Confirm server-readable chat in the conversation before sharing a note.' : privacyMode === 'readable' ? 'Saved notes are readable by this server’s operator and remain until removed.' : 'Shared notes follow this conversation’s privacy mode.'}</p>
</section>

<style>
	.shared-notes { height: 100%; min-height: 0; display: flex; flex-direction: column; container-type: inline-size; color: var(--text-primary); background: var(--surface-base); }
	.notes-header { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); }
	.notes-header h3 { margin: 0; font-size: 1rem; color: var(--text-heading); }
	.notes-header p { margin: 3px 0 0; color: var(--text-secondary); font-size: .75rem; line-height: 1.35; }
	button, input, textarea { font: inherit; color: inherit; }
	button { cursor: pointer; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-raised); padding: 7px 10px; }
	button:hover:not(:disabled) { background: var(--surface-hover); }
	button:disabled { opacity: .5; cursor: default; }
	button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent-primary-color); outline-offset: 1px; }
	.new-note, .save-note { color: var(--text-heading); border-color: var(--accent-primary-color); white-space: nowrap; }
	.notes-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(150px, 36%) minmax(0, 1fr); }
	.notes-list { min-width: 0; overflow-y: auto; border-right: 1px solid var(--border-subtle); background: var(--surface-sunken); padding: 8px; }
	.note-row { display: flex; flex-direction: column; align-items: flex-start; text-align: left; gap: 4px; width: 100%; border-color: transparent; background: transparent; margin-bottom: 4px; overflow-wrap: anywhere; }
	.note-row.selected { border-color: var(--border-subtle); background: var(--surface-raised); }
	.note-row strong { color: var(--text-heading); font-size: .84rem; }
	.note-row span, .note-row small { color: var(--text-secondary); font-size: .7rem; }
	.notes-empty { color: var(--text-secondary); font-size: .82rem; line-height: 1.5; padding: 14px 8px; margin: 0; }
	.note-detail { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
	.detail-top { padding: 12px 16px 0; display: flex; gap: 8px; align-items: center; justify-content: space-between; }
	.scope-label { color: var(--text-secondary); font-size: .73rem; }
	.note-title { border: 0; border-bottom: 1px solid var(--border-subtle); background: transparent; padding: 12px 16px; font-size: 1.15rem; font-weight: 650; }
	.note-detail textarea { flex: 1; min-height: 100px; width: 100%; resize: none; border: 0; background: transparent; padding: 14px 16px; line-height: 1.55; }
	.note-detail footer { display: flex; gap: 8px; align-items: center; padding: 10px 16px; border-top: 1px solid var(--border-subtle); }
	.save-state { color: var(--text-secondary); font-size: .73rem; margin-right: auto; }
	.remove-note { color: var(--text-secondary); }
	.note-empty { margin: auto; padding: 24px; text-align: center; max-width: 320px; }
	.note-empty h4 { margin: 0 0 7px; color: var(--text-heading); }
	.note-empty p { margin: 0; color: var(--text-secondary); line-height: 1.5; font-size: .82rem; }
	.note-error, .note-status { margin: 0; padding: 8px 14px; font-size: .78rem; background: var(--surface-raised); }
	.note-error { color: var(--text-danger, var(--text-primary)); }
	.note-error button { margin-left: 8px; }
	.privacy-hint { margin: 0; padding: 8px 14px; color: var(--text-secondary); border-top: 1px solid var(--border-subtle); font-size: .69rem; line-height: 1.4; }
	@container (max-width: 520px) {
		.notes-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
		.notes-list { display: flex; gap: 6px; overflow-x: auto; overflow-y: hidden; max-height: 100px; border-right: 0; border-bottom: 1px solid var(--border-subtle); }
		.note-row { flex: 0 0 145px; }
		.notes-empty { flex: 1; }
	}
</style>
