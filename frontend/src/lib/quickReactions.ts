import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

export interface QuickReactionSettings {
	enabled: boolean;
	customEmojiIds: string[];
}

export const MAX_CUSTOM_QUICK_REACTION_EMOJIS = 12;

const QUICK_REACTION_SETTINGS_KEY = 'wabi.quickReactions.settings';

const DEFAULT_QUICK_REACTION_SETTINGS: QuickReactionSettings = {
	enabled: true,
	customEmojiIds: []
};

function sanitizeCustomEmojiIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const unique = new Set<string>();
	for (const item of value) {
		if (typeof item !== 'string') continue;
		const normalized = item.trim();
		if (!normalized) continue;
		unique.add(normalized);
		if (unique.size >= MAX_CUSTOM_QUICK_REACTION_EMOJIS) break;
	}
	return Array.from(unique);
}

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
	if (!normalized) return false;
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
