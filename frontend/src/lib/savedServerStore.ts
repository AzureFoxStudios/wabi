/**
 * savedServerStore.ts
 * Server list state management, persistence, and normalization
 */

import { browser } from '$app/environment';
import { derived, writable } from 'svelte/store';
import type { SavedServerEntry, SavedServerFolder, SavedServerFolderView, SavedServerRailItem, SavedServerView } from './savedServers';
import { activeServerUrl as activeServerUrlStore, normalizeServerUrl } from './serverUrl';
import { sanitizeServerEntry, sanitizeFolder, sortEntries, deriveServerView, getFolderMembers, getLastFolderMemberUrl } from './savedServerUtils';

const SAVED_SERVERS_STORAGE_KEY = 'wabi.savedServers.v1';

interface SavedServersState {
	entries: SavedServerEntry[];
	folders: SavedServerFolder[];
}

const DEFAULT_STATE: SavedServersState = {
	entries: [],
	folders: []
};

export function normalizeState(state: SavedServersState): SavedServersState {
	const entries = sortEntries(state.entries.map((entry) => ({ ...entry })));
	const foldersById = new Map<string, SavedServerFolder>();

	for (const folder of state.folders.map((folder) => ({ ...folder }))) {
		if (!foldersById.has(folder.id)) {
			foldersById.set(folder.id, {
				id: folder.id,
				name: folder.name?.trim().slice(0, 40) || ''
			});
		}
	}

	for (const entry of entries) {
		if (entry.folderId && !foldersById.has(entry.folderId)) {
			foldersById.set(entry.folderId, {
				id: entry.folderId,
				name: ''
			});
		}
	}

	const folderMembers = new Map<string, SavedServerEntry[]>();
	for (const entry of entries) {
		if (!entry.folderId) continue;
		const members = folderMembers.get(entry.folderId) || [];
		members.push(entry);
		folderMembers.set(entry.folderId, members);
	}

	const folders: SavedServerFolder[] = [];
	for (const [folderId, folder] of foldersById.entries()) {
		const members = folderMembers.get(folderId) || [];
		if (members.length >= 2) {
			folders.push(folder);
			continue;
		}
		if (members.length === 1) {
			members[0].folderId = null;
		}
	}

	return {
		entries: sortEntries(entries).map((entry, index) => ({
			...entry,
			order: index
		})),
		folders
	};
}

export function loadState(): SavedServersState {
	if (!browser) return DEFAULT_STATE;
	try {
		const raw = localStorage.getItem(SAVED_SERVERS_STORAGE_KEY);
		if (!raw) return DEFAULT_STATE;
		const parsed = JSON.parse(raw) as Partial<SavedServersState>;
		const entries = Array.isArray(parsed.entries)
			? parsed.entries
				.map((entry, index) => sanitizeServerEntry(entry, index))
				.filter((entry): entry is SavedServerEntry => entry !== null)
			: [];
		const folders = Array.isArray(parsed.folders)
			? parsed.folders
				.map(sanitizeFolder)
				.filter((folder): folder is SavedServerFolder => folder !== null)
			: [];
		return normalizeState({ entries, folders });
	} catch {
		return DEFAULT_STATE;
	}
}

export function persistState(state: SavedServersState): void {
	if (!browser) return;
	try {
		localStorage.setItem(
			SAVED_SERVERS_STORAGE_KEY,
			JSON.stringify({
				entries: sortEntries(state.entries),
				folders: state.folders
			})
		);
	} catch {
		// Best effort only.
	}
}

export const savedServersState = writable<SavedServersState>(normalizeState(loadState()));

savedServersState.subscribe((state) => {
	persistState(normalizeState(state));
});

export function withMutableState(
	mutator: (draft: SavedServersState) => void
): void {
	savedServersState.update((state) => {
		const draft: SavedServersState = {
			entries: sortEntries(state.entries).map((entry) => ({ ...entry })),
			folders: state.folders.map((folder) => ({ ...folder }))
		};
		mutator(draft);
		return normalizeState(draft);
	});
}

export function updateEntry(
	url: string,
	updater: (entry: SavedServerEntry | null, entries: SavedServerEntry[]) => SavedServerEntry | null
): void {
	const normalizedUrl = normalizeServerUrl(url);
	if (!normalizedUrl) return;
	withMutableState((state) => {
		const entries = sortEntries(state.entries);
		const currentEntry = entries.find((entry) => entry.url === normalizedUrl) || null;
		const nextEntry = updater(currentEntry, entries);
		const remaining = entries.filter((entry) => entry.url !== normalizedUrl);
		const nextEntries = nextEntry ? sortEntries([...remaining, nextEntry]) : remaining;
		state.entries = nextEntries.map((entry, index) => ({ ...entry, order: index }));
	});
}

