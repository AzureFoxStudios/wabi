import { getApiBase, fetchWithTimeout } from './utils';

export interface LoreRepo {
	channelId: number;
	repoName: string;
	createdBy: number;
	createdAt: number;
	/** 'native' (default) or { mirror: { upstream_url } } for read-only mirrors. Optional for backwards compat. */
	class?: 'native' | 'imported' | 'mirror' | { mirror?: { upstream_url?: string } } | null;
	/** When true, uploads land on an uploads/* review line and need approval to become official. */
	auto_branch_on_upload?: boolean;
	/** Source URL retained when files were imported from Git. */
	imported_from?: string | null;
}

/** Error thrown by lore API helpers — carries the HTTP status for callers to branch on. */
function normalizeRepoClass(raw: unknown): LoreRepo['class'] {
	const strCls = typeof raw === 'string' ? raw : undefined;
	const objCls = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
	if (strCls === 'native' || strCls === 'imported' || strCls === 'mirror') return strCls;
	if (objCls?.type === 'native') return 'native';
	if (objCls?.type === 'imported') return 'imported';
	if (objCls?.type === 'mirror' || objCls?.mirror || objCls?.upstream_url) {
		const mirror = objCls.mirror as { upstream_url?: string } | undefined;
		return { mirror: { upstream_url: mirror?.upstream_url ?? (typeof objCls.upstream_url === 'string' ? objCls.upstream_url : undefined) } };
	}
	return 'native';
}

function normalizeLoreRepo(raw: any): LoreRepo {
	return {
		channelId: raw.channelId ?? raw.channel_id,
		repoName: raw.repoName ?? raw.repo_name ?? 'Unnamed repository',
		createdBy: raw.createdBy ?? raw.created_by,
		createdAt: raw.createdAt ?? raw.created_at,
		class: normalizeRepoClass(raw.class ?? raw.repo_class ?? raw.type),
		auto_branch_on_upload: raw.auto_branch_on_upload ?? raw.autoBranchOnUpload ?? false,
		imported_from: raw.imported_from ?? raw.importedFrom ?? null
	};
}

export function loreError(message: string, status: number): Error {
	const err = new Error(message);
	(err as any).status = status;
	return err;
}

/** Connect-flow errors: map the statuses users actually hit to readable copy. */
function loreConnectError(message: string, status: number): Error {
	if (status === 409) {
		return loreError('A space with this name already exists here — try a different name.', status);
	}
	if (status === 502) {
		return loreError('The version service could not be reached — try again in a moment.', status);
	}
	return loreError(message, status);
}

export interface LoreFileInfo {
	path: string;
	size: number;
	/** Legacy fields — the addon actually serves status/etag today. */
	modifiedAt?: number;
	lockedBy?: number | null;
	/** Working-tree status reported by `lore status --scan`. */
	status?: string;
	/** Content etag (SHA-256 or sampled) for optimistic concurrency. */
	etag?: string | null;
}

export interface LoreRevision {
	hash: string;
	message: string;
	authorId: number;
	timestamp: number;
}

export interface LoreBranch {
	name: string;
}

export function loreUrl(path: string): string {
	// Server mounts lore under /api/addons/lore (main.rs nest /api + addons nest)
	return `${getApiBase()}/api/addons/lore${path}`;
}

/**
 * Parse a Wabi channel id string (`ch_{hex}`) into the numeric i64 the Lore
 * API path expects. Server assigns ids as format!("ch_{:x}", commit_seq).
 * Accepts plain decimal digits too for safety.
 */
export function parseLoreChannelId(chId: string | null | undefined): number | null {
	if (!chId) return null;
	const match = chId.match(/^ch_([0-9a-fA-F]+)$/);
	if (!match) return null;
	const n = Number.parseInt(match[1], 16);
	return Number.isFinite(n) ? n : null;
}

/** Authenticated media URL builder (L3). Prefer blob previews (L5) for <img>/<video>. */
export function loreFileUrl(channelId: number, path: string, revision?: string): string {
	const params = new URLSearchParams();
	if (revision) params.set('revision', revision);
	const qs = params.toString();
	const base = loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}`);
	return qs ? `${base}?${qs}` : base;
}

export async function getLoreRepo(token: string, channelId: number): Promise<LoreRepo | null> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}`), {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (res.status === 404) return null;
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to get lore repo');
	}
	return normalizeLoreRepo(await res.json());
}

