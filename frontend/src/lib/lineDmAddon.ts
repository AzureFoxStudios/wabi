import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

export type LineDmPreset = 'line' | 'discord' | 'minimal';
export type LineDmWallpaperSize = 'cover' | 'contain' | 'auto';
export type LineDmWallpaperRepeat = 'no-repeat' | 'repeat' | 'repeat-x' | 'repeat-y';

export interface LineDmProfile {
	preset: LineDmPreset;
	wallpaperUrl: string | null;
	wallpaperOpacity: number;
	wallpaperBlur: number;
	wallpaperSize: LineDmWallpaperSize;
	wallpaperPosition: string;
	wallpaperRepeat: LineDmWallpaperRepeat;
	scrimOpacity: number;
	surfaceOpacity: number;
	bubbleOpacity: number;
}

export interface LineDmAddonState {
	enabled: boolean;
	defaultProfile: LineDmProfile;
	conversationProfiles: Record<string, Partial<LineDmProfile>>;
}

const STORAGE_KEY = 'wabi:addon:line-dm:v1';

export const LINE_DM_DEFAULT_PROFILE: LineDmProfile = {
	preset: 'line',
	wallpaperUrl: null,
	wallpaperOpacity: 0.32,
	wallpaperBlur: 0,
	wallpaperSize: 'cover',
	wallpaperPosition: 'center',
	wallpaperRepeat: 'no-repeat',
	scrimOpacity: 0.28,
	surfaceOpacity: 0.78,
	bubbleOpacity: 0.92
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	const numeric = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.min(max, Math.max(min, numeric));
}

function normalizePreset(value: unknown, fallback: LineDmPreset): LineDmPreset {
	return value === 'line' || value === 'discord' || value === 'minimal' ? value : fallback;
}

function normalizeWallpaperSize(
	value: unknown,
	fallback: LineDmWallpaperSize
): LineDmWallpaperSize {
	return value === 'cover' || value === 'contain' || value === 'auto' ? value : fallback;
}

function normalizeWallpaperRepeat(
	value: unknown,
	fallback: LineDmWallpaperRepeat
): LineDmWallpaperRepeat {
	return value === 'no-repeat' || value === 'repeat' || value === 'repeat-x' || value === 'repeat-y'
		? value
		: fallback;
}

function normalizeProfile(
	value: unknown,
	fallback: LineDmProfile = LINE_DM_DEFAULT_PROFILE
): LineDmProfile {
	const input = value && typeof value === 'object' ? (value as Partial<LineDmProfile>) : {};
	return {
		preset: normalizePreset(input.preset, fallback.preset),
		wallpaperUrl: typeof input.wallpaperUrl === 'string' && input.wallpaperUrl.trim() ? input.wallpaperUrl.trim() : null,
		wallpaperOpacity: clamp(input.wallpaperOpacity, 0, 1, fallback.wallpaperOpacity),
		wallpaperBlur: clamp(input.wallpaperBlur, 0, 24, fallback.wallpaperBlur),
		wallpaperSize: normalizeWallpaperSize(input.wallpaperSize, fallback.wallpaperSize),
		wallpaperPosition:
			typeof input.wallpaperPosition === 'string' && input.wallpaperPosition.trim()
				? input.wallpaperPosition.trim()
				: fallback.wallpaperPosition,
		wallpaperRepeat: normalizeWallpaperRepeat(input.wallpaperRepeat, fallback.wallpaperRepeat),
		scrimOpacity: clamp(input.scrimOpacity, 0, 0.95, fallback.scrimOpacity),
		surfaceOpacity: clamp(input.surfaceOpacity, 0.25, 1, fallback.surfaceOpacity),
		bubbleOpacity: clamp(input.bubbleOpacity, 0.25, 1, fallback.bubbleOpacity)
	};
}

