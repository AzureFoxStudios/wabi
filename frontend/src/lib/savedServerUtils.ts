/**
 * savedServerUtils.ts
 * Utility functions for server entry sanitization, normalization, and display
 */

import { browser } from '$app/environment';
import type { FrontendAppMetadataPolicy, LaunchPageConfig } from './api';
import { getAuthToken, getGuestSessionId, getStoredDbUserId, getStoredUsername } from './authSession';
import { normalizeServerUrl } from './serverUrl';
import type { SavedServerEntry, SavedServerFolder, SavedServerView } from './savedServers';

export function createFolderId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `folder-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeAlias(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().slice(0, 80);
	return trimmed.length > 0 ? trimmed : null;
}

export function sanitizeServerEntry(value: unknown, fallbackOrder: number): SavedServerEntry | null {
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
				: null,
		useNeutralBranding: input.useNeutralBranding === true
	};
}

export function sanitizeFolder(value: unknown): SavedServerFolder | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const id = typeof input.id === 'string' ? input.id.trim().slice(0, 64) : '';
	const name = typeof input.name === 'string' ? input.name.trim().slice(0, 40) : '';
	if (!id) return null;
	return { id, name };
}

export function sortEntries(entries: SavedServerEntry[]): SavedServerEntry[] {
	return [...entries].sort((a, b) => {
		if (a.order !== b.order) return a.order - b.order;
		return b.lastConnectedAt - a.lastConnectedAt;
	});
}

export function defaultDisplayName(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.hostname;
	} catch {
		return url;
	}
}

export function resolveServerAssetUrl(serverUrl: string, assetUrl: string | null | undefined): string | null {
	if (!assetUrl) return null;
	const trimmed = assetUrl.trim();
	if (!trimmed) return null;
	try {
		return new URL(trimmed, serverUrl).toString();
	} catch {
		return trimmed;
	}
}

export function deriveServerView(entry: SavedServerEntry, activeUrl: string | null): SavedServerView {
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
	const effectiveTagline =
		metadata?.tagline ||
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
		effectiveTagline,
		isActive: activeUrl === entry.url
	};
}

export function getFolderMembers(entries: SavedServerEntry[], folderId: string, excludeUrl?: string): SavedServerEntry[] {
	return sortEntries(entries).filter((entry) => entry.folderId === folderId && entry.url !== excludeUrl);
}

export function getLastFolderMemberUrl(entries: SavedServerEntry[], folderId: string, excludeUrl?: string): string | null {
	const members = getFolderMembers(entries, folderId, excludeUrl);
	return members[members.length - 1]?.url || null;
}
