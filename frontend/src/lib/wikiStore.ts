import { writable, get } from 'svelte/store';
import { getAuthToken } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';
import { users, type User } from '$lib/socket';

export interface WikiPage {
	pageId: string;
	channelId: string;
	title: string;
	body: string;
	authorUserId: number;
	createdAtMicros: number;
	updatedAtMicros: number;
	isDeleted: boolean;
	parentPageId: string;
	slug: string;
	orderIndex: number;
}

export interface WikiRevision {
	revisionId: string;
	pageId: string;
	channelId: string;
	editorUserId: number;
	title: string;
	body: string;
	summary: string;
	createdAtMicros: number;
}

const wikiPages = writable<WikiPage[]>([]);
const wikiRevisions = writable<WikiRevision[]>([]);
const wikiLoading = writable(false);
const wikiError = writable<string | null>(null);
const wikiChannelId = writable<string | null>(null);

export const wikiPagesStore = wikiPages;
export const wikiRevisionsStore = wikiRevisions;
export const wikiLoadingStore = wikiLoading;
export const wikiErrorStore = wikiError;

function apiBase(): string {
	return `${getServerUrl()}/api/wiki`;
}

function headers(): Record<string, string> {
	const token = getAuthToken();
	return {
		'Content-Type': 'application/json',
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

export async function loadWiki(channelId: string): Promise<void> {
	const token = getAuthToken();
	if (!token || !channelId) {
		wikiPages.set([]);
		wikiRevisions.set([]);
		wikiChannelId.set(null);
		return;
	}

	wikiChannelId.set(channelId);
	wikiLoading.set(true);
	wikiError.set(null);

	try {
		const res = await fetch(
			`${apiBase()}/${encodeURIComponent(channelId)}/pages`,
			{ headers: headers() }
		);
		if (!res.ok) throw new Error(`Failed to load wiki: ${res.statusText}`);
		const data = await res.json();
		const pages: WikiPage[] = (data.pages || []).map((p: Record<string, unknown>) => ({
			pageId: String(p.pageId ?? ''),
			channelId: String(p.channelId ?? ''),
			title: String(p.title ?? ''),
			body: String(p.body ?? ''),
			authorUserId: Number(p.authorUserId ?? 0),
			createdAtMicros: Number(p.createdAtMicros ?? 0),
			updatedAtMicros: Number(p.updatedAtMicros ?? 0),
			isDeleted: Boolean(p.isDeleted),
			parentPageId: String(p.parentPageId ?? ''),
			slug: String(p.slug ?? ''),
			orderIndex: Number(p.orderIndex ?? 0),
		}));
		wikiPages.set(pages);
	} catch (err) {
		wikiError.set(err instanceof Error ? err.message : 'Failed to load wiki pages');
		wikiPages.set([]);
	} finally {
		wikiLoading.set(false);
	}
}

export async function loadRevisions(channelId: string, pageId: string): Promise<void> {
	try {
		const res = await fetch(
			`${apiBase()}/${encodeURIComponent(channelId)}/pages/${encodeURIComponent(pageId)}/revisions`,
			{ headers: headers() }
		);
		if (!res.ok) throw new Error(`Failed to load revisions: ${res.statusText}`);
		const data = await res.json();
		const revisions: WikiRevision[] = (data.revisions || []).map((r: Record<string, unknown>) => ({
			revisionId: String(r.revisionId ?? ''),
			pageId: String(r.pageId ?? ''),
			channelId: String(r.channelId ?? ''),
			editorUserId: Number(r.editorUserId ?? 0),
			title: String(r.title ?? ''),
			body: String(r.body ?? ''),
			summary: String(r.summary ?? ''),
			createdAtMicros: Number(r.createdAtMicros ?? 0),
		}));
		wikiRevisions.set(revisions);
	} catch (err) {
		wikiError.set(err instanceof Error ? err.message : 'Failed to load revisions');
		wikiRevisions.set([]);
	}
}

export async function createWikiPage(
	channelId: string,
	data: { title: string; body: string; parentPageId?: string; slug?: string; orderIndex?: number }
): Promise<WikiPage | null> {
	try {
		const res = await fetch(
			`${apiBase()}/${encodeURIComponent(channelId)}/pages`,
			{
				method: 'POST',
				headers: headers(),
				body: JSON.stringify(data),
			}
		);
		if (!res.ok) throw new Error(`Failed to create page: ${res.statusText}`);
		const page: WikiPage = await res.json();
		wikiPages.update((ps) => [...ps, page]);
		return page;
	} catch (err) {
		wikiError.set(err instanceof Error ? err.message : 'Failed to create page');
		return null;
	}
}

export async function updateWikiPage(
	channelId: string,
	pageId: string,
	data: { title?: string; body?: string; parentPageId?: string; slug?: string; orderIndex?: number }
): Promise<WikiPage | null> {
	try {
		const res = await fetch(
			`${apiBase()}/${encodeURIComponent(channelId)}/pages/${encodeURIComponent(pageId)}`,
			{
				method: 'PUT',
				headers: headers(),
				body: JSON.stringify(data),
			}
		);
		if (!res.ok) throw new Error(`Failed to update page: ${res.statusText}`);
		const page: WikiPage = await res.json();
		wikiPages.update((ps) => ps.map((p) => (p.pageId === page.pageId ? page : p)));
		return page;
	} catch (err) {
		wikiError.set(err instanceof Error ? err.message : 'Failed to update page');
		return null;
	}
}

export function findWikiAuthor(userId: number): User | undefined {
	return get(users).find((u) => u.dbUserId === userId);
}

export function formatWikiTime(micros: number): string {
	const ms = micros > 1e12 ? Math.floor(micros / 1000) : micros;
	const now = Date.now();
	const diff = now - ms;
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (seconds < 60) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 7) return `${days}d ago`;
	try {
		return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ms));
	} catch {
		return `${days}d ago`;
	}
}
