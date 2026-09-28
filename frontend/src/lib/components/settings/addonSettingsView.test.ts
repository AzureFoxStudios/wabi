import { describe, expect, test } from 'bun:test';
import { ADDON_SECTION_IDS, LOCAL_ADDON_CONTROL_META } from './addonSettingsRegistry';
import { createAddonSettingsView } from './addonSettingsView';

const NO_STATE: Record<string, boolean> = {};

describe('add-on settings render snapshots', () => {
	test('every available control contributes to its section and the total', () => {
		const view = createAddonSettingsView('', false, NO_STATE);
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
	});

	test('changing the query updates visibility and counts together', () => {
		const before = createAddonSettingsView('', false, NO_STATE);
		const after = createAddonSettingsView('MoreQuickReacts', false, NO_STATE);
		expect(before.visibleLocalAddonControlCount).toBe(before.availableLocalAddonControlCount);
		expect(after.visibleLocalAddonControlCount).toBe(1);
		expect(after.localAddonControlMatches('more_quick_reacts')).toBe(true);
		expect(after.localAddonControlMatches('spellcheck')).toBe(false);
		expect(after.addonSectionMatchCount('media')).toBe(1);
		expect(after.localAddonControlMatches).not.toBe(before.localAddonControlMatches);
		expect(after.addonSectionMatchCount).not.toBe(before.addonSectionMatchCount);
		// Earlier rendered snapshots never start reading a later query by closure.
		expect(before.localAddonControlMatches('spellcheck')).toBe(true);
	});

	test('enabled-only hides rows reported as off and keeps unreported rows visible', () => {
		const state = { spellcheck: false, char_counter: true };
		const filtered = createAddonSettingsView('', true, state);
		expect(filtered.localAddonControlMatches('spellcheck')).toBe(false);
		expect(filtered.localAddonControlMatches('char_counter')).toBe(true);
		// A control that has not reported yet must not disappear.
		expect(filtered.localAddonControlMatches('more_quick_reacts')).toBe(true);
		expect(filtered.visibleLocalAddonControlCount).toBe(
			filtered.availableLocalAddonControlCount - 1
		);
		const unfiltered = createAddonSettingsView('', false, state);
		expect(unfiltered.localAddonControlMatches('spellcheck')).toBe(true);
	});

	test('category filter narrows local rows and toggles the server/bundled groups', () => {
		const media = createAddonSettingsView('', false, NO_STATE, 'media');
		expect(media.showLocalRows).toBe(true);
		expect(media.showServerRows).toBe(false);
		expect(media.showBundledRows).toBe(false);
		expect(media.localAddonControlMatches('more_quick_reacts')).toBe(true);
		expect(media.localAddonControlMatches('spellcheck')).toBe(false);

		const server = createAddonSettingsView('', false, NO_STATE, 'server');
		expect(server.showServerRows).toBe(true);
		expect(server.showLocalRows).toBe(false);
		expect(server.visibleLocalAddonControlCount).toBe(0);

		const all = createAddonSettingsView('', false, NO_STATE, 'all');
		expect(all.showServerRows).toBe(true);
		expect(all.showBundledRows).toBe(true);
		expect(all.showLocalRows).toBe(true);
	});

	test('translator settings stay discoverable regardless of runtime detection', () => {
		const view = createAddonSettingsView('translator', false, NO_STATE);
		expect(view.visibleLocalAddonControlCount).toBe(1);
		expect(view.localAddonControlMatches('translator_addon')).toBe(true);
		expect(view.addonSectionMatchCount('utilities')).toBe(1);
	});

	test('inventory rows honor the same query and enabled-only filter as local controls', () => {
		const steam = { id: 'steam', name: 'Steam', enabled: false };
		const lore = { id: 'lore', name: 'Lore', enabled: true };
		expect(createAddonSettingsView('steam', false, NO_STATE).inventoryAddonMatches(steam, 'server')).toBe(true);
		expect(createAddonSettingsView('steam', false, NO_STATE).inventoryAddonMatches(lore, 'server')).toBe(false);
		expect(createAddonSettingsView('no-addon-matches', false, NO_STATE).inventoryAddonMatches(steam, 'bundled')).toBe(false);
		expect(createAddonSettingsView('', true, NO_STATE).inventoryAddonMatches(steam, 'server')).toBe(false);
		expect(createAddonSettingsView('', true, NO_STATE).inventoryAddonMatches(lore, 'server')).toBe(true);
	});

	test('unknown, removed, and nonmatching controls do not advertise phantom matches', () => {
		for (const query of ['not-an-addon-at-all', 'LINE DM', 'PinDMs']) {
			const view = createAddonSettingsView(query, false, NO_STATE);
			expect(view.visibleLocalAddonControlCount).toBe(0);
			for (const section of ADDON_SECTION_IDS) {
				expect(view.addonSectionMatchCount(section)).toBe(0);
			}
		}
		expect(
			createAddonSettingsView('', false, NO_STATE).localAddonControlMatches('toString')
		).toBe(false);
	});
});
