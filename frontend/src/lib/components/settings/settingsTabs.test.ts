/**
 * Settings content tabs (design contract §8.9, §9.1, §9.4): each tab on the kit, saying who it
 * is for, with developer instruments out of member UI. Source guards plus the small models the
 * tabs render from.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONNECTION_DETAILS_KEY, readConnectionDetailsPreference, writeConnectionDetailsPreference } from './connectionDetailsSetting';
import { OFFICE_ADDON_ROWS, RETIRED_LOCAL_ADDON_CONTROLS, officeAddonState } from './officeAddonsSetting';
import { LOCAL_ADDON_CONTROL_META } from './addonSettingsRegistry';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const tabs = {
	profile: read('./ProfileSettingsTab.svelte'),
	notifications: read('./NotificationsSettingsTab.svelte'),
	audio: read('./AudioSettingsTab.svelte'),
	server: read('./ServerSettingsTab.svelte'),
	about: read('./AboutSettingsTab.svelte'),
	emoji: read('./EmojiSettingsTab.svelte'),
	addons: read('./AddonSettingsTab.svelte'),
	admin: read('./AdminSettingsTab.svelte'),
	boost: read('./VolunteerBoostCard.svelte'),
	diagnostics: read('./ConnectionDiagnostics.svelte'),
	tailcat: read('./TailcatConnectionCard.svelte'),
	storage: read('../StorageSettings.svelte'),
	decorations: read('../ProfileAppearanceControls.svelte')
};
const sections = ['Appearance', 'Chat', 'Identity', 'Media', 'Navigation', 'Notifications', 'Search', 'Spoilers', 'Utilities'].map((name) =>
	read(`./addons/${name}Section.svelte`)
);
const addonRow = read('./addons/AddonRow.svelte');
const everything = [...Object.values(tabs), ...sections, addonRow];

class MemoryStorage {
	private values = new Map<string, string>();
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.values.set(key, value);
	}
}

describe('every settings tab uses the kit', () => {
	test('no native dialogs, selects, details or ON/OFF text toggles', () => {
		for (const source of everything) {
			expect(source).not.toMatch(/\b(window\.)?(alert|confirm|prompt)\(/);
			expect(source).not.toMatch(/<select\b|<details\b/);
			expect(source).not.toMatch(/class="toggle-btn|settings-group-card|setting-item/);
		}
	});

	test('add-on options are switch rows, not native checkboxes', () => {
		for (const source of sections) expect(source).not.toContain('type="checkbox"');
		expect(sections.join('\n')).toContain('class="addon-option"');
	});

	test('maturity tags carry the base tag class', () => {
		for (const source of everything) {
			for (const match of source.matchAll(/class="([^"]*w-tag--mat[^"]*)"/g)) {
				expect(match[1].split(/\s+/)).toContain('w-tag');
			}
		}
	});

	test('labels are sentence case (settings#13)', () => {
		const joined = everything.join('\n');
		for (const titleCase of ['Desktop Notifications', 'Suppress All Role', 'Show Message Preview', 'Server Management', 'Reset Usage Counters', 'Reset Unicode Counters', 'System Default']) {
			expect(joined).not.toContain(titleCase);
		}
	});
});

describe('Profile', () => {
	test('counters read "N / limit", never bytes, and there is one save path', () => {
		expect(tabs.profile).toContain('profileCounter(');
		expect(tabs.profile).not.toMatch(/bytes/i);
		expect(tabs.profile.match(/<form\b/g)?.length).toBe(1);
		expect(tabs.profile).toContain('w-profile__savebar');
	});
});

describe('Audio & video › Troubleshooting', () => {
	test('connection details are a per-device switch, off by default', () => {
		const storage = new MemoryStorage();
		expect(readConnectionDetailsPreference(storage)).toBe(false);
		writeConnectionDetailsPreference(true, storage);
		expect(storage.getItem(CONNECTION_DETAILS_KEY)).toBe('on');
		expect(readConnectionDetailsPreference(storage)).toBe(true);
		writeConnectionDetailsPreference(false, storage);
		expect(readConnectionDetailsPreference(storage)).toBe(false);
		expect(readConnectionDetailsPreference(null)).toBe(false);
	});

	test('the switch and the connection facts live only inside the Troubleshooting disclosure', () => {
		const disclosure = tabs.audio.indexOf('id="audio-troubleshooting"');
		expect(disclosure).toBeGreaterThan(0);
		expect(tabs.audio.lastIndexOf('Show connection details during calls')).toBeGreaterThan(disclosure);
		expect(tabs.audio.indexOf('<ConnectionDiagnostics />')).toBeGreaterThan(disclosure);
		expect(tabs.about).not.toContain('ConnectionDiagnostics');
	});

	test('connection facts are words, never relay ids, URLs or raw enums', () => {
		expect(tabs.diagnostics).not.toMatch(/relayNodeId|advertisedUrl|TURN ready|SFU off|Gateway off/);
		expect(tabs.diagnostics).not.toContain("replaceAll('_', ' ')");
	});
});

describe('About', () => {
	test('memory telemetry exists only in dev builds outside the showcase', () => {
		expect(tabs.about).toContain('const showDevInstruments = isDevBuild && !isShowcaseMode();');
		expect(tabs.about).toContain('{#if showDevInstruments}');
		const gate = tabs.about.indexOf('{#if showDevInstruments}');
		expect(tabs.about.indexOf('Sample memory use')).toBeGreaterThan(gate);
	});
});

describe('Privacy & security › This device (the old Server tab)', () => {
	test('device options say whose they are; the boost card keeps EXPERIMENTAL', () => {
		expect(tabs.server).not.toContain('Server Management');
		expect(tabs.server).toContain('Saved on this device · not shared');
		expect(tabs.boost).toMatch(/class="w-tag w-tag--mat"[^>]*>Experimental</);
		// Consent is given before the start button.
		expect(tabs.boost.indexOf('class="w-check"')).toBeLessThan(tabs.boost.indexOf("'Start boosting'"));
	});

	test('raw error text is logged, not shown', () => {
		for (const source of [tabs.boost, tabs.tailcat, tabs.storage]) {
			expect(source).not.toMatch(/error = e instanceof Error \? e\.message/);
		}
	});
});

describe('Add-ons', () => {
	test('Sheets and Present are per-device switches with PREVIEW and consent facts', () => {
		expect(OFFICE_ADDON_ROWS.map((row) => row.id)).toEqual(['sheets', 'present']);
		for (const row of OFFICE_ADDON_ROWS) {
			expect(row.facts.length).toBeGreaterThanOrEqual(2);
			expect(row.facts.join(' ')).toContain('shares no files');
		}
		expect(tabs.addons).toContain("word('maturity.preview', 'Preview')");
		expect(tabs.addons).toContain('role="switch"');
		expect(tabs.addons).toContain('setWorkspaceAddonEnabled(id, next)');
	});

	test('the row hint states availability and this device choice', () => {
		expect(officeAddonState(null, false)).toBe('Checking this build…');
		expect(officeAddonState(false, true)).toBe('Not included in this build of the app.');
		expect(officeAddonState(true, true)).toBe('On for this device.');
		expect(officeAddonState(true, false)).toBe('Off on this device.');
	});

	test('no usage counters (beta-sweep#14)', () => {
		const joined = sections.join('\n');
		expect(joined).not.toMatch(/quick-strip clicks|picker opens|shortcode collisions|Local counters|Local usage counters/);
		expect(joined).not.toMatch(/Reset (Usage|Unicode) Counters|Export Unicode Prefs/);
	});

	test('a retired control is neither rendered nor counted', () => {
		for (const id of RETIRED_LOCAL_ADDON_CONTROLS) {
			expect(sections.join('\n')).not.toContain(`localAddonControlMatches('${id}')`);
			// The registry entry belongs to another package; the page still has to skip it.
			if (Object.hasOwn(LOCAL_ADDON_CONTROL_META, id)) expect(tabs.addons).toContain('RETIRED_LOCAL_ADDON_CONTROLS.has(id)');
		}
	});
});

describe('Storage', () => {
	test('queue state is words, the required queue is a fact, disabled states are real', () => {
		expect(tabs.storage).not.toMatch(/pending: \{|failed: \{|synced: \{/);
		expect(tabs.storage).toContain('queueWords');
		expect(tabs.storage).not.toContain("'storage.offline.scopes.always_on'");
		expect(tabs.storage).toMatch(/disabled=\{working \|\| !ready \|\| queueCounts\.failed === 0\}/);
	});
});