export async function createLoreRepo(
	token: string,
	channelId: number,
	repoName: string,
	opts?: { auto_branch_on_upload?: boolean }
): Promise<LoreRepo> {
	const res = await fetchWithTimeout(loreUrl('/repos'), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			channelId,
			repoName,
			auto_branch_on_upload: opts?.auto_branch_on_upload === true
		})
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw loreConnectError((err as any).error || 'Failed to create space', res.status);
	}
	return normalizeLoreRepo(await res.json());
}

/**
 * Download the whole repo as a zip ("Download project"). The server builds
 * the archive from the same listing the file tree shows, so ignore rules
 * match. Saves via a blob anchor using the server's Content-Disposition name.
 */
export async function downloadLoreProject(token: string, channelId: number): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/archive`), {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw loreError((err as any).error || 'Failed to download project', res.status);
	}
	const disposition = res.headers.get('Content-Disposition') ?? '';
	const match = disposition.match(/filename="?([^";]+)"?/);
	const blob = await res.blob();
	const objectUrl = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = objectUrl;
	a.download = match?.[1] ?? `lore-${channelId}.zip`;
	a.click();
	URL.revokeObjectURL(objectUrl);
}

/** Link an EXISTING space on the local Lore server to a channel (clone, not create). */
export async function linkLoreRepo(
	token: string,
	channelId: number,
	repoName: string
): Promise<LoreRepo> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/link`), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ channelId, repoName })
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw loreConnectError((err as any).error || 'Failed to link existing space', res.status);
	}
	return normalizeLoreRepo(await res.json());
}

/**
 * Remove a space binding. `mode='detach'` unlinks the channel but keeps the
 * working tree + history on the server (re-linkable); `mode='delete'` wipes
 * every byte permanently.
 */
export async function deleteLoreRepo(
	token: string,
	channelId: number,
	mode: 'detach' | 'delete' = 'delete'
): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}?mode=${mode}`), {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to delete lore repo');
	}
}

/** Update channel-repo workflow settings. */
export async function updateLoreRepoSettings(
	token: string,
	channelId: number,
	settings: { auto_branch_on_upload?: boolean }
): Promise<LoreRepo> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}`), {
		method: 'PATCH',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(settings)
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw loreError((err as any).error || 'Failed to update repository settings', res.status);
	}
	return normalizeLoreRepo(await res.json());
}

export interface LoreUploadResult {
	revision: LoreRevision;
	file: LoreFileInfo;
	/** Content etag of the uploaded version (If-Match baseline for future saves). */
	etag?: string;
	/** Change-feed cursor after this write (wabi-sync advances over this). */
	cursor?: number;
	/** False when the WDB event write failed (the lore write itself succeeded). */
	wdbRecorded?: boolean;
	/** Set when auto_branch_on_upload routed the upload into an uploads/* review line. */
	pending_review?: boolean;
	review_branch?: string;
}

export async function uploadLoreFile(
	token: string,
	channelId: number,
	path: string,
	file: File | Blob | string,
	message?: string,
	ifMatch?: string | null
): Promise<LoreUploadResult> {
	const params = new URLSearchParams();
	if (message) params.set('message', message);
	if (typeof file !== 'string' && path) params.set('repo_path', path);
	const url = `${loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}`)}?${params.toString()}`;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/octet-stream'
	};
	if (ifMatch !== undefined) headers['If-Match'] = ifMatch === null ? '""' : `"${ifMatch}"`;
	const res = await fetchWithTimeout(url, {
		method: 'PUT',
		headers,
		body: typeof file === 'string' ? file : await file.arrayBuffer()
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		if (res.status === 409) throw new LoreConflictError((err as any).currentEtag ?? null);
		throw new Error((err as any).error || 'Failed to upload file');
	}
	return (await res.json()) as LoreUploadResult;
}

/**
 * Attach an external source (GitHub/GitLab) as a read-only mirror of this
 * space. History stays at the source.
 */
export async function linkLoreExternalRepo(
	token: string,
	channelId: number,
	upstreamUrl: string,
	name: string
): Promise<LoreRepo> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/external`), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ upstream_url: upstreamUrl, name })
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw loreConnectError(
			(err as any).error || 'Failed to link external space',
			res.status
		);
	}
	return normalizeLoreRepo(await res.json());
}

