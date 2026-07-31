import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

const PINNED_DM_IDS_KEY = 'wabi.pinDms.pinnedConversationIds';

function sanitizePinnedIds(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	const normalized = input
		.map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
		.filter(Boolean);
	return normalized.filter((value, index) => normalized.indexOf(value) === index);
}

function safeReadPinnedIds(): string[] {
	if (!browser) return [];
	try {
		const raw = localStorage.getItem(PINNED_DM_IDS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return sanitizePinnedIds(parsed);
	} catch {
		return [];
	}
}

function safeWritePinnedIds(ids: string[]): void {
	if (!browser) return;
	try {
		localStorage.setItem(PINNED_DM_IDS_KEY, JSON.stringify(ids));
	} catch {
		// best-effort persistence
	}
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export const pinnedDmIdsStore = writable<string[]>(safeReadPinnedIds());

if (browser) {
	pinnedDmIdsStore.subscribe((ids) => {
		safeWritePinnedIds(sanitizePinnedIds(ids));
	});
}

export function isPinnedDm(channelId: string, pinnedIds: string[] = get(pinnedDmIdsStore)): boolean {
	return pinnedIds.includes(channelId);
}

export function setPinnedDm(channelId: string, pinned: boolean): void {
	const normalizedId = channelId.trim();
	if (!normalizedId) return;
	pinnedDmIdsStore.update((current) => {
		const alreadyPinned = current.includes(normalizedId);
		if (pinned && !alreadyPinned) return [...current, normalizedId];
		if (!pinned && alreadyPinned) return current.filter((id) => id !== normalizedId);
		return current;
	});
}

export function togglePinnedDm(channelId: string): void {
	setPinnedDm(channelId, !isPinnedDm(channelId));
}

export function clearPinnedDms(): void {
	pinnedDmIdsStore.set([]);
}

export function prunePinnedDms(validChannelIds: Iterable<string>): void {
	const valid = new Set(validChannelIds);
	pinnedDmIdsStore.update((current) => {
		const next = current.filter((id) => valid.has(id));
		return arraysEqual(current, next) ? current : next;
	});
}
