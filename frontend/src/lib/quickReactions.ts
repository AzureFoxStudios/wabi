import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

export interface QuickReactionSettings {
	enabled: boolean;
	customEmojiIds: string[];
}

export const MAX_CUSTOM_QUICK_REACTION_EMOJIS = 12;

/**
 * Junk-emoji deny list for the quick-reaction strip.
 *
 * Context: the fallback pool that fills the strip when no custom ids are set
 * is built in `MessageList.svelte` (~line 1402) by scanning the head of the
 * emoji catalog (openmoji order), whose first entries are keycap `#`, `*`,
 * `hyphen-minus`, keycap `0`, … — so users see weird glyphs. That pool builder
 * lives outside this module, so the lever available HERE is sanitizing the
 * custom-id path: any junk id a user (or a previous default) stored is dropped
 * on read/write, and `isJunkQuickReactionEmojiId` is exported so the
 * MessageList fallback scan can reuse it in a follow-up.
 */
const QUICK_REACTION_JUNK_NAME_EXACT = new Set([
	'#',
	'*',
	'-',
	'+',
	'hash',
	'asterisk',
	'hyphen-minus',
	'hyphen',
	'minus',
	'keycap',
	'keycap-number-sign',
	'keycap-asterisk',
	'keycap-digit-zero',
	'keycap-digit-one',
	'keycap-digit-two',
	'keycap-digit-three',
	'keycap-digit-four',
	'keycap-digit-five',
	'keycap-digit-six',
	'keycap-digit-seven',
	'keycap-digit-eight',
	'keycap-digit-nine'
]);

const QUICK_REACTION_JUNK_ID_PATTERNS: RegExp[] = [
	/^keycap/i,
	/^regional_indicator/i,
	/^hyphen/i,
	/^minus$/i,
	/^[0-9#*+\-]$/,
	/^digit_[0-9]$/i,
	/^keycap_[0-9#*]$/i
];

export function isJunkQuickReactionEmojiId(emojiId: string | null | undefined): boolean {
	const normalized = (emojiId ?? '').trim().toLowerCase().replace(/[^a-z0-9#+*_ -]/g, '');
	if (!normalized) return true;
	if (QUICK_REACTION_JUNK_NAME_EXACT.has(normalized)) return true;
	return QUICK_REACTION_JUNK_ID_PATTERNS.some((pattern) => pattern.test(normalized));
}

function sanitizeCustomEmojiIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const unique = new Set<string>();
	for (const item of value) {
		if (typeof item !== 'string') continue;
		const normalized = item.trim();
		if (!normalized) continue;
		if (isJunkQuickReactionEmojiId(normalized)) continue;
		unique.add(normalized);
		if (unique.size >= MAX_CUSTOM_QUICK_REACTION_EMOJIS) break;
	}
	return Array.from(unique);
}

const QUICK_REACTION_SETTINGS_KEY = 'wabi.quickReactions.settings';

const DEFAULT_QUICK_REACTION_SETTINGS: QuickReactionSettings = {
	enabled: true,
	customEmojiIds: []
};

function sanitizeQuickReactionSettings(
	input: Partial<QuickReactionSettings> | null | undefined
): QuickReactionSettings {
	const current = input || {};
	return {
		enabled: current.enabled !== false,
		customEmojiIds: sanitizeCustomEmojiIds(current.customEmojiIds)
	};
}

function safeReadQuickReactionSettings(): QuickReactionSettings {
	if (!browser) return { ...DEFAULT_QUICK_REACTION_SETTINGS };
	try {
		const raw = localStorage.getItem(QUICK_REACTION_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_QUICK_REACTION_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<QuickReactionSettings>;
		return sanitizeQuickReactionSettings(parsed);
	} catch {
		return { ...DEFAULT_QUICK_REACTION_SETTINGS };
	}
}

function safeWriteQuickReactionSettings(value: QuickReactionSettings): void {
	if (!browser) return;
	try {
		localStorage.setItem(QUICK_REACTION_SETTINGS_KEY, JSON.stringify(value));
	} catch {
		// best-effort persistence
	}
}

export const quickReactionSettingsStore = writable<QuickReactionSettings>(
	safeReadQuickReactionSettings()
);

if (browser) {
	quickReactionSettingsStore.subscribe((settings) => {
		safeWriteQuickReactionSettings(sanitizeQuickReactionSettings(settings));
	});
}

export function getQuickReactionSettings(): QuickReactionSettings {
	return get(quickReactionSettingsStore);
}

export function setQuickReactionsEnabled(enabled: boolean): void {
	quickReactionSettingsStore.update((current) =>
		sanitizeQuickReactionSettings({
			...current,
			enabled
		})
	);
}

export function setQuickReactionCustomEmojiIds(customEmojiIds: string[]): void {
	quickReactionSettingsStore.update((current) =>
		sanitizeQuickReactionSettings({
			...current,
			customEmojiIds
		})
	);
}

export function addQuickReactionCustomEmojiId(emojiId: string): boolean {
	const normalized = emojiId.trim();
	if (!normalized || isJunkQuickReactionEmojiId(normalized)) return false;
	const settings = getQuickReactionSettings();
	if (settings.customEmojiIds.includes(normalized)) return false;
	if (settings.customEmojiIds.length >= MAX_CUSTOM_QUICK_REACTION_EMOJIS) return false;
	setQuickReactionCustomEmojiIds([...settings.customEmojiIds, normalized]);
	return true;
}

export function removeQuickReactionCustomEmojiId(emojiId: string): void {
	const normalized = emojiId.trim();
	if (!normalized) return;
	quickReactionSettingsStore.update((current) =>
		sanitizeQuickReactionSettings({
			...current,
			customEmojiIds: current.customEmojiIds.filter((id) => id !== normalized)
		})
	);
}

export function clearQuickReactionCustomEmojiIds(): void {
	quickReactionSettingsStore.update((current) =>
		sanitizeQuickReactionSettings({
			...current,
			customEmojiIds: []
		})
	);
}