export function moveEntryInOrderedList(
	entries: SavedServerEntry[],
	sourceUrl: string,
	targetUrl: string,
	position: 'before' | 'after',
	nextFolderId?: string | null
): SavedServerEntry[] {
	if (!sourceUrl || !targetUrl || sourceUrl === targetUrl) {
		return entries.map((entry, index) => ({ ...entry, order: index }));
	}
	const next = sortEntries(entries).map((entry) => ({ ...entry }));
	const sourceIndex = next.findIndex((entry) => entry.url === sourceUrl);
	if (sourceIndex === -1 || !next.some((entry) => entry.url === targetUrl)) {
		return next.map((entry, index) => ({ ...entry, order: index }));
	}

	const [source] = next.splice(sourceIndex, 1);
	if (nextFolderId !== undefined) {
		source.folderId = nextFolderId;
	}

	const adjustedTargetIndex = next.findIndex((entry) => entry.url === targetUrl);
	const insertIndex = position === 'after' ? adjustedTargetIndex + 1 : adjustedTargetIndex;
	next.splice(insertIndex, 0, source);

	return next.map((entry, index) => ({
		...entry,
		order: index
	}));
}

export function buildStateRailItems(state: SavedServersState): Array<{
	kind: 'server' | 'folder';
	id: string;
	urls: string[];
	firstUrl: string;
	lastUrl: string;
}> {
	const entries = sortEntries(state.entries);
	const membersByFolderId = new Map<string, SavedServerEntry[]>();
	for (const entry of entries) {
		if (!entry.folderId) continue;
		const members = membersByFolderId.get(entry.folderId) || [];
		members.push(entry);
		membersByFolderId.set(entry.folderId, members);
	}

	const items: Array<{
		kind: 'server' | 'folder';
		id: string;
		urls: string[];
		firstUrl: string;
		lastUrl: string;
	}> = [];
	const seenFolderIds = new Set<string>();

	for (const entry of entries) {
		if (entry.folderId) {
			const members = membersByFolderId.get(entry.folderId) || [];
			if (members.length >= 2 && !seenFolderIds.has(entry.folderId)) {
				items.push({
					kind: 'folder',
					id: entry.folderId,
					urls: members.map((member) => member.url),
					firstUrl: members[0].url,
					lastUrl: members[members.length - 1].url
				});
				seenFolderIds.add(entry.folderId);
			}
			continue;
		}

		items.push({
			kind: 'server',
			id: entry.url,
			urls: [entry.url],
			firstUrl: entry.url,
			lastUrl: entry.url
		});
	}

	return items;
}

export const savedServers = derived(
	[savedServersState, activeServerUrlStore],
	([$state, $activeServerUrl]) =>
		sortEntries($state.entries).map((entry) =>
			deriveServerView(entry, normalizeServerUrl($activeServerUrl || '') || $activeServerUrl || null)
		)
);

export const savedServerFolders = derived(savedServersState, ($state) => $state.folders);

export const savedServerFolderViews = derived(
	[savedServers, savedServerFolders],
	([$entries, $folders]): SavedServerFolderView[] => {
		const byFolderId = new Map<string, SavedServerView[]>();
		for (const entry of $entries) {
			if (!entry.folderId) continue;
			const members = byFolderId.get(entry.folderId) || [];
			members.push(entry);
			byFolderId.set(entry.folderId, members);
		}

		return $folders
			.map((folder) => {
				const members = (byFolderId.get(folder.id) || []).sort((a, b) => a.order - b.order);
				if (members.length < 2) return null;
				const activeMember = members.find((member) => member.isActive) || null;
				return {
					...folder,
					members,
					effectiveName:
						folder.name ||
						(members.length === 2
							? `${members[0].effectiveName} + 1`
							: `${members[0].effectiveName} + ${members.length - 1}`),
					effectiveAccentColor:
						activeMember?.effectiveAccentColor || members[0]?.effectiveAccentColor || null,
					activeMember
				};
			})
			.filter((folder): folder is SavedServerFolderView => folder !== null)
			.sort((a, b) => (a.members[0]?.order || 0) - (b.members[0]?.order || 0));
	}
);

export const savedServerRailItems = derived(
	[savedServers, savedServerFolderViews],
	([$entries, $folders]): SavedServerRailItem[] => {
		const folderById = new Map($folders.map((folder) => [folder.id, folder]));
		const seenFolders = new Set<string>();
		const items: SavedServerRailItem[] = [];

		for (const entry of $entries) {
			if (entry.folderId) {
				const folder = folderById.get(entry.folderId);
				if (folder && !seenFolders.has(folder.id)) {
					items.push({
						kind: 'folder',
						id: folder.id,
						folder,
						firstUrl: folder.members[0]?.url || entry.url,
						lastUrl: folder.members[folder.members.length - 1]?.url || entry.url
					});
					seenFolders.add(folder.id);
				}
				continue;
			}

			items.push({
				kind: 'server',
				id: entry.url,
				server: entry,
				firstUrl: entry.url,
				lastUrl: entry.url
			});
		}

		return items;
	}
);

export const currentSavedServer = derived(savedServers, ($entries) =>
	$entries.find((entry) => entry.isActive) || null
);
