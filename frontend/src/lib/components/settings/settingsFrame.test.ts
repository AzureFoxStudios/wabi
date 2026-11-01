import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	ACCESSIBILITY_TEXT_SIZES,
	APPEARANCE_ACCOUNT_SCOPE_NOTE,
	APPEARANCE_TEXT_SIZES,
	DEVICE_SCOPE_NOTE,
	appearanceLayoutScopeHint,
	ROW_FOCUS_SELECTORS,
	centeredScrollTop,
	dockLimitOptions,
	rowFocusTarget,
	FOOT_PAGE,
	SETTINGS_PAGES,
	SETTINGS_SEARCH_INDEX,
	resolveSettingsRequest,
	searchSettings,
	settingsNavGroups,
	settingsScopeNote,
	settingsTabOrder,
	textSizeOptions,
	textSizeValue
} from './settingsFrame';
import { ICONS } from '../ui/icons';

const en = JSON.parse(readFileSync(fileURLToPath(new URL('../../i18n/locales/en.json', import.meta.url)), 'utf8'));
const lookup = (key: string) => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);

describe('settings nav', () => {
	test('groups are Account, This device and the community, with About in the foot', () => {
		const groups = settingsNavGroups('Common Ground', true);
		expect(groups.map((group) => group.label)).toEqual(['Account', 'This device', 'Common Ground']);
		expect(groups.map((group) => group.pages.map((page) => page.id))).toEqual([
			['profile', 'privacy', 'notifications'],
			['appearance', 'accessibility', 'audio', 'games', 'addons'],
			['emojis', 'storage', 'admin']
		]);
		expect(FOOT_PAGE.id).toBe('about');
	});

	test('Admin is only listed for people who can manage the community', () => {
		expect(settingsNavGroups('Common Ground', false)[2].pages.map((page) => page.id)).toEqual(['emojis', 'storage']);
		expect(settingsTabOrder(false)).not.toContain('admin');
		expect(settingsTabOrder(true)).toContain('admin');
	});

	test('an unnamed community still gets a kicker', () => {
		expect(settingsNavGroups('  ', false)[2].label).toBe('This community');
	});

	test('tab order is the nav order with About last (arrow keys follow it)', () => {
		expect(settingsTabOrder(true)).toEqual([
			'profile', 'privacy', 'notifications', 'appearance', 'accessibility', 'audio', 'games', 'addons', 'emojis', 'storage', 'admin', 'about'
		]);
	});

	test('every page has an English label in the locale pack and a registered icon', () => {
		for (const page of Object.values(SETTINGS_PAGES)) {
			expect(lookup(page.labelKey)).toBe(page.label);
			expect(ICONS[page.icon]).toBeDefined();
		}
	});
});

describe('settings requests', () => {
	test('the old Server page opens Privacy & security, where its device choices now live', () => {
		expect(resolveSettingsRequest('server')).toBe('privacy');
	});

	test('known pages open as asked; unknown requests do nothing', () => {
		for (const request of ['profile', 'notifications', 'audio', 'addons'] as const) expect(resolveSettingsRequest(request)).toBe(request);
		expect(resolveSettingsRequest('nope')).toBeNull();
		expect(resolveSettingsRequest(null)).toBeNull();
	});
});

