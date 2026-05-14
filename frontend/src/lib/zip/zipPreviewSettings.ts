import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

export type ZipPreviewSortMode = 'name_asc' | 'name_desc' | 'size_desc' | 'size_asc';

export interface ZipPreviewSettings {
	enabled: boolean;
	inlinePreviewEnabled: boolean;
	sortMode: ZipPreviewSortMode;
}

const ZIP_PREVIEW_SETTINGS_KEY = 'wabi.zipPreview.settings';

const DEFAULT_ZIP_PREVIEW_SETTINGS: ZipPreviewSettings = {
	enabled: true,
	inlinePreviewEnabled: true,
	sortMode: 'name_asc'
};

function sanitizeSortMode(value: unknown): ZipPreviewSortMode {
	if (value === 'name_desc') return 'name_desc';
	if (value === 'size_desc') return 'size_desc';
	if (value === 'size_asc') return 'size_asc';
	return 'name_asc';
}

function sanitizeZipPreviewSettings(
	input: Partial<ZipPreviewSettings> | null | undefined
): ZipPreviewSettings {
	return {
		enabled: input?.enabled !== false,
		inlinePreviewEnabled: input?.inlinePreviewEnabled !== false,
		sortMode: sanitizeSortMode(input?.sortMode)
	};
}

function safeReadZipPreviewSettings(): ZipPreviewSettings {
	if (!browser) return { ...DEFAULT_ZIP_PREVIEW_SETTINGS };
	try {
		const raw = localStorage.getItem(ZIP_PREVIEW_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_ZIP_PREVIEW_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<ZipPreviewSettings>;
		return sanitizeZipPreviewSettings(parsed);
	} catch {
		return { ...DEFAULT_ZIP_PREVIEW_SETTINGS };
	}
}

function safeWriteZipPreviewSettings(value: ZipPreviewSettings): void {
	if (!browser) return;
	try {
		localStorage.setItem(ZIP_PREVIEW_SETTINGS_KEY, JSON.stringify(value));
	} catch {
		// best-effort persistence
	}
}

export const zipPreviewSettingsStore = writable<ZipPreviewSettings>(safeReadZipPreviewSettings());

if (browser) {
	zipPreviewSettingsStore.subscribe((settings) => {
		safeWriteZipPreviewSettings(sanitizeZipPreviewSettings(settings));
	});
}

export function getZipPreviewSettings(): ZipPreviewSettings {
	return get(zipPreviewSettingsStore);
}

export function setZipPreviewEnabled(enabled: boolean): void {
	zipPreviewSettingsStore.update((current) =>
		sanitizeZipPreviewSettings({
			...current,
			enabled
		})
	);
}

export function setZipPreviewInlinePreviewEnabled(enabled: boolean): void {
	zipPreviewSettingsStore.update((current) =>
		sanitizeZipPreviewSettings({
			...current,
			inlinePreviewEnabled: enabled
		})
	);
}

export function setZipPreviewSortMode(sortMode: ZipPreviewSortMode): void {
	zipPreviewSettingsStore.update((current) =>
		sanitizeZipPreviewSettings({
			...current,
			sortMode
		})
	);
}
