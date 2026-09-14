import { writable } from 'svelte/store';

export type MapTokenVisibility = 'everyone' | 'staff' | 'owner';

export interface MapToken {
	id: string;
	placeId: string;
	layerId: string | null;
	x: number;
	y: number;
	label: string;
	glyph: string;
	color: string;
	ownerId: string | null;
	visibility: MapTokenVisibility;
	updatedAt: number;
}

const STORAGE_KEY = 'wabi-server-map-tokens-v1';

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function loadInitial(): MapToken[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function persist(tokens: MapToken[]): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

function createTokenStore() {
	const { subscribe, update, set } = writable<MapToken[]>(loadInitial());
	return {
		subscribe,
		add(input: Omit<MapToken, 'id' | 'updatedAt'>) {
			update((tokens) => {
				const next = [...tokens, {
					...input,
					id: `map-token-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`,
					x: clamp01(input.x),
					y: clamp01(input.y),
					updatedAt: Date.now()
				}];
				persist(next);
				return next;
			});
		},
		move(id: string, x: number, y: number) {
			update((tokens) => {
				const next = tokens.map((token) => token.id === id
					? { ...token, x: clamp01(x), y: clamp01(y), updatedAt: Date.now() }
					: token);
				persist(next);
				return next;
			});
		},
		remove(id: string) {
			update((tokens) => {
				const next = tokens.filter((token) => token.id !== id);
				persist(next);
				return next;
			});
		},
		replace(tokens: MapToken[]) {
			persist(tokens);
			set(tokens);
		}
	};
}

export const mapTokens = createTokenStore();

/**
 * Transport seam for STDB/WabiDB. The UI talks only to mapTokens today;
 * a realtime adapter can replace local persistence without changing map UI.
 */
export interface MapTokenRealtimeAdapter {
	connect(placeId: string): Promise<void>;
	disconnect(): Promise<void>;
	moveToken(tokenId: string, x: number, y: number): Promise<void>;
}