describe('scope notes', () => {
	test('device pages say they stay on this device; community pages say who sees them', () => {
		for (const tab of ['appearance', 'accessibility', 'audio', 'addons'] as const) {
			expect(settingsScopeNote(tab, 'Common Ground')).toBe(DEVICE_SCOPE_NOTE);
		}
		for (const tab of ['accessibility', 'audio', 'addons'] as const) {
			expect(settingsScopeNote(tab, 'Common Ground', true)).toBe(DEVICE_SCOPE_NOTE);
		}
		expect(DEVICE_SCOPE_NOTE).toBe('Saved on this device · not shared');
		for (const tab of ['emojis', 'admin'] as const) {
			expect(settingsScopeNote(tab, 'Common Ground')).toBe('Visible to members of Common Ground');
		}
	});

	test('Profile names what members see (its password and payment rows are not shown to them)', () => {
		expect(settingsScopeNote('profile', 'Common Ground')).toBe('Your profile is visible to members of Common Ground');
		expect(settingsScopeNote('profile', ' ')).toBe('Your profile is visible to members of this community');
	});

	test('signed in, Appearance says the theme and background image follow the account (they are saved there)', () => {
		expect(settingsScopeNote('appearance', 'Common Ground', true)).toBe(APPEARANCE_ACCOUNT_SCOPE_NOTE);
		expect(APPEARANCE_ACCOUNT_SCOPE_NOTE).toBe('Theme and background image follow your account');
		expect(APPEARANCE_ACCOUNT_SCOPE_NOTE).not.toContain('not shared');
	});

	test('the signed-in header makes no claim about "the rest": Navigation side and the server rail follow the account too', () => {
		// They live in the /api/user/layout container (layoutPersistence queuePersist, railLayout.ts),
		// so a header saying everything else stays on this device would be false for them.
		expect(APPEARANCE_ACCOUNT_SCOPE_NOTE).not.toMatch(/rest|this device|everything else/i);
	});

	test('the header note is short enough to sit beside the page title (one-line header, §8.9)', () => {
		expect(APPEARANCE_ACCOUNT_SCOPE_NOTE.length).toBeLessThanOrEqual(DEVICE_SCOPE_NOTE.length + 16);
	});
});

describe('Layout locality line on Appearance', () => {
	test('signed in, it names the rows saved to the account (the others are this device, as the nav group says)', () => {
		expect(appearanceLayoutScopeHint(true, false)).toBe('Navigation side and the server rail follow your account.');
	});

	test('the desktop app adds its layout presets, which are part of the same saved layout', () => {
		expect(appearanceLayoutScopeHint(true, true)).toBe('Navigation side, the server rail and layout presets follow your account.');
	});

	test('it is a one-line section hint (§8.9: one-line hints; .settings-block__hint is 68ch)', () => {
		for (const presets of [false, true]) expect(appearanceLayoutScopeHint(true, presets).length).toBeLessThanOrEqual(72);
	});

	test('signed out there is no line: nothing leaves the device and the header already says so', () => {
		expect(appearanceLayoutScopeHint(false, false)).toBe('');
		expect(appearanceLayoutScopeHint(false, true)).toBe('');
		expect(settingsScopeNote('appearance', 'Common Ground', false)).toBe(DEVICE_SCOPE_NOTE);
	});
});

describe('scope notes on other pages', () => {
	test('Notifications never claims "this device": its push choices are account switches for every device', () => {
		expect(settingsScopeNote('notifications', 'Common Ground')).toBe('');
		expect(settingsScopeNote('notifications', 'Common Ground', true)).toBe('');
	});

	test('pages that mix both or only describe have no note', () => {
		for (const tab of ['privacy', 'games', 'storage', 'about', 'notifications'] as const) expect(settingsScopeNote(tab, 'Common Ground')).toBe('');
	});
});

