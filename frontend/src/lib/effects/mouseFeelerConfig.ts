export const BASIC_FEELER_PATTERNS = [
	{ id: 'triangles', name: 'Triangles', description: 'A light field of familiar triangles.' },
	{ id: 'dots', name: 'Dots', description: 'Small dots revealed around your pointer.' },
	{ id: 'grid', name: 'Grid', description: 'A fine geometric grid.' },
	{ id: 'sparkles', name: 'Sparkles', description: 'Scattered points of light.' },
	{ id: 'none', name: 'No texture', description: 'Keep just the soft pointer glow.' }
] as const;

export const LITTLE_WORLD_PATTERNS = [
	{ id: 'creatures', name: 'Creature Garden', description: 'Small creatures, plants and curious visitors.' },
	{ id: 'cat-nap', name: 'Cat Nap', description: 'Sleepy cats and their favorite things.' },
	{ id: 'capybara-bath', name: 'Capybara Bath', description: 'Capybaras enjoying a quiet soak.' },
	{ id: 'frog-pond', name: 'Frog Pond', description: 'Frogs, lily pads and pond life.' },
	{ id: 'moth-garden', name: 'Moth Garden', description: 'Moths among flowers and leaves.' },
	{ id: 'peeking-eyes', name: 'Peeking Eyes', description: 'Little faces peeking out of the dark.' },
	{ id: 'suits', name: 'Suits', description: 'Playing-card suits in a varied scatter.' },
	{ id: 'tabletop', name: 'Tabletop', description: 'Dice, cards and tabletop treasures.' },
	{ id: 'tiny-dungeon', name: 'Tiny Dungeon', description: 'Tiny rooms, keys and dungeon finds.' },
	{ id: 'dungeon-mimics', name: 'Dungeon Mimics', description: 'Chests and suspicious little treasures.' },
	{ id: 'climb-icons', name: 'Climb Icons', description: 'Scattered monsters, campfires, shops and dungeon encounters.' },
	{ id: 'crystal-quest', name: 'Crystal Quest', description: 'Crystals and fantasy adventuring finds.' },
	{ id: 'arcade', name: 'Arcade', description: 'Small arcade sprites and game tokens.' },
	{ id: 'chess', name: 'Chess', description: 'Chess pieces scattered across an invisible board.' },
	{ id: 'ancient-scroll', name: 'Ancient Scroll', description: 'Old scrolls, marks and forgotten treasures.' },
	{ id: 'arcane', name: 'Arcane', description: 'Scattered magical symbols and charms.' },
	{ id: 'alchemy', name: 'Alchemy', description: 'Bottles, ingredients and strange experiments.' },
	{ id: 'space', name: 'Space', description: 'Planets, stars and small space explorers.' },
	{ id: 'ocean', name: 'Ocean', description: 'Shells, fish and drifting sea life.' },
	{ id: 'forest', name: 'Forest', description: 'Leaves, mushrooms and woodland finds.' },
	{ id: 'tiny-worlds', name: 'Tiny Worlds', description: 'Miniature places and pocket-sized adventures.' },
	{ id: 'weather', name: 'Weather', description: 'Clouds, sunshine and passing showers.' },
	{ id: 'artist-desk', name: 'Artist Desk', description: 'Brushes, pencils and a creative scattering of tools.' },
	{ id: 'computer', name: 'Computer', description: 'Small devices and familiar computer symbols.' },
	{ id: 'desktop-archaeology', name: 'Desktop Archaeology', description: 'Old disks, cables and desktop discoveries.' },
	{ id: 'robot-lab', name: 'Robot Lab', description: 'Robots, parts and laboratory curiosities.' },
	{ id: 'music', name: 'Music', description: 'Notes, instruments and musical keepsakes.' },
	{ id: 'notebook', name: 'Notebook', description: 'Doodles, paper and handwritten ideas.' }
] as const;

