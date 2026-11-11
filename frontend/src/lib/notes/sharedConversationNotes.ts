import { getAuthToken, authSessionGeneration, onAuthSessionCleared } from '$lib/authSession';
import { tryRefresh } from '$lib/api/authRefresh';
import { getServerUrl } from '$lib/serverUrl';
import { e2eeClientRealmKey, encryptMessageForChannel, prepareIncomingE2eeMessage } from '$lib/e2ee';
import type { Message } from '$lib/socket-types';

export type SharedNoteWire = {
	id: string;
	channelId: string;
	authorUserId: number;
	content: string;
	encrypted: boolean;
	createdAt: number;
	updatedAt: number;
	revision: number;
};

export type SharedNote = SharedNoteWire & {
	title: string;
	text: string;
	locked: boolean;
	openError?: string;
};

/** An error whose message was written for the person reading it. */
export class SharedNoteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SharedNoteError';
	}
}

/**
 * The words to show for a failure: its own message only when it was written
 * for the reader, otherwise `fallback`. A runtime error's message ("Failed to
 * fetch", a JSON parse error, a crypto detail) is never shown.
 */
export function sharedNoteErrorText(error: unknown, fallback: string): string {
	return error instanceof SharedNoteError ? error.message : fallback;
}

const CANNOT_OPEN = 'This note cannot be opened on this device.';
// Same claims as the message placeholders in e2eeUnreadable.ts, and no more.
const NOTE_NO_KEY = 'This note uses experimental encryption. This device does not have its key, so it cannot be shown.';
const NOTE_FAILED_CHECK = 'This note uses experimental encryption. It failed a check on this device and is not shown.';

type NotePayload = { title: string; text: string };

export type SharedNoteDraft = {
	selectedId: string | null;
	title: string;
	text: string;
	savedTitle: string;
	savedText: string;
	baselineRevision: number;
};

// Unsaved text stays in page memory only. The two DM surfaces retain separate
// drafts, scoped to the server and account; none is persisted to browser disk.
const drafts = new Map<string, SharedNoteDraft>();
function draftKey(channelId: string, surface: string): string | null {
	try { return `${e2eeClientRealmKey()}|${surface}|${channelId}`; } catch { return null; }
}
export function keepSharedNoteDraft(channelId: string, surface: string, draft: SharedNoteDraft): void {
	const key = draftKey(channelId, surface);
	if (!key) return;
	if (draft.title === draft.savedTitle && draft.text === draft.savedText) {
		drafts.delete(key);
		return;
	}
	drafts.delete(key);
	drafts.set(key, { ...draft });
	while (drafts.size > 24) drafts.delete(drafts.keys().next().value!);
}
export function takeSharedNoteDraft(channelId: string, surface: string): SharedNoteDraft | null {
	const key = draftKey(channelId, surface);
	if (!key) return null;
	const draft = drafts.get(key) || null;
	drafts.delete(key);
	return draft;
}
onAuthSessionCleared((server) => {
	for (const key of drafts.keys()) if (key.startsWith(`${server.replace(/\/+$/, '')}|`)) drafts.delete(key);
});

function noteRealm() {
	const server = getServerUrl().replace(/\/+$/, '');
	const token = getAuthToken(server) || getAuthToken();
	if (!token) throw new SharedNoteError('Sign in to open shared notes.');
	return { server, generation: authSessionGeneration(server) };
}

async function request(path: string, init: RequestInit = {}): Promise<any> {
	const realm = noteRealm();
	const send = () => {
		const token = getAuthToken(realm.server) || getAuthToken();
		if (!token) throw new SharedNoteError('Your session expired. Sign in to use shared notes.');
		return fetch(`${realm.server}${path}`, {
			...init,
			credentials: 'include',
			headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
		});
	};
	let response = await send();
	if (response.status === 401 && await tryRefresh(realm.server)) {
		realm.generation = authSessionGeneration(realm.server);
		response = await send();
	}
	const value = await response.json().catch(() => ({}));
	if (response.status === 404 && (!value?.error || value.error === 'not_found')) {
		throw new SharedNoteError('Shared notes need an updated Wabi server. Ask the operator to update it, then retry.');
	}
	// `error` is a sentence the server wrote for the reader (api/conversation_notes.rs).
	if (!response.ok) throw new SharedNoteError(typeof value?.error === 'string' && value.error ? value.error : `Shared notes request failed (${response.status}).`);
	if (getServerUrl().replace(/\/+$/, '') !== realm.server || authSessionGeneration(realm.server) !== realm.generation) {
		throw new SharedNoteError('The account or server changed while loading shared notes.');
	}
	return value;
}

export function parseReadableNote(content: string): NotePayload {
	const payload = JSON.parse(content);
	if (!payload || typeof payload.title !== 'string' || typeof payload.text !== 'string') throw new SharedNoteError('This note has an invalid saved format.');
	return { title: payload.title, text: payload.text };
}

export async function openSharedNote(channelId: string, wire: SharedNoteWire): Promise<SharedNote> {
	try {
		let clear = wire.content;
		if (wire.encrypted) {
			const prepared = await prepareIncomingE2eeMessage(channelId, {
				id: wire.id, user: '', userId: `user-${wire.authorUserId}`,
				text: wire.content, type: 'text', timestamp: wire.updatedAt,
			} as Message);
			if (!prepared.e2eeVerified) {
				throw new SharedNoteError(prepared.e2eeUnreadable === 'no-key' ? NOTE_NO_KEY
					: prepared.e2eeUnreadable === 'failed-check' ? NOTE_FAILED_CHECK : CANNOT_OPEN);
			}
			clear = prepared.text;
		}
		return { ...wire, ...parseReadableNote(clear), locked: false };
	} catch (error) {
		return { ...wire, title: 'Note unavailable', text: '', locked: true,
			openError: sharedNoteErrorText(error, CANNOT_OPEN) };
	}
}

export async function listSharedNotes(channelId: string): Promise<SharedNote[]> {
	const value = await request(`/api/conversation-notes/${encodeURIComponent(channelId)}`);
	const rows: SharedNoteWire[] = Array.isArray(value.notes) ? value.notes : [];
	return Promise.all(rows.map((row) => openSharedNote(channelId, row)));
}

async function wireContent(channelId: string, payload: NotePayload): Promise<string> {
	const title = payload.title.trim();
	if (!title) throw new SharedNoteError('Give the shared note a title.');
	if (title.length > 120) throw new SharedNoteError('The note title is too long.');
	if (payload.text.length > 20_000) throw new SharedNoteError('The note is too long.');
	const clear = JSON.stringify({ title, text: payload.text });
	const encrypted = await encryptMessageForChannel(channelId, clear, 'text');
	return encrypted?.wireText || clear;
}

export async function saveSharedNote(channelId: string, payload: NotePayload, prior?: SharedNote): Promise<SharedNote> {
	const content = await wireContent(channelId, payload);
	const path = `/api/conversation-notes/${encodeURIComponent(channelId)}${prior ? `/${encodeURIComponent(prior.id)}` : ''}`;
	const wire: SharedNoteWire = await request(path, {
		method: prior ? 'PUT' : 'POST',
		body: JSON.stringify({ content, ...(prior ? { revision: prior.revision } : {}) }),
	});
	return openSharedNote(channelId, wire);
}

export async function removeSharedNote(channelId: string, note: SharedNote): Promise<void> {
	await request(`/api/conversation-notes/${encodeURIComponent(channelId)}/${encodeURIComponent(note.id)}`, {
		method: 'DELETE', body: JSON.stringify({ revision: note.revision }),
	});
}
