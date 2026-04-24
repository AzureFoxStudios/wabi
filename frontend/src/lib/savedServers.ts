import { browser } from '$app/environment';
import { derived, get, writable } from 'svelte/store';
import type { FrontendAppMetadataPolicy, LaunchPageConfig } from './api';
import { getLaunchPageConfigFrom, getPublicFrontendAppMetadata } from './api';
import {
	getAuthToken,
	getGuestSessionId,
	getStoredDbUserId,
	getStoredUsername
} from './authSession';
import {
	activeServerUrl as activeServerUrlStore,
	getConfiguredServerRememberPreference,
	normalizeServerUrl,
	resolveServerUrl,
	setConfiguredServerUrl
} from './serverUrl';
import { setPendingChannelNavigation } from './pendingServerNavigation';

const SAVED_SERVERS_STORAGE_KEY = 'wabi.savedServers.v1';

export interface SavedServerFolder {
	id: string;
	name: string;
}

export interface SavedServerEntry {
	url: string;
	localAlias: string | null;
	folderId: string | null;
	order: number;
	firstConnectedAt: number;
	lastConnectedAt: number;
	lastUsername: string | null;
	lastDbUserId: number | null;
	hasRegisteredSession: boolean;
	hasGuestSession: boolean;
	frontendMetadata: FrontendAppMetadataPolicy | null;
	launchPageBranding: Pick<LaunchPageConfig, 'brandName' | 'logoUrl' | 'heroImageUrl' | 'subheadline' | 'palette'> | null;
}

interface SavedServersState {
	entries: SavedServerEntry[];
	folders: SavedServerFolder[];
}

export interface SavedServerView extends SavedServerEntry {
	effectiveName: string;
	effectiveIconUrl: string | null;
	effectiveBannerUrl: string | null;
	effectiveAccentColor: string | null;
	effectiveDescription: string | null;
	isActive: boolean;
}

export interface SavedServerFolderView extends SavedServerFolder {
	members: SavedServerView[];
	effectiveName: string;
	effectiveAccentColor: string | null;
	activeMember: SavedServerView | null;
}

export type SavedServerRailItem =
	| {
		kind: 'server';
		id: string;
		server: SavedServerView;
		firstUrl: string;
		lastUrl: string;
	}
	| {
		kind: 'folder';
		id: string;
		folder: SavedServerFolderView;
		firstUrl: string;
		lastUrl: string;
	};

const DEFAULT_STATE: SavedServersState = {
	entries: [],
	folders: []
};

