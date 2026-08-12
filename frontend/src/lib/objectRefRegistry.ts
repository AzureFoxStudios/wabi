import { writable, get } from 'svelte/store';
import { placeRegistry } from './placeStore';

export type ObjectRefKind = 'forum_post' | 'wiki_page' | 'gallery_work' | 'place';

export interface ObjectRefRecord {
	kind: ObjectRefKind;
	id: string;
	slug: string;
	title: string;
	channelId: string;
	subtitle?: string;
	status?: string;
	thumbUrl?: string;
	updatedAt?: number;
}

type RefKey = `${ObjectRefKind}:${string}`;

export const objectRefStore = writable<Map<RefKey, ObjectRefRecord>>(new Map());

function refKey(kind: ObjectRefKind, id: string): RefKey {
	return `${kind}:${id}`;
}

export function registerObjectRef(record: ObjectRefRecord): void {
	if (!record?.kind || !record?.id) return;
	const title = typeof record.title === 'string' ? record.title.trim() : '';
	const slug = typeof record.slug === 'string' ? record.slug.trim() : '';
	const normalized: ObjectRefRecord = {
		...record,
		title: title || slug || record.id,
		slug: slug || slugify(title || record.id)
	};
	objectRefStore.update((map) => {
		const next = new Map(map);
		next.set(refKey(normalized.kind, normalized.id), normalized);
		return next;
	});
}

export function unregisterObjectRef(kind: ObjectRefKind, id: string): void {
	objectRefStore.update((map) => {
		const next = new Map(map);
		next.delete(refKey(kind, id));
		return next;
	});
}

export function clearObjectRefs(): void {
	objectRefStore.set(new Map());
}

export function slugify(s: string): string {
	return s
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function searchObjectRefs(query: string, limit = 8): ObjectRefRecord[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];

	const current = get(objectRefStore);
	const scored: Array<{ record: ObjectRefRecord; score: number }> = [];

	for (const record of current.values()) {
		const slugLower = String(record.slug || '').toLowerCase();
		const titleLower = String(record.title || '').toLowerCase();
		const subtitleLower = (record.subtitle ?? '').toLowerCase();

		let score = 0;
		if (slugLower === q) {
			score = 100;
		} else if (slugLower.startsWith(q)) {
			score = 50;
		} else if (slugLower.includes(q)) {
			score = 30;
		} else if (titleLower.includes(q)) {
			score = 20;
		} else if (subtitleLower.includes(q)) {
			score = 10;
		}

		if (score > 0) {
			scored.push({ record, score });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((r) => r.record);
}

export function resolveObjectRef(
	token: string
):
	| { status: 'unique'; record: ObjectRefRecord }
	| { status: 'ambiguous'; candidates: ObjectRefRecord[] }
	| { status: 'miss' } {
	const trimmed = token.trim();
	if (!trimmed) return { status: 'miss' };

	const current = get(objectRefStore);
	const candidates: ObjectRefRecord[] = [];

	const nsMatch = trimmed.match(/^([fwgm])\/(.+)/);
	if (nsMatch) {
		const kindMap: Record<string, ObjectRefKind> = {
			f: 'forum_post',
			w: 'wiki_page',
			g: 'gallery_work',
			m: 'place'
		};
		const kind = kindMap[nsMatch[1]];
		const slug = nsMatch[2].toLowerCase();

		for (const record of current.values()) {
			if (record.kind === kind && record.slug.toLowerCase() === slug) {
				candidates.push(record);
			}
		}
	} else {
		const slug = trimmed.toLowerCase();
		for (const record of current.values()) {
			if (record.slug.toLowerCase() === slug) {
				candidates.push(record);
			}
		}
	}

	if (candidates.length === 0) return { status: 'miss' };
	if (candidates.length === 1) return { status: 'unique', record: candidates[0] };
	return { status: 'ambiguous', candidates };
}

let _initialized = false;

export function syncPlacesFromRegistry(): void {
	const places = get(placeRegistry);
	const refs: ObjectRefRecord[] = places.map((place) => ({
		kind: 'place' as ObjectRefKind,
		id: place.id,
		slug: slugify(place.name),
		title: place.name,
		channelId: ''
	}));

	objectRefStore.update((map) => {
		const next = new Map(map);
		for (const key of next.keys()) {
			if (key.startsWith('place:')) {
				next.delete(key);
			}
		}
		for (const ref of refs) {
			next.set(refKey(ref.kind, ref.id), ref);
		}
		return next;
	});
}

export function initObjectRefRegistry(): void {
	if (_initialized) return;
	_initialized = true;

	syncPlacesFromRegistry();

	placeRegistry.subscribe(() => {
		syncPlacesFromRegistry();
	});
}