/**
 * Import an external source into Wabi as a native space — files come over,
 * history starts fresh.
 */
export async function importLoreRepo(
	token: string,
	channelId: number,
	upstreamUrl: string,
	name: string
): Promise<LoreRepo> {
	const res = await fetchWithTimeout(loreUrl('/repos/import'), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ channel_id: channelId, upstream_url: upstreamUrl, name })
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw loreConnectError(
			(err as any).error || 'Failed to import external space',
			res.status
		);
	}
	return normalizeLoreRepo(await res.json());
}

/** Approve or reject an uploads/* line awaiting review. */
export async function reviewLoreBranch(
	token: string,
	channelId: number,
	branchName: string,
	decision: 'approve' | 'reject'
): Promise<void> {
	const res = await fetchWithTimeout(
		loreUrl(`/repos/${channelId}/review/${encodeURIComponent(branchName)}/${decision}`),
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` }
		}
	);
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw loreError(
			(err as any).error || 'Failed to update review',
			res.status
		);
	}
}

export async function listLoreFiles(token: string, channelId: number, prefix?: string): Promise<LoreFileInfo[]> {
	const params = new URLSearchParams();
	if (prefix) params.set('prefix', prefix);
	const url = `${loreUrl(`/repos/${channelId}/files`)}?${params.toString()}`;
	const res = await fetchWithTimeout(url, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to list files');
	}
	return (await res.json()) as LoreFileInfo[];
}

export async function downloadLoreFile(
	token: string,
	channelId: number,
	path: string,
	revision?: string
): Promise<Blob> {
	const params = new URLSearchParams();
	if (revision) params.set('revision', revision);
	const url = `${loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}`)}?${params.toString()}`;
	const res = await fetchWithTimeout(url, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to download file');
	}
	return await res.blob();
}

export async function getSignedLoreUrl(
	token: string,
	channelId: number,
	path: string,
	revision?: string,
	expires?: number
): Promise<string> {
	const params = new URLSearchParams({ path });
	if (revision) params.set('revision', revision);
	if (expires) params.set('expires', String(expires));
	const url = `${loreUrl(`/repos/${channelId}/signed-url`)}?${params.toString()}`;
	const res = await fetchWithTimeout(url, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to create signed URL');
	}
	const payload = (await res.json()) as { url?: string; expiresAt?: number };
	if (!payload.url) throw new Error('Signed URL response missing url');
	return payload.url;
}

export async function deleteLoreFile(
	token: string,
	channelId: number,
	path: string,
	message?: string,
	ifMatch?: string
): Promise<void> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/json'
	};
	if (ifMatch !== undefined) headers['If-Match'] = `"${ifMatch}"`;
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}`), {
		method: 'DELETE',
		headers,
		body: JSON.stringify({ message: message || '' })
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		if (res.status === 409) throw new LoreConflictError((err as any).currentEtag ?? null);
		throw new Error((err as any).error || 'Failed to delete file');
	}
}

// ---------------------------------------------------------------------------
// Sync protocol: optimistic concurrency (ETag / If-Match), manifest, change
// feed, and server-minted connect tokens.
// ---------------------------------------------------------------------------

/** Thrown when a PUT/DELETE is rejected because the file changed on the server. */
export class LoreConflictError extends Error {
	/** The server's current etag — fetch it and reapply your edit. */
	currentEtag: string | null;
	constructor(currentEtag: string | null) {
		super('File changed on the server since you loaded it');
		this.name = 'LoreConflictError';
		this.currentEtag = currentEtag;
	}
}

/** Download text content + its etag (the editor's baseline for If-Match). */
export async function downloadLoreFileText(
	token: string,
	channelId: number,
	path: string,
	revision?: string
): Promise<{ content: string; etag: string | null }> {
	const params = new URLSearchParams();
	if (revision) params.set('revision', revision);
	const url = `${loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}`)}?${params.toString()}`;
	const res = await fetchWithTimeout(url, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to load file');
	}
	const etag = res.headers.get('ETag')?.replace(/^W\/|"|"$|^"$/g, '') ?? null;
	return { content: await res.text(), etag };
}