function createFolderId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `folder-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeAlias(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().slice(0, 80);
	return trimmed.length > 0 ? trimmed : null;
}

function sanitizeServerEntry(value: unknown, fallbackOrder: number): SavedServerEntry | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const url = typeof input.url === 'string' ? normalizeServerUrl(input.url) : null;
	if (!url) return null;
	return {
		url,
		localAlias: normalizeAlias(typeof input.localAlias === 'string' ? input.localAlias : null),
		folderId: typeof input.folderId === 'string' && input.folderId.trim().length > 0 ? input.folderId : null,
		order: typeof input.order === 'number' && Number.isFinite(input.order) ? input.order : fallbackOrder,
		firstConnectedAt: typeof input.firstConnectedAt === 'number' && Number.isFinite(input.firstConnectedAt) ? input.firstConnectedAt : Date.now(),
		lastConnectedAt: typeof input.lastConnectedAt === 'number' && Number.isFinite(input.lastConnectedAt) ? input.lastConnectedAt : Date.now(),
		lastUsername: typeof input.lastUsername === 'string' ? input.lastUsername.trim().slice(0, 80) || null : null,
		lastDbUserId: typeof input.lastDbUserId === 'number' && Number.isFinite(input.lastDbUserId) ? input.lastDbUserId : null,
		hasRegisteredSession: input.hasRegisteredSession === true,
		hasGuestSession: input.hasGuestSession === true,
		frontendMetadata:
			input.frontendMetadata && typeof input.frontendMetadata === 'object' && !Array.isArray(input.frontendMetadata)
				? (input.frontendMetadata as FrontendAppMetadataPolicy)
				: null,
		launchPageBranding:
			input.launchPageBranding && typeof input.launchPageBranding === 'object' && !Array.isArray(input.launchPageBranding)
				? (input.launchPageBranding as SavedServerEntry['launchPageBranding'])
				: null
	};
}

function sanitizeFolder(value: unknown): SavedServerFolder | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const id = typeof input.id === 'string' ? input.id.trim().slice(0, 64) : '';
	const name = typeof input.name === 'string' ? input.name.trim().slice(0, 40) : '';
	if (!id) return null;
	return { id, name };
}

function sortEntries(entries: SavedServerEntry[]): SavedServerEntry[] {
	return [...entries].sort((a, b) => {
		if (a.order !== b.order) return a.order - b.order;
		return b.lastConnectedAt - a.lastConnectedAt;
	});
}

function normalizeState(state: SavedServersState): SavedServersState {
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

function loadState(): SavedServersState {
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

function persistState(state: SavedServersState): void {
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

function defaultDisplayName(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.hostname;
	} catch {
		return url;
	}
}

function resolveServerAssetUrl(serverUrl: string, assetUrl: string | null | undefined): string | null {
	if (!assetUrl) return null;
	const trimmed = assetUrl.trim();
	if (!trimmed) return null;
	try {
		return new URL(trimmed, serverUrl).toString();
	} catch {
		return trimmed;
	}
}

function deriveServerView(entry: SavedServerEntry, activeUrl: string | null): SavedServerView {
	const metadata = entry.frontendMetadata;
	const launch = entry.launchPageBranding;
	const useLaunchFallback = metadata?.launchPageFallbackEnabled !== false;
	const hasRegisteredSession = Boolean(getAuthToken(entry.url));
	const hasGuestSession = Boolean(getGuestSessionId(entry.url));
	const effectiveName =
		entry.localAlias ||
		metadata?.displayName ||
		(useLaunchFallback ? launch?.brandName : null) ||
		defaultDisplayName(entry.url);
	const effectiveIconUrl = resolveServerAssetUrl(
		entry.url,
		metadata?.iconUrl || (useLaunchFallback ? launch?.logoUrl || null : null)
	);
	const effectiveBannerUrl = resolveServerAssetUrl(
		entry.url,
		metadata?.bannerUrl || (useLaunchFallback ? launch?.heroImageUrl || null : null)
	);
	const effectiveAccentColor =
		metadata?.accentColor ||
		(useLaunchFallback ? launch?.palette?.accent || null : null) ||
		null;
	const effectiveDescription =
		metadata?.description ||
		(useLaunchFallback ? launch?.subheadline || null : null) ||
		null;
	return {
		...entry,
		hasRegisteredSession,
		hasGuestSession,
		effectiveName,
		effectiveIconUrl,
		effectiveBannerUrl,
		effectiveAccentColor,
		effectiveDescription,
		isActive: activeUrl === entry.url
	};
}

const savedServersState = writable<SavedServersState>(normalizeState(loadState()));

savedServersState.subscribe((state) => {
	persistState(normalizeState(state));
});

function withMutableState(
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

function updateEntry(
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

function moveEntryInOrderedList(
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

function getFolderMembers(entries: SavedServerEntry[], folderId: string, excludeUrl?: string): SavedServerEntry[] {
	return sortEntries(entries).filter((entry) => entry.folderId === folderId && entry.url !== excludeUrl);
}

function getLastFolderMemberUrl(entries: SavedServerEntry[], folderId: string, excludeUrl?: string): string | null {
	const members = getFolderMembers(entries, folderId, excludeUrl);
	return members[members.length - 1]?.url || null;
}

function buildStateRailItems(state: SavedServersState): Array<{
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

async function refreshSavedServerMetadata(url: string): Promise<void> {
	const normalizedUrl = normalizeServerUrl(url);
	if (!normalizedUrl) return;
	try {
		const [frontendMetadata, launchPageConfig] = await Promise.all([
			getPublicFrontendAppMetadata(normalizedUrl),
			getLaunchPageConfigFrom(normalizedUrl)
		]);
		updateEntry(normalizedUrl, (entry, entries) => {
			if (!entry) return null;
			return {
				...entry,
				order: entry.order ?? entries.length,
				frontendMetadata,
				launchPageBranding: launchPageConfig
					? {
						brandName: launchPageConfig.brandName,
						logoUrl: launchPageConfig.logoUrl,
						heroImageUrl: launchPageConfig.heroImageUrl,
						subheadline: launchPageConfig.subheadline,
						palette: launchPageConfig.palette
					}
					: null
			};
		});
	} catch {
		// Ignore metadata refresh failures and keep stale data.
	}
}

export function recordSuccessfulServerConnection(details?: {
	url?: string | null;
	username?: string | null;
	dbUserId?: number | null;
}): void {
	const normalizedUrl = normalizeServerUrl(details?.url || resolveServerUrl().url);
	if (!normalizedUrl) return;
	const now = Date.now();
	updateEntry(normalizedUrl, (entry, entries) => ({
		url: normalizedUrl,
		localAlias: entry?.localAlias || null,
		folderId: entry?.folderId || null,
		order: entry?.order ?? entries.length,
		firstConnectedAt: entry?.firstConnectedAt || now,
		lastConnectedAt: now,
		lastUsername: details?.username || getStoredUsername(normalizedUrl),
		lastDbUserId: details?.dbUserId ?? getStoredDbUserId(normalizedUrl),
		hasRegisteredSession: Boolean(getAuthToken(normalizedUrl)),
		hasGuestSession: Boolean(getGuestSessionId(normalizedUrl)),
		frontendMetadata: entry?.frontendMetadata || null,
		launchPageBranding: entry?.launchPageBranding || null
	}));
	void refreshSavedServerMetadata(normalizedUrl);
}

export function renameLocalSavedServer(url: string, alias: string | null): void {
	updateEntry(url, (entry, entries) => {
		if (!entry) return null;
		return {
			...entry,
			localAlias: normalizeAlias(alias),
			order: entry.order ?? entries.length
		};
	});
}

export function removeSavedServer(url: string): void {
	updateEntry(url, () => null);
}

export function reorderSavedServer(
	sourceUrl: string,
	targetUrl: string,
	position: 'before' | 'after' = 'before',
	nextFolderId?: string | null
): void {
	const normalizedSource = normalizeServerUrl(sourceUrl);
	const normalizedTarget = normalizeServerUrl(targetUrl);
	if (!normalizedSource || !normalizedTarget || normalizedSource === normalizedTarget) return;

	withMutableState((state) => {
		state.entries = moveEntryInOrderedList(
			state.entries,
			normalizedSource,
			normalizedTarget,
			position,
			nextFolderId
		);
	});
}

export function createSavedServerFolder(sourceUrl: string, targetUrl: string): void {
	const normalizedSource = normalizeServerUrl(sourceUrl);
	const normalizedTarget = normalizeServerUrl(targetUrl);
	if (!normalizedSource || !normalizedTarget || normalizedSource === normalizedTarget) return;

	withMutableState((state) => {
		const entries = sortEntries(state.entries);
		const sourceEntry = entries.find((entry) => entry.url === normalizedSource) || null;
		const targetEntry = entries.find((entry) => entry.url === normalizedTarget) || null;
		if (!sourceEntry || !targetEntry) return;

		const sourceFolderId = sourceEntry.folderId;
		const targetFolderId = targetEntry.folderId;

		if (sourceFolderId && targetFolderId && sourceFolderId === targetFolderId) {
			return;
		}

		if (sourceFolderId && targetFolderId && sourceFolderId !== targetFolderId) {
			const sourceMembers = getFolderMembers(entries, sourceFolderId);
			let nextEntries = entries.map((entry) =>
				entry.folderId === sourceFolderId ? { ...entry, folderId: targetFolderId } : { ...entry }
			);
			let anchorUrl = getLastFolderMemberUrl(nextEntries, targetFolderId) || normalizedTarget;
			for (const member of sourceMembers) {
				nextEntries = moveEntryInOrderedList(nextEntries, member.url, anchorUrl, 'after', targetFolderId);
				anchorUrl = member.url;
			}
			state.entries = nextEntries;
			return;
		}

		if (targetFolderId) {
			const anchorUrl = getLastFolderMemberUrl(entries, targetFolderId, normalizedSource) || normalizedTarget;
			state.entries = moveEntryInOrderedList(entries, normalizedSource, anchorUrl, 'after', targetFolderId);
			return;
		}

		if (sourceFolderId) {
			const anchorUrl = getLastFolderMemberUrl(entries, sourceFolderId, normalizedTarget) || normalizedSource;
			state.entries = moveEntryInOrderedList(entries, normalizedTarget, anchorUrl, 'after', sourceFolderId);
			return;
		}

		const folderId = createFolderId();
		const nextEntries = entries.map((entry) =>
			entry.url === normalizedTarget ? { ...entry, folderId } : { ...entry }
		);
		state.folders = [...state.folders, { id: folderId, name: '' }];
		state.entries = moveEntryInOrderedList(nextEntries, normalizedSource, normalizedTarget, 'after', folderId);
	});
}

export function moveSavedServerToFolder(sourceUrl: string, folderId: string | null): void {
	const normalizedSource = normalizeServerUrl(sourceUrl);
	if (!normalizedSource) return;

	withMutableState((state) => {
		const entries = sortEntries(state.entries);
		const sourceEntry = entries.find((entry) => entry.url === normalizedSource) || null;
		if (!sourceEntry) return;

		if (folderId === null) {
			state.entries = entries.map((entry, index) => ({
				...(entry.url === normalizedSource ? { ...entry, folderId: null } : { ...entry }),
				order: index
			}));
			return;
		}

		const folderExists = state.folders.some((folder) => folder.id === folderId);
		if (!folderExists) return;

		const anchorUrl = getLastFolderMemberUrl(entries, folderId, normalizedSource);
		if (!anchorUrl) {
			state.entries = entries.map((entry, index) => ({
				...(entry.url === normalizedSource ? { ...entry, folderId } : { ...entry }),
				order: index
			}));
			return;
		}

		state.entries = moveEntryInOrderedList(entries, normalizedSource, anchorUrl, 'after', folderId);
	});
}

export function renameSavedServerFolder(folderId: string, name: string | null): void {
	const normalizedFolderId = folderId.trim();
	if (!normalizedFolderId) return;
	withMutableState((state) => {
		state.folders = state.folders.map((folder) =>
			folder.id === normalizedFolderId
				? { ...folder, name: normalizeAlias(name) || '' }
				: folder
		);
	});
}

export function reorderSavedServerRailItem(
	sourceItemId: string,
	targetItemId: string,
	position: 'before' | 'after' = 'before'
): void {
	const sourceId = sourceItemId.trim();
	const targetId = targetItemId.trim();
	if (!sourceId || !targetId || sourceId === targetId) return;

	withMutableState((state) => {
		const items = buildStateRailItems(state);
		const source = items.find((item) => item.id === sourceId);
		const target = items.find((item) => item.id === targetId);
		if (!source || !target) return;

		const sourceUrls = new Set(source.urls);
		const remaining = sortEntries(state.entries)
			.filter((entry) => !sourceUrls.has(entry.url))
			.map((entry) => ({ ...entry }));
		const block = sortEntries(state.entries)
			.filter((entry) => sourceUrls.has(entry.url))
			.map((entry) => ({ ...entry }));
		if (block.length === 0) return;

		const anchorUrl = position === 'before' ? target.firstUrl : target.lastUrl;
		const anchorIndex = remaining.findIndex((entry) => entry.url === anchorUrl);
		if (anchorIndex === -1) return;

		const insertIndex = position === 'after' ? anchorIndex + 1 : anchorIndex;
		remaining.splice(insertIndex, 0, ...block);
		state.entries = remaining.map((entry, index) => ({
			...entry,
			order: index
		}));
	});
}

export function refreshSavedServer(url: string): void {
	void refreshSavedServerMetadata(url);
}

export function switchToSavedServer(url: string): void {
	const normalizedUrl = normalizeServerUrl(url);
	if (!normalizedUrl || !browser) return;
	const remember = getConfiguredServerRememberPreference();
	setConfiguredServerUrl(normalizedUrl, remember);
	window.location.reload();
}

export function switchToSavedServerChannel(url: string, channelId: string): void {
	const normalizedUrl = normalizeServerUrl(url);
	if (!normalizedUrl || !browser || !channelId.trim()) return;
	setPendingChannelNavigation(normalizedUrl, channelId);
	switchToSavedServer(normalizedUrl);
}

export function openUnsavedServer(url: string): void {
	switchToSavedServer(url);
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

if (browser) {
	const currentUrl = normalizeServerUrl(get(activeServerUrlStore) || '');
	if (currentUrl) {
		const existingEntry = loadState().entries.find((entry) => entry.url === currentUrl);
		if (existingEntry) {
			void refreshSavedServerMetadata(currentUrl);
		}
	}
}
