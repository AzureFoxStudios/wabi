import { describe, expect, test } from 'bun:test';
import { ADDON_SECTION_IDS, LOCAL_ADDON_CONTROL_META } from './addonSettingsRegistry';
import { createAddonSettingsView } from './addonSettingsView';

describe('add-on settings render snapshots', () => {
	test('every available control contributes to its section and the total', () => {
		for (const translatorDetected of [false, true]) {
			const view = createAddonSettingsView('', 'chat', translatorDetected);
			let total = 0;
			for (const section of ADDON_SECTION_IDS) {
				const count = Object.entries(LOCAL_ADDON_CONTROL_META).filter(
					([id, meta]) => meta.section === section && view.localAddonControlMatches(id)
				).length;
				expect(view.addonSectionMatchCount(section)).toBe(count);
				total += count;
			}
			expect(view.visibleLocalAddonControlCount).toBe(total);
			expect(view.availableLocalAddonControlCount).toBe(total);
		}
	});

	test('changing the query updates section visibility, expansion, and callback props together', () => {
		const before = createAddonSettingsView('', 'chat', false);
		const after = createAddonSettingsView('MoreQuickReacts', 'chat', false);
		expect(before.isAddonSectionOpen('chat')).toBe(true);
		expect(before.isAddonSectionOpen('media')).toBe(false);
		expect(after.visibleLocalAddonControlCount).toBe(1);
		expect(after.localAddonControlMatches('more_quick_reacts')).toBe(true);
		expect(after.localAddonControlMatches('spellcheck')).toBe(false);
		expect(after.isAddonSectionOpen('media')).toBe(true);
		expect(after.isAddonSectionOpen('chat')).toBe(false);
		expect(after.addonSectionMatchCount('media')).toBe(1);
		expect(after.localAddonControlMatches).not.toBe(before.localAddonControlMatches);
		expect(after.isAddonSectionOpen).not.toBe(before.isAddonSectionOpen);
		expect(after.addonSectionMatchCount).not.toBe(before.addonSectionMatchCount);
		// Earlier rendered snapshots never start reading a later query by closure.
		expect(before.localAddonControlMatches('spellcheck')).toBe(true);
	});

	test('search expands all matching sections and clearing restores manual selection', () => {
		const search = createAddonSettingsView('emoji', 'utilities', false);
		expect(search.isAddonSectionOpen('chat')).toBe(true);
		expect(search.isAddonSectionOpen('media')).toBe(true);
		expect(search.isAddonSectionOpen('utilities')).toBe(false);
		const cleared = createAddonSettingsView('', 'utilities', false);
		for (const section of ADDON_SECTION_IDS) {
			expect(cleared.isAddonSectionOpen(section)).toBe(section === 'utilities');
		}
	});

	test('manual accordion selection and collapse work across every section', () => {
		for (const active of [...ADDON_SECTION_IDS, null]) {
			const view = createAddonSettingsView('', active, false);
			for (const section of ADDON_SECTION_IDS) {
				expect(view.isAddonSectionOpen(section)).toBe(section === active);
			}
		}
	});

	test('late translator inventory updates matching content and counts consistently', () => {
		const before = createAddonSettingsView('translator', 'chat', false);
		const detected = createAddonSettingsView('translator', 'chat', true);
		expect(before.visibleLocalAddonControlCount).toBe(0);
		expect(before.isAddonSectionOpen('utilities')).toBe(false);
		expect(detected.availableLocalAddonControlCount).toBe(before.availableLocalAddonControlCount + 1);
		expect(detected.visibleLocalAddonControlCount).toBe(1);
		expect(detected.localAddonControlMatches('translator_addon')).toBe(true);
		expect(detected.isAddonSectionOpen('utilities')).toBe(true);
		expect(detected.addonSectionMatchCount('utilities')).toBe(1);
		expect(before.localAddonControlMatches('translator_addon')).toBe(false);
	});

	test('unknown, removed, and nonmatching controls do not advertise phantom matches', () => {
		for (const query of ['not-an-addon-at-all', 'LINE DM', 'PinDMs']) {
			const view = createAddonSettingsView(query, 'chat', false);
			expect(view.visibleLocalAddonControlCount).toBe(0);
			for (const section of ADDON_SECTION_IDS) {
				expect(view.isAddonSectionOpen(section)).toBe(false);
			}
		}
		expect(createAddonSettingsView('', 'chat', true).localAddonControlMatches('toString')).toBe(false);
	});
});
