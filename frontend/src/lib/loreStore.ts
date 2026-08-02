import { writable, get } from 'svelte/store';
import { getAuthToken } from '$lib/authSession';
import { currentChannel } from '$lib/socket';
import {
	getLoreRepo,
	listLoreFiles,
	getLoreRepoHistory,
	getLoreBranches,
	getLoreFileHistory,
	getLoreFileDiff,
	checkLoreHealth,
	parseLoreChannelId,
	type LoreRepo,
	type LoreFileInfo,
	type LoreRevision,
	type LoreBranch
} from '$lib/api/lore';

export const loreRepo = writable<LoreRepo | null>(null);
export const loreFiles = writable<LoreFileInfo[]>([]);
export const loreRevisions = writable<LoreRevision[]>([]);
export const loreBranches = writable<LoreBranch[]>([]);
export const loreFileHistory = writable<LoreRevision[]>([]);
export const loreFileDiff = writable<string | null>(null);
export const loreLoading = writable(false);
export const loreError = writable<string | null>(null);
export const loreHealth = writable<string | null>(null);

async function refresh(load: () => Promise<void>) {
	loreLoading.set(true);
	loreError.set(null);
	try {
		await load();
	} catch (err) {
		loreError.set(err instanceof Error ? err.message : 'An error occurred');
	} finally {
		loreLoading.set(false);
	}
}

/** L4: channel ids are hex on the wire (`ch_{:x}`); never decimal-parse. */
function getChannelId(): number | null {
	return parseLoreChannelId(get(currentChannel));
}

export async function loadLoreRepo() {
	const token = getAuthToken();
	const channelId = getChannelId();
	if (!token || !channelId) return;
	await refresh(async () => {
		const [repo, files] = await Promise.all([
			getLoreRepo(token, channelId),
			listLoreFiles(token, channelId).catch(() => [] as LoreFileInfo[])
		]);
		loreRepo.set(repo);
		loreFiles.set(files);
	});
}

export async function loadLoreHistory() {
	const token = getAuthToken();
	const channelId = getChannelId();
	if (!token || !channelId) return;
	await refresh(async () => {
		const [revisions, branches] = await Promise.all([
			getLoreRepoHistory(token, channelId),
			getLoreBranches(token, channelId)
		]);
		loreRevisions.set(revisions);
		loreBranches.set(branches);
	});
}

export async function loadLoreFileHistory(filePath: string) {
	const token = getAuthToken();
	const channelId = getChannelId();
	if (!token || !channelId) return;
	await refresh(async () => {
		const history = await getLoreFileHistory(token, channelId, filePath);
		loreFileHistory.set(history);
	});
}

export async function loadLoreFileDiff(filePath: string, from: string, to: string) {
	const token = getAuthToken();
	const channelId = getChannelId();
	if (!token || !channelId) return;
	await refresh(async () => {
		const diff = await getLoreFileDiff(token, channelId, filePath, from, to);
		loreFileDiff.set(diff);
	});
}

export async function loadLoreHealth() {
	const token = getAuthToken();
	if (!token) return;
	try {
		const health = await checkLoreHealth(token);
		loreHealth.set(health.status);
	} catch {
		loreHealth.set('error');
	}
}

export function addLoreFile(file: LoreFileInfo) {
	loreFiles.update((files) => {
		const idx = files.findIndex((f) => f.path === file.path);
		if (idx >= 0) {
			const updated = [...files];
			updated[idx] = file;
			return updated;
		}
		return [...files, file];
	});
}

export function removeLoreFile(filePath: string) {
	loreFiles.update((files) => files.filter((f) => f.path !== filePath));
}

export function clearLoreFileHistory() {
	loreFileHistory.set([]);
	loreFileDiff.set(null);
}

export function resetLoreStore() {
	loreRepo.set(null);
	loreFiles.set([]);
	loreRevisions.set([]);
	loreBranches.set([]);
	loreFileHistory.set([]);
	loreFileDiff.set(null);
	loreLoading.set(false);
	loreError.set(null);
}
