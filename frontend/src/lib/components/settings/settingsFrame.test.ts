import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	ACCESSIBILITY_TEXT_SIZES,
	APPEARANCE_TEXT_SIZES,
	DEVICE_SCOPE_NOTE,
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
		for (const tab of ['appearance', 'accessibility', 'audio', 'addons', 'notifications'] as const) {
			expect(settingsScopeNote(tab, 'Common Ground')).toBe(DEVICE_SCOPE_NOTE);
		}
		expect(DEVICE_SCOPE_NOTE).toBe('Saved on this device · not shared');
		for (const tab of ['profile', 'emojis', 'admin'] as const) {
			expect(settingsScopeNote(tab, 'Common Ground')).toBe('Visible to members of Common Ground');
		}
	});

	test('pages that mix both or only describe have no note', () => {
		for (const tab of ['privacy', 'games', 'storage', 'about'] as const) expect(settingsScopeNote(tab, 'Common Ground')).toBe('');
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
