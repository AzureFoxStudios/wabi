import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
import type { Emoji } from './socket-types';
import { computeUnicodeEmojiConversion } from './unicodeEmojisCore';

export type UnicodeEmojiSource = 'default' | 'openmoji';

export interface UnicodeEmojiSettings {
	enabled: boolean;
	convertDefault: boolean;
	convertOpenmoji: boolean;
}

export interface UnicodeEmojiTelemetrySnapshot {
	convertedTokens: number;
	unknownTokens: number;
	shortcodeCollisions: number;
	lastUpdatedAt: number | null;
}

export interface UnicodeEmojiConversionPreview {
	convertedText: string;
	convertedTokens: number;
	unknownTokens: number;
	shortcodeCollisions: number;
}

export interface UnicodeEmojiPreferencesExport {
	version: 1;
	exportedAt: number;
	settings: UnicodeEmojiSettings;
	telemetry?: UnicodeEmojiTelemetrySnapshot;
}

const UNICODE_EMOJI_SETTINGS_KEY = 'wabi.unicodeEmojis.settings';
// Stored in browser localStorage only. This module never sends these counters over the network.
const UNICODE_EMOJI_TELEMETRY_KEY = 'wabi.unicodeEmojis.telemetry';

const DEFAULT_UNICODE_EMOJI_SETTINGS: UnicodeEmojiSettings = {
	enabled: false,
	convertDefault: true,
	convertOpenmoji: true
};

const DEFAULT_UNICODE_EMOJI_TELEMETRY: UnicodeEmojiTelemetrySnapshot = {
	convertedTokens: 0,
	unknownTokens: 0,
	shortcodeCollisions: 0,
	lastUpdatedAt: null
};

function sanitizeUnicodeEmojiSettings(
	input: Partial<UnicodeEmojiSettings> | null | undefined
): UnicodeEmojiSettings {
	return {
		enabled: input?.enabled === true,
		convertDefault: input?.convertDefault !== false,
		convertOpenmoji: input?.convertOpenmoji !== false
	};
}

function sanitizeTelemetryCounter(value: unknown): number {
	const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(parsed) || parsed < 0) return 0;
	return Math.floor(parsed);
}

function sanitizeUnicodeEmojiTelemetry(
	input: Partial<UnicodeEmojiTelemetrySnapshot> | null | undefined
): UnicodeEmojiTelemetrySnapshot {
	const current = input || {};
	const lastUpdatedAtRaw =
		typeof current.lastUpdatedAt === 'number' && Number.isFinite(current.lastUpdatedAt)
			? Math.floor(current.lastUpdatedAt)
			: null;
	return {
		convertedTokens: sanitizeTelemetryCounter(current.convertedTokens),
		unknownTokens: sanitizeTelemetryCounter(current.unknownTokens),
		shortcodeCollisions: sanitizeTelemetryCounter(current.shortcodeCollisions),
		lastUpdatedAt: lastUpdatedAtRaw && lastUpdatedAtRaw > 0 ? lastUpdatedAtRaw : null
	};
}

