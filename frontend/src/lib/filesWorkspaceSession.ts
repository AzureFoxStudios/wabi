import { writable, type Writable } from 'svelte/store';
import { getAuthToken, authSessionGeneration, onAuthSessionCleared, getStoredDbUserId } from './authSession';
import { getServerUrl } from './serverUrl';
import { accountTokenSubject } from './apiRequest';
import { groupMembership, captureGroupAccess } from './groupAccess';
import type { LoreRepo, LoreFileInfo } from './api/lore';
import { showToast } from './toast';

/**
 * Local copy of the lore channel-id parse (ch_{hex} → numeric) so bun tests
 * never load `$lib/api/lore` (which pulls socketConnection →
 * import.meta.glob, unavailable under bun). Behavior matches lore.ts.
 */
export function parseFilesChannelId(chId: string | null | undefined): number | null {
	if (!chId) return null;
	const match = chId.match(/^ch_([0-9a-fA-F]+)$/);
	if (!match) return null;
	const n = Number.parseInt(match[1], 16);
	return Number.isFinite(n) ? n : null;
}

/** A connected space plus the channel it hangs off. */
export interface SpaceRepo extends LoreRepo {
	channelKey: string;
	channelName: string;
}

export interface LoreChannelRef {
	id: string;
	name: string;
}

export type UploadStatus = 'pending' | 'uploading' | 'done' | 'error' | 'conflict' | 'cancelled';

export interface UploadJob {
	id: string;
	name: string;
	dest: string;
	status: UploadStatus;
	error?: string;
}

export interface SearchResult {
	channelId: number;
	channelName: string;
	path: string;
	size: number;
}

export type PreviewKind = 'image' | 'text' | 'other';

export interface FilesWorkspaceDeps {
	server: () => string;
	token: () => string | null;
	accountId: () => string | null;
	generation: () => number;
	getRepo: (token: string, channelId: number) => Promise<LoreRepo | null>;
	listFiles: (token: string, channelId: number) => Promise<LoreFileInfo[]>;
	downloadFile: (token: string, channelId: number, path: string) => Promise<Blob>;
	uploadFile: (
		token: string,
		channelId: number,
		dest: string,
		file: File | Blob
	) => Promise<{ pending_review?: boolean }>;
	notify: (message: string, kind: 'info' | 'error') => void;
	saveBlob: (blob: Blob, filename: string) => void;
	createObjectUrl: (blob: Blob) => string;
	revokeObjectUrl: (url: string) => void;
	captureAccess: (channelKey: string) => () => boolean;
	onSessionCleared: (listener: (server: string) => void) => () => void;
	onContextChanged: (listener: () => void) => () => void;
	onRevoked: (listener: (event: { channelId: string }) => void) => () => void;
}

