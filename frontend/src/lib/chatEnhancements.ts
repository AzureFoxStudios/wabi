import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

export interface ChatAliasEntry {
	id: string;
	trigger: string;
	replacement: string;
	enabled: boolean;
}

export type ChatFilterMode = 'censor' | 'hide';

export interface ChatFilterSettings {
	enabled: boolean;
	mode: ChatFilterMode;
	terms: string[];
	replacement: string;
	applyToIncoming: boolean;
	applyToOutgoing: boolean;
}

export interface CustomQuoteSettings {
	template: string;
}

export interface CustomQuotePayload {
	user: string;
	text: string;
	timestamp: number;
	channel?: string;
	messageId?: string;
}

export interface ChatFilterResult {
	hidden: boolean;
	text: string;
	matchedTerms: string[];
}

const CHAT_ALIASES_KEY = 'wabi.chatEnhancements.aliases';
const CHAT_FILTER_KEY = 'wabi.chatEnhancements.filter';
const CUSTOM_QUOTE_KEY = 'wabi.chatEnhancements.quote';

const DEFAULT_CHAT_FILTER: ChatFilterSettings = {
	enabled: false,
	mode: 'censor',
	terms: [],
	replacement: '***',
	applyToIncoming: true,
	applyToOutgoing: true
};

const DEFAULT_CUSTOM_QUOTE_TEMPLATE = '> {text}\n- {user} ({timestamp})';

const DEFAULT_CUSTOM_QUOTE_SETTINGS: CustomQuoteSettings = {
	template: DEFAULT_CUSTOM_QUOTE_TEMPLATE
};

function safeReadJson<T>(key: string, fallback: T): T {
	if (!browser) return fallback;
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return fallback;
		const parsed = JSON.parse(raw) as T;
		return parsed ?? fallback;
	} catch {
		return fallback;
	}
}

function safeWriteJson<T>(key: string, value: T): void {
	if (!browser) return;
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// best effort persistence
	}
}

function normalizeTerms(input: string[]): string[] {
	return input
		.map((term) => term.trim().toLowerCase())
		.filter(Boolean)
		.filter((term, index, all) => all.indexOf(term) === index);
}

function sanitizeAliases(input: ChatAliasEntry[]): ChatAliasEntry[] {
	return input
		.map((entry) => ({
			id: entry.id || `alias-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			trigger: normalizeAliasTrigger(entry.trigger),
			replacement: (entry.replacement || '').trim(),
			enabled: entry.enabled !== false
		}))
		.filter((entry) => Boolean(entry.trigger && entry.replacement));
}

function sanitizeFilter(input: ChatFilterSettings): ChatFilterSettings {
	return {
		enabled: input.enabled === true,
		mode: input.mode === 'hide' ? 'hide' : 'censor',
		terms: normalizeTerms(Array.isArray(input.terms) ? input.terms : []),
		replacement: (input.replacement || '***').trim() || '***',
		applyToIncoming: input.applyToIncoming !== false,
		applyToOutgoing: input.applyToOutgoing !== false
	};
}

function sanitizeQuoteSettings(input: CustomQuoteSettings): CustomQuoteSettings {
	return {
		template: (input.template || '').trim() || DEFAULT_CUSTOM_QUOTE_TEMPLATE
	};
}

function loadAliases(): ChatAliasEntry[] {
	const parsed = safeReadJson<ChatAliasEntry[]>(CHAT_ALIASES_KEY, []);
	return sanitizeAliases(Array.isArray(parsed) ? parsed : []);
}

function loadFilterSettings(): ChatFilterSettings {
	const parsed = safeReadJson<ChatFilterSettings>(CHAT_FILTER_KEY, DEFAULT_CHAT_FILTER);
	return sanitizeFilter(parsed || DEFAULT_CHAT_FILTER);
}

function loadQuoteSettings(): CustomQuoteSettings {
	const parsed = safeReadJson<CustomQuoteSettings>(CUSTOM_QUOTE_KEY, DEFAULT_CUSTOM_QUOTE_SETTINGS);
	return sanitizeQuoteSettings(parsed || DEFAULT_CUSTOM_QUOTE_SETTINGS);
}

export const chatAliasesStore = writable<ChatAliasEntry[]>(loadAliases());
export const chatFilterStore = writable<ChatFilterSettings>(loadFilterSettings());
export const customQuoteSettingsStore = writable<CustomQuoteSettings>(loadQuoteSettings());

if (browser) {
	chatAliasesStore.subscribe((aliases) => {
		safeWriteJson(CHAT_ALIASES_KEY, sanitizeAliases(aliases));
	});
	chatFilterStore.subscribe((settings) => {
		safeWriteJson(CHAT_FILTER_KEY, sanitizeFilter(settings));
	});
	customQuoteSettingsStore.subscribe((settings) => {
		safeWriteJson(CUSTOM_QUOTE_KEY, sanitizeQuoteSettings(settings));
	});
}

export function normalizeAliasTrigger(trigger: string): string {
	const trimmed = trigger.trim().toLowerCase();
	if (!trimmed) return '';
	return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function setChatAliases(aliases: ChatAliasEntry[]): void {
	chatAliasesStore.set(sanitizeAliases(aliases));
}

export function addChatAlias(trigger: string, replacement: string): void {
	const normalizedTrigger = normalizeAliasTrigger(trigger);
	const normalizedReplacement = replacement.trim();
	if (!normalizedTrigger || !normalizedReplacement) return;

	chatAliasesStore.update((current) => {
		const withoutDuplicate = current.filter(
			(entry) => normalizeAliasTrigger(entry.trigger) !== normalizedTrigger
		);
		return [
			...withoutDuplicate,
			{
				id: `alias-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				trigger: normalizedTrigger,
				replacement: normalizedReplacement,
				enabled: true
			}
		];
	});
}

