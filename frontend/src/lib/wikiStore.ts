import { writable, get } from 'svelte/store';
import { getAuthToken, onAuthSessionCleared } from '$lib/authSession';
import { fetchChannel } from './api/channelAccess';
import { getServerUrl } from '$lib/serverUrl';
import { groupMembership } from './groupAccess';
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

// Each mounted Wiki owns its page selection, revisions and request lifetime.
export function createWikiWorkspace() {
	const wikiPages = writable<WikiPage[]>([]);
	const wikiRevisions = writable<WikiRevision[]>([]);
	const wikiLoading = writable(false);
	const wikiError = writable<string | null>(null);
	const wikiChannelId = writable<string | null>(null);
	let loadRequestId = 0;
	let revisionRequestId = 0;

	const wikiPagesStore = wikiPages;
	const wikiRevisionsStore = wikiRevisions;
	const wikiLoadingStore = wikiLoading;
	const wikiErrorStore = wikiError;

	let generation = 0;
	let disposed = false;
	function clear() {
	 generation += 1; loadRequestId += 1; revisionRequestId += 1;
	 wikiPages.set([]); wikiRevisions.set([]); wikiChannelId.set(null);
	 wikiLoading.set(false); wikiError.set(null);
	}
	function capture(channelId: string) {
	 const version = generation, token = getAuthToken(), server = getServerUrl();
	 return () => !disposed && generation === version && get(wikiChannelId) === channelId
	  && getAuthToken() === token && getServerUrl() === server;
	}
	const stopAuth = onAuthSessionCleared(clear);
	const stopContext = groupMembership.onContextChanged(clear);
	const stopRevocation = groupMembership.onRevoked(event => {
	 if (event.channelId === get(wikiChannelId)) clear();
	});
	function dispose() { disposed = true; clear(); stopAuth(); stopContext(); stopRevocation(); }

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

	function normalizeWikiPage(value: Record<string, unknown>): WikiPage {
		return {
			pageId: String(value.pageId ?? ''),
			channelId: String(value.channelId ?? ''),
			title: String(value.title ?? ''),
			body: String(value.body ?? ''),
			authorUserId: Number(value.authorUserId ?? 0),
			createdAtMicros: Number(value.createdAtMicros ?? 0),
			updatedAtMicros: Number(value.updatedAtMicros ?? 0),
			isDeleted: Boolean(value.isDeleted),
			parentPageId: String(value.parentPageId ?? ''),
			slug: String(value.slug ?? ''),
			orderIndex: Number(value.orderIndex ?? 0),
		};
	}

	function normalizeWikiRevision(value: Record<string, unknown>): WikiRevision {
		return {
			revisionId: String(value.revisionId ?? ''),
			pageId: String(value.pageId ?? ''),
			channelId: String(value.channelId ?? ''),
			editorUserId: Number(value.editorUserId ?? 0),
			title: String(value.title ?? ''),
			body: String(value.body ?? ''),
			summary: String(value.summary ?? ''),
			createdAtMicros: Number(value.createdAtMicros ?? 0),
		};
	}

	async function loadWiki(channelId: string): Promise<void> {
		if (disposed) return;
	 groupMembership.realm();
	 if (get(wikiChannelId) !== channelId) clear();
	 const requestId = ++loadRequestId;
		const token = getAuthToken();
		if (!token || !channelId) {
			wikiPages.set([]);
			wikiRevisions.set([]);
			wikiChannelId.set(null);
			return;
		}

		wikiChannelId.set(channelId);
	 const isCurrent = capture(channelId);
		wikiLoading.set(true);
		wikiError.set(null);

		try {
			const res = await fetchChannel(channelId,
				`${apiBase()}/${encodeURIComponent(channelId)}/pages`,
				{ headers: headers() }
			);
			if (!res.ok) throw new Error(`Failed to load wiki: ${res.statusText}`);
			const data = await res.json();
			if (requestId !== loadRequestId || !isCurrent()) return;
			const pages: WikiPage[] = (data.pages || []).map((p: Record<string, unknown>) => normalizeWikiPage(p));
			wikiPages.set(pages);
		} catch (err) {
			if (requestId !== loadRequestId || !isCurrent()) return;
			wikiError.set(err instanceof Error ? err.message : 'Failed to load wiki pages');
			wikiPages.set([]);
		} finally {
			if (requestId === loadRequestId && isCurrent()) wikiLoading.set(false);
		}
	}

	async function loadRevisions(channelId: string, pageId: string): Promise<void> {
		const requestId = ++revisionRequestId;
	 const isCurrent = capture(channelId);
	 if (!isCurrent()) return;
	 wikiRevisions.set([]);
		try {
			const res = await fetchChannel(channelId,
				`${apiBase()}/${encodeURIComponent(channelId)}/pages/${encodeURIComponent(pageId)}/revisions`,
				{ headers: headers() }
			);
			if (!res.ok) throw new Error(`Failed to load revisions: ${res.statusText}`);
			const data = await res.json();
			if (requestId !== revisionRequestId || !isCurrent()) return;
			const revisions: WikiRevision[] = (data.revisions || []).map((r: Record<string, unknown>) => normalizeWikiRevision(r));
			wikiRevisions.set(revisions);
		} catch (err) {
			if (requestId !== revisionRequestId || !isCurrent()) return;
			wikiError.set(err instanceof Error ? err.message : 'Failed to load revisions');
			wikiRevisions.set([]);
		}
	}

	async function createWikiPage(
		channelId: string,
		data: { title: string; body: string; parentPageId?: string; slug?: string; orderIndex?: number }
	): Promise<WikiPage | null> {
	 const isCurrent = capture(channelId);
	 if (!isCurrent()) return null;
		try {
			const res = await fetchChannel(channelId,
				`${apiBase()}/${encodeURIComponent(channelId)}/pages`,
				{
					method: 'POST',
					headers: headers(),
					body: JSON.stringify(data),
				}
			);
			if (!res.ok) throw new Error(`Failed to create page: ${res.statusText}`);
			const page: WikiPage = normalizeWikiPage(await res.json());
	 if (!isCurrent()) return null;
			wikiError.set(null);
			wikiPages.update((ps) => [...ps, page]);
			return page;
		} catch (err) {
	 if (!isCurrent()) return null;
			wikiError.set(err instanceof Error ? err.message : 'Failed to create page');
			return null;
		}
	}

	async function updateWikiPage(
		channelId: string,
		pageId: string,
		data: { title?: string; body?: string; parentPageId?: string; slug?: string; orderIndex?: number }
	): Promise<WikiPage | null> {
	 const isCurrent = capture(channelId);
	 if (!isCurrent()) return null;
		try {
			const res = await fetchChannel(channelId,
				`${apiBase()}/${encodeURIComponent(channelId)}/pages/${encodeURIComponent(pageId)}`,
				{
					method: 'PUT',
					headers: headers(),
					body: JSON.stringify(data),
				}
			);
			if (!res.ok) throw new Error(`Failed to update page: ${res.statusText}`);
			const page: WikiPage = normalizeWikiPage(await res.json());
	 if (!isCurrent()) return null;
			wikiError.set(null);
			wikiPages.update((ps) => ps.map((p) => (p.pageId === page.pageId ? page : p)));
			return page;
		} catch (err) {
	 if (!isCurrent()) return null;
			wikiError.set(err instanceof Error ? err.message : 'Failed to update page');
			return null;
		}
	}

	function findWikiAuthor(userId: number): User | undefined {
		return get(users).find((u) => u.dbUserId === userId);
	}

	function formatWikiTime(micros: number): string {
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

	return { wikiPagesStore, wikiRevisionsStore, wikiLoadingStore, wikiErrorStore, loadWiki, loadRevisions, createWikiPage, updateWikiPage, findWikiAuthor, formatWikiTime, dispose };
}

// Compatibility facade for non-view callers and presentation helpers.
export const { wikiPagesStore, wikiRevisionsStore, wikiLoadingStore, wikiErrorStore, loadWiki, loadRevisions, createWikiPage, updateWikiPage, findWikiAuthor, formatWikiTime } = createWikiWorkspace();
