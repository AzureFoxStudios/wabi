import { writable, get } from 'svelte/store';
import { getAuthToken } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';
import { users, type User } from '$lib/socket';

export interface ForumPost {
	post_id: string;
	thread_id: string;
	channel_id: string;
	author_user_id: number;
	body: string;
	created_at_micros: number;
	edited_at_micros?: number;
	is_deleted: boolean;
	is_thread_starter: boolean;
	title: string;
	tags: string[];
	votes_up: number;
	votes_down: number;
	is_solution: boolean;
	category?: string;
}

export type ForumCategory = string;

const forumThreads = writable<ForumPost[]>([]);
const forumPostsByThread = writable<Map<string, ForumPost[]>>(new Map());
const forumLoading = writable(false);
const forumError = writable<string | null>(null);
const forumSelectedThreadId = writable<string | null>(null);
const forumChannelId = writable<string | null>(null);

export const forumThreadsStore = forumThreads;
export const forumPostsByThreadStore = forumPostsByThread;
export const forumLoadingStore = forumLoading;
export const forumErrorStore = forumError;
export const forumSelectedThreadIdStore = forumSelectedThreadId;

function apiBase(): string {
	return `${getServerUrl()}/api/forum`;
}

function headers(): Record<string, string> {
	const token = getAuthToken();
	return {
		'Content-Type': 'application/json',
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

export async function loadThreads(channelId: string): Promise<void> {
	const token = getAuthToken();
	if (!token || !channelId) {
		forumThreads.set([]);
		forumPostsByThread.set(new Map());
		forumChannelId.set(null);
		return;
	}

	forumChannelId.set(channelId);
	forumLoading.set(true);
	forumError.set(null);

	try {
		const res = await fetch(`${apiBase()}/${encodeURIComponent(channelId)}/threads`, {
			headers: headers(),
		});
		if (!res.ok) throw new Error(`Failed to load threads: ${res.statusText}`);
		const data = await res.json();
		const threads: ForumPost[] = (data.threads || []).map((t: Record<string, unknown>) => ({
			post_id: String(t.post_id ?? ''),
			thread_id: String(t.thread_id ?? ''),
			channel_id: String(t.channel_id ?? ''),
			author_user_id: Number(t.author_user_id ?? 0),
			body: String(t.body ?? ''),
			created_at_micros: Number(t.created_at_micros ?? 0),
			edited_at_micros: t.edited_at_micros != null ? Number(t.edited_at_micros) : undefined,
			is_deleted: Boolean(t.is_deleted),
			is_thread_starter: Boolean(t.is_thread_starter),
			title: String(t.title ?? ''),
			tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
			votes_up: Number(t.votes_up ?? 0),
			votes_down: Number(t.votes_down ?? 0),
			is_solution: Boolean(t.is_solution),
			category: t.category != null ? String(t.category) : undefined,
		}));
		forumThreads.set(threads);
	} catch (err) {
		forumError.set(err instanceof Error ? err.message : 'Failed to load forum threads');
		forumThreads.set([]);
	} finally {
		forumLoading.set(false);
	}
}

export async function loadPosts(channelId: string, threadId: string): Promise<void> {
	try {
		const res = await fetch(
			`${apiBase()}/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/posts`,
			{ headers: headers() }
		);
		if (!res.ok) throw new Error(`Failed to load posts: ${res.statusText}`);
		const data = await res.json();
		const posts: ForumPost[] = (data.posts || []).map((p: Record<string, unknown>) => ({
			post_id: String(p.post_id ?? ''),
			thread_id: String(p.thread_id ?? ''),
			channel_id: String(p.channel_id ?? ''),
			author_user_id: Number(p.author_user_id ?? 0),
			body: String(p.body ?? ''),
			created_at_micros: Number(p.created_at_micros ?? 0),
			edited_at_micros: p.edited_at_micros != null ? Number(p.edited_at_micros) : undefined,
			is_deleted: Boolean(p.is_deleted),
			is_thread_starter: Boolean(p.is_thread_starter),
			title: String(p.title ?? ''),
			tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
			votes_up: Number(p.votes_up ?? 0),
			votes_down: Number(p.votes_down ?? 0),
			is_solution: Boolean(p.is_solution),
			category: p.category != null ? String(p.category) : undefined,
		}));
		forumPostsByThread.update((map) => {
			const next = new Map(map);
			next.set(threadId, posts);
			return next;
		});
	} catch (err) {
		forumError.set(err instanceof Error ? err.message : 'Failed to load posts');
	}
}

export async function createThread(
	channelId: string,
	body: string,
	title?: string,
	tags?: string[],
	category?: string
): Promise<ForumPost | null> {
	try {
		const res = await fetch(`${apiBase()}/${encodeURIComponent(channelId)}/threads`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({ title, body, tags, category }),
		});
		if (!res.ok) throw new Error(`Failed to create thread: ${res.statusText}`);
		const post: ForumPost = await res.json();
		forumThreads.update((ts) => [post, ...ts]);
		return post;
	} catch (err) {
		forumError.set(err instanceof Error ? err.message : 'Failed to create thread');
		return null;
	}
}

export async function createPost(
	channelId: string,
	threadId: string,
	body: string,
	tags?: string[]
): Promise<ForumPost | null> {
	try {
		const res = await fetch(
			`${apiBase()}/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/posts`,
			{
				method: 'POST',
				headers: headers(),
				body: JSON.stringify({ body, tags }),
			}
		);
		if (!res.ok) throw new Error(`Failed to create post: ${res.statusText}`);
		const post: ForumPost = await res.json();
		forumPostsByThread.update((map) => {
			const next = new Map(map);
			const existing = next.get(threadId) || [];
			next.set(threadId, [...existing, post]);
			return next;
		});
		return post;
	} catch (err) {
		forumError.set(err instanceof Error ? err.message : 'Failed to create post');
		return null;
	}
}

export async function votePost(
	channelId: string,
	threadId: string,
	postId: string,
	direction: 'up' | 'down'
): Promise<ForumPost | null> {
	try {
		const res = await fetch(
			`${apiBase()}/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/posts/${encodeURIComponent(postId)}/vote`,
			{
				method: 'POST',
				headers: headers(),
				body: JSON.stringify({ direction }),
			}
		);
		if (!res.ok) throw new Error(`Failed to vote: ${res.statusText}`);
		const post: ForumPost = await res.json();
		updatePostInStore(threadId, post);
		return post;
	} catch (err) {
		forumError.set(err instanceof Error ? err.message : 'Failed to vote');
		return null;
	}
}

export async function markSolution(
	channelId: string,
	threadId: string,
	postId: string
): Promise<ForumPost | null> {
	try {
		const res = await fetch(
			`${apiBase()}/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/posts/${encodeURIComponent(postId)}/solution`,
			{
				method: 'POST',
				headers: headers(),
			}
		);
		if (!res.ok) throw new Error(`Failed to mark solution: ${res.statusText}`);
		const post: ForumPost = await res.json();
		updatePostInStore(threadId, post);
		return post;
	} catch (err) {
		forumError.set(err instanceof Error ? err.message : 'Failed to mark solution');
		return null;
	}
}

export async function updateForumPost(
	channelId: string,
	threadId: string,
	postId: string,
	patch: { title?: string; body?: string; tags?: string[]; category?: string }
): Promise<ForumPost | null> {
	try {
		const current =
			get(forumThreads).find((t) => t.post_id === postId) ||
			(get(forumPostsByThread).get(threadId) || []).find((p) => p.post_id === postId);
		const res = await fetch(
			`${apiBase()}/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/posts/${encodeURIComponent(postId)}`,
			{
				method: 'PUT',
				headers: headers(),
				body: JSON.stringify({
					body: patch.body ?? current?.body ?? '',
					title: patch.title ?? null,
					tags: patch.tags ?? null,
					category: patch.category ?? null,
				}),
			}
		);
		if (!res.ok) throw new Error(`Failed to update post: ${res.statusText}`);
		const post: ForumPost = await res.json();
		updatePostInStore(threadId, post);
		return post;
	} catch (err) {
		forumError.set(err instanceof Error ? err.message : 'Failed to update post');
		return null;
	}
}

export async function renameForumCategory(
	channelId: string,
	from: string,
	to: string
): Promise<boolean> {
	const name = to.trim();
	if (!name || name === from) return false;
	const targets = get(forumThreads).filter((t) => categorizeThread(t) === from);
	let ok = true;
	for (const t of targets) {
		const updated = await updateForumPost(channelId, t.thread_id, t.post_id, { category: name });
		if (!updated) ok = false;
	}
	if (ok && targets.length > 0) await loadThreads(channelId);
	return ok && targets.length > 0;
}

function updatePostInStore(threadId: string, updated: ForumPost): void {
	forumPostsByThread.update((map) => {
		const next = new Map(map);
		const existing = next.get(threadId) || [];
		next.set(
			threadId,
			existing.map((p) => (p.post_id === updated.post_id ? updated : p))
		);
		return next;
	});
	forumThreads.update((ts) =>
		ts.map((t) => (t.post_id === updated.post_id ? updated : t))
	);
}

export function findAuthor(userId: number): User | undefined {
	return get(users).find((u) => u.dbUserId === userId);
}

export function formatForumTime(micros: number): string {
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

export function getDefaultCategories(): ForumCategory[] {
	return ['General', 'Bug', 'Feature', 'Discussion'];
}

export function categorizeThread(post: ForumPost): string {
	if (post.category) return post.category;
	if (post.tags.length > 0) return post.tags[0];
	return 'General';
}

export function tagClass(tag: string): string {
	const lower = tag.toLowerCase();
	if (lower === 'bug') return 'forum-tag-bug';
	if (lower === 'feature') return 'forum-tag-feature';
	if (lower === 'discussion') return 'forum-tag-discussion';
	return '';
}