export const CONNECTED_WORLD_PATTERNS = [
	{ id: 'lattice', name: 'Lattice', description: 'A connected network that responds to movement.' },
	{ id: 'climb-route', name: 'Climb Route', description: 'Branching dungeon routes through monsters, shops, campfires and treasure.' },
	{ id: 'arcane-circle', name: 'Arcane Circle', description: 'Interlocking circles and magical geometry.' },
	{ id: 'rune-wall', name: 'Rune Wall', description: 'A wall of runes awakened by your pointer.' },
	{ id: 'maze', name: 'Maze', description: 'Linked passages revealed as you explore.' },
	{ id: 'water', name: 'Water Ripples', description: 'Expanding ripples follow your movement.' },
	{ id: 'sand', name: 'Sand', description: 'A sandy surface brushed by your pointer trail.' }
] as const;

export type LittleWorldPattern = (typeof LITTLE_WORLD_PATTERNS)[number]['id'];
export type ConnectedWorldPattern = (typeof CONNECTED_WORLD_PATTERNS)[number]['id'];
export type BuiltInFeelerPattern = (typeof BASIC_FEELER_PATTERNS)[number]['id'] | LittleWorldPattern | ConnectedWorldPattern;
export type FeelerPattern = BuiltInFeelerPattern | 'local';

export type FeelerSettings = {
	enabled: boolean;
	pattern: FeelerPattern;
	customEffectId: string | null;
	radius: number;
	intensity: number;
	textureOpacity: number;
	patternScale: number;
	idleDelayMs: number;
	fadeMs: number;
	trailMs: number;
	trailStrength: number;
	seed: number;
	fieldDensity: number;
	materialDetail: number;
	settleSpeed: number;
	mazeCurve: number;
	response: number;
};

// Keep the existing key so every pre-Connected Worlds preference migrates in place.
export const FEELER_STORAGE_KEY = 'wabi.mouse-feeler.v1';
export const FEELER_SETTINGS_EVENT = 'wabi:mouse-feeler-settings';
export const FEELER_DEMO_EVENT = 'wabi:pointer-demo';
export const FEELER_DEMO_STATE_EVENT = 'wabi:pointer-demo-state';
export const FEELER_ERROR_EVENT = 'wabi:pointer-error';
export const FEELER_ERROR_REQUEST_EVENT = 'wabi:pointer-error-request';

export type FeelerDemoRequest = {
	bounds?: { left: number; top: number; width: number; height: number };
	stop?: boolean;
};

export const DEFAULT_FEELER_SETTINGS: FeelerSettings = {
	enabled: true,
	pattern: 'triangles',
	customEffectId: null,
	radius: 190,
	intensity: 0.05,
	textureOpacity: 0.16,
	patternScale: 1,
	idleDelayMs: 90,
	fadeMs: 520,
	trailMs: 280,
	trailStrength: 0.5,
	seed: 104729,
	fieldDensity: 1,
	materialDetail: 1,
	settleSpeed: 1,
	mazeCurve: 0.7,
	response: 0.65
};

export function isLittleWorldPattern(value: unknown): value is LittleWorldPattern {
	return LITTLE_WORLD_PATTERNS.some((pattern) => pattern.id === value);
}

export function isConnectedWorldPattern(value: unknown): value is ConnectedWorldPattern {
	return CONNECTED_WORLD_PATTERNS.some((pattern) => pattern.id === value);
}

