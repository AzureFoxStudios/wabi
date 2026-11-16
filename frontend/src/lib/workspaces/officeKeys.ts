/**
 * Keys the office shell owns for every tool (Sheets, Documents, Present): Save, Undo, Redo.
 *
 * Pure so the rules can be tested without a browser. The shell calls `officeKeyAction` from one
 * window listener that is scoped to the open editor. Rules that keep it from fighting the text
 * surfaces:
 *  - Undo and Redo are left alone while the user is typing in a text field or in the code editor:
 *    those have their own undo (a cell being edited, the inspector, CodeMirror's Yjs-aware one).
 *  - Help (Ctrl+/) and Save are taken everywhere in the editor, because the browser's "Save page as…" is never what
 *    someone pressing Ctrl+S in a spreadsheet wants.
 *  - Composition (IME, for example Thai) is never interrupted.
 */
export type OfficeKeyAction = 'undo' | 'redo' | 'save' | 'help';

export interface KeyLike {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	isComposing?: boolean;
}

export interface KeyTarget {
	/** An input, textarea, select or contenteditable: it has its own undo. */
	textEntry: boolean;
	/** Inside CodeMirror: Documents installs its own undo keymap. */
	codeEditor: boolean;
}

export function officeKeyAction(event: KeyLike, target: KeyTarget): OfficeKeyAction | null {
	if (event.isComposing) return null;
	// Exactly one of Ctrl/Cmd, and never Alt: AltGr on many layouts reports Ctrl+Alt.
	if (event.ctrlKey === event.metaKey || event.altKey) return null;
	const key = event.key.toLowerCase();
	if (key === 's' && !event.shiftKey) return 'save';
	// Ctrl+/ opens the shortcuts list from anywhere in the editor, text fields included.
	if (key === '/' && !event.shiftKey) return 'help';
	if (target.textEntry || target.codeEditor) return null;
	if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
	if (key === 'y' && !event.shiftKey) return 'redo';
	return null;
}

/** Describes where a key event came from. Safe to call outside a browser. */
export function keyTarget(target: EventTarget | null): KeyTarget {
	if (typeof Element === 'undefined' || !(target instanceof Element)) return { textEntry: false, codeEditor: false };
	const codeEditor = target.closest('.cm-editor') !== null;
	const textEntry =
		target.matches('input, textarea, select') ||
		(target instanceof HTMLElement && target.isContentEditable);
	return { textEntry, codeEditor };
}
