/**
 * Source guards for the Settings frame and Appearance (design contract §8.9, §7.25, §5.2).
 * They pin structure that a refactor could silently lose: the kit dialog, the vertical
 * tablist, the confirm on Sign out, one chat-background picker, role-only colors.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SETTINGS_SEARCH_INDEX, type SettingsTab } from './settingsFrame';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const exists = (path: string) => existsSync(fileURLToPath(new URL(path, import.meta.url)));

const settings = read('../Settings.svelte');
const appearance = read('./AppearanceSettingsTab.svelte');
const accessibility = read('./AccessibilitySettingsTab.svelte');
const backdrop = read('./ChatBackdropSettings.svelte');
const skin = read('../../../styles/settings-skin.css');
const appearanceCss = read('../../../styles/components/settings-appearance.css');
const legacySheets = [
	'../../../styles/components/settings-nav.css',
	'../../../styles/components/settings-controls.css',
	'../../../styles/components/settings-core-part1.css',
	'../../../styles/components/settings-core-part2.css',
	'../../../styles/components/settings-core-part3.css'
].map(read);

describe('Settings frame', () => {
	test('is the kit dialog at the settings size, above other dialogs', () => {
		expect(settings).toContain('<BaseModal');
		expect(settings).toContain('size="settings"');
		expect(settings).toContain('overlayZIndex="var(--z-settings-shell)"');
		expect(settings).not.toContain('modal-overlay wabi-settings-overlay');
	});

	test('the nav is a vertical tablist of tabs with one tab stop', () => {
		expect(settings).toContain('role="tablist" aria-orientation="vertical"');
		expect(settings).toContain('role="tab"');
		expect(settings).toContain('aria-selected={selected}');
		expect(settings).toContain('tabindex={selected ? 0 : -1}');
		expect(settings).toContain('role="tabpanel"');
		expect(settings).not.toContain('aria-pressed={activeSettingsTab');
	});

	test('the header has the page title, scope note, search and an icon close (no text glyph)', () => {
		expect(settings).toContain('settings-head__note');
		expect(settings).toContain('placeholder="Search settings"');
		expect(settings).toContain('role="combobox"');
		expect(settings).toContain('<Icon name="x"');
		expect(settings).not.toContain('&#x2715;');
		expect(settings).not.toContain('✕');
	});

	test('language moved out of the header into Appearance', () => {
		expect(settings).not.toContain('setAppLocale');
		expect(appearance).toContain('setAppLocale');
		expect(appearance).toContain('ariaLabel="Language"');
	});

	test('Privacy & security says "Not independently verified" with experimental encryption (§9.2)', () => {
		expect(settings).toContain('PRIVACY_EXPLANATION');
		expect(settings).toMatch(/state === 'experimental-encryption'\}\{words\.sentence\}/);
	});

	test('Sign out is a quiet item that asks first; no native alerts remain', () => {
		expect(settings).toContain('async function handleSignOut');
		expect(settings).toMatch(/handleSignOut[\s\S]*?confirmAction\(/);
		expect(settings).not.toMatch(/\balert\(/);
		expect(skin).not.toMatch(/settings-signout[^{]*\{[^}]*--w-danger/);
	});
});

describe('Search settings', () => {
	/** The sources that render each page (Settings.svelte draws the Privacy & security intro). */
	const pageSources: Record<SettingsTab, string[]> = {
		profile: ['./ProfileSettingsTab.svelte'],
		privacy: ['../Settings.svelte', './ServerSettingsTab.svelte', './VolunteerBoostCard.svelte'],
		notifications: ['./NotificationsSettingsTab.svelte'],
		appearance: ['./AppearanceSettingsTab.svelte', './ChatBackdropSettings.svelte'],
		accessibility: ['./AccessibilitySettingsTab.svelte'],
		audio: ['./AudioSettingsTab.svelte'],
		games: ['../../games/GamesSettingsEntry.svelte'],
		addons: ['./AddonSettingsTab.svelte'],
		emojis: ['./EmojiSettingsTab.svelte'],
		storage: ['../StorageSettings.svelte'],
		admin: ['./AdminSettingsTab.svelte'],
		about: ['./AboutSettingsTab.svelte']
	};

	test('every result names words that are on its page, so it never promises a setting that is not there', () => {
		const missing = SETTINGS_SEARCH_INDEX.filter((entry) => {
			const text = pageSources[entry.tab].map(read).join('\n').toLowerCase();
			return !text.includes(entry.label.toLowerCase());
		}).map((entry) => `${entry.tab}: ${entry.label}`);
		expect(missing).toEqual([]);
	});
});