export interface FilesWorkspaceSession {
	spaces: Writable<Record<number, SpaceRepo>>;
	spacesLoaded: Writable<boolean>;
	spacesError: Writable<string | null>;
	spacesWarning: Writable<string | null>;
	files: Writable<LoreFileInfo[]>;
	filesLoading: Writable<boolean>;
	filesError: Writable<string | null>;
	searchResults: Writable<SearchResult[]>;
	searchLoading: Writable<boolean>;
	searchError: Writable<string | null>;
	searchWarning: Writable<string | null>;
	previewPath: Writable<string | null>;
	previewName: Writable<string>;
	previewKind: Writable<PreviewKind>;
	previewUrl: Writable<string | null>;
	previewText: Writable<string | null>;
	previewInfo: Writable<LoreFileInfo | null>;
	previewLoading: Writable<boolean>;
	previewError: Writable<string | null>;
	uploadJobs: Writable<UploadJob[]>;
	onRetired: (listener: () => void) => () => void;
	loadSpaces: (refs: LoreChannelRef[]) => Promise<void>;
	loadFiles: (channelId: number) => Promise<void>;
	searchSpaces: (query: string, spaces: SpaceRepo[]) => Promise<void>;
	openPreview: (channelId: number, path: string, knownFiles?: LoreFileInfo[]) => Promise<void>;
	closePreview: () => void;
	download: (channelId: number, path: string) => Promise<boolean>;
	startUploads: (
		channelId: number,
		folder: string,
		fileList: Array<File | (Blob & { name: string })>,
		opts?: { readOnly?: boolean }
	) => Promise<void>;
	retryUpload: (jobId: string) => Promise<void>;
	dismissUpload: (jobId: string) => void;
	dismissCompleted: () => void;
	dispose: () => void;
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp']);
const TEXT_EXT = new Set([
	'txt', 'md', 'markdown', 'json', 'ts', 'tsx', 'js', 'jsx', 'rs', 'toml',
	'css', 'scss', 'html', 'htm', 'xml', 'yaml', 'yml', 'py', 'sh', 'bash',
	'csv', 'log', 'sql', 'ini', 'conf', 'env', 'gitignore'
]);

export const UPLOAD_CONCURRENCY = 3;

let jobCounter = 0;

/** Stable unique ids: repeated filenames/destinations must never collide as list keys. */
export function createUploadJobId(): string {
	jobCounter += 1;
	try {
		if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
			return `upload-${crypto.randomUUID()}`;
		}
	} catch {
		// Fall through to the counter fallback.
	}
	return `upload-${Date.now().toString(36)}-${jobCounter.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Pure builder so repeated names stay distinct and tests can assert key stability. */
export function buildUploadJobs(fileNames: string[], folder: string): UploadJob[] {
	return fileNames.map((name) => ({
		id: createUploadJobId(),
		name,
		dest: folder ? `${folder}/${name}` : name,
		status: 'pending' as const
	}));
}

export function summarizeUploads(jobs: UploadJob[]): { total: number; done: number; failed: number; pending: number } {
	let done = 0;
	let failed = 0;
	let pending = 0;
	for (const job of jobs) {
		if (job.status === 'done') done += 1;
		else if (job.status === 'error' || job.status === 'conflict' || job.status === 'cancelled') failed += 1;
		else pending += 1;
	}
	return { total: jobs.length, done, failed, pending };
}

/** The server rejects stale overwrites with 409 — surface it, never overwrite silently. */
export function isConflictError(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false;
	if ((err as { name?: unknown }).name === 'LoreConflictError') return true;
	const message = err instanceof Error ? err.message : String(err);
	return /409|conflict|changed on the server/i.test(message);
}

export function extOf(path: string): string {
	const idx = path.lastIndexOf('.');
	if (idx === -1) return '';
	return path.slice(idx + 1).toLowerCase();
}

export function classifyPreviewKind(path: string): PreviewKind {
	const ext = extOf(path);
	if (IMAGE_EXT.has(ext)) return 'image';
	if (TEXT_EXT.has(ext)) return 'text';
	return 'other';
}

export function previewNameOf(path: string): string {
	return path.split('/').pop() ?? path;
}

export function toFilesChannelKey(channelId: number): string {
	return `ch_${channelId.toString(16)}`;
}

function defaultAccountId(server: string): string | null {
	const stored = getStoredDbUserId(server);
	if (stored !== null) return String(stored);
	return accountTokenSubject(getAuthToken(server));
}

function defaultSaveBlob(blob: Blob, filename: string): void {
	if (typeof document === 'undefined') return;
	try {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => {
			try { URL.revokeObjectURL(url); } catch { /* best effort */ }
		}, 1500);
	} catch {
		// Download affordance is best effort outside a real DOM.
	}
}

function defaultDeps(): FilesWorkspaceDeps {
	// Lore API modules are loaded lazily so dependency-injected bun tests
	// never evaluate `$lib/api/lore` (socketConnection → import.meta.glob).
	const lazy = () => import('./api/lore');
	return {
		server: () => getServerUrl(),
		token: () => getAuthToken(),
		accountId: () => defaultAccountId(getServerUrl()),
		generation: () => authSessionGeneration(),
		getRepo: (token, channelId) => lazy().then((m) => m.getLoreRepo(token, channelId)),
		listFiles: (token, channelId) => lazy().then((m) => m.listLoreFiles(token, channelId)),
		downloadFile: (token, channelId, path) => lazy().then((m) => m.downloadLoreFile(token, channelId, path)),
		uploadFile: (token, channelId, dest, file) => lazy().then((m) => m.uploadLoreFile(token, channelId, dest, file)),
		notify: (message, kind) => {
			try { showToast(message, kind); } catch { /* tests inject their own */ }
		},
		saveBlob: defaultSaveBlob,
		createObjectUrl: (blob) => URL.createObjectURL(blob),
		revokeObjectUrl: (url) => {
			try { URL.revokeObjectURL(url); } catch { /* best effort */ }
		},
		captureAccess: (channelKey) => captureGroupAccess(channelKey),
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
	channelId: number | null;
}

function messageOf(err: unknown, fallback: string): string {
	return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * One mounted Files workspace owns one session: its own spaces/files/search/
 * preview/upload stores, its own request generations, and its own disposal.
 * The module keeps no global cache, so two mounted instances never share
 * mutable state.
 *
 * Every async operation captures server/token/account/generation/retirement
 * (plus the channel it belongs to) before the first await, then re-checks
 * between continuations with the existing context primitives
 * (authSessionGeneration/accountTokenSubject/captureGroupAccess via deps).
 * Late completions apply only while the session is alive (same
 * server/account/generation; a same-account token refresh is tolerated) and
 * only to the view that requested them (per-operation seq + key guards stop
 * A-B-A resurrection). Logout, account/server switches, membership
 * revocation, preview close, and disposal retire the scope instead of leaking
 * results into whatever is on screen next.
 */
export function createFilesWorkspaceSession(overrides?: Partial<FilesWorkspaceDeps>): FilesWorkspaceSession {
	const deps: FilesWorkspaceDeps = { ...defaultDeps(), ...overrides };

	const spaces = writable<Record<number, SpaceRepo>>({});
	const spacesLoaded = writable<boolean>(false);
	const spacesError = writable<string | null>(null);
	const spacesWarning = writable<string | null>(null);
	const files = writable<LoreFileInfo[]>([]);
	const filesLoading = writable<boolean>(false);
	const filesError = writable<string | null>(null);
	const searchResults = writable<SearchResult[]>([]);
	const searchLoading = writable<boolean>(false);
	const searchError = writable<string | null>(null);
	const searchWarning = writable<string | null>(null);
	const previewPath = writable<string | null>(null);
	const previewName = writable<string>('');
	const previewKind = writable<PreviewKind>('other');
	const previewUrl = writable<string | null>(null);
	const previewText = writable<string | null>(null);
	const previewInfo = writable<LoreFileInfo | null>(null);
	const previewLoading = writable<boolean>(false);
	const previewError = writable<string | null>(null);
	const uploadJobs = writable<UploadJob[]>([]);

	let disposed = false;
	let retirement = 0;
	let spacesSeq = 0;
	let filesSeq = 0;
	let searchSeq = 0;
	let previewSeq = 0;
	let uploadBatch = 0;
	let currentFilesKey: string | null = null;
	let loadedFilesKey: string | null = null;
	let currentSearchKey: string | null = null;
	let loadedSearchKey: string | null = null;
	let currentPreviewKey: string | null = null;
	let ownedFilesChannel: number | null = null;
	let ownedPreviewChannel: number | null = null;
	let lastServer: string | null = null;
	let activePreviewUrl: string | null = null;
	const retirementListeners = new Set<() => void>();
	const uploadPayloads = new Map<string, { channelId: number; file: File | Blob }>();
	let lastSpaceRefs: LoreChannelRef[] = [];

	function capture(channelId: number | null): CapturedScope {
		const server = deps.server();
		const token = deps.token();
		return {
			server,
			token,
			subject: accountTokenSubject(token),
			account: deps.accountId(),
			generation: deps.generation(),
			retirement,
			channelId
		};
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

	function filesKeyFor(scope: CapturedScope, channelId: number): string {
		return JSON.stringify([scope.server, scope.account, channelId]);
	}

	function revokeActivePreviewUrl(): void {
		if (activePreviewUrl) {
			try { deps.revokeObjectUrl(activePreviewUrl); } catch { /* best effort */ }
			activePreviewUrl = null;
		}
	}

	function clearPreviewStores(): void {
		revokeActivePreviewUrl();
		previewPath.set(null);
		previewName.set('');
		previewKind.set('other');
		previewUrl.set(null);
		previewText.set(null);
		previewInfo.set(null);
		previewLoading.set(false);
		previewError.set(null);
	}

	function cancelUploadsFor(prefix: 'all' | number): void {
		uploadBatch += 1;
		uploadJobs.update((all) =>
			all.map((job) => {
				const payload = uploadPayloads.get(job.id);
				const matches =
					prefix === 'all' || (payload !== undefined && payload.channelId === prefix);
				if (!matches) return job;
				if (job.status !== 'pending' && job.status !== 'uploading') return job;
				return { ...job, status: 'cancelled' as const, error: 'Session changed before upload started — retry to upload again.' };
			})
		);
	}

	function retireAll(reason: string): void {
		retirement += 1;
		spacesSeq += 1;
		filesSeq += 1;
		searchSeq += 1;
		previewSeq += 1;
		currentFilesKey = null;
		loadedFilesKey = null;
		currentSearchKey = null;
		loadedSearchKey = null;
		currentPreviewKey = null;
		ownedFilesChannel = null;
		ownedPreviewChannel = null;
		revokeActivePreviewUrl();
		spaces.set({});
		spacesLoaded.set(true);
		spacesError.set(reason || null);
		spacesWarning.set(null);
		files.set([]);
		filesLoading.set(false);
		filesError.set(reason || null);
		searchResults.set([]);
		searchLoading.set(false);
		searchError.set(reason || null);
		searchWarning.set(null);
		clearPreviewStores();
		if (reason) previewError.set(reason);
		// Queued uploads stop; already-issued requests are fenced at completion
		// (no mutation, toast, or download into the new scope). Completed and
		// failed counts stay until the user explicitly dismisses them.
		uploadJobs.update((all) =>
			all.map((job) =>
				job.status === 'pending' || job.status === 'uploading'
					? { ...job, status: 'cancelled' as const, error: 'Session changed before upload finished — retry to upload again.' }
					: job
			)
		);
		uploadBatch += 1;
		for (const listener of retirementListeners) {
			try { listener(); } catch { /* best effort */ }
		}
	}

	function retireChannel(channelKey: string, numeric: number | null): void {
		let touched = false;
		spaces.update((all) => {
			if (numeric !== null && all[numeric]) {
				const next = { ...all };
				delete next[numeric];
				touched = true;
				return next;
			}
			return all;
		});
		if (ownedFilesChannel !== null && (ownedFilesChannel === numeric || toFilesChannelKey(ownedFilesChannel) === channelKey)) {
			filesSeq += 1;
			currentFilesKey = null;
			ownedFilesChannel = null;
			files.set([]);
			filesLoading.set(false);
			filesError.set('Channel access changed. Reload files.');
			touched = true;
		}
		if (ownedPreviewChannel !== null && (ownedPreviewChannel === numeric || toFilesChannelKey(ownedPreviewChannel) === channelKey)) {
			previewSeq += 1;
			currentPreviewKey = null;
			ownedPreviewChannel = null;
			clearPreviewStores();
			previewError.set('Channel access changed. Reload files.');
			touched = true;
		}
		if (numeric !== null) cancelUploadsFor(numeric);
		if (touched) {
			for (const listener of retirementListeners) {
				try { listener(); } catch { /* best effort */ }
			}
		}
	}

	const unsubscribeContext = deps.onContextChanged(() => {
		if (!disposed) retireAll('Your context changed. Reload files.');
	});
	const unsubscribeRevoked = deps.onRevoked((event) => {
		if (disposed) return;
		const numeric = /^ch_[0-9a-fA-F]+$/.test(event.channelId) ? parseFilesChannelId(event.channelId) : null;
		retireChannel(event.channelId, numeric);
	});
	const unsubscribeSessionCleared = deps.onSessionCleared((clearedServer) => {
		if (disposed) return;
		if (clearedServer === (lastServer ?? deps.server())) {
			retireAll('Your session changed. Sign in to load files.');
		}
	});

	async function loadSpaces(refs: LoreChannelRef[]): Promise<void> {
		if (disposed) return;
		lastSpaceRefs = [...refs];
		const scope = capture(null);
		lastServer = scope.server;
		const my = ++spacesSeq;
		if (!scope.token) {
			if (disposed || my !== spacesSeq) return;
			spaces.set({});
			spacesLoaded.set(true);
			spacesError.set('Sign in to load spaces.');
			spacesWarning.set(null);
			return;
		}
		spacesLoaded.set(false);
		spacesError.set(null);
		spacesWarning.set(null);
		const found: Record<number, SpaceRepo> = {};
		const failures: string[] = [];
		for (const ref of refs) {
			const numeric = parseFilesChannelId(ref.id);
			if (numeric === null) continue;
			let hasAccess: () => boolean;
			try {
				hasAccess = deps.captureAccess(ref.id);
			} catch (err) {
				failures.push(`${ref.name}: ${messageOf(err, 'Channel unavailable')}`);
				continue;
			}
			try {
				const info = await deps.getRepo(scope.token, numeric);
				if (disposed || my !== spacesSeq) return;
				if (!sessionAlive(scope)) return;
				if (!hasAccess()) continue;
				// Null means absent repo (404) — not an error, just no space here.
				if (info) found[numeric] = { ...info, channelKey: ref.id, channelName: ref.name };
			} catch (err) {
				if (disposed || my !== spacesSeq) return;
				if (!sessionAlive(scope)) return;
				if (!hasAccess()) continue;
				failures.push(`${ref.name}: ${messageOf(err, 'Failed to load space')}`);
			}
		}
		if (disposed || my !== spacesSeq) return;
		if (!sessionAlive(scope)) return;
		spaces.set(found);
		spacesLoaded.set(true);
		const names = Object.keys(found).length;
		if (names === 0 && failures.length === 0) {
			spacesError.set(null);
			spacesWarning.set(null);
		} else if (names === 0) {
			spacesError.set(`Could not load spaces: ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ''}`);
			spacesWarning.set(null);
		} else if (failures.length > 0) {
			spacesError.set(null);
			spacesWarning.set(`Loaded ${names} space${names === 1 ? '' : 's'}, ${failures.length} unavailable: ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ''}`);
		} else {
			spacesError.set(null);
			spacesWarning.set(null);
		}
	}

	async function loadFiles(channelId: number): Promise<void> {
		if (disposed) return;
		const channelKey = toFilesChannelKey(channelId);
		const scope = capture(channelId);
		lastServer = scope.server;
		const key = filesKeyFor(scope, channelId);
		const my = ++filesSeq;
		currentFilesKey = key;
		ownedFilesChannel = channelId;
		if (!scope.token) {
			if (disposed || my !== filesSeq || currentFilesKey !== key) return;
			loadedFilesKey = null;
			files.set([]);
			filesError.set('Sign in to load files.');
			filesLoading.set(false);
			return;
		}
		let hasAccess: () => boolean;
		try {
			hasAccess = deps.captureAccess(channelKey);
		} catch (err) {
			if (disposed || my !== filesSeq || currentFilesKey !== key) return;
			loadedFilesKey = null;
			files.set([]);
			filesError.set(messageOf(err, 'Channel unavailable.'));
			filesLoading.set(false);
			return;
		}
		filesLoading.set(true);
		filesError.set(null);
		// Clear synchronously so the previous scope never renders under the new key.
		if (loadedFilesKey !== key) files.set([]);
		try {
			const entries = await deps.listFiles(scope.token, channelId);
			if (disposed || my !== filesSeq || currentFilesKey !== key) return;
			if (!sessionAlive(scope) || !hasAccess()) return;
			files.set(entries ?? []);
			loadedFilesKey = key;
		} catch (err) {
			if (disposed || my !== filesSeq || currentFilesKey !== key) return;
			if (!sessionAlive(scope) || !hasAccess()) return;
			loadedFilesKey = null;
			files.set([]);
			filesError.set(messageOf(err, 'Failed to load files'));
		} finally {
			if (!disposed && my === filesSeq && currentFilesKey === key) filesLoading.set(false);
		}
	}

	async function searchSpaces(query: string, spaceList: SpaceRepo[]): Promise<void> {
		if (disposed) return;
		const scope = capture(null);
		lastServer = scope.server;
		const q = query.trim().toLowerCase();
		const key = JSON.stringify([scope.server, scope.account, q]);
		const my = ++searchSeq;
		currentSearchKey = key;
		if (!q) {
			if (disposed || my !== searchSeq) return;
			loadedSearchKey = null;
			searchResults.set([]);
			searchError.set(null);
			searchWarning.set(null);
			searchLoading.set(false);
			return;
		}
		if (!scope.token) {
			if (disposed || my !== searchSeq || currentSearchKey !== key) return;
			loadedSearchKey = null;
			searchResults.set([]);
			searchError.set('Sign in to search files.');
			searchWarning.set(null);
			searchLoading.set(false);
			return;
		}
		searchLoading.set(true);
		searchError.set(null);
		searchWarning.set(null);
		if (loadedSearchKey !== key) searchResults.set([]);
		const acc: SearchResult[] = [];
		const failures: string[] = [];
		try {
			for (const space of spaceList) {
				let hasAccess: () => boolean;
				try {
					hasAccess = deps.captureAccess(space.channelKey);
				} catch (err) {
					failures.push(`${space.channelName}: ${messageOf(err, 'Channel unavailable')}`);
					continue;
				}
				try {
					const entries = await deps.listFiles(scope.token, space.channelId);
					if (disposed || my !== searchSeq || currentSearchKey !== key) return;
					if (!sessionAlive(scope)) return;
					if (!hasAccess()) {
						failures.push(`${space.channelName}: access changed during search`);
						continue;
					}
					for (const file of entries ?? []) {
						if (file.path.toLowerCase().includes(q)) {
							acc.push({ channelId: space.channelId, channelName: space.channelName, path: file.path, size: file.size });
						}
					}
				} catch (err) {
					if (disposed || my !== searchSeq || currentSearchKey !== key) return;
					if (!sessionAlive(scope)) return;
					failures.push(`${space.channelName}: ${messageOf(err, 'Search failed')}`);
				}
				if (acc.length >= 100) break;
			}
		} catch (err) {
			if (disposed || my !== searchSeq || currentSearchKey !== key) return;
			if (!sessionAlive(scope)) return;
			loadedSearchKey = null;
			searchResults.set(acc.slice(0, 100));
			searchError.set(messageOf(err, 'Search failed'));
			searchLoading.set(false);
			return;
		}
		if (disposed || my !== searchSeq || currentSearchKey !== key) return;
		if (!sessionAlive(scope)) return;
		searchResults.set(acc.slice(0, 100));
		loadedSearchKey = key;
		if (acc.length === 0 && failures.length === 0) {
			searchError.set(null);
			searchWarning.set(null);
		} else if (acc.length === 0) {
			searchError.set(`Search failed: ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ''}`);
			searchWarning.set(null);
		} else if (failures.length > 0) {
			searchError.set(null);
			searchWarning.set(`Partial results — ${failures.length} space${failures.length === 1 ? '' : 's'} unavailable: ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ''}`);
		} else {
			searchError.set(null);
			searchWarning.set(null);
		}
		searchLoading.set(false);
	}

	async function openPreview(channelId: number, path: string, knownFiles?: LoreFileInfo[]): Promise<void> {
		if (disposed) return;
		const channelKey = toFilesChannelKey(channelId);
		const scope = capture(channelId);
		lastServer = scope.server;
		const key = JSON.stringify([scope.server, scope.account, channelId, path]);
		const my = ++previewSeq;
		currentPreviewKey = key;
		ownedPreviewChannel = channelId;
		revokeActivePreviewUrl();
		const info = (knownFiles ?? []).find((f) => f.path === path) ?? null;
		const kind = classifyPreviewKind(path);
		previewPath.set(path);
		previewName.set(previewNameOf(path));
		previewKind.set(kind);
		previewUrl.set(null);
		previewText.set(null);
		previewInfo.set(info);
		previewError.set(null);
		previewLoading.set(true);
		if (!scope.token) {
			if (disposed || my !== previewSeq || currentPreviewKey !== key) return;
			previewError.set('Sign in to preview files.');
			previewLoading.set(false);
			return;
		}
		let hasAccess: () => boolean;
		try {
			hasAccess = deps.captureAccess(channelKey);
		} catch (err) {
			if (disposed || my !== previewSeq || currentPreviewKey !== key) return;
			previewError.set(messageOf(err, 'Channel unavailable.'));
			previewLoading.set(false);
			return;
		}
		try {
			const blob = await deps.downloadFile(scope.token, channelId, path);
			if (disposed || my !== previewSeq || currentPreviewKey !== key) return;
			if (!sessionAlive(scope) || !hasAccess()) return;
			if (kind === 'image') {
				const url = deps.createObjectUrl(blob);
				if (disposed || my !== previewSeq || currentPreviewKey !== key) {
					try { deps.revokeObjectUrl(url); } catch { /* best effort */ }
					return;
				}
				if (!sessionAlive(scope) || !hasAccess()) {
					try { deps.revokeObjectUrl(url); } catch { /* best effort */ }
					return;
				}
				activePreviewUrl = url;
				previewUrl.set(url);
			} else if (kind === 'text') {
				const text = await blob.text();
				if (disposed || my !== previewSeq || currentPreviewKey !== key) return;
				if (!sessionAlive(scope) || !hasAccess()) return;
				previewText.set(text);
			}
		} catch (err) {
			if (disposed || my !== previewSeq || currentPreviewKey !== key) return;
			if (!sessionAlive(scope) || !hasAccess()) return;
			previewKind.set('other');
			const message = messageOf(err, 'Could not preview file');
			previewError.set(message);
			deps.notify(message, 'error');
		} finally {
			if (!disposed && my === previewSeq && currentPreviewKey === key) previewLoading.set(false);
		}
	}

	function closePreview(): void {
		// Invalidate any pending preview completion (close wins over late bytes).
		previewSeq += 1;
		currentPreviewKey = null;
		ownedPreviewChannel = null;
		clearPreviewStores();
	}

	async function download(channelId: number, path: string): Promise<boolean> {
		if (disposed) return false;
		const channelKey = toFilesChannelKey(channelId);
		const scope = capture(channelId);
		lastServer = scope.server;
		if (!scope.token) {
			deps.notify('Sign in to download files.', 'error');
			return false;
		}
		let hasAccess: () => boolean;
		try {
			hasAccess = deps.captureAccess(channelKey);
		} catch (err) {
			deps.notify(messageOf(err, 'Channel unavailable.'), 'error');
			return false;
		}
		try {
			const blob = await deps.downloadFile(scope.token, channelId, path);
			// An already-issued request may complete after retirement, but it
			// must not download/toast into the new scope.
			if (disposed || !sessionAlive(scope) || !hasAccess()) return false;
			deps.saveBlob(blob, previewNameOf(path));
			return true;
		} catch (err) {
			if (disposed || !sessionAlive(scope) || !hasAccess()) return false;
			deps.notify(messageOf(err, 'Download failed'), 'error');
			return false;
		}
	}

	async function runUploadJob(
		job: UploadJob,
		channelId: number,
		scope: CapturedScope,
		hasAccess: () => boolean,
		batch: number | null,
		payload: File | Blob
	): Promise<void> {
		uploadJobs.update((all) => all.map((j) => (j.id === job.id ? { ...j, status: 'uploading' as const } : j)));
		try {
			const result = await deps.uploadFile(scope.token as string, channelId, job.dest, payload);
			if (disposed) return;
			if (batch !== null && batch !== uploadBatch) return;
			if (!sessionAlive(scope) || !hasAccess()) return;
			uploadJobs.update((all) => all.map((j) => (j.id === job.id ? { ...j, status: 'done' as const, error: undefined } : j)));
			uploadPayloads.delete(job.id);
			if (result?.pending_review) deps.notify(`${job.name} saved — waiting for team review`, 'info');
		} catch (err) {
			if (disposed) return;
			if (batch !== null && batch !== uploadBatch) return;
			if (!sessionAlive(scope) || !hasAccess()) return;
			if (isConflictError(err)) {
				uploadJobs.update((all) =>
					all.map((j) =>
						j.id === job.id
							? { ...j, status: 'conflict' as const, error: 'File changed on the server since you loaded it — kept the server copy. Rename and retry.' }
							: j
					)
				);
				deps.notify(`${job.name}: file changed on server — kept the server copy`, 'error');
			} else {
				const message = messageOf(err, 'Upload failed');
				uploadJobs.update((all) =>
					all.map((j) => (j.id === job.id ? { ...j, status: 'error' as const, error: message } : j))
				);
				deps.notify(`${job.name}: ${message}`, 'error');
			}
		}
	}

	async function startUploads(
		channelId: number,
		folder: string,
		fileList: Array<File | (Blob & { name: string })>,
		opts?: { readOnly?: boolean }
	): Promise<void> {
		if (disposed) return;
		// Mirror spaces are read-only views of an upstream source — no uploads.
		if (opts?.readOnly) return;
		if (!fileList.length) return;
		const channelKey = toFilesChannelKey(channelId);
		const scope = capture(channelId);
		lastServer = scope.server;
		if (!scope.token) {
			deps.notify('Sign in to upload files.', 'error');
			return;
		}
		let hasAccess: () => boolean;
		try {
			hasAccess = deps.captureAccess(channelKey);
		} catch (err) {
			deps.notify(messageOf(err, 'Channel unavailable.'), 'error');
			return;
		}
		const batch = ++uploadBatch;
		const jobs: UploadJob[] = fileList.map((file) => {
			const name = (file as { name?: unknown }).name;
			const safeName = typeof name === 'string' && name ? name : 'upload';
			return {
				id: createUploadJobId(),
				name: safeName,
				dest: folder ? `${folder}/${safeName}` : safeName,
				status: 'pending' as const
			};
		});
		fileList.forEach((file, index) => {
			uploadPayloads.set(jobs[index].id, { channelId, file });
		});
		uploadJobs.update((all) => [...all, ...jobs]);
		let cursor = 0;
		async function worker(): Promise<void> {
			while (true) {
				if (disposed || batch !== uploadBatch || !sessionAlive(scope) || !hasAccess()) break;
				const index = cursor++;
				if (index >= jobs.length) break;
				const job = jobs[index];
				const payload = uploadPayloads.get(job.id);
				if (!payload) continue;
				await runUploadJob(job, channelId, scope, hasAccess, batch, payload.file);
			}
		}
		await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, jobs.length) }, worker));
		if (disposed || batch !== uploadBatch || !sessionAlive(scope) || !hasAccess()) return;
		// Keep the existing server contract: refresh the listing after a batch.
		// This is a user-initiated reload of the same scope, not background sync.
		await loadFiles(channelId);
		// Errors and conflicts are retained for explicit retry/dismiss — never
		// auto-pruned. The job list (and its acknowledged counts) survives
		// until the user dismisses it.
	}

	async function retryUpload(jobId: string): Promise<void> {
		if (disposed) return;
		const payload = uploadPayloads.get(jobId);
		if (!payload) return;
		const channelKey = toFilesChannelKey(payload.channelId);
		const scope = capture(payload.channelId);
		lastServer = scope.server;
		if (!scope.token) {
			deps.notify('Sign in to upload files.', 'error');
			return;
		}
		let hasAccess: () => boolean;
		try {
			hasAccess = deps.captureAccess(channelKey);
		} catch (err) {
			deps.notify(messageOf(err, 'Channel unavailable.'), 'error');
			return;
		}
		uploadJobs.update((all) =>
			all.map((j) => (j.id === jobId ? { ...j, status: 'pending' as const, error: undefined } : j))
		);
		let current: UploadJob | undefined;
		uploadJobs.subscribe((all) => {
			current = all.find((j) => j.id === jobId);
		})();
		if (!current) return;
		// Explicit retry owns a fresh scope; retirement checks still fence it.
		await runUploadJob(current, payload.channelId, scope, hasAccess, null, payload.file);
	}

	function dismissUpload(jobId: string): void {
		uploadPayloads.delete(jobId);
		uploadJobs.update((all) => all.filter((j) => j.id !== jobId));
	}

	function dismissCompleted(): void {
		uploadJobs.update((all) => {
			const keep = all.filter((j) => j.status !== 'done');
			const removed = all.filter((j) => j.status === 'done');
			for (const job of removed) uploadPayloads.delete(job.id);
			return keep;
		});
	}

	function dispose(): void {
		if (disposed) return;
		retireAll('');
		disposed = true;
		retirementListeners.clear();
		uploadPayloads.clear();
		try { unsubscribeContext(); } catch { /* best effort */ }
		try { unsubscribeRevoked(); } catch { /* best effort */ }
		try { unsubscribeSessionCleared(); } catch { /* best effort */ }
	}

	return {
		spaces,
		spacesLoaded,
		spacesError,
		spacesWarning,
		files,
		filesLoading,
		filesError,
		searchResults,
		searchLoading,
		searchError,
		searchWarning,
		previewPath,
		previewName,
		previewKind,
		previewUrl,
		previewText,
		previewInfo,
		previewLoading,
		previewError,
		uploadJobs,
		onRetired: (listener) => {
			retirementListeners.add(listener);
			return () => {
				retirementListeners.delete(listener);
			};
		},
		loadSpaces,
		loadFiles,
		searchSpaces,
		openPreview,
		closePreview,
		download,
		startUploads,
		retryUpload,
		dismissUpload,
		dismissCompleted,
		dispose
	};
}
