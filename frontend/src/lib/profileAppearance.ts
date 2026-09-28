import { browser } from '$app/environment';
import { derived, writable } from 'svelte/store';
import { accessibilityReducedMotion } from './accessibility';

export interface ProfileAppearance {
	showCosmetics: boolean;
	names: boolean;
	plates: boolean;
	decorations: boolean;
	animate: boolean;
}

export const DEFAULT_PROFILE_APPEARANCE: ProfileAppearance = {
	showCosmetics: true, names: true, plates: true, decorations: true, animate: true
};
const KEY = 'wabi.profileAppearance.v1';

export function normalizeProfileAppearance(value: unknown): ProfileAppearance {
	const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	return Object.fromEntries(Object.entries(DEFAULT_PROFILE_APPEARANCE).map(([key, fallback]) => [key, typeof source[key] === 'boolean' ? source[key] : fallback])) as unknown as ProfileAppearance;
}

function loadAppearance(): ProfileAppearance {
	if (!browser) return { ...DEFAULT_PROFILE_APPEARANCE };
	try {
		const saved = localStorage.getItem(KEY);
		if (saved) return normalizeProfileAppearance(JSON.parse(saved));
		const legacyMedia = JSON.parse(localStorage.getItem('wabi:profile:visibility') || '{}');
		return { ...DEFAULT_PROFILE_APPEARANCE, names: localStorage.getItem('wabi.nameStyles.visible') !== 'false', decorations: legacyMedia.disableAll !== true };
	} catch { return { ...DEFAULT_PROFILE_APPEARANCE }; }
}

export const profileAppearance = writable<ProfileAppearance>(loadAppearance());
export const profileNamesVisible = derived(profileAppearance, (p) => p.showCosmetics && p.names);
export const profilePlatesVisible = derived(profileAppearance, (p) => p.showCosmetics && p.plates);
export const profileDecorationsVisible = derived(profileAppearance, (p) => p.showCosmetics && p.decorations);
const osMotionQuery = browser && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
export const profileOsReducedMotion = writable(osMotionQuery?.matches ?? false);
osMotionQuery?.addEventListener('change', (event) => profileOsReducedMotion.set(event.matches));
export const profileMotionAllowed = derived([profileAppearance, accessibilityReducedMotion, profileOsReducedMotion], ([p, reduced, osReduced]) => p.showCosmetics && p.animate && !reduced && !osReduced);

export function setProfileAppearance(patch: Partial<ProfileAppearance>): void {
	profileAppearance.update((current) => {
		const next = normalizeProfileAppearance({ ...current, ...patch });
		if (browser) {
			try {
				localStorage.setItem(KEY, JSON.stringify(next));
				localStorage.setItem('wabi.nameStyles.visible', String(next.showCosmetics && next.names));
				localStorage.setItem('wabi:profile:visibility', JSON.stringify({ disableAll: !(next.showCosmetics && next.decorations) }));
			} catch { /* The preference still applies for this session. */ }
		}
		return next;
	});
}

if (browser) window.addEventListener('storage', (event) => {
	if (event.key === KEY || event.key === null) profileAppearance.set(loadAppearance());
});
