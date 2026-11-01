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
const searchField = read('./SettingsSearch.svelte');
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
		expect(settings).toContain('<SettingsSearch');
		expect(searchField).toContain("'Search settings'");
		expect(searchField).toContain('role="combobox"');
		expect(settings).toContain('<Icon name="x"');
		expect(settings).not.toContain('&#x2715;');
		expect(settings).not.toContain('✕');
	});

	test('the scope note describes the page from outside its heading', () => {
		const heading = settings.match(/<h2 class="settings-head__name"[^>]*>[\s\S]*?<\/h2>/)?.[0] ?? '';
		expect(heading).toContain('pageLabel(activePage, $t)');
		expect(heading).not.toContain('scopeNote');
		expect(settings).toContain('id="settings-scope-note"');
		expect(settings).toContain("aria-describedby={scopeNote ? 'settings-scope-note' : undefined}");
	});

	test('close buttons keep their translated name', () => {
		expect(settings).toContain("translatedOr($t, 'common.close', 'Close')");
		expect(settings).not.toContain('aria-label="Close settings"');
	});

	test('keeps the component\'s Svelte 4 template style (no snippets)', () => {
		expect(settings).not.toContain('{#snippet');
		expect(settings).not.toContain('{@render');
	});

	test('language moved out of the header into Appearance, still translated', () => {
		expect(settings).not.toContain('setAppLocale');
		expect(appearance).toContain('setAppLocale');
		expect(appearance).toContain("translatedOr($t, 'settings.language', 'Language')");
		expect(appearance).toContain('ariaLabel={languageLabel}');
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
	test('a jump scrolls only the page column and focuses the row\'s checked option or tab stop', () => {
		const reveal = settings.slice(settings.indexOf('async function revealSetting'), settings.indexOf('function handleFrameKeydown'));
		expect(reveal).not.toContain('scrollIntoView');
		expect(reveal).toContain('root.scrollTop = centeredScrollTop(');
		expect(reveal).toContain('rowFocusTarget<HTMLElement>(row)?.focus({ preventScroll: true })');
	});

	test('Escape is only kept from the dialog while there is a search to clear', () => {
		expect(searchField).toContain("event.key === 'Escape' && (showResults || query)");
	});

	test('on phones, opening a page moves focus to its back button; arrows in the list only move focus', () => {
		expect(settings).toContain('bind:this={backButton}');
		expect(settings).toMatch(/if \(pushed\) void tick\(\)\.then\(\(\) => backButton\?\.focus\(\)\)/);
		expect(settings).toMatch(/if \(\$isMobile\) tabButtons\[tabOrder\[next\]\]\?\.focus\(\);/);
	});

	/** The sources that render each page (Settings.svelte draws the Privacy & security intro). */
	const pageSources: Record<SettingsTab, string[]> = {
		profile: ['./ProfileSettingsTab.svelte'],
		privacy: ['../Settings.svelte', './ServerSettingsTab.svelte', './VolunteerBoostCard.svelte'],
		notifications: ['./NotificationsSettingsTab.svelte'],
		appearance: ['./AppearanceSettingsTab.svelte', './ChatBackdropSettings.svelte', '../../effects/PointerEffectsTab.svelte'],
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

	test('a failed theme save can be retried: choosing the theme again, or Try again', () => {
		expect(appearance).toContain('themeChoiceAction(themeId, $themeStore.themeId, Boolean(themeSaveError))');
		expect(appearance).toMatch(/<button[^>]*aria-busy=\{themeRetrying\}[^>]*on:click=\{retryThemeSave\}>Try again<\/button/);
		expect(appearance).not.toContain('choose it again to retry');
	});

	test('Try again keeps focus in the dialog: its row stays while the save runs, focus moves before the row goes', () => {
		const retry = appearance.slice(appearance.indexOf('async function retryThemeSave'), appearance.indexOf('async function persistTheme'));
		// Not routed through chooseTheme, which clears the error (and so unmounts the focused button) at once.
		expect(retry).not.toContain('chooseTheme(');
		expect(retry).toContain('themeRetrying = true');
		// On success the checked theme takes focus first, then the row goes.
		expect(retry.indexOf('.focus()')).toBeGreaterThan(-1);
		expect(retry.indexOf('.focus()')).toBeLessThan(retry.indexOf("themeSaveError = ''"));
		// A repeat failure re-creates the alert in new words so it is read out again.
		expect(appearance).toContain('{#key themeSaveFailures}');
		expect(appearance).toContain('THEME_SAVE_FAILED_AGAIN');
	});

	test('each locality fact is said once: the header for the theme and image, the Layout section for its account rows', () => {
		expect(appearance).not.toContain('Synced to server');
		expect(backdrop).not.toContain('follows your account');
		expect(appearance).toContain('appearanceLayoutScopeHint(signedIn, nativeApp)');
		const layout = appearance.slice(appearance.indexOf('id="appearance-layout-title"'), appearance.indexOf('id="appearance-open-to"'));
		expect(layout).toContain('{#if layoutScopeHint}');
		// Settings tells the page whether an account is signed in (the same test as its header note).
		expect(settings).toContain('<AppearanceSettingsTab {signedIn} />');
	});

	test('the server rail rows save to the account, as the Layout line says (they are its only writer)', () => {
		expect(appearance).toContain("import { persistRailLayout } from '$lib/railLayout';");
		for (const fn of ['setRailDensity', 'setRailSide']) {
			const body = appearance.slice(appearance.indexOf(`function ${fn}(`), appearance.indexOf('}', appearance.indexOf(`function ${fn}(`)));
			expect(body).toContain('persistRailLayout()');
		}
		expect(appearance).toContain('onchange={(value) => setRailDensity(value as RailDensity)}');
		expect(appearance).toContain('onchange={(value) => setRailSide(value as RailSide)}');
	});

	test('"Panels pinned side by side" offers every limit the store accepts (1 to MAX_DOCK_STACK_LIMIT)', () => {
		expect(appearance).toContain('dockLimitOptions(MAX_DOCK_STACK_LIMIT)');
		expect(appearance).toMatch(/<Select\s+ariaLabel="Panels pinned side by side"[\s\S]*?options=\{dockLimits\}/);
	});

	test('Customize theme is its own disclosure row, and collapsed disclosures point at nothing', () => {
		expect(appearance).not.toContain('theme-picker__tune');
		expect(appearance).toContain('class="w-disclosure theme-tuning__toggle"');
		expect(appearance).toContain("aria-controls={showThemeTuning ? 'appearance-theme-tuning' : undefined}");
		expect(backdrop).toContain("aria-controls={showMoreImageOptions ? 'backdrop-more-options' : undefined}");
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

	test('the hidden file input is not rendered, so it cannot stretch or scroll the dialog', () => {
		expect(backdrop).toMatch(/<input class="backdrop-file" type="file"[^>]* hidden \/>/);
		expect(appearanceCss).toMatch(/\.backdrop-file \{\s*display: none;\s*\}/);
	});

	test('the preview draws message rows the stream\'s way, not bubbles', () => {
		expect(backdrop).toContain('backdrop-preview__avatar');
		expect(backdrop).not.toContain('backdrop-preview__msg--own');
		const msg = appearanceCss.match(/\.backdrop-preview__msg \{[^}]*\}/)?.[0] ?? '';
		expect(msg).not.toMatch(/border|background/);
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

	test('the dialog frame clips instead of hiding, so script can never scroll it', () => {
		expect(skin).toMatch(/:root \.wabi-settings-modal\.w-dialog,\s*:root \.wabi-settings-modal > \.base-modal__body \{\s*overflow: hidden;\s*overflow: clip;/);
	});

	test('truth labels and theme names wrap instead of being cut off', () => {
		const note = skin.match(/\.settings-head__note \{[^}]*\}/)?.[0] ?? '';
		expect(note).not.toContain('ellipsis');
		expect(note).not.toContain('nowrap');
		expect(skin).toMatch(/\.settings-head__title \{[^}]*flex-wrap: wrap/);
		const name = appearanceCss.match(/\.theme-option__label \{[^}]*\}/)?.[0] ?? '';
		expect(name).not.toContain('ellipsis');
		expect(appearanceCss).toMatch(/\.theme-option__name \{[^}]*flex-wrap: wrap/);
	});

	test('stacked legacy rows align to the top, so grid neighbours line up', () => {
		expect(skin).toMatch(/\.setting-item-stack \{[^}]*justify-content: flex-start/);
	});

	test('kit rules are not restyled app-wide from this sheet', () => {
		expect(skin).not.toMatch(/(^|[\s,}])\.w-range:focus-visible/);
	});

	test('an input inside a kit field wrapper keeps the single box (no field border inside it)', () => {
		const plainFieldRule = skin.match(/input:not\(\[type\]\),\s*textarea,\s*select\s*\):where\(([^)]*)\)\)/);
		expect(plainFieldRule?.[1]).toContain('.w-field *');
	});
});

describe('theme save retry', () => {
	test('an older Try again never clears the alert of a newer save', () => {
		const retry = appearance.slice(appearance.indexOf('async function retryThemeSave()'), appearance.indexOf('async function persistTheme('));
		expect(retry).toContain('const retrySeq = themeSaveSeq + 1;');
		expect(retry).toContain('if (!saved || retrySeq !== themeSaveSeq) return;');
		expect(retry.indexOf('if (!saved || retrySeq !== themeSaveSeq) return;')).toBeLessThan(retry.indexOf("themeSaveError = '';"));
	});
});
