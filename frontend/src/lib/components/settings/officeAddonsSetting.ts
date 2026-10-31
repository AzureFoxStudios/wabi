/**
 * Settings › Add-ons › Office tools (design contract §8.9, §9.1): Sheets and Present are optional
 * add-ons and an integration candidate, never a shipped feature. Each row is a per-device switch
 * with its maturity word and the consent facts said before you turn it on.
 */

import type { OfficeAddon } from '$lib/workspaces/addonState';

export const PREVIEW_TITLE = 'Integration candidate, not a deployed feature';
export const OFFICE_KICKER = 'Optional add-on · Preview';

export interface OfficeAddonRow {
	id: OfficeAddon;
	name: string;
	/** What it is, one line. */
	summary: string;
	/** What turning it on does and does not do, said before the switch. */
	facts: string[];
}

export const OFFICE_ADDON_ROWS: OfficeAddonRow[] = [
	{
		id: 'sheets',
		name: 'Sheets',
		summary: 'Spreadsheets in center stage, beside your channels.',
		facts: [
			'Its editor loads only when you open Sheets.',
			'Turning it on shares no files.',
			'Present stays as it is.'
		]
	},
	{
		id: 'present',
		name: 'Present',
		summary: 'Slide decks you can present to a call.',
		facts: [
			'Its editor loads only when you open Present.',
			'Turning it on shares no files.',
			'Sheets stays as it is.'
		]
	}
];

/** The hint under a row, from what this build includes and what this device chose. */
export function officeAddonState(available: boolean | null, enabled: boolean): string {
	if (available === null) return 'Checking this build…';
	if (!available) return 'Not included in this build of the app.';
	return enabled ? 'On for this device.' : 'Off on this device.';
}

/**
 * Local add-on controls whose rows were retired but whose registry entry remains (the registry
 * belongs to another package). They never render, so the Add-ons page leaves them out of its
 * "N shown" count. "Show a clear-unread action" stopped changing anything once Mark all read
 * moved into the CHANNELS and channel menus.
 */
export const RETIRED_LOCAL_ADDON_CONTROLS: ReadonlySet<string> = new Set(['read_all_notifications_button']);
