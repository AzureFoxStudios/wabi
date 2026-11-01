import { describe, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { desktopServerRailWidth, switcherPanelGeometry, SWITCHER_MIN_WIDTH } from './serverSwitcherLayout';

describe('switcherPanelGeometry: over the sidebar, beside the rail, never crushed', () => {
	test('a full sidebar gets a switcher at its own width', () => {
		expect(switcherPanelGeometry(280, 0)).toEqual({ offset: 0, width: 280 });
		expect(switcherPanelGeometry(360, 0)).toEqual({ offset: 0, width: 360 });
	});

	test('the rail stays visible: the switcher starts after it', () => {
		expect(switcherPanelGeometry(280, 92)).toEqual({ offset: 92, width: 280 });
		expect(switcherPanelGeometry(300, 48)).toEqual({ offset: 48, width: 300 });
	});

	test('a compact or collapsed sidebar still gets a usable switcher', () => {
		for (const sidebar of [0, 50, 60, 120, 160, 240, 279]) {
			expect(switcherPanelGeometry(sidebar, 0).width).toBe(SWITCHER_MIN_WIDTH);
		}
		expect(SWITCHER_MIN_WIDTH).toBeGreaterThanOrEqual(260);
	});

	test('nonsense widths read as zero, never as negative or NaN', () => {
		expect(switcherPanelGeometry(Number.NaN, Number.NaN)).toEqual({ offset: 0, width: SWITCHER_MIN_WIDTH });
		expect(switcherPanelGeometry(-40, -92)).toEqual({ offset: 0, width: SWITCHER_MIN_WIDTH });
		expect(switcherPanelGeometry(Number.POSITIVE_INFINITY, 0).width).toBe(SWITCHER_MIN_WIDTH);
	});

	test('the rail width store starts at zero (no rail until ServerRail renders one)', () => {
		expect(get(desktopServerRailWidth)).toBe(0);
	});
});
