/**
 * Every keyboard shortcut Wabi binds, in one place, for the Settings > Keyboard page.
 *
 * What is listed here was read from the code that handles the key (the file is named beside each
 * group), and the three office tools come straight from their own list in
 * workspaces/officeShortcuts.ts, so that list and this page can never disagree. Areas that have not
 * been audited yet (calls, whiteboard, maps, the gallery viewer) are not listed rather than guessed;
 * `UNLISTED_NOTE` says so on the page.
 *
 * `Mod` is Ctrl, or the command key on a Mac. This is read-only: the page shows what is bound, it
 * does not rebind anything.
 */
import { shortcutsFor, type ShortcutGroup, type ShortcutRow } from '../workspaces/officeShortcuts';

export type { ShortcutGroup, ShortcutRow };

export interface ShortcutArea {
	id: string;
	title: string;
	/** One line on where these keys work. */
	where: string;
	groups: ShortcutGroup[];
}

export const UNLISTED_NOTE =
	'Only keys that are bound today and have been checked are listed. Calls, the whiteboard, maps and the gallery viewer have their own key handling that is not listed yet.';

// MainLayout.svelte, routes/+page.svelte, jumpIndex.ts.
const GENERAL: ShortcutArea = {
	id: 'general',
	title: 'Anywhere in Wabi',
	where: 'Work from any screen once you are signed in.',
	groups: [
		{
			title: 'Getting around',
			rows: [
				{ keys: 'Mod+K', action: 'Open or close the jump palette: go to any channel, person or page' },
				{ keys: 'Mod+Shift+N', action: 'Open or close the quick scratchpad' },
				{ keys: 'Ctrl+Shift+O', action: 'Sign out' }
			]
		}
	]
};

// chat/ChatComposer.svelte (handleKeyDown), ForumComposer.svelte.
const CHAT: ShortcutArea = {
	id: 'chat',
	title: 'Chat and forum',
	where: 'In the message box of a channel or a conversation, and the forum composer.',
	groups: [
		{
			title: 'Writing a message',
			rows: [
				{ keys: 'Enter', action: 'Send the message' },
				{ keys: 'Shift+Enter', action: 'New line' },
				{ keys: 'Up arrow in an empty box', action: 'Edit your last message' },
				{ keys: 'Esc', action: 'Cancel an edit, or close the suggestion list' },
				{ keys: '/ at the start', action: 'Show the command list' }
			]
		},
		{
			title: 'Suggestions while you type',
			rows: [
				{ keys: ': then letters', action: 'Suggest emoji; Up and Down to choose, Tab to accept' },
				{ keys: '@ then letters', action: 'Suggest people; Up and Down to choose, Enter or Tab to accept' }
			]
		},
		{ title: 'Forum', rows: [{ keys: 'Mod+Enter', action: 'Post your thread or reply' }] }
	]
};

// Settings.svelte (handleFrameKeydown), settings/ProfileSettingsTab.svelte, ReaderTabImpl.svelte.
const OTHER: ShortcutArea = {
	id: 'other',
	title: 'Settings and reading',
	where: 'On those pages only.',
	groups: [
		{
			title: 'Settings',
			rows: [
				{ keys: '/', action: 'Jump to Search settings (when you are not typing in a field)' },
				{ keys: 'Mod+Enter on the profile page', action: 'Save your profile' }
			]
		},
		{
			title: 'Reader',
			rows: [
				{ keys: 'Mod+F with text selected', action: 'Search for the selected text' },
				{ keys: 'F with text selected', action: 'Turn focus mode on or off' }
			]
		}
	]
};

const OFFICE: { id: string; title: string; tool: 'documents' | 'sheets' | 'present'; where: string }[] = [
	{ id: 'documents', title: 'Documents', tool: 'documents', where: 'Writing in a document.' },
	{ id: 'sheets', title: 'Sheets', tool: 'sheets', where: 'Working in a spreadsheet.' },
	{ id: 'present', title: 'Present', tool: 'present', where: 'Editing or running a presentation.' }
];

const withMac = (area: ShortcutArea, mac: boolean): ShortcutArea => ({
	...area,
	groups: area.groups.map((group) => ({ title: group.title, rows: group.rows.map((row) => ({ keys: mark(row.keys, mac), action: row.action })) }))
});

/** `Mod` shows as Ctrl, or as the command key on a Mac (with Alt as Option). */
function mark(keys: string, mac: boolean): string {
	return mac ? keys.replaceAll('Mod', '⌘').replaceAll('Alt', 'Option') : keys.replaceAll('Mod', 'Ctrl');
}

export function shortcutAreas(mac: boolean): ShortcutArea[] {
	return [
		withMac(GENERAL, mac),
		withMac(CHAT, mac),
		...OFFICE.map((area) => ({ id: area.id, title: area.title, where: area.where, groups: shortcutsFor(area.tool, mac) })),
		withMac(OTHER, mac)
	];
}

/**
 * Keeps the rows that match every word of `query` (in the keys, the action, or the group, area
 * and where-it-works words), dropping groups and areas left empty. An empty query keeps everything.
 */
export function searchShortcutAreas(areas: readonly ShortcutArea[], query: string): ShortcutArea[] {
	const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [...areas];
	const out: ShortcutArea[] = [];
	for (const area of areas) {
		const groups: ShortcutGroup[] = [];
		for (const group of area.groups) {
			const rows = group.rows.filter((row) => {
				const haystack = `${row.keys} ${row.action} ${group.title} ${area.title} ${area.where}`.toLocaleLowerCase();
				return words.every((word) => haystack.includes(word));
			});
			if (rows.length) groups.push({ title: group.title, rows });
		}
		if (groups.length) out.push({ ...area, groups });
	}
	return out;
}

/** The number of shortcuts across areas, for the page's summary line. */
export function countShortcuts(areas: readonly ShortcutArea[]): number {
	return areas.reduce((total, area) => total + area.groups.reduce((sum, group) => sum + group.rows.length, 0), 0);
}
