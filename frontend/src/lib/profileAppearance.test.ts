import { describe, expect, mock, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { get, writable } from 'svelte/store';

// Window/accessibility mocks must not escape into unrelated frontend suites.
const FIXTURE_FLAG = 'WABI_PROFILE_APPEARANCE_FIXTURE';
if (process.env[FIXTURE_FLAG] !== '1') {
	test('profile viewer preferences run with isolated browser mocks', () => {
		const result = Bun.spawnSync([process.execPath, 'test', fileURLToPath(import.meta.url)], {
			cwd: fileURLToPath(new URL('../../', import.meta.url)),
			env: { ...process.env, [FIXTURE_FLAG]: '1' }, stdout: 'pipe', stderr: 'pipe'
		});
		const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
		expect(result.exitCode, output).toBe(0);
	}, 30_000);
} else {
	const KEY = 'wabi.profileAppearance.v1';
	const values = new Map<string, string>([
		['wabi.nameStyles.visible', 'false'], ['wabi:profile:visibility', JSON.stringify({ disableAll: true })]
	]);
	let storageFails = false;
	const localStorage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => { if (storageFails) throw new Error('Storage is blocked'); values.set(key, value); }
	};
	const storageListeners = new Set<(event: { key: string | null }) => void>();
	const motionListeners = new Set<(event: { matches: boolean }) => void>();
	const mediaQuery = {
		matches: true,
		addEventListener: (event: string, callback: (event: { matches: boolean }) => void) => { if (event === 'change') motionListeners.add(callback); }
	};
	const window = {
		matchMedia: (query: string) => { expect(query).toBe('(prefers-reduced-motion: reduce)'); return mediaQuery; },
		addEventListener: (event: string, callback: (event: { key: string | null }) => void) => { if (event === 'storage') storageListeners.add(callback); }
	};
	Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
	Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
	const accessibilityReducedMotion = writable(false);
	mock.module('$app/environment', () => ({ browser: true }));
	mock.module('./accessibility', () => ({ accessibilityReducedMotion }));
	const {
		DEFAULT_PROFILE_APPEARANCE, normalizeProfileAppearance, profileAppearance,
		profileNamesVisible, profilePlatesVisible, profileDecorationsVisible,
		profileMotionAllowed, profileOsReducedMotion, setProfileAppearance
	} = await import('./profileAppearance');
	const initialAppearance = get(profileAppearance);
	const initialOsReducedMotion = get(profileOsReducedMotion);
	function osMotion(matches: boolean) { mediaQuery.matches = matches; for (const callback of motionListeners) callback({ matches }); }
	function storedChange(key: string | null = KEY) { for (const callback of storageListeners) callback({ key }); }
	function reset() { storageFails = false; accessibilityReducedMotion.set(false); osMotion(false); setProfileAppearance(DEFAULT_PROFILE_APPEARANCE); }

	describe('profile viewer preference contract', () => {
		test('first load migrates legacy plain names and hidden decorations', () => {
			expect(initialAppearance).toEqual({ showCosmetics: true, names: false, plates: true, decorations: false, animate: true });
			expect(initialOsReducedMotion).toBe(true);
		});
		test('master plain mode hides everything and remembers granular choices on restore', () => {
			reset(); setProfileAppearance({ names: false, plates: true, decorations: false, animate: true });
			setProfileAppearance({ showCosmetics: false });
			expect(get(profileNamesVisible)).toBe(false); expect(get(profilePlatesVisible)).toBe(false);
			expect(get(profileDecorationsVisible)).toBe(false); expect(get(profileMotionAllowed)).toBe(false);
			expect(get(profileAppearance)).toMatchObject({ names: false, plates: true, decorations: false, animate: true });
			setProfileAppearance({ showCosmetics: true });
			expect(get(profileNamesVisible)).toBe(false); expect(get(profilePlatesVisible)).toBe(true);
			expect(get(profileDecorationsVisible)).toBe(false); expect(get(profileMotionAllowed)).toBe(true);
		});
		test('granular decoration updates never turn global plain mode back on', () => {
			reset(); setProfileAppearance({ showCosmetics: false, decorations: false });
			setProfileAppearance({ decorations: true });
			expect(get(profileAppearance)).toMatchObject({ showCosmetics: false, decorations: true });
			expect(get(profileDecorationsVisible)).toBe(false); expect(get(profileNamesVisible)).toBe(false);
		});
		test('app and operating-system reduced motion each override animation', () => {
			reset(); expect(get(profileMotionAllowed)).toBe(true);
			accessibilityReducedMotion.set(true); expect(get(profileMotionAllowed)).toBe(false);
			accessibilityReducedMotion.set(false); expect(get(profileMotionAllowed)).toBe(true);
			osMotion(true); expect(get(profileMotionAllowed)).toBe(false);
			setProfileAppearance({ animate: true }); expect(get(profileMotionAllowed)).toBe(false);
			osMotion(false); expect(get(profileMotionAllowed)).toBe(true);
			setProfileAppearance({ animate: false }); expect(get(profileMotionAllowed)).toBe(false);
		});
		test('device persistence saves the full selection while legacy keys reflect effective visibility', () => {
			reset(); setProfileAppearance({ showCosmetics: false, names: true, decorations: true, plates: false });
			expect(JSON.parse(values.get(KEY)!)).toEqual(get(profileAppearance));
			expect(values.get('wabi.nameStyles.visible')).toBe('false');
			expect(JSON.parse(values.get('wabi:profile:visibility')!)).toEqual({ disableAll: true });
			setProfileAppearance({ showCosmetics: true });
			expect(values.get('wabi.nameStyles.visible')).toBe('true');
			expect(JSON.parse(values.get('wabi:profile:visibility')!)).toEqual({ disableAll: false });
		});
		test('another tab storage change applies its saved settings without rewriting them', () => {
			reset(); const other = { ...DEFAULT_PROFILE_APPEARANCE, names: false, plates: false, animate: false };
			values.set(KEY, JSON.stringify(other)); storedChange();
			expect(get(profileAppearance)).toEqual(other); expect(get(profileNamesVisible)).toBe(false);
			expect(get(profilePlatesVisible)).toBe(false); expect(get(profileMotionAllowed)).toBe(false);
			values.set(KEY, JSON.stringify(DEFAULT_PROFILE_APPEARANCE)); storedChange('unrelated-key');
			expect(get(profileAppearance)).toEqual(other);
		});
		test('clearing storage restores defaults without retaining another tab hidden effects', () => {
			reset(); setProfileAppearance({ showCosmetics: false }); values.clear(); storedChange(null);
			expect(get(profileAppearance)).toEqual(DEFAULT_PROFILE_APPEARANCE);
			expect(get(profileNamesVisible)).toBe(true); expect(get(profileDecorationsVisible)).toBe(true);
		});
		test('malformed persisted values fall back safely and reject nonboolean controls', () => {
			reset(); values.set(KEY, '{broken'); storedChange(); expect(get(profileAppearance)).toEqual(DEFAULT_PROFILE_APPEARANCE);
			expect(normalizeProfileAppearance({ showCosmetics: false, names: 'false', animate: 0, decorations: null })).toEqual({ ...DEFAULT_PROFILE_APPEARANCE, showCosmetics: false });
		});
		test('blocked device storage still applies the viewer choice for this session', () => {
			reset(); storageFails = true;
			expect(() => setProfileAppearance({ decorations: false })).not.toThrow();
			expect(get(profileDecorationsVisible)).toBe(false);
			storageFails = false;
		});
	});
}
