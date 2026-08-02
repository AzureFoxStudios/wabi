import { getApiBase, fetchWithTimeout } from './utils';

export interface LoreRepo {
	channelId: number;
	repoName: string;
	createdBy: number;
	createdAt: number;
}

export interface LoreFileInfo {
	path: string;
	size: number;
	modifiedAt: number;
	lockedBy: number | null;
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
	return (await res.json()) as LoreRepo;
}

export async function createLoreRepo(token: string, channelId: number, repoName: string): Promise<LoreRepo> {
	const res = await fetchWithTimeout(loreUrl('/repos'), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ channelId, repoName })
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to create lore repo');
	}
	return (await res.json()) as LoreRepo;
}

export async function deleteLoreRepo(token: string, channelId: number): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}`), {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to delete lore repo');
	}
}

export async function uploadLoreFile(
	token: string,
	channelId: number,
	path: string,
	file: File,
	message?: string
): Promise<{ revision: LoreRevision; file: LoreFileInfo }> {
	const params = new URLSearchParams();
	if (message) params.set('message', message);
	if (path) params.set('repo_path', path);
	const url = `${loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}`)}?${params.toString()}`;
	const res = await fetchWithTimeout(url, {
		method: 'PUT',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/octet-stream'
		},
		body: await file.arrayBuffer()
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to upload file');
	}
	return (await res.json()) as { revision: LoreRevision; file: LoreFileInfo };
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

export async function deleteLoreFile(token: string, channelId: number, path: string, message?: string): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}`), {
		method: 'DELETE',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ message: message || '' })
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to delete file');
	}
}

export async function lockLoreFile(token: string, channelId: number, path: string): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}/lock`), {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to lock file');
	}
}

export async function unlockLoreFile(token: string, channelId: number, path: string): Promise<void> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}/lock`), {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error((err as any).error || 'Failed to unlock file');
	}
}

export async function getLoreFileHistory(token: string, channelId: number, path: string): Promise<LoreRevision[]> {
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}/history`), {
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
	const res = await fetchWithTimeout(loreUrl(`/repos/${channelId}/files/${encodeURIComponent(path)}/diff?${params.toString()}`), {
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
		throw new Error((err as any).error || 'Failed to list branches');
	}
	const data = (await res.json()) as { branches: string[] };
	return (data.branches || []).map((name) => ({ name }));
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
