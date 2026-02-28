import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

type PersonalPinMap = Record<string, string[]>;

const PERSONAL_PINS_STORAGE_KEY = 'wabi.personalPins.byChannel';

function sanitizePinMap(input: unknown): PersonalPinMap {
	if (!input || typeof input !== 'object') return {};
	const map: PersonalPinMap = {};
	for (const [channelId, value] of Object.entries(input as Record<string, unknown>)) {
		const normalizedChannelId = String(channelId || '').trim();
		if (!normalizedChannelId || !Array.isArray(value)) continue;
		const ids = value
			.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
			.filter(Boolean)
			.filter((entry, index, array) => array.indexOf(entry) === index);
		if (ids.length > 0) {
			map[normalizedChannelId] = ids;
		}
	}
	return map;
}

function safeReadPinMap(): PersonalPinMap {
	if (!browser) return {};
	try {
		const raw = localStorage.getItem(PERSONAL_PINS_STORAGE_KEY);
		if (!raw) return {};
		return sanitizePinMap(JSON.parse(raw));
	} catch {
		return {};
	}
}

function safeWritePinMap(map: PersonalPinMap): void {
	if (!browser) return;
	try {
		localStorage.setItem(PERSONAL_PINS_STORAGE_KEY, JSON.stringify(sanitizePinMap(map)));
	} catch {
		// best-effort persistence
	}
}

export const personalPinsStore = writable<PersonalPinMap>(safeReadPinMap());

if (browser) {
	personalPinsStore.subscribe((map) => {
		safeWritePinMap(map);
	});
}

export function getPersonalPinsForChannel(
	channelId: string,
	pinMap: PersonalPinMap = get(personalPinsStore)
): string[] {
	const normalizedChannelId = channelId.trim();
	if (!normalizedChannelId) return [];
	return pinMap[normalizedChannelId] || [];
}

export function isMessagePersonalPinned(
	channelId: string,
	messageId: string,
	pinMap: PersonalPinMap = get(personalPinsStore)
): boolean {
	const normalizedMessageId = messageId.trim();
	if (!normalizedMessageId) return false;
	return getPersonalPinsForChannel(channelId, pinMap).includes(normalizedMessageId);
}

export function togglePersonalPin(channelId: string, messageId: string): void {
	const normalizedChannelId = channelId.trim();
	const normalizedMessageId = messageId.trim();
	if (!normalizedChannelId || !normalizedMessageId) return;
	personalPinsStore.update((current) => {
		const next: PersonalPinMap = { ...current };
		const existing = next[normalizedChannelId] || [];
		if (existing.includes(normalizedMessageId)) {
			const filtered = existing.filter((id) => id !== normalizedMessageId);
			if (filtered.length > 0) {
				next[normalizedChannelId] = filtered;
			} else {
				delete next[normalizedChannelId];
			}
		} else {
			next[normalizedChannelId] = [...existing, normalizedMessageId];
		}
		return sanitizePinMap(next);
	});
}

export function setPersonalPin(channelId: string, messageId: string, pinned: boolean): void {
	const alreadyPinned = isMessagePersonalPinned(channelId, messageId);
	if (alreadyPinned === pinned) return;
	togglePersonalPin(channelId, messageId);
}

export function clearPersonalPinsForChannel(channelId: string): void {
	const normalizedChannelId = channelId.trim();
	if (!normalizedChannelId) return;
	personalPinsStore.update((current) => {
		if (!current[normalizedChannelId]) return current;
		const next = { ...current };
		delete next[normalizedChannelId];
		return sanitizePinMap(next);
	});
}

export function clearAllPersonalPins(): void {
	personalPinsStore.set({});
}