/** Save editor content as a versioned upload. Throws LoreConflictError on 409. */
export async function saveLoreFileContent(
	token: string,
	channelId: number,
	path: string,
	content: string,
	baselineEtag: string | null,
	message?: string
): Promise<LoreUploadResult> {
	return uploadLoreFile(
		token,
		channelId,
		path,
		content,
		message || `Edit ${path} in Wabi`,
		baselineEtag
	);
}

export interface LoreManifest {
	channelId: number;
	files: LoreFileInfo[];
	headRevision: string;
	readOnly: boolean;
}

export async function getLoreManifest(token: string, channelId: number): Promise<LoreManifest> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/manifest`), {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to load manifest');
	}
	return (await res.json()) as LoreManifest;
}

export interface LoreChangeEntry {
	seq: number;
	path: string;
	action: 'upload' | 'delete' | 'snapshot' | string;
	etag?: string | null;
	revision?: string;
	authorUserId?: number;
}

export async function getLoreChanges(
	token: string,
	channelId: number,
	since = 0
): Promise<{ latestSeq: number; changes: LoreChangeEntry[] }> {
	const res = await fetchWithTimeout(
		loreUrl(`/repos/${channelId}/changes?since=${since}`),
		{ headers: { Authorization: `Bearer ${token}` } }
	);
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to load changes');
	}
	return await res.json();
}

export interface LoreConnectTokenInfo {
	tokenHashPrefix: string;
	scopes: string;
	userId: number;
	createdAtMicros: number;
}

/** Mint a server-side connect token (plaintext returned exactly once). */
export async function mintLoreConnectToken(
	token: string,
	channelId: number,
	scopes: 'read' | 'write'
): Promise<{ token: string; tokenHashPrefix: string; scopes: string }> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/connect-tokens`), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ scopes })
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to mint connect token');
	}
	return await res.json();
}

export async function listLoreConnectTokens(
	token: string,
	channelId: number
): Promise<LoreConnectTokenInfo[]> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/connect-tokens`), {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) return [];
	const payload = (await res.json()) as { tokens?: LoreConnectTokenInfo[] };
	return payload.tokens ?? [];
}

export async function revokeLoreConnectToken(
	token: string,
	channelId: number,
	tokenHash: string
): Promise<void> {
	const res = await fetchWithTimeout(
		loreUrl(`/repos/${channelId}/connect-tokens/${encodeURIComponent(tokenHash)}`),
		{
			method: 'DELETE',
			headers: { Authorization: `Bearer ${token}` }
		}
	);
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to revoke token');
	}
}

export async function lockLoreFile(token: string, channelId: number, path: string): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/lock/${encodeURIComponent(path)}`), {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to lock file');
	}
}

export async function unlockLoreFile(token: string, channelId: number, path: string): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/lock/${encodeURIComponent(path)}`), {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to unlock file');
	}
}

export async function getLoreFileHistory(token: string, channelId: number, path: string): Promise<LoreRevision[]> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/history/${encodeURIComponent(path)}`), {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to get file history');
	}
	return (await res.json()) as LoreRevision[];
}

export async function getLoreFileDiff(token: string, channelId: number, path: string, from: string, to: string): Promise<string> {
	const params = new URLSearchParams({ from, to });
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/diff/${encodeURIComponent(path)}?${params.toString()}`), {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to get file diff');
	}
	return await res.text();
}

export async function getLoreRepoHistory(token: string, channelId: number): Promise<LoreRevision[]> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/history`), {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to get repo history');
	}
	return (await res.json()) as LoreRevision[];
}