describe('Appearance', () => {
	test('Theme leads, as one radiogroup of role-built previews', () => {
		const theme = appearance.indexOf('appearance-theme-title');
		expect(theme).toBeGreaterThan(-1);
		expect(theme).toBeLessThan(appearance.indexOf('appearance-reading-title'));
		expect(appearance).toContain('role="radiogroup"');
		expect(appearance).toContain('role="radio"');
		expect(appearance).toContain('style={themePreviewStyle(theme)}');
		expect(appearance).toContain('{...themePreviewAttributes(theme)}');
	});

	test('Reading has text size, density, reduce motion, own messages and language', () => {
		for (const id of ['appearance-text-size', 'appearance-density', 'appearance-reduce-motion', 'appearance-own-right', 'appearance-language']) {
			expect(appearance).toContain(`id="${id}"`);
		}
	});

	test('the dead chrome-opacity slider and the raw number input are gone', () => {
		expect(appearance).not.toContain('Chrome opacity');
		expect(appearance).not.toContain('appChromeOpacity');
		expect(appearance).not.toContain('type="number"');
	});

	test('settings rows use the kit switch and segmented control, not ON/OFF buttons or checkboxes', () => {
		for (const source of [appearance, accessibility]) {
			expect(source).not.toContain('toggle-btn');
			expect(source).not.toContain('class="segmented"');
			expect(source).not.toContain('type="checkbox"');
			expect(source).not.toContain('<details');
		}
	});

	test('the reduce-motion switch marks <html data-motion="reduce">', () => {
		expect(appearance).toContain("setAttribute('data-motion', 'reduce')");
		expect(accessibility).toContain("setAttribute('data-motion', 'reduce')");
	});

	test('Accessibility has one text-size control, not a slider plus S/M/L/XL', () => {
		expect(accessibility).toContain('labelledby="a11y-text-size"');
		expect(accessibility).not.toContain('sound-option');
		expect(accessibility).not.toContain('setting-nested');
	});
});

describe('Chat background', () => {
	test('is one picker; the legacy editor chain is retired', () => {
		expect(appearance).toContain('<ChatBackdropSettings />');
		expect(appearance).not.toContain('BackgroundImageEditor');
		expect(backdrop).not.toContain('BackgroundImageEditorLegacy');
		expect(exists('../BackgroundImageEditor.svelte')).toBe(false);
		expect(exists('../BackgroundImageEditorLegacy.svelte')).toBe(false);
	});

	test('keeps reading and writing the same stored data', () => {
		expect(backdrop).toContain('resolveThemeBackground(get(backgroundImageSetting), get(themeStore).customTheme)');
		expect(backdrop).toContain('persistBackgroundImageSetting(next)');
		expect(backdrop).toContain('saveChatBackdropSettings(settings)');
		expect(backdrop).toContain('/api/upload-background-image');
	});
});

describe('settings styles', () => {
	const sheets = [skin, appearanceCss, ...legacySheets];

	test('use roles only: no raw hex or rgba colors, no legacy accent tokens in the rewritten sheets', () => {
		for (const css of [skin, appearanceCss]) {
			expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
			expect(css).not.toMatch(/rgba?\(/);
			expect(css).not.toMatch(/--(accent-primary-color|surface-[a-z]+|text-(primary|secondary|heading|muted))\b/);
		}
	});

	test('no !important, no thin native scrollbars, no transition: all', () => {
		for (const css of sheets) {
			expect(css).not.toContain('!important');
			expect(css).not.toMatch(/scrollbar-width:\s*thin/);
			expect(css).not.toMatch(/transition:\s*all\b/);
		}
	});

	test('selection grammar: raised fill with the signature glyph, ringed in High Contrast, no left bars', () => {
		expect(skin).toMatch(/\.settings-nav__item\[aria-selected='true'\] \{[^}]*background: var\(--w-raise\)/);
		expect(skin).toMatch(/\.settings-nav__item\[aria-selected='true'\] > svg \{[^}]*var\(--w-sig\)/);
		expect(skin).toMatch(/data-char='contrast'\] \.wabi-settings-modal \.settings-nav__item\[aria-selected='true'\] \{[^}]*inset 0 0 0 1px var\(--w-line-strong\)/);
		for (const css of sheets) expect(css).not.toMatch(/inset [23]px 0 0/);
	});

	test('the selected theme wears the page accent outline at 3px; High Contrast outlines every preview', () => {
		expect(appearanceCss).toContain('--page-accent: var(--w-accent)');
		expect(appearanceCss).toMatch(/\[aria-checked='true'\] \.theme-preview \{[^}]*outline: 2px solid var\(--page-accent\);[^}]*outline-offset: 3px/);
		expect(appearanceCss).toMatch(/data-char='contrast'\] \.theme-preview \{[^}]*var\(--page-edge\)/);
	});

	test('the selected segmented key is paper, never an accent fill', () => {
		expect(skin).toMatch(/:is\(\.active, \[aria-pressed='true'\], \[aria-checked='true'\]\) \{[^}]*background: var\(--w-bg\)/);
		for (const css of sheets) expect(css).not.toMatch(/\.active \{[^}]*background: var\(--w-accent\)/);
	});

	test('an input inside a kit field wrapper keeps the single box (no field border inside it)', () => {
		const plainFieldRule = skin.match(/input:not\(\[type\]\),\s*textarea,\s*select\s*\):where\(([^)]*)\)\)/);
		expect(plainFieldRule?.[1]).toContain('.w-field *');
	});
});
