import { writable, type Writable } from 'svelte/store';
import { getAuthToken, authSessionGeneration, onAuthSessionCleared, getStoredDbUserId } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';
import { fetchChannel } from './api/channelAccess';
import { tryRefresh } from './api/authRefresh';
import { accountTokenSubject } from './apiRequest';
import { groupMembership } from './groupAccess';

export interface GalleryFeedback {
	feedbackId: string;
	workId: string;
	channelId: string;
	authorUserId: number;
	comment: string;
	xPercent: number;
	yPercent: number;
	createdAtMicros: number;
	isDeleted: boolean;
}

/** A lightbox composer's unsent marker + text for one work. */
export interface FeedbackDraftSnapshot {
	marker: { x: number; y: number } | null;
	text: string;
}

/**
 * An old save completion may only clear the draft it saved. If the composer
 * moved on (new text, moved marker, or a different work), the newer draft
 * survives. Pure so the lightbox — and unit tests — share one rule.
 */
export function shouldClearFeedbackDraft(
	saved: FeedbackDraftSnapshot,
	current: FeedbackDraftSnapshot | null
): boolean {
	if (!current) return false;
	if (current.text !== saved.text) return false;
	if (saved.marker === null || current.marker === null) {
		return saved.marker === current.marker;
	}
	return current.marker.x === saved.marker.x && current.marker.y === saved.marker.y;
}

export interface GalleryFeedbackDeps {
	server: () => string;
	token: () => string | null;
	accountId: () => string | null;
	generation: () => number;
	fetchChannel: (channelId: string, url: string, options?: RequestInit) => Promise<Response>;
	refresh: (server: string) => Promise<boolean>;
	onSessionCleared: (listener: (server: string) => void) => () => void;
	onContextChanged: (listener: () => void) => () => void;
	onRevoked: (listener: (event: { channelId: string }) => void) => () => void;
}

export interface GalleryFeedbackSession {
	feedbackItems: Writable<GalleryFeedback[]>;
	feedbackLoading: Writable<boolean>;
	feedbackError: Writable<string | null>;
	onRetired: (listener: () => void) => () => void;
	load: (channelId: string, workId: string) => Promise<void>;
	add: (
		channelId: string,
		workId: string,
		comment: string,
		xPercent: number,
		yPercent: number
	) => Promise<string | null>;
	remove: (channelId: string, workId: string, feedbackId: string) => Promise<boolean>;
	dispose: () => void;
}

function defaultAccountId(server: string): string | null {
	const stored = getStoredDbUserId(server);
	if (stored !== null) return String(stored);
	return accountTokenSubject(getAuthToken(server));
}

function defaultDeps(): GalleryFeedbackDeps {
	return {
		server: () => getServerUrl(),
		token: () => getAuthToken(),
		accountId: () => defaultAccountId(getServerUrl()),
		generation: () => authSessionGeneration(),
		fetchChannel: (channelId, url, options) => fetchChannel(channelId, url, options),
		refresh: (server) => tryRefresh(server),
		onSessionCleared: (listener) => onAuthSessionCleared(listener),
		onContextChanged: (listener) => groupMembership.onContextChanged(listener),
		onRevoked: (listener) => groupMembership.onRevoked(listener)
	};
}

interface CapturedScope {
	server: string;
	token: string | null;
	subject: string | null;
	account: string | null;
	generation: number;
	retirement: number;
	channelId: string;
	workId: string;
}

function coerceString(value: unknown, fallback = ''): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return fallback;
}