export async function getLoreBranches(token: string, channelId: number): Promise<LoreBranch[]> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/branches`), {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw loreError((err as any).error || 'Failed to list branches', res.status);
	}
	const data = (await res.json()) as { branches?: Array<string | { name?: string }> };
	return (data.branches || [])
		.map((branch) => typeof branch === 'string' ? branch : branch.name)
		.filter((name): name is string => Boolean(name))
		.map((name) => ({ name }));
}

export async function createLoreBranch(token: string, channelId: number, name: string, baseRevision?: string): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/branches`), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ name, baseRevision: baseRevision || null })
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to create branch');
	}
}

export async function mergeLoreBranch(token: string, channelId: number, branchName: string): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/branches/${encodeURIComponent(branchName)}/merge`), {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to merge branch');
	}
}

export async function createLoreSnapshot(token: string, channelId: number, message: string): Promise<LoreRevision> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/snapshot`), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ message })
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to create snapshot');
	}
	return (await res.json()) as LoreRevision;
}

export async function checkLoreHealth(token: string): Promise<{ status: string }> {
	const res = await fetchWithTimeout(loreUrl('/health'), {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		return { status: 'error' };
	}
	return (await res.json()) as { status: string };
}

// ============================================================================
// W6b: External-tool Connect — per-channel connection config + setup snippets
// ============================================================================

export interface LoreConnectConfig {
	serverUrl: string;
	repoId: string;
	token: string;
}

export interface LoreConnectSnippet {
	lang: string;
	label: string;
	code: string;
}

const LORE_CONNECT_STORAGE_PREFIX = 'wabi:lore:connect:';

export function loreConnectStorageKey(channelKey: string): string {
	return `${LORE_CONNECT_STORAGE_PREFIX}${channelKey}`;
}

export function loadLoreConnectConfig(channelKey: string): LoreConnectConfig | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const raw = localStorage.getItem(loreConnectStorageKey(channelKey));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<LoreConnectConfig>;
		return {
			serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '',
			repoId: typeof parsed.repoId === 'string' ? parsed.repoId : '',
			token: typeof parsed.token === 'string' ? parsed.token : ''
		};
	} catch {
		return null;
	}
}

export function saveLoreConnectConfig(channelKey: string, config: LoreConnectConfig): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(loreConnectStorageKey(channelKey), JSON.stringify(config));
	} catch {
		// Best effort only.
	}
}