export function updateChatAlias(
	id: string,
	updates: Partial<Pick<ChatAliasEntry, 'trigger' | 'replacement' | 'enabled'>>
): void {
	chatAliasesStore.update((current) =>
		current.map((entry) => {
			if (entry.id !== id) return entry;
			return {
				...entry,
				trigger:
					typeof updates.trigger === 'string'
						? normalizeAliasTrigger(updates.trigger)
						: entry.trigger,
				replacement:
					typeof updates.replacement === 'string'
						? updates.replacement.trim()
						: entry.replacement,
				enabled:
					typeof updates.enabled === 'boolean'
						? updates.enabled
						: entry.enabled
			};
		})
	);
}

export function removeChatAlias(id: string): void {
	chatAliasesStore.update((current) => current.filter((entry) => entry.id !== id));
}

export function expandInputWithChatAlias(
	input: string,
	aliases: ChatAliasEntry[] = get(chatAliasesStore)
): string {
	const trimmed = input.trim();
	if (!trimmed.startsWith('/')) return input;

	const [rawTrigger, ...argsParts] = trimmed.split(/\s+/);
	const normalizedTrigger = normalizeAliasTrigger(rawTrigger);
	const match = aliases.find(
		(entry) => entry.enabled && normalizeAliasTrigger(entry.trigger) === normalizedTrigger
	);
	if (!match) return input;

	const args = argsParts.join(' ');
	let output = match.replacement;
	if (output.includes('{args}')) {
		output = output.replace(/\{args\}/gi, args);
	} else if (args) {
		output = `${output} ${args}`.trim();
	}
	return output.trim();
}

export function setChatFilterSettings(next: Partial<ChatFilterSettings>): void {
	chatFilterStore.update((current) => sanitizeFilter({ ...current, ...next }));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyChatFilter(
	text: string,
	direction: 'incoming' | 'outgoing',
	settings: ChatFilterSettings = get(chatFilterStore)
): ChatFilterResult {
	if (!settings.enabled) {
		return {
			hidden: false,
			text,
			matchedTerms: []
		};
	}

	if (direction === 'incoming' && !settings.applyToIncoming) {
		return {
			hidden: false,
			text,
			matchedTerms: []
		};
	}

	if (direction === 'outgoing' && !settings.applyToOutgoing) {
		return {
			hidden: false,
			text,
			matchedTerms: []
		};
	}

	const lowerText = text.toLowerCase();
	const matchedTerms = settings.terms.filter((term) => lowerText.includes(term));
	if (matchedTerms.length === 0) {
		return {
			hidden: false,
			text,
			matchedTerms: []
		};
	}

	if (settings.mode === 'hide') {
		return {
			hidden: true,
			text: '',
			matchedTerms
		};
	}

	let filteredText = text;
	for (const term of matchedTerms) {
		const matcher = new RegExp(escapeRegExp(term), 'gi');
		filteredText = filteredText.replace(matcher, settings.replacement);
	}

	return {
		hidden: false,
		text: filteredText,
		matchedTerms
	};
}

export function setCustomQuoteTemplate(template: string): void {
	customQuoteSettingsStore.set(
		sanitizeQuoteSettings({
			template
		})
	);
}

export function resetCustomQuoteTemplate(): void {
	customQuoteSettingsStore.set({ ...DEFAULT_CUSTOM_QUOTE_SETTINGS });
}

export function formatCustomQuote(
	payload: CustomQuotePayload,
	settings: CustomQuoteSettings = get(customQuoteSettingsStore)
): string {
	const template = settings.template?.trim() || DEFAULT_CUSTOM_QUOTE_TEMPLATE;
	const replacements: Record<string, string> = {
		user: payload.user || 'Unknown',
		text: payload.text || '[empty]',
		timestamp: new Date(payload.timestamp).toLocaleString(),
		channel: payload.channel || '',
		message_id: payload.messageId || ''
	};

	return template.replace(/\{(user|text|timestamp|channel|message_id)\}/gi, (match, key) => {
		const normalizedKey = String(key).toLowerCase();
		return replacements[normalizedKey] ?? match;
	});
}

