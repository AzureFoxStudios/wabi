export type BuiltInFeelerPattern = 'triangles' | 'dots' | 'grid' | 'sparkles' | 'suits' | 'none';
export type FeelerPattern = BuiltInFeelerPattern | 'local';

export type FeelerSettings = {
	enabled: boolean;
	pattern: FeelerPattern;
	customEffectId: string | null;
	radius: number;
	intensity: number;
	textureOpacity: number;
	idleDelayMs: number;
	fadeMs: number;
};

export const FEELER_STORAGE_KEY = 'wabi.mouse-feeler.v1';
export const FEELER_SETTINGS_EVENT = 'wabi:mouse-feeler-settings';

export const DEFAULT_FEELER_SETTINGS: FeelerSettings = {
	enabled: true,
	pattern: 'triangles',
	customEffectId: null,
	radius: 190,
	intensity: 0.05,
	textureOpacity: 0.16,
	idleDelayMs: 90,
	fadeMs: 520
};

export function isFeelerPattern(value: unknown): value is FeelerPattern {
	return value === 'triangles' ||
		value === 'dots' ||
		value === 'grid' ||
		value === 'sparkles' ||
		value === 'suits' ||
		value === 'none' ||
		value === 'local';
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function normalizeFeelerSettings(input: Partial<FeelerSettings> | null | undefined): FeelerSettings {
	return {
		enabled: input?.enabled !== false,
		pattern: isFeelerPattern(input?.pattern) ? input.pattern : DEFAULT_FEELER_SETTINGS.pattern,
		customEffectId:
			typeof input?.customEffectId === 'string' && input.customEffectId.trim()
				? input.customEffectId.trim()
				: null,
		radius: clampNumber(input?.radius, DEFAULT_FEELER_SETTINGS.radius, 80, 360),
		intensity: clampNumber(input?.intensity, DEFAULT_FEELER_SETTINGS.intensity, 0, 0.15),
		textureOpacity: clampNumber(input?.textureOpacity, DEFAULT_FEELER_SETTINGS.textureOpacity, 0, 0.4),
		idleDelayMs: clampNumber(input?.idleDelayMs, DEFAULT_FEELER_SETTINGS.idleDelayMs, 30, 300),
		fadeMs: clampNumber(input?.fadeMs, DEFAULT_FEELER_SETTINGS.fadeMs, 150, 1200)
	};
}

export function readFeelerSettings(): FeelerSettings {
	if (typeof window === 'undefined') return { ...DEFAULT_FEELER_SETTINGS };
	try {
		const raw = window.localStorage.getItem(FEELER_STORAGE_KEY);
		if (!raw) return { ...DEFAULT_FEELER_SETTINGS };
		return normalizeFeelerSettings(JSON.parse(raw) as Partial<FeelerSettings>);
	} catch {
		return { ...DEFAULT_FEELER_SETTINGS };
	}
}

export function writeFeelerSettings(next: FeelerSettings): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(FEELER_STORAGE_KEY, JSON.stringify(normalizeFeelerSettings(next)));
	} catch {
		// Cosmetic preference persistence is best-effort only.
	}
}

export function applyFeelerSettings(patch: Partial<FeelerSettings>): FeelerSettings {
	const next = normalizeFeelerSettings({ ...readFeelerSettings(), ...patch });
	writeFeelerSettings(next);
	if (typeof window !== 'undefined') {
		window.dispatchEvent(new CustomEvent<Partial<FeelerSettings>>(FEELER_SETTINGS_EVENT, { detail: patch }));
	}
	return next;
}