function safeReadUnicodeEmojiSettings(): UnicodeEmojiSettings {
	if (!browser) return { ...DEFAULT_UNICODE_EMOJI_SETTINGS };
	try {
		const raw = localStorage.getItem(UNICODE_EMOJI_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_UNICODE_EMOJI_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<UnicodeEmojiSettings>;
		return sanitizeUnicodeEmojiSettings(parsed);
	} catch {
		return { ...DEFAULT_UNICODE_EMOJI_SETTINGS };
	}
}

function safeReadUnicodeEmojiTelemetry(): UnicodeEmojiTelemetrySnapshot {
	if (!browser) return { ...DEFAULT_UNICODE_EMOJI_TELEMETRY };
	try {
		const raw = localStorage.getItem(UNICODE_EMOJI_TELEMETRY_KEY);
		if (!raw) return { ...DEFAULT_UNICODE_EMOJI_TELEMETRY };
		const parsed = JSON.parse(raw) as Partial<UnicodeEmojiTelemetrySnapshot>;
		return sanitizeUnicodeEmojiTelemetry(parsed);
	} catch {
		return { ...DEFAULT_UNICODE_EMOJI_TELEMETRY };
	}
}

function safeWriteUnicodeEmojiSettings(value: UnicodeEmojiSettings): void {
	if (!browser) return;
	try {
		localStorage.setItem(UNICODE_EMOJI_SETTINGS_KEY, JSON.stringify(value));
	} catch {
		// best-effort persistence
	}
}

function safeWriteUnicodeEmojiTelemetry(value: UnicodeEmojiTelemetrySnapshot): void {
	if (!browser) return;
	try {
		localStorage.setItem(UNICODE_EMOJI_TELEMETRY_KEY, JSON.stringify(value));
	} catch {
		// best-effort persistence
	}
}

export const unicodeEmojiSettingsStore = writable<UnicodeEmojiSettings>(
	safeReadUnicodeEmojiSettings()
);

export const unicodeEmojiTelemetryStore = writable<UnicodeEmojiTelemetrySnapshot>(
	safeReadUnicodeEmojiTelemetry()
);

if (browser) {
	unicodeEmojiSettingsStore.subscribe((settings) => {
		safeWriteUnicodeEmojiSettings(sanitizeUnicodeEmojiSettings(settings));
	});
	unicodeEmojiTelemetryStore.subscribe((snapshot) => {
		safeWriteUnicodeEmojiTelemetry(sanitizeUnicodeEmojiTelemetry(snapshot));
	});
}

export function getUnicodeEmojiSettings(): UnicodeEmojiSettings {
	return get(unicodeEmojiSettingsStore);
}

export function setUnicodeEmojiConversionEnabled(enabled: boolean): void {
	unicodeEmojiSettingsStore.set(
		sanitizeUnicodeEmojiSettings({
			enabled
		})
	);
}

export function setUnicodeEmojiSourceEnabled(source: UnicodeEmojiSource, enabled: boolean): void {
	unicodeEmojiSettingsStore.update((current) => {
		const next = { ...current };
		if (source === 'default') {
			next.convertDefault = enabled;
		} else {
			next.convertOpenmoji = enabled;
		}
		return sanitizeUnicodeEmojiSettings(next);
	});
}

export function setUnicodeEmojiDefaultSourceEnabled(enabled: boolean): void {
	setUnicodeEmojiSourceEnabled('default', enabled);
}

export function setUnicodeEmojiOpenmojiSourceEnabled(enabled: boolean): void {
	setUnicodeEmojiSourceEnabled('openmoji', enabled);
}

export function getUnicodeEmojiTelemetrySnapshot(): UnicodeEmojiTelemetrySnapshot {
	return get(unicodeEmojiTelemetryStore);
}

export function resetUnicodeEmojiTelemetry(): void {
	unicodeEmojiTelemetryStore.set({ ...DEFAULT_UNICODE_EMOJI_TELEMETRY });
}

export function exportUnicodeEmojiPreferences(includeTelemetry = false): string {
	const payload: UnicodeEmojiPreferencesExport = {
		version: 1,
		exportedAt: Date.now(),
		settings: sanitizeUnicodeEmojiSettings(getUnicodeEmojiSettings())
	};
	if (includeTelemetry) {
		payload.telemetry = sanitizeUnicodeEmojiTelemetry(getUnicodeEmojiTelemetrySnapshot());
	}
	return JSON.stringify(payload, null, 2);
}

export function importUnicodeEmojiPreferences(raw: string): {
	settings: UnicodeEmojiSettings;
	telemetryImported: boolean;
} {
	const parsed = JSON.parse(raw) as
		| Partial<UnicodeEmojiPreferencesExport>
		| Partial<UnicodeEmojiSettings>
		| null;

	const settingsCandidate =
		parsed && typeof parsed === 'object' && 'settings' in parsed
			? (parsed.settings as Partial<UnicodeEmojiSettings>)
			: (parsed as Partial<UnicodeEmojiSettings>);

	const sanitizedSettings = sanitizeUnicodeEmojiSettings(settingsCandidate);
	unicodeEmojiSettingsStore.set(sanitizedSettings);

	let telemetryImported = false;
	if (
		parsed &&
		typeof parsed === 'object' &&
		'telemetry' in parsed &&
		parsed.telemetry &&
		typeof parsed.telemetry === 'object'
	) {
		unicodeEmojiTelemetryStore.set(
			sanitizeUnicodeEmojiTelemetry(parsed.telemetry as Partial<UnicodeEmojiTelemetrySnapshot>)
		);
		telemetryImported = true;
	}

	return {
		settings: sanitizedSettings,
		telemetryImported
	};
}

function recordUnicodeEmojiTelemetry(delta: {
	convertedTokens: number;
	unknownTokens: number;
	shortcodeCollisions: number;
}): void {
	if (
		delta.convertedTokens <= 0 &&
		delta.unknownTokens <= 0 &&
		delta.shortcodeCollisions <= 0
	) {
		return;
	}
	unicodeEmojiTelemetryStore.update((current) =>
		sanitizeUnicodeEmojiTelemetry({
			convertedTokens: current.convertedTokens + delta.convertedTokens,
			unknownTokens: current.unknownTokens + delta.unknownTokens,
			shortcodeCollisions: current.shortcodeCollisions + delta.shortcodeCollisions,
			lastUpdatedAt: Date.now()
		})
	);
}

export function previewUnicodeEmojiConversion(
	text: string,
	emojiCatalog: Emoji[],
	settingsOverride?: Partial<UnicodeEmojiSettings>
): UnicodeEmojiConversionPreview {
	if (!text.includes(':')) {
		return {
			convertedText: text,
			convertedTokens: 0,
			unknownTokens: 0,
			shortcodeCollisions: 0
		};
	}
	const settings = sanitizeUnicodeEmojiSettings(settingsOverride ?? getUnicodeEmojiSettings());
	if (!settings.enabled || (!settings.convertDefault && !settings.convertOpenmoji)) {
		return {
			convertedText: text,
			convertedTokens: 0,
			unknownTokens: 0,
			shortcodeCollisions: 0
		};
	}
	return computeUnicodeEmojiConversion(text, emojiCatalog, settings);
}

export function replaceEmojiShortcodesWithUnicode(
	text: string,
	emojiCatalog: Emoji[],
	enabled: boolean,
	settingsOverride?: Partial<UnicodeEmojiSettings>
): string {
	if (!enabled || !text.includes(':')) return text;
	const settings = sanitizeUnicodeEmojiSettings(settingsOverride ?? getUnicodeEmojiSettings());
	if (!settings.enabled) return text;
	if (!settings.convertDefault && !settings.convertOpenmoji) return text;

	const result = computeUnicodeEmojiConversion(text, emojiCatalog, settings);
	recordUnicodeEmojiTelemetry({
		convertedTokens: result.convertedTokens,
		unknownTokens: result.unknownTokens,
		shortcodeCollisions: result.shortcodeCollisions
	});
	return result.convertedText;
}
