/**
 * The keyboard shortcuts sheet (Ctrl+/ or ⋯ > Keyboard shortcuts), as data.
 *
 * Only keys that are really bound are listed, each verified in a browser or by a test when it was
 * added; when a binding changes, change it here too. `Mod` shows as Ctrl, or ⌘ on a Mac.
 */
export type OfficeTool = 'documents' | 'sheets' | 'present';
export interface ShortcutRow { keys: string; action: string }
export interface ShortcutGroup { title: string; rows: ShortcutRow[] }

const COMMON: ShortcutGroup = {
	title: 'Everywhere in the editor',
	rows: [
		{ keys: 'Mod+Z', action: 'Undo' },
		{ keys: 'Mod+Y or Mod+Shift+Z', action: 'Redo' },
		{ keys: 'Mod+S', action: 'Save here, and say where the file is kept' },
		{ keys: 'Mod+/', action: 'Show or hide this list' }
	]
};

const SHEETS: ShortcutGroup[] = [
	{
		title: 'Moving and selecting',
		rows: [
			{ keys: 'Arrows', action: 'Move one cell' },
			{ keys: 'Enter / Shift+Enter', action: 'Move down / up' },
			{ keys: 'Tab / Shift+Tab', action: 'Move right / left' },
			{ keys: 'Mod+Arrows', action: 'Jump to the edge of the data' },
			{ keys: 'Home / Mod+Home / Mod+End', action: 'Start of the row / A1 / last used cell' },
			{ keys: 'PageUp / PageDown', action: 'One screen up / down' },
			{ keys: 'Shift+Arrows', action: 'Extend the selection' },
			{ keys: 'Mod+Space / Shift+Space', action: 'Select the column / row' },
			{ keys: 'Mod+A', action: 'Select everything' },
			{ keys: 'Shift+F10 or the Menu key', action: 'Open the cell menu' }
		]
	},
	{
		title: 'Editing',
		rows: [
			{ keys: 'Type, or F2', action: 'Edit the cell (F2 keeps the arrow keys in the text)' },
			{ keys: 'Enter / Tab while editing', action: 'Save and move' },
			{ keys: 'Esc', action: 'Cancel the edit' },
			{ keys: 'Alt+Enter', action: 'New line inside the cell' },
			{ keys: 'Delete', action: 'Clear the selected cells' },
			{ keys: '= then letters', action: 'Suggest functions; Tab accepts' },
			{ keys: 'Click or arrows after =, (, or a comma', action: 'Write a cell or range into the formula' },
			{ keys: 'F4', action: 'Cycle $A$1, A$1, $A1, A1 on the reference at the cursor' },
			{ keys: 'Alt+=', action: 'Add up the numbers above or to the left' },
			{ keys: 'Mod+;', action: "Today's date" }
		]
	},
	{
		title: 'Copy, fill and format',
		rows: [
			{ keys: 'Mod+C / Mod+X / Mod+V', action: 'Copy, cut, paste (formulas move their references)' },
			{ keys: 'Mod+D / Mod+R', action: 'Fill down / right' },
			{ keys: 'Drag the corner handle', action: 'Fill a series or repeat a block' },
			{ keys: 'Mod+B / Mod+I / Mod+U', action: 'Bold, italic, underline' },
			{ keys: 'Mod+Shift+$ % ! # ~', action: 'Currency, percent, number, date, general' },
			{ keys: 'Mod+F / Mod+H', action: 'Find / find and replace' }
		]
	}
];

