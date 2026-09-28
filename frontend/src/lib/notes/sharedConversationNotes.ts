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
	if (!token) throw new Error('Sign in to open shared notes.');
	return { server, generation: authSessionGeneration(server) };
}

async function request(path: string, init: RequestInit = {}): Promise<any> {
	const realm = noteRealm();
	const send = () => {
		const token = getAuthToken(realm.server) || getAuthToken();
		if (!token) throw new Error('Your session expired. Sign in to use shared notes.');
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
		throw new Error('Shared notes need an updated Wabi server. Ask the operator to update it, then retry.');
	}
	if (!response.ok) throw new Error(value?.error || `Shared notes request failed (${response.status}).`);
	if (getServerUrl().replace(/\/+$/, '') !== realm.server || authSessionGeneration(realm.server) !== realm.generation) {
		throw new Error('The account or server changed while loading shared notes.');
	}
	return value;
}

export function parseReadableNote(content: string): NotePayload {
	const payload = JSON.parse(content);
	if (!payload || typeof payload.title !== 'string' || typeof payload.text !== 'string') throw new Error('This note has an invalid saved format.');
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
			if (!prepared.e2eeVerified) throw new Error(prepared.e2eeError || 'This device cannot decrypt the shared note.');
			clear = prepared.text;
		}
		return { ...wire, ...parseReadableNote(clear), locked: false };
	} catch (error) {
		return { ...wire, title: 'Encrypted note unavailable', text: '', locked: true,
			openError: error instanceof Error ? error.message : 'This note cannot be opened on this device.' };
	}
}

export async function listSharedNotes(channelId: string): Promise<SharedNote[]> {
	const value = await request(`/api/conversation-notes/${encodeURIComponent(channelId)}`);
	const rows: SharedNoteWire[] = Array.isArray(value.notes) ? value.notes : [];
	return Promise.all(rows.map((row) => openSharedNote(channelId, row)));
}

async function wireContent(channelId: string, payload: NotePayload): Promise<string> {
	const title = payload.title.trim();
	if (!title) throw new Error('Give the shared note a title.');
	if (title.length > 120) throw new Error('The note title is too long.');
	if (payload.text.length > 20_000) throw new Error('The note is too long.');
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
