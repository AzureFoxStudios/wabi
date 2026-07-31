/**
 * User-defined channel organizers (categories).
 * Local-first: persists per-browser; does not replace type sections yet —
 * categories group *within* the text list and custom sections.
 */
import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

export type ChannelOrganizer = {
	id: string;
	name: string;
	/** Channel ids assigned to this organizer (order preserved). */
	channelIds: string[];
	collapsed?: boolean;
};

const STORAGE_KEY = 'wabi.channelOrganizers.v1';

function load(): ChannelOrganizer[] {
	if (!browser) return [];
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((o) => o && typeof o.id === 'string' && typeof o.name === 'string')
			.map((o) => ({
				id: o.id,
				name: String(o.name).slice(0, 40),
				channelIds: Array.isArray(o.channelIds) ? o.channelIds.map(String) : [],
				collapsed: Boolean(o.collapsed)
			}));
	} catch {
		return [];
	}
}

function persist(list: ChannelOrganizer[]) {
	if (!browser) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
	} catch {
		/* ignore */
	}
}

export const channelOrganizers = writable<ChannelOrganizer[]>(load());

channelOrganizers.subscribe((list) => persist(list));

export function createOrganizer(name: string): string {
	const id =
		typeof crypto !== 'undefined' && crypto.randomUUID
			? crypto.randomUUID()
			: `org-${Date.now()}`;
	const trimmed = name.trim().slice(0, 40) || 'New category';
	channelOrganizers.update((list) => [...list, { id, name: trimmed, channelIds: [], collapsed: false }]);
	return id;
}

export function renameOrganizer(id: string, name: string) {
	const trimmed = name.trim().slice(0, 40);
	if (!trimmed) return;
	channelOrganizers.update((list) => list.map((o) => (o.id === id ? { ...o, name: trimmed } : o)));
}

export function deleteOrganizer(id: string) {
	channelOrganizers.update((list) => list.filter((o) => o.id !== id));
}

export function toggleOrganizerCollapsed(id: string) {
	channelOrganizers.update((list) =>
		list.map((o) => (o.id === id ? { ...o, collapsed: !o.collapsed } : o))
	);
}

export function assignChannelToOrganizer(channelId: string, organizerId: string | null) {
	channelOrganizers.update((list) =>
		list.map((o) => {
			const without = o.channelIds.filter((id) => id !== channelId);
			if (organizerId && o.id === organizerId) {
				return { ...o, channelIds: [...without, channelId] };
			}
			return { ...o, channelIds: without };
		})
	);
}

export function getUnorganizedChannelIds(allIds: string[]): string[] {
	const assigned = new Set(get(channelOrganizers).flatMap((o) => o.channelIds));
	return allIds.filter((id) => !assigned.has(id));
}