const DOCUMENTS: ShortcutGroup[] = [
	{
		title: 'Writing',
		rows: [
			{ keys: 'Mod+B / Mod+I', action: 'Bold, italic' },
			{ keys: 'Mod+Shift+X / Mod+E', action: 'Strikethrough, inline code' },
			{ keys: 'Mod+K', action: 'Insert or edit a link' },
			{ keys: 'Mod+Alt+1 / 2 / 3', action: 'Heading 1, 2, 3 (again to undo it)' },
			{ keys: 'Mod+Alt+0 or Mod+Shift+N', action: 'Normal paragraph' },
			{ keys: 'Mod+Shift+L or Mod+Shift+8', action: 'Bulleted list' },
			{ keys: 'Mod+Shift+7', action: 'Numbered list' },
			{ keys: 'Mod+Enter', action: 'Tick or untick a task' },
			{ keys: 'Tab / Shift+Tab', action: 'Indent or outdent a list item or the selected lines' },
			{ keys: 'Enter in a list', action: 'Continue the list; on an empty item, end it' },
			{ keys: '/ on an empty line', action: 'Insert menu' }
		]
	},
	{
		title: 'Finding, pasting and printing',
		rows: [
			{ keys: 'Mod+F / Mod+H', action: 'Find / find and replace' },
			{ keys: 'Enter / Shift+Enter in Find', action: 'Next / previous match' },
			{ keys: 'Mod+Shift+V', action: 'Paste as plain text' },
			{ keys: 'Mod+P', action: 'Print (title and text only)' }
		]
	}
];

const PRESENT: ShortcutGroup[] = [
	{
		title: 'On the slide',
		rows: [
			{ keys: 'Tab / Shift+Tab', action: 'Move to the next / previous object' },
			{ keys: 'Mod+A', action: 'Select all objects; Esc deselects' },
			{ keys: 'Shift+click or Mod+click', action: 'Add or remove an object from the selection' },
			{ keys: 'Drag on empty slide', action: 'Select everything the box encloses' },
			{ keys: 'Enter or F2 on a text object', action: 'Edit its words on the slide; Esc to leave' },
			{ keys: 'Arrows / Shift+Arrows / Mod+Arrows', action: 'Nudge by 1% / 5% / 0.2%' },
			{ keys: 'Alt+Arrows', action: 'Resize the object' },
			{ keys: 'Mod+C / Mod+X / Mod+V', action: 'Copy, cut, paste objects (one or several)' },
			{ keys: 'Mod+D', action: 'Duplicate the selected objects' },
			{ keys: 'Delete', action: 'Remove the selected objects' },
			{ keys: 'Hold Alt while dragging', action: 'Move without snapping to guides' }
		]
	},
	{
		title: 'Slides',
		rows: [
			{ keys: 'Mod+M', action: 'New slide after this one' },
			{ keys: 'Mod+Shift+D', action: 'Duplicate the slide' },
			{ keys: 'Mod+Up / Mod+Down', action: 'Move the slide up / down' },
			{ keys: 'Mod+Shift+Up / Mod+Shift+Down', action: 'Move the slide to the start / end' },
			{ keys: 'Delete in the slide strip', action: 'Remove the slide' }
		]
	},
	{
		title: 'Presenting',
		rows: [
			{ keys: 'Right, Down, PageDown, Space, Enter or N', action: 'Next slide' },
			{ keys: 'Left, Up, PageUp, Backspace or P', action: 'Previous slide' },
			{ keys: 'A number, then Enter', action: 'Go to that slide' },
			{ keys: 'Home / End', action: 'First / last slide' },
			{ keys: 'B / W', action: 'Black / white screen' },
			{ keys: 'F', action: 'Full screen' },
			{ keys: 'Esc', action: 'End the show' }
		]
	}
];

const BY_TOOL: Record<OfficeTool, ShortcutGroup[]> = { sheets: SHEETS, documents: DOCUMENTS, present: PRESENT };

function mark(keys: string, mac: boolean): string {
	return mac ? keys.replaceAll('Mod', '⌘').replaceAll('Alt', 'Option') : keys.replaceAll('Mod', 'Ctrl');
}

export function shortcutsFor(tool: OfficeTool, mac: boolean): ShortcutGroup[] {
	return [...BY_TOOL[tool], COMMON].map((group) => ({ title: group.title, rows: group.rows.map((row) => ({ keys: mark(row.keys, mac), action: row.action })) }));
}
