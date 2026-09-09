import { writable, get } from 'svelte/store';
import { getAuthToken } from '$lib/authSession';
import { fetchChannel } from './api/channelAccess';
import { getServerUrl } from '$lib/serverUrl';
import { users, type User } from '$lib/socket';

export interface ForumAttachment {
	url: string;
	name: string;
	size?: number;
	mime?: string;
}

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
	attachments?: ForumAttachment[];
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

// Forum posts live in a dedicated WabiDB forum table/projection (ForumPostRecord),
// not in chat messages — the API payloads accept only body/title/tags/category.
// Images uploaded via the chat resumable path persist as `![name](url)` markdown
// appended to `body`; these helpers build and parse that markdown client-side.
const FORUM_IMAGE_MARKDOWN_RE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;

export function buildForumImageMarkdown(attachments: ForumAttachment[]): string {
	if (attachments.length === 0) return '';
	return attachments.map((a) => `![${a.name.replace(/[\[\]\n]/g, '')}](${a.url})`).join('\n');
}

export function withForumImages(body: string, attachments: ForumAttachment[]): string {
	const markdown = buildForumImageMarkdown(attachments);
	if (!markdown) return body;
	return body ? `${body}\n\n${markdown}` : markdown;
}

export function extractForumAttachments(body: string): ForumAttachment[] {
	const out: ForumAttachment[] = [];
	if (!body) return out;
	FORUM_IMAGE_MARKDOWN_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = FORUM_IMAGE_MARKDOWN_RE.exec(body)) !== null) {
		const name = match[1] || 'image';
		const url = match[2];
		if (url && !out.some((a) => a.url === url)) {
			out.push({ url, name, mime: 'image/*' });
		}
	}
	return out;
}

export function stripForumImageMarkdown(body: string): string {
	if (!body) return body;
	return body
		.replace(FORUM_IMAGE_MARKDOWN_RE, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function resolveForumFileUrl(url: string): string {
	if (!url) return '';
	if (/^(https?:|data:|blob:)/i.test(url)) return url;
	const base = getServerUrl().replace(/\/+$/, '');
	const path = url.startsWith('/') ? url : `/${url}`;
	return `${base}${path}`;
}

export function formatForumFileSize(bytes?: number): string {
	if (bytes == null || Number.isNaN(bytes)) return '';
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	return `${(kb / 1024).toFixed(2)} MB`;
}

function mapForumPost(t: Record<string, unknown>): ForumPost {
	const body = String(t.body ?? '');
	return {
		post_id: String(t.post_id ?? ''),
		thread_id: String(t.thread_id ?? ''),
		channel_id: String(t.channel_id ?? ''),
		author_user_id: Number(t.author_user_id ?? 0),
		body,
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
		attachments: extractForumAttachments(body),
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
		const res = await fetchChannel(channelId, `${apiBase()}/${encodeURIComponent(channelId)}/threads`, {
			headers: headers(),
		});
		if (!res.ok) throw new Error(`Failed to load threads: ${res.statusText}`);
		const data = await res.json();
		const threads: ForumPost[] = (data.threads || []).map((t: Record<string, unknown>) =>
			mapForumPost(t)
		);
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
		const res = await fetchChannel(channelId,
			`${apiBase()}/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/posts`,
			{ headers: headers() }
		);
		if (!res.ok) throw new Error(`Failed to load posts: ${res.statusText}`);
		const data = await res.json();
		const posts: ForumPost[] = (data.posts || []).map((p: Record<string, unknown>) =>
			mapForumPost(p)
		);
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
	category?: string,
	attachments?: ForumAttachment[]
): Promise<ForumPost | null> {
	try {
		const res = await fetchChannel(channelId, `${apiBase()}/${encodeURIComponent(channelId)}/threads`, {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({
				title,
				body: withForumImages(body, attachments || []),
				tags,
				category,
			}),
		});
		if (!res.ok) throw new Error(`Failed to create thread: ${res.statusText}`);
		const post: ForumPost = mapForumPost(await res.json());
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
	tags?: string[],
	attachments?: ForumAttachment[]
): Promise<ForumPost | null> {
	try {
		const res = await fetchChannel(channelId,
			`${apiBase()}/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/posts`,
			{
				method: 'POST',
				headers: headers(),
				body: JSON.stringify({ body: withForumImages(body, attachments || []), tags }),
			}
		);
		if (!res.ok) throw new Error(`Failed to create post: ${res.statusText}`);
		const post: ForumPost = mapForumPost(await res.json());
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
		const res = await fetchChannel(channelId,
			`${apiBase()}/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/posts/${encodeURIComponent(postId)}/vote`,
			{
				method: 'POST',
				headers: headers(),
				body: JSON.stringify({ direction }),
			}
		);
		if (!res.ok) throw new Error(`Failed to vote: ${res.statusText}`);
		const post: ForumPost = mapForumPost(await res.json());
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
		const res = await fetchChannel(channelId,
			`${apiBase()}/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/posts/${encodeURIComponent(postId)}/solution`,
			{
				method: 'POST',
				headers: headers(),
			}
		);
		if (!res.ok) throw new Error(`Failed to mark solution: ${res.statusText}`);
		const post: ForumPost = mapForumPost(await res.json());
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
		const res = await fetchChannel(channelId,
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
		const post: ForumPost = mapForumPost(await res.json());
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
