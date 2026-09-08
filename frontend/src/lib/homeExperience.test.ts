import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { applyHomeExperienceMode } from './homeExperience';
import { activeRightTab, pinnedPanelId, rightPanelMode, stubStrip, DEFAULT_STUB_STRIP } from './layoutStoreStates';

function reset() {
	rightPanelMode.set('none');
	pinnedPanelId.set(null);
	activeRightTab.set('users');
	stubStrip.set([...DEFAULT_STUB_STRIP]);
}

beforeEach(reset);
afterEach(reset);

describe('explicit home experience selection', () => {
	test('fresh registration seeds the selected panel and repeating the choice keeps it open', () => {
		for (const [mode, panel] of [['community', 'users'], ['conversations', 'dms']] as const) {
			applyHomeExperienceMode(mode);
			applyHomeExperienceMode(mode);
			expect(get(pinnedPanelId)).toBe(panel);
			expect(get(activeRightTab)).toBe(panel);
			expect(get(rightPanelMode)).toBe('pinned');
		}
	});

	test('explicit Settings choice replaces another pin, then restores it over a transient peek', () => {
		rightPanelMode.set('pinned');
		pinnedPanelId.set('notes');
		activeRightTab.set('notes');
		applyHomeExperienceMode('conversations');
		expect(get(pinnedPanelId)).toBe('dms');
		activeRightTab.set('notes');
		applyHomeExperienceMode('conversations');
		expect(get(activeRightTab)).toBe('dms');
		expect(get(rightPanelMode)).toBe('pinned');
	});
});
