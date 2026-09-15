import { expect, test } from 'bun:test';
import {
	applyFeelerSettings,
	BASIC_FEELER_PATTERNS,
	CONNECTED_WORLD_PATTERNS,
	DEFAULT_FEELER_SETTINGS,
	FEELER_SETTINGS_EVENT,
	FEELER_STORAGE_KEY,
	isConnectedWorldPattern,
	isFeelerPattern,
	isLittleWorldPattern,
	LITTLE_WORLD_PATTERNS,
	normalizeFeelerSettings,
	readFeelerSettings,
	writeFeelerSettings,
	type FeelerSettings
} from './mouseFeelerConfig';

test('current-main pointer preferences survive the Connected Worlds migration', () => {
	const legacy = {
		enabled: false, pattern: 'suits' as const, customEffectId: null,
		radius: 250, intensity: 0.12, textureOpacity: 0.32, idleDelayMs: 220, fadeMs: 990
	};
	expect(normalizeFeelerSettings(legacy)).toMatchObject(legacy);
	expect(normalizeFeelerSettings(legacy)).toMatchObject({ patternScale: 1, trailMs: 280, trailStrength: 0.5 });
	const imported = normalizeFeelerSettings({ ...legacy, pattern: 'local', customEffectId: '  image:kept  ' });
	expect(imported.pattern).toBe('local');
	expect(imported.customEffectId).toBe('image:kept');
});

test('every recovered family is selectable without displacing the basics', () => {
	const basics = ['dots', 'triangles', 'grid', 'sparkles', 'none'];
	const scatter = ['creatures', 'cat-nap', 'capybara-bath', 'frog-pond', 'moth-garden', 'peeking-eyes', 'suits', 'tabletop', 'tiny-dungeon', 'dungeon-mimics', 'climb-icons', 'crystal-quest', 'arcade', 'chess', 'ancient-scroll', 'arcane', 'alchemy', 'space', 'ocean', 'forest', 'tiny-worlds', 'weather', 'artist-desk', 'computer', 'desktop-archaeology', 'robot-lab', 'music', 'notebook'];
	const connected = ['lattice', 'climb-route', 'arcane-circle', 'rune-wall', 'maze', 'water', 'sand'];
	expect(BASIC_FEELER_PATTERNS.map((pattern) => String(pattern.id)).sort()).toEqual(basics.sort());
	expect(LITTLE_WORLD_PATTERNS.map((pattern) => String(pattern.id)).sort()).toEqual(scatter.sort());
	expect(CONNECTED_WORLD_PATTERNS.map((pattern) => String(pattern.id)).sort()).toEqual(connected.sort());
	for (const pattern of [...basics, ...scatter, ...connected, 'local']) {
		expect(isFeelerPattern(pattern)).toBe(true);
		expect(String(normalizeFeelerSettings({ pattern } as Partial<FeelerSettings>).pattern)).toBe(pattern);
	}
	expect(isLittleWorldPattern('climb-icons')).toBe(true);
	expect(isConnectedWorldPattern('climb-route')).toBe(true);
	expect(isLittleWorldPattern('climb-route')).toBe(false);
	expect(isConnectedWorldPattern('arcane')).toBe(false);
	expect(isFeelerPattern('unexpected')).toBe(false);
	expect(normalizeFeelerSettings({ pattern: 'water-ripples' } as unknown as Partial<FeelerSettings>).pattern).toBe('water');
});

test('untrusted saved controls normalize safely while explicit zero stays zero', () => {
	const bounded = normalizeFeelerSettings({
		radius: Infinity, intensity: -1, textureOpacity: 99, patternScale: -1,
		idleDelayMs: 0, fadeMs: 9999, trailMs: 0, trailStrength: 0,
		seed: 99.9, fieldDensity: 999, materialDetail: -4,
		settleSpeed: 999, mazeCurve: -2, response: 4
	});
	expect(bounded).toMatchObject({
		radius: DEFAULT_FEELER_SETTINGS.radius, intensity: 0, textureOpacity: 0.4,
		patternScale: 0.5, idleDelayMs: 30, fadeMs: 1200, trailMs: 0, trailStrength: 0,
		seed: 99, fieldDensity: 1.5, materialDetail: 0.5, settleSpeed: 4, mazeCurve: 0, response: 1
	});
	expect(normalizeFeelerSettings({ radius: null, intensity: '', trailMs: false } as unknown as Partial<FeelerSettings>)).toMatchObject({
		radius: DEFAULT_FEELER_SETTINGS.radius, intensity: DEFAULT_FEELER_SETTINGS.intensity, trailMs: DEFAULT_FEELER_SETTINGS.trailMs
	});
	expect(normalizeFeelerSettings({ seed: 1e20 }).seed).toBe(0xffffffff);
	expect(normalizeFeelerSettings(null)).toEqual(DEFAULT_FEELER_SETTINGS);
});

test('pointer settings persist independently, synchronize normalized values and survive blocked storage', () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const memory = new Map<string, string>([['theme_id', 'untouched'], ['background', 'untouched']]);
	const events: CustomEvent<FeelerSettings>[] = [];
	let blocked = false;
	const localStorage = {
		getItem(key: string) { if (blocked) throw new Error('storage blocked'); return memory.get(key) ?? null; },
		setItem(key: string, value: string) { if (blocked) throw new Error('storage blocked'); memory.set(key, value); }
	};
	Object.defineProperty(globalThis, 'window', { configurable: true, value: {
		localStorage,
		dispatchEvent(event: CustomEvent<FeelerSettings>) { events.push(event); return true; }
	} });
	try {
		writeFeelerSettings({ ...DEFAULT_FEELER_SETTINGS });
		applyFeelerSettings({ pattern: 'notebook', seed: 42, radius: 270 });
		applyFeelerSettings({ trailMs: 0 });
		expect(readFeelerSettings()).toMatchObject({ pattern: 'notebook', seed: 42, radius: 270, trailMs: 0 });
		expect(memory.get('theme_id')).toBe('untouched');
		expect(memory.get('background')).toBe('untouched');
		expect([...memory.keys()].sort()).toEqual(['background', 'theme_id', FEELER_STORAGE_KEY].sort());
		expect(events.at(-1)?.type).toBe(FEELER_SETTINGS_EVENT);
		expect(events.at(-1)?.detail).toEqual(readFeelerSettings());
		blocked = true;
		applyFeelerSettings({ pattern: 'sand', enabled: false });
		applyFeelerSettings({ radius: 330 });
		expect(readFeelerSettings()).toMatchObject({ pattern: 'sand', enabled: false, radius: 330, seed: 42, trailMs: 0 });
		blocked = false;
		applyFeelerSettings({ intensity: 0.08 });
		expect(JSON.parse(memory.get(FEELER_STORAGE_KEY)!)).toMatchObject({ pattern: 'sand', enabled: false, radius: 330, intensity: 0.08 });
	} finally {
		blocked = false;
		writeFeelerSettings({ ...DEFAULT_FEELER_SETTINGS });
		if (original) Object.defineProperty(globalThis, 'window', original);
		else Reflect.deleteProperty(globalThis, 'window');
	}
});