export function isFeelerPattern(value: unknown): value is FeelerPattern {
	return value === 'local' || BASIC_FEELER_PATTERNS.some((pattern) => pattern.id === value) ||
		isLittleWorldPattern(value) || isConnectedWorldPattern(value);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function normalizeFeelerSettings(input: Partial<FeelerSettings> | null | undefined): FeelerSettings {
	// The recovered bundle called this material water-ripples.
	const storedPattern: unknown = input?.pattern;
	const pattern = storedPattern === 'water-ripples' ? 'water' : storedPattern;
	return {
		enabled: input?.enabled !== false,
		pattern: isFeelerPattern(pattern) ? pattern : DEFAULT_FEELER_SETTINGS.pattern,
		customEffectId:
			typeof input?.customEffectId === 'string' && input.customEffectId.trim()
				? input.customEffectId.trim()
				: null,
		radius: clampNumber(input?.radius, DEFAULT_FEELER_SETTINGS.radius, 80, 360),
		intensity: clampNumber(input?.intensity, DEFAULT_FEELER_SETTINGS.intensity, 0, 0.15),
		textureOpacity: clampNumber(input?.textureOpacity, DEFAULT_FEELER_SETTINGS.textureOpacity, 0, 0.4),
		patternScale: clampNumber(input?.patternScale, DEFAULT_FEELER_SETTINGS.patternScale, 0.5, 2),
		idleDelayMs: clampNumber(input?.idleDelayMs, DEFAULT_FEELER_SETTINGS.idleDelayMs, 30, 300),
		fadeMs: clampNumber(input?.fadeMs, DEFAULT_FEELER_SETTINGS.fadeMs, 150, 1200),
		trailMs: clampNumber(input?.trailMs, DEFAULT_FEELER_SETTINGS.trailMs, 0, 1200),
		trailStrength: clampNumber(input?.trailStrength, DEFAULT_FEELER_SETTINGS.trailStrength, 0, 1),
		seed: Math.floor(clampNumber(input?.seed, DEFAULT_FEELER_SETTINGS.seed, 0, 0xffffffff)),
		fieldDensity: clampNumber(input?.fieldDensity, DEFAULT_FEELER_SETTINGS.fieldDensity, 0.6, 1.5),
		materialDetail: clampNumber(input?.materialDetail, DEFAULT_FEELER_SETTINGS.materialDetail, 0.5, 2),
		settleSpeed: clampNumber(input?.settleSpeed, DEFAULT_FEELER_SETTINGS.settleSpeed, 0.25, 4),
		mazeCurve: clampNumber(input?.mazeCurve, DEFAULT_FEELER_SETTINGS.mazeCurve, 0, 1),
		response: clampNumber(input?.response, DEFAULT_FEELER_SETTINGS.response, 0, 1)
	};
}

// Storage can be unavailable in a private/restricted webview. Changes still work
// for this page session, and subsequent partial edits must not reset each other.
let sessionSettings = { ...DEFAULT_FEELER_SETTINGS };
let storageWriteFailed = false;

export function readFeelerSettings(): FeelerSettings {
	if (typeof window === 'undefined') return { ...DEFAULT_FEELER_SETTINGS };
	if (storageWriteFailed) return { ...sessionSettings };
	try {
		const raw = window.localStorage.getItem(FEELER_STORAGE_KEY);
		sessionSettings = raw ? normalizeFeelerSettings(JSON.parse(raw)) : { ...DEFAULT_FEELER_SETTINGS };
		return { ...sessionSettings };
	} catch {
		return { ...sessionSettings };
	}
}

export function writeFeelerSettings(next: FeelerSettings): void {
	if (typeof window === 'undefined') return;
	sessionSettings = normalizeFeelerSettings(next);
	try {
		window.localStorage.setItem(FEELER_STORAGE_KEY, JSON.stringify(sessionSettings));
		storageWriteFailed = false;
	} catch {
		storageWriteFailed = true;
	}
}

export function applyFeelerSettings(patch: Partial<FeelerSettings>): FeelerSettings {
	const next = normalizeFeelerSettings({ ...readFeelerSettings(), ...patch });
	writeFeelerSettings(next);
	if (typeof window !== 'undefined') {
		window.dispatchEvent(new CustomEvent<FeelerSettings>(FEELER_SETTINGS_EVENT, { detail: next }));
	}
	return next;
}
