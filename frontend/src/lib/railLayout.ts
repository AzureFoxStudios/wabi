import { get } from 'svelte/store';
import { railDensity, railSide, railLayoutLoaded, type RailDensity, type RailSide } from './layoutStoreStates';
import { mergeIntoServerContainer } from './docking/layoutPersistence';
import { getApiBase } from '$lib/api/utils';
import { getAuthToken } from '$lib/authSession';

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 500;

/**
 * Rail chrome (density + side) is stored inside the same `/api/user/layout`
 * container as the docking layout and theme (keys: layout, theme, railDensity, railSide).
 * This module only reads/writes the rail keys; it never touches layout/theme.
 * Writes go through mergeIntoServerContainer so other slots survive.
 */

interface RailLayoutState {
	railDensity: RailDensity;
	railSide: RailSide;
}

export async function loadRailLayout(): Promise<void> {
	const token = getAuthToken();
	if (!token) {
		railLayoutLoaded.set(true);
		return;
	}
	try {
		const res = await fetch(`${getApiBase()}/api/user/layout`, {
			headers: { Authorization: `Bearer ${token}` }
		});
		if (!res.ok) return;
		const body: { layoutJson: string | null; updatedAt: number | null } = await res.json();
		if (!body.layoutJson) return;
		const parsed = JSON.parse(body.layoutJson) as Partial<RailLayoutState>;
		if (isRailDensity(parsed.railDensity)) {
			railDensity.set(parsed.railDensity);
		}
		if (isRailSide(parsed.railSide)) {
			railSide.set(parsed.railSide);
		}
	} catch {
		// best effort, defaults already set
	} finally {
		railLayoutLoaded.set(true);
	}
}

export function persistRailLayout(): void {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(async () => {
		const token = getAuthToken();
		if (!token) return;
		const payload: RailLayoutState = {
			railDensity: get(railDensity),
			railSide: get(railSide)
		};
		await mergeIntoServerContainer(token, 'railDensity', payload.railDensity);
		await mergeIntoServerContainer(token, 'railSide', payload.railSide);
	}, PERSIST_DEBOUNCE_MS);
}

function isRailDensity(v: unknown): v is RailDensity {
	return v === 'full' || v === 'icons-only' || v === 'hidden';
}

function isRailSide(v: unknown): v is RailSide {
	return v === 'left' || v === 'right';
}