function normalizeConversationProfiles(
	value: unknown
): Record<string, Partial<LineDmProfile>> {
	if (!value || typeof value !== 'object') return {};
	const out: Record<string, Partial<LineDmProfile>> = {};

	for (const [channelId, profile] of Object.entries(value as Record<string, unknown>)) {
		const normalizedId = channelId.trim();
		if (!normalizedId || !profile || typeof profile !== 'object') continue;
		const candidate = profile as Partial<LineDmProfile>;
		const next: Partial<LineDmProfile> = {};

		if (candidate.preset !== undefined) {
			next.preset = normalizePreset(candidate.preset, LINE_DM_DEFAULT_PROFILE.preset);
		}
		if (candidate.wallpaperUrl !== undefined) {
			next.wallpaperUrl =
				typeof candidate.wallpaperUrl === 'string' && candidate.wallpaperUrl.trim()
					? candidate.wallpaperUrl.trim()
					: null;
		}
		if (candidate.wallpaperOpacity !== undefined) {
			next.wallpaperOpacity = clamp(
				candidate.wallpaperOpacity,
				0,
				1,
				LINE_DM_DEFAULT_PROFILE.wallpaperOpacity
			);
		}
		if (candidate.wallpaperBlur !== undefined) {
			next.wallpaperBlur = clamp(candidate.wallpaperBlur, 0, 24, LINE_DM_DEFAULT_PROFILE.wallpaperBlur);
		}
		if (candidate.wallpaperSize !== undefined) {
			next.wallpaperSize = normalizeWallpaperSize(
				candidate.wallpaperSize,
				LINE_DM_DEFAULT_PROFILE.wallpaperSize
			);
		}
		if (candidate.wallpaperPosition !== undefined) {
			next.wallpaperPosition =
				typeof candidate.wallpaperPosition === 'string' && candidate.wallpaperPosition.trim()
					? candidate.wallpaperPosition.trim()
					: LINE_DM_DEFAULT_PROFILE.wallpaperPosition;
		}
		if (candidate.wallpaperRepeat !== undefined) {
			next.wallpaperRepeat = normalizeWallpaperRepeat(
				candidate.wallpaperRepeat,
				LINE_DM_DEFAULT_PROFILE.wallpaperRepeat
			);
		}
		if (candidate.scrimOpacity !== undefined) {
			next.scrimOpacity = clamp(candidate.scrimOpacity, 0, 0.95, LINE_DM_DEFAULT_PROFILE.scrimOpacity);
		}
		if (candidate.surfaceOpacity !== undefined) {
			next.surfaceOpacity = clamp(
				candidate.surfaceOpacity,
				0.25,
				1,
				LINE_DM_DEFAULT_PROFILE.surfaceOpacity
			);
		}
		if (candidate.bubbleOpacity !== undefined) {
			next.bubbleOpacity = clamp(
				candidate.bubbleOpacity,
				0.25,
				1,
				LINE_DM_DEFAULT_PROFILE.bubbleOpacity
			);
		}

		out[normalizedId] = next;
	}

	return out;
}

function normalizeState(value: unknown): LineDmAddonState {
	const input = value && typeof value === 'object' ? (value as Partial<LineDmAddonState>) : {};
	return {
		enabled: Boolean(input.enabled),
		defaultProfile: normalizeProfile(input.defaultProfile),
		conversationProfiles: normalizeConversationProfiles(input.conversationProfiles)
	};
}

function loadStoredState(): LineDmAddonState {
	if (!browser) {
		return {
			enabled: false,
			defaultProfile: { ...LINE_DM_DEFAULT_PROFILE },
			conversationProfiles: {}
		};
	}

	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return {
				enabled: false,
				defaultProfile: { ...LINE_DM_DEFAULT_PROFILE },
				conversationProfiles: {}
			};
		}
		return normalizeState(JSON.parse(raw));
	} catch {
		return {
			enabled: false,
			defaultProfile: { ...LINE_DM_DEFAULT_PROFILE },
			conversationProfiles: {}
		};
	}
}

export const lineDmAddonStore = writable<LineDmAddonState>(loadStoredState());

if (browser) {
	lineDmAddonStore.subscribe((value) => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
		} catch {
			// Best-effort local persistence only.
		}
	});
}

export function setLineDmAddonEnabled(enabled: boolean): void {
	lineDmAddonStore.update((state) => ({ ...state, enabled }));
}

export function updateLineDmDefaultProfile(patch: Partial<LineDmProfile>): void {
	lineDmAddonStore.update((state) => ({
		...state,
		defaultProfile: normalizeProfile({ ...state.defaultProfile, ...patch }, state.defaultProfile)
	}));
}

export function updateLineDmConversationProfile(
	channelId: string,
	patch: Partial<LineDmProfile>
): void {
	const normalizedId = channelId.trim();
	if (!normalizedId) return;

	lineDmAddonStore.update((state) => {
		const current = state.conversationProfiles[normalizedId] || {};
		return {
			...state,
			conversationProfiles: {
				...state.conversationProfiles,
				[normalizedId]: {
					...current,
					...normalizeConversationProfiles({ [normalizedId]: { ...current, ...patch } })[normalizedId]
				}
			}
		};
	});
}

export function clearLineDmConversationProfile(channelId: string): void {
	const normalizedId = channelId.trim();
	if (!normalizedId) return;

	lineDmAddonStore.update((state) => {
		if (!state.conversationProfiles[normalizedId]) return state;
		const nextProfiles = { ...state.conversationProfiles };
		delete nextProfiles[normalizedId];
		return {
			...state,
			conversationProfiles: nextProfiles
		};
	});
}

export function getLineDmResolvedProfile(
	channelId: string | null | undefined,
	state: LineDmAddonState = get(lineDmAddonStore)
): LineDmProfile {
	const normalizedId = channelId?.trim();
	if (!normalizedId) {
		return normalizeProfile(state.defaultProfile, state.defaultProfile);
	}

	const override = state.conversationProfiles[normalizedId];
	if (!override) {
		return normalizeProfile(state.defaultProfile, state.defaultProfile);
	}

	return normalizeProfile({ ...state.defaultProfile, ...override }, state.defaultProfile);
}

export function hasLineDmConversationProfile(
	channelId: string,
	state: LineDmAddonState = get(lineDmAddonStore)
): boolean {
	return Boolean(state.conversationProfiles[channelId.trim()]);
}