function coerceNumber(value: unknown, fallback = 0): number {
	const numeric = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
	return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * The wire format is snake_case (wabidb domain records); accept camelCase as
 * well so a future backend rename does not silently blank ids and coords.
 */
function normalizeFeedback(raw: Record<string, unknown>): GalleryFeedback {
	return {
		feedbackId: coerceString(raw.feedbackId ?? raw.feedback_id),
		workId: coerceString(raw.workId ?? raw.work_id),
		channelId: coerceString(raw.channelId ?? raw.channel_id),
		authorUserId: coerceNumber(raw.authorUserId ?? raw.author_user_id),
		comment: coerceString(raw.comment),
		xPercent: coerceNumber(raw.xPercent ?? raw.x_percent),
		yPercent: coerceNumber(raw.yPercent ?? raw.y_percent),
		createdAtMicros: coerceNumber(raw.createdAtMicros ?? raw.created_at_micros),
		isDeleted: Boolean(raw.isDeleted ?? raw.is_deleted)
	};
}

function normalizeFeedbackList(data: unknown): GalleryFeedback[] {
	const rows = Array.isArray(data) ? data : (data as { feedback?: unknown })?.feedback;
	if (!Array.isArray(rows)) return [];
	return rows
		.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
		.map(normalizeFeedback);
}

/**
 * One lightbox instance owns one session: its own items/loading/error
 * stores, its own request generation, and its own disposal. Nothing is
 * shared across servers, accounts, channels, works, or mounted surfaces —
 * the module keeps no global cache.
 *
 * Every operation captures server/token/account/generation/channel/work up
 * front. Late completions apply only while the session is alive (same
 * server/account/generation; a same-account token refresh is tolerated) and
 * only to the view that requested them. Logout/re-login, account switches,
 * revocation, and disposal retire the scope instead of leaking results into
 * whatever is on screen next.
 */
export function createGalleryFeedbackSession(
	overrides?: Partial<GalleryFeedbackDeps>
): GalleryFeedbackSession {
	const deps: GalleryFeedbackDeps = { ...defaultDeps(), ...overrides };
	const feedbackItems = writable<GalleryFeedback[]>([]);
	const feedbackLoading = writable<boolean>(false);
	const feedbackError = writable<string | null>(null);

	let disposed = false;
	let retirement = 0;
	let ownedScope: CapturedScope | null = null;
	const retirementListeners = new Set<() => void>();
	let seq = 0;
	let currentKey: string | null = null;
	let loadedKey: string | null = null;

	function capture(channelId: string, workId: string): CapturedScope {
		const server = deps.server();
		const token = deps.token();
		return {
			server,
			token,
			subject: accountTokenSubject(token),
			account: deps.accountId(),
			generation: deps.generation(),
			retirement,
			channelId,
			workId
		};
	}

	function scopeKey(scope: CapturedScope): string {
		return JSON.stringify([scope.server, scope.account, scope.channelId, scope.workId]);
	}

	function sessionAlive(scope: CapturedScope): boolean {
		if (disposed || scope.retirement !== retirement) return false;
		if (deps.server() !== scope.server) return false;
		if (deps.generation() !== scope.generation) return false;
		if (deps.accountId() !== scope.account) return false;
		const now = deps.token();
		if (now === scope.token) return true;
		// A same-account access-token refresh mid-flight is recoverable work,
		// not a session change. Any subject change (or logout) retires it.
		if (!now || !scope.token) return false;
		const before = scope.subject;
		const after = accountTokenSubject(now);
		return before !== null && after !== null && before === after;
	}

	function retire(reason: string): void {
		retirement += 1;
		seq += 1;
		ownedScope = null;
		currentKey = null;
		loadedKey = null;
		feedbackItems.set([]);
		feedbackError.set(reason);
		feedbackLoading.set(false);
		for (const listener of retirementListeners) listener();
	}

	const unsubscribeContext = deps.onContextChanged(() => {
		if (!disposed) retire('Your context changed. Reload feedback.');
	});
	const unsubscribeRevoked = deps.onRevoked((event) => {
		if (!disposed && event.channelId === ownedScope?.channelId) {
			retire('Channel access changed. Reload feedback.');
		}
	});
	const unsubscribeSessionCleared = deps.onSessionCleared((clearedServer) => {
		if (disposed) return;
		if (clearedServer === (ownedScope?.server ?? deps.server())) {
			retire('Your session changed. Sign in to load feedback.');
		}
	});

	function feedbackUrl(scope: CapturedScope): string {
		return `${scope.server}/api/gallery/${encodeURIComponent(scope.channelId)}/works/${encodeURIComponent(scope.workId)}/feedback`;
	}

	function scopedHeaders(scope: CapturedScope, token: string | null): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {})
		};
	}

	async function requestFeedback(scope: CapturedScope, init?: RequestInit): Promise<Response> {
		if (!sessionAlive(scope)) throw new Error('Feedback session retired.');
		const first = await deps.fetchChannel(scope.channelId, feedbackUrl(scope), {
			...init,
			headers: scopedHeaders(scope, scope.token)
		});
		if (first.status !== 401) return first;
		// The transport already attempted its own refresh; one explicit retry
		// covers custom fetchChannel impls. Never loop: a second 401 means
		// re-authenticate, surfaced truthfully below.
		if (!sessionAlive(scope)) return first;
		let refreshed = false;
		try {
			refreshed = await deps.refresh(scope.server);
		} catch {
			refreshed = false;
		}
		if (!refreshed || disposed || !sessionAlive(scope)) return first;
		return deps.fetchChannel(scope.channelId, feedbackUrl(scope), {
			...init,
			headers: scopedHeaders(scope, deps.token())
		});
	}

	async function load(channelId: string, workId: string): Promise<void> {
		if (disposed) return;
		if (!channelId || !workId) return;
		const scope = capture(channelId, workId);
		ownedScope = scope;
		const key = scopeKey(scope);
		const my = ++seq;
		currentKey = key;
		if (!scope.token) {
			if (my !== seq || disposed) return;
			loadedKey = null;
			feedbackItems.set([]);
			feedbackError.set('Sign in to load feedback.');
			feedbackLoading.set(false);
			return;
		}
		feedbackLoading.set(true);
		feedbackError.set(null);
		// Clear synchronously so a previous scope's items never render under
		// the new key while its request is in flight.
		if (loadedKey !== key) feedbackItems.set([]);
		try {
			const res = await requestFeedback(scope);
			if (disposed || my !== seq || currentKey !== key) return;
			if (!sessionAlive(scope)) return;
			if (!res.ok) throw new Error(`Failed to load feedback (${res.status}).`);
			const data = await res.json().catch(() => null);
			if (disposed || my !== seq || currentKey !== key) return;
			if (!sessionAlive(scope)) return;
			feedbackItems.set(normalizeFeedbackList(data));
			loadedKey = key;
		} catch (err) {
			if (disposed || my !== seq || currentKey !== key) return;
			if (!sessionAlive(scope)) return;
			feedbackError.set(err instanceof Error ? err.message : 'Failed to load feedback.');
		} finally {
			if (!disposed && my === seq) feedbackLoading.set(false);
		}
	}

	async function add(
		channelId: string,
		workId: string,
		comment: string,
		xPercent: number,
		yPercent: number
	): Promise<string | null> {
		if (disposed || !channelId || !workId) return null;
		const scope = capture(channelId, workId);
		ownedScope = scope;
		const key = scopeKey(scope);
		if (!scope.token) {
			if (currentKey === null || currentKey === key) {
				feedbackError.set('Sign in to add feedback.');
			}
			return null;
		}
		try {
			const res = await requestFeedback(scope, {
				method: 'POST',
				body: JSON.stringify({ comment, xPercent, yPercent })
			});
			if (disposed || !sessionAlive(scope)) return null;
			if (!res.ok) throw new Error(`Failed to add feedback (${res.status}).`);
			const data = await res.json().catch(() => null);
			if (!sessionAlive(scope)) return null;
			const id =
				typeof (data as { feedbackId?: unknown } | null)?.feedbackId === 'string' &&
				((data as { feedbackId: string }).feedbackId.length > 0)
					? (data as { feedbackId: string }).feedbackId
					: null;
			// The follow-up reload belongs to the saving view only. If the
			// user navigated on, the new view's own load owns the list.
			if (currentKey === key) await load(channelId, workId);
			return sessionAlive(scope) ? id : null;
		} catch (err) {
			if (!disposed && sessionAlive(scope) && (currentKey === null || currentKey === key)) {
				feedbackError.set(err instanceof Error ? err.message : 'Failed to add feedback.');
			}
			return null;
		}
	}

	async function remove(channelId: string, workId: string, feedbackId: string): Promise<boolean> {
		if (disposed || !channelId || !workId || !feedbackId) return false;
		const scope = capture(channelId, workId);
		ownedScope = scope;
		const key = scopeKey(scope);
		if (!scope.token) {
			if (currentKey === null || currentKey === key) {
				feedbackError.set('Sign in to delete feedback.');
			}
			return false;
		}
		try {
			const first = await deps.fetchChannel(
				scope.channelId,
				`${feedbackUrl(scope)}/${encodeURIComponent(feedbackId)}`,
				{ method: 'DELETE', headers: scopedHeaders(scope, scope.token) }
			);
			if (disposed || !sessionAlive(scope)) return false;
			if (!first.ok) throw new Error(`Failed to delete feedback (${first.status}).`);
			if (currentKey === key) await load(channelId, workId);
			return true;
		} catch (err) {
			if (!disposed && sessionAlive(scope) && (currentKey === null || currentKey === key)) {
				feedbackError.set(err instanceof Error ? err.message : 'Failed to delete feedback.');
			}
			return false;
		}
	}

	function dispose(): void {
		if (disposed) return;
		retire('');
		disposed = true;
		retirementListeners.clear();
		unsubscribeContext();
		unsubscribeRevoked();
		try {
			unsubscribeSessionCleared();
		} catch {
			// Unsubscribe is best effort.
		}
	}

	return {
		feedbackItems,
		feedbackLoading,
		feedbackError,
		onRetired: (listener) => {
			retirementListeners.add(listener);
			return () => { retirementListeners.delete(listener); };
		},
		load,
		add,
		remove,
		dispose
	};
}