describe('landing on a searched row', () => {
	/** A row stand-in: answers querySelector from a selector → element map. */
	const rowWith = (found: Record<string, string>) => ({ querySelector: (selector: string) => found[selector] ?? null });
	const [checkedRadio, tabStop, firstControl] = ROW_FOCUS_SELECTORS;

	test('focus goes to the checked option, never to an unchecked segment key', () => {
		expect(checkedRadio).toBe('[role="radio"][aria-checked="true"]');
		expect(rowFocusTarget(rowWith({ [checkedRadio]: '100%', [firstControl]: '90%' }))).toBe('100%');
	});

	test('then the row tab stop, then its first enabled control; nothing when the row has none', () => {
		expect(rowFocusTarget(rowWith({ [tabStop]: 'theme', [firstControl]: 'more' }))).toBe('theme');
		expect(rowFocusTarget(rowWith({ [firstControl]: 'switch' }))).toBe('switch');
		expect(firstControl).toContain(':not([tabindex="-1"])');
		expect(rowFocusTarget(rowWith({}))).toBeNull();
	});

	test('only the page column scrolls, to centre the row, clamped to what it can scroll', () => {
		const scroller = { scrollTop: 0, top: 100, height: 600, scrollHeight: 2000 };
		expect(centeredScrollTop(scroller, { top: 900, height: 80 })).toBe(540);
		expect(centeredScrollTop({ ...scroller, scrollTop: 300 }, { top: 150, height: 80 })).toBe(90);
		expect(centeredScrollTop(scroller, { top: 120, height: 80 })).toBe(0);
		expect(centeredScrollTop(scroller, { top: 5000, height: 80 })).toBe(1400);
	});
});

describe('layout limits', () => {
	test('"Panels pinned side by side" offers every limit the store accepts, 1 to 12', () => {
		const options = dockLimitOptions(12);
		expect(options).toHaveLength(12);
		expect(options[0]).toEqual({ value: '1', label: '1 panel' });
		expect(options[11]).toEqual({ value: '12', label: '12 panels' });
	});
});

describe('search settings', () => {
	test('a label prefix ranks first and names its page', () => {
		const [first] = searchSettings('text', false);
		expect(first).toMatchObject({ tab: 'appearance', label: 'Text size', pageLabel: 'Appearance' });
	});

	test('keywords find settings by other words', () => {
		expect(searchSettings('dark mode', false)[0]).toMatchObject({ tab: 'appearance', label: 'Theme' });
		expect(searchSettings('gps', false)[0]).toMatchObject({ tab: 'privacy', label: 'Directions GPS' });
		expect(searchSettings('avatar', false).map((result) => result.label)).toContain('Profile picture');
	});

	test('accents and case do not matter', () => {
		expect(searchSettings('ESPANOL', false)[0]).toMatchObject({ label: 'Language' });
		expect(searchSettings('  Reduce   MOTION ', false).map((result) => result.tab)).toEqual(['appearance', 'accessibility']);
	});

	test('admin-only results are hidden from members', () => {
		expect(searchSettings('dashboard', false)).toEqual([]);
		expect(searchSettings('dashboard', true)[0]).toMatchObject({ tab: 'admin' });
	});

	test('an empty query finds nothing; results are capped', () => {
		expect(searchSettings('   ', true)).toEqual([]);
		expect(searchSettings('e', true, 5)).toHaveLength(5);
	});

	test('every index entry points at a page that exists', () => {
		for (const entry of SETTINGS_SEARCH_INDEX) expect(SETTINGS_PAGES[entry.tab]).toBeDefined();
	});
});

describe('text size keys', () => {
	test('Appearance offers 90 / 100 / 112 / 125%; Accessibility adds 150%', () => {
		expect(textSizeOptions(1, APPEARANCE_TEXT_SIZES).map((option) => option.label)).toEqual(['90%', '100%', '112%', '125%']);
		expect(textSizeOptions(1, ACCESSIBILITY_TEXT_SIZES).map((option) => option.label)).toEqual(['90%', '100%', '112%', '125%', '150%']);
	});

	test('a saved scale that is not a key is shown in order, so the control tells the truth', () => {
		const options = textSizeOptions(1.2, APPEARANCE_TEXT_SIZES);
		expect(options.map((option) => option.label)).toEqual(['90%', '100%', '112%', '120%', '125%']);
		expect(textSizeValue(1.2, options)).toBe(1.2);
	});

	test('rounding noise from the old slider still selects the key', () => {
		const options = textSizeOptions(1.1200000001, APPEARANCE_TEXT_SIZES);
		expect(options).toHaveLength(4);
		expect(textSizeValue(1.1200000001, options)).toBe(1.12);
	});
});
