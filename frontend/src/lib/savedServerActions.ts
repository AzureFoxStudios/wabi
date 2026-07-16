/**
 * savedServerActions.ts
 * Public API and server management actions
 */

import { browser, building } from '$app/environment';
import { get } from 'svelte/store';
import type { SavedServerEntry } from './savedServers';
import { getLaunchPageConfigFrom, getPublicFrontendAppMetadata } from './api';
import { getAuthToken, getGuestSessionId, getStoredDbUserId, getStoredUsername } from './authSession';
import { getConfiguredServerRememberPreference, normalizeServerUrl, resolveServerUrl, setConfiguredServerUrl } from './serverUrl';
import { setPendingChannelNavigation } from './pendingServerNavigation';
import { updateEntry, withMutableState, moveEntryInOrderedList, savedServersState, buildStateRailItems } from './savedServerStore';
import { sortEntries, normalizeAlias, createFolderId, getLastFolderMemberUrl, getFolderMembers } from './savedServerUtils';

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
	recordSuccessfulServerConnection({ url: normalizedUrl });
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

export function initializeCurrentServerMetadata(): void {
	if (!browser || building) return;
	const currentUrl = normalizeServerUrl(get(savedServersState).entries[0]?.url || '');
	if (currentUrl) {
		const state = get(savedServersState);
		const existingEntry = state.entries.find((entry) => entry.url === currentUrl);
		if (existingEntry) {
			void refreshSavedServerMetadata(currentUrl);
		}
	}
}