export function generateLoreAccessToken(): string {
	const bytes = new Uint8Array(32);
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fillLoreSnippet(template: string, server: string, repo: string, token: string, url: string): string {
	return template
		.replaceAll('__SERVER__', server)
		.replaceAll('__REPO__', repo)
		.replaceAll('__TOKEN__', token)
		.replaceAll('__URL__', url);
}

/** Pre-formatted, copyable setup snippets for external tools. */
export function buildLoreConnectSnippets(serverUrl: string, repoId: string, token: string): LoreConnectSnippet[] {
	const server = serverUrl.trim().replace(/\/+$/, '');
	const repo = repoId.trim() || '<repo>';
	const tok = token.trim() || '<token>';
	const url = `${server}/api/addons/lore/repos/${repo}/files`;

	const c = `#define SERVER "__SERVER__"
#define REPO "__REPO__"
#define TOKEN "__TOKEN__"

#include <stdio.h>
#include <string.h>
#include <curl/curl.h>

static size_t write_cb(void *ptr, size_t size, size_t nmemb, void *userdata) {
    return fwrite(ptr, size, nmemb, (FILE *)userdata);
}

int main(void) {
    CURL *curl = curl_easy_init();
    if (!curl) return 1;
    struct curl_slist *headers = NULL;
    char auth[256];
    snprintf(auth, sizeof auth, "Authorization: Bearer %s", TOKEN);
    headers = curl_slist_append(headers, auth);

    char url[512];
    snprintf(url, sizeof url, "%s/api/addons/lore/repos/%s/files", SERVER, REPO);

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, stdout);

    curl_easy_perform(curl);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    return 0;
}`;

	const cpp = `#define SERVER "__SERVER__"
#define REPO "__REPO__"
#define TOKEN "__TOKEN__"

#include <httplib.h>
#include <iostream>
#include <string>

int main() {
    httplib::Client cli(SERVER);
    httplib::Headers headers = {
        {"Authorization", "Bearer " + std::string(TOKEN)}
    };
    std::string path = "/api/addons/lore/repos/" + std::string(REPO) + "/files";
    auto res = cli.Get(path, headers);
    if (res && res->status == 200) {
        std::cout << res->body << std::endl;
    }
    return 0;
}`;

	const csharp = `using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading.Tasks;

class Program
{
    static async Task Main()
    {
        const string server = "__SERVER__";
        const string repo = "__REPO__";
        const string token = "__TOKEN__";

        using var client = new HttpClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", token);

        string json = await client.GetStringAsync(
            $"{server}/api/addons/lore/repos/{repo}/files");
        Console.WriteLine(json);
    }
}`;

	const rust = `use reqwest::header::{AUTHORIZATION, HeaderValue};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let server = "__SERVER__";
    let repo = "__REPO__";
    let token = "__TOKEN__";

    let client = reqwest::Client::new();
    let json = client
        .get(format!("{server}/api/addons/lore/repos/{repo}/files"))
        .header(AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {token}"))?)
        .send()
        .await?
        .text()
        .await?;
    println!("{json}");
    Ok(())
}`;

	const go = `package main

import (
	"fmt"
	"io"
	"net/http"
)

func main() {
	const server = "__SERVER__"
	const repo = "__REPO__"
	const token = "__TOKEN__"

	req, err := http.NewRequest("GET", server+"/api/addons/lore/repos/"+repo+"/files", nil)
	if err != nil {
		panic(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	fmt.Println(string(body))
}`;

	const python = `import requests

SERVER = "__SERVER__"
REPO = "__REPO__"
TOKEN = "__TOKEN__"

r = requests.get(
    "{{URL}}",
    headers={"Authorization": "Bearer " + TOKEN},
)
print(r.json())`.replace('{{URL}}', url);

	const js = `const SERVER = '__SERVER__';
const REPO = '__REPO__';
const TOKEN = '__TOKEN__';

const res = await fetch('__URL__', {
  headers: { Authorization: 'Bearer ' + TOKEN },
});
const files = await res.json();
console.log(files);`;

	const raw: { lang: string; label: string; code: string }[] = [
		{ lang: 'c', label: 'C (libcurl)', code: c },
		{ lang: 'cpp', label: 'C++ (cpp-httplib)', code: cpp },
		{ lang: 'csharp', label: 'C# (HttpClient)', code: csharp },
		{ lang: 'rust', label: 'Rust (reqwest)', code: rust },
		{ lang: 'go', label: 'Go (net/http)', code: go },
		{ lang: 'python', label: 'Python (requests)', code: python },
		{ lang: 'js', label: 'JavaScript (fetch)', code: js }
	];

	return raw.map((s) => ({ lang: s.lang, label: s.label, code: fillLoreSnippet(s.code, server, repo, tok, url) }));
}

// ---------------------------------------------------------------------------
// Chat-channel Lore bindings + promote-from-chat (spec 2026-08-28, Phase 1)
// ---------------------------------------------------------------------------

export interface LoreChannelBinding {
	channelId: number;
	repoChannelId: number;
	path: string;
	branch: string;
	mode: 'none' | 'direct' | 'stage' | 'hybrid' | string;
	allowedTypes: string[];
	autoStage: boolean;
	updatedBy: number;
	updatedAtMicros: number;
}

export interface LorePromoteInfo {
	messageId: string;
	channelId: number;
	repoChannelId: number;
	fileUrl: string;
	fileName: string;
	path: string;
	branch: string;
	mode: string;
	revisionHash: string;
	pendingReview: boolean;
	reviewBranch: string | null;
	promotedBy: number;
	timestampMicros: number;
}

export interface LorePromoteResponse {
	collision?: boolean;
	path?: string;
	revision?: { hash: string; message?: string };
	branch?: string;
	mode?: string;
	pendingReview?: boolean;
	reviewBranch?: string | null;
}

function bindingFromRaw(raw: Record<string, unknown> | null | undefined): LoreChannelBinding | null {
	if (!raw) return null;
	const pick = <T>(k: string): T => ((raw[k] ?? raw[toCamel(k)]) as T);
	return {
		channelId: pick<number>('channel_id') ?? 0,
		repoChannelId: pick<number>('repo_channel_id') ?? 0,
		path: pick<string>('path') ?? '/',
		branch: pick<string>('branch') ?? 'main',
		mode: pick<string>('mode') ?? 'none',
		allowedTypes: pick<string[]>('allowed_types') ?? [],
		autoStage: pick<boolean>('auto_stage') ?? false,
		updatedBy: pick<number>('updated_by') ?? 0,
		updatedAtMicros: pick<number>('updated_at_micros') ?? 0
	};
}

function toCamel(snake: string): string {
	return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function promoteFromRaw(raw: Record<string, unknown>): LorePromoteInfo {
	const pick = <T>(k: string): T => ((raw[k] ?? raw[toCamel(k)]) as T);
	return {
		messageId: pick<string>('message_id') ?? '',
		channelId: pick<number>('channel_id') ?? 0,
		repoChannelId: pick<number>('repo_channel_id') ?? 0,
		fileUrl: pick<string>('file_url') ?? '',
		fileName: pick<string>('file_name') ?? '',
		path: pick<string>('path') ?? '',
		branch: pick<string>('branch') ?? '',
		mode: pick<string>('mode') ?? '',
		revisionHash: pick<string>('revision_hash') ?? '',
		pendingReview: pick<boolean>('pending_review') ?? false,
		reviewBranch: (pick<string | null>('review_branch') as string | null) ?? null,
		promotedBy: pick<number>('promoted_by') ?? 0,
		timestampMicros: pick<number>('timestamp_micros') ?? 0
	};
}

async function loreApiError(res: Response): Promise<string> {
	try {
		const body = await res.json();
		return String(body?.error ?? body?.message ?? body?.detail ?? res.statusText);
	} catch {
		return res.statusText;
	}
}

export async function getLoreBinding(token: string, channelId: number): Promise<LoreChannelBinding | null> {
	const res = await fetchWithTimeout(loreUrl(`/binding/${channelId}`), {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`Lore binding fetch failed: ${await loreApiError(res)}`);
	const body = await res.json();
	return bindingFromRaw(body?.binding);
}

export async function setLoreBinding(
	token: string,
	channelId: number,
	binding: {
		repoChannelId: number;
		path: string;
		branch?: string;
		mode: string;
		allowedTypes?: string[];
		autoStage?: boolean;
	}
): Promise<LoreChannelBinding> {
	const res = await fetchWithTimeout(loreUrl(`/binding/${channelId}`), {
		method: 'PUT',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			repo_channel_id: binding.repoChannelId,
			path: binding.path,
			branch: binding.branch ?? 'main',
			mode: binding.mode,
			allowed_types: binding.allowedTypes ?? [],
			auto_stage: binding.autoStage ?? false
		})
	});
	if (!res.ok) throw new Error(await loreApiError(res));
	return (await res.json()) as unknown as LoreChannelBinding;
}

export async function deleteLoreBinding(token: string, channelId: number): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/binding/${channelId}`), {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok && res.status !== 404) throw new Error(await loreApiError(res));
}

export async function promoteLoreFromMessage(
	token: string,
	req: {
		messageId: string;
		fileUrl: string;
		repoChannelId?: number;
		path?: string;
		branch?: string;
		mode?: 'direct' | 'stage';
		collision?: 'overwrite';
	}
): Promise<LorePromoteResponse> {
	const res = await fetchWithTimeout(loreUrl('/promote/from-message'), {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			message_id: req.messageId,
			file_url: req.fileUrl,
			repo_channel_id: req.repoChannelId,
			path: req.path,
			branch: req.branch,
			mode: req.mode,
			collision: req.collision
		})
	});
	if (!res.ok) throw new Error(await loreApiError(res));
	return (await res.json()) as LorePromoteResponse;
}

export async function getLorePromotesForMessage(token: string, messageId: string): Promise<LorePromoteInfo[]> {
	const res = await fetchWithTimeout(loreUrl(`/promotes/${encodeURIComponent(messageId)}`), {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) throw new Error(await loreApiError(res));
	const body = await res.json();
	return Array.isArray(body?.promotes) ? body.promotes.map(promoteFromRaw) : [];
}
