import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

export interface ComposerEnhancementSettings {
	spellcheckEnabled: boolean;
	charCounterEnabled: boolean;
	splitLargeMessagesEnabled: boolean;
	splitLargeMessagesChunkSize: number;
	splitLargeMessagesInputMaxLength: number;
}

const COMPOSER_ENHANCEMENTS_KEY = 'wabi.composerEnhancements.settings';
const MIN_SPLIT_CHUNK_SIZE = 250;
const MAX_SPLIT_CHUNK_SIZE = 4000;
const MIN_INPUT_MAX_LENGTH = 2000;
const MAX_INPUT_MAX_LENGTH = 100000;

const DEFAULT_COMPOSER_ENHANCEMENT_SETTINGS: ComposerEnhancementSettings = {
	spellcheckEnabled: true,
	charCounterEnabled: true,
	splitLargeMessagesEnabled: false,
	splitLargeMessagesChunkSize: 2000,
	splitLargeMessagesInputMaxLength: 20000
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function sanitizeComposerSettings(input: Partial<ComposerEnhancementSettings> | null | undefined): ComposerEnhancementSettings {
	const base = input || {};
	const splitLargeMessagesChunkSize = clampNumber(
		base.splitLargeMessagesChunkSize,
		DEFAULT_COMPOSER_ENHANCEMENT_SETTINGS.splitLargeMessagesChunkSize,
		MIN_SPLIT_CHUNK_SIZE,
		MAX_SPLIT_CHUNK_SIZE
	);
	const splitLargeMessagesInputMaxLength = Math.max(
		splitLargeMessagesChunkSize,
		clampNumber(
			base.splitLargeMessagesInputMaxLength,
			DEFAULT_COMPOSER_ENHANCEMENT_SETTINGS.splitLargeMessagesInputMaxLength,
			MIN_INPUT_MAX_LENGTH,
			MAX_INPUT_MAX_LENGTH
		)
	);

	return {
		spellcheckEnabled: base.spellcheckEnabled !== false,
		charCounterEnabled: base.charCounterEnabled !== false,
		splitLargeMessagesEnabled: base.splitLargeMessagesEnabled === true,
		splitLargeMessagesChunkSize,
		splitLargeMessagesInputMaxLength
	};
}

function safeReadComposerSettings(): ComposerEnhancementSettings {
	if (!browser) return { ...DEFAULT_COMPOSER_ENHANCEMENT_SETTINGS };
	try {
		const raw = localStorage.getItem(COMPOSER_ENHANCEMENTS_KEY);
		if (!raw) return { ...DEFAULT_COMPOSER_ENHANCEMENT_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<ComposerEnhancementSettings>;
		return sanitizeComposerSettings(parsed);
	} catch {
		return { ...DEFAULT_COMPOSER_ENHANCEMENT_SETTINGS };
	}
}

function safeWriteComposerSettings(value: ComposerEnhancementSettings): void {
	if (!browser) return;
	try {
		localStorage.setItem(COMPOSER_ENHANCEMENTS_KEY, JSON.stringify(value));
	} catch {
		// best-effort persistence
	}
}

export const composerEnhancementSettingsStore = writable<ComposerEnhancementSettings>(
	safeReadComposerSettings()
);

if (browser) {
	composerEnhancementSettingsStore.subscribe((settings) => {
		safeWriteComposerSettings(sanitizeComposerSettings(settings));
	});
}

export function setSpellCheckEnabled(enabled: boolean): void {
	composerEnhancementSettingsStore.update((current) =>
		sanitizeComposerSettings({
			...current,
			spellcheckEnabled: enabled
		})
	);
}

export function setCharCounterEnabled(enabled: boolean): void {
	composerEnhancementSettingsStore.update((current) =>
		sanitizeComposerSettings({
			...current,
			charCounterEnabled: enabled
		})
	);
}

export function setSplitLargeMessagesEnabled(enabled: boolean): void {
	composerEnhancementSettingsStore.update((current) =>
		sanitizeComposerSettings({
			...current,
			splitLargeMessagesEnabled: enabled
		})
	);
}

export function setSplitLargeMessagesChunkSize(chunkSize: number): void {
	composerEnhancementSettingsStore.update((current) =>
		sanitizeComposerSettings({
			...current,
			splitLargeMessagesChunkSize: chunkSize
		})
	);
}

export function getComposerEnhancementSettings(): ComposerEnhancementSettings {
	return get(composerEnhancementSettingsStore);
}

export function splitMessageForSending(input: string, chunkSize?: number): string[] {
	const settings = getComposerEnhancementSettings();
	const maxChunkLength =
		typeof chunkSize === 'number'
			? clampNumber(chunkSize, settings.splitLargeMessagesChunkSize, MIN_SPLIT_CHUNK_SIZE, MAX_SPLIT_CHUNK_SIZE)
			: settings.splitLargeMessagesChunkSize;

	const normalized = input.trim();
	if (!normalized) return [];
	if (normalized.length <= maxChunkLength) return [normalized];

	const chunks: string[] = [];
	let remaining = normalized;

	while (remaining.length > maxChunkLength) {
		let splitAt = remaining.lastIndexOf('\n', maxChunkLength);
		if (splitAt < Math.floor(maxChunkLength * 0.6)) {
			splitAt = remaining.lastIndexOf(' ', maxChunkLength);
		}
		if (splitAt <= 0) {
			splitAt = maxChunkLength;
		}

		const segment = remaining.slice(0, splitAt).trim();
		if (segment) {
			chunks.push(segment);
		}
		remaining = remaining.slice(splitAt).trimStart();
	}

	if (remaining.trim()) {
		chunks.push(remaining.trim());
	}

	return chunks;
}
