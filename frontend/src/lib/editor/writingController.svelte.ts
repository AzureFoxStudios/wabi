/**
 * One writing surface's live state (design contract §7.15, §8.8): the editor view, the measured
 * selection (for the selection bubble) and the caret's line (for the block handle), plus the
 * CodeMirror extensions that keep them current.
 *
 * Both writing editors build on it, so Documents, the wiki and Notes share one surface:
 * WritingEditor (a value-driven page: wiki, notes) and Documents' CollaborativeText (a shared
 * Yjs text). Each creates a controller, adds `controller.extension` to its editor and renders
 * the editor inside <WritingFrame {controller}>, which draws the page, the bubble and Insert.
 *
 * A plain-text page (`markdown: false`) keeps the reading face but none of the Markdown tools:
 * no line styles, no formatting keys, no bubble, no Insert.
 */
import { EditorView, placeholder as placeholderText } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { caretReporter, selectionReporter, viewHandle, writingSurface, type CaretLine, type WritingSelection } from './writingSurface';

export class WritingController {
	view = $state.raw<EditorView | null>(null);
	/** The non-empty selection while the editor has focus, else null. */
	selection = $state.raw<WritingSelection | null>(null);
	/** The last non-empty selection: the bubble keeps acting on it while it holds focus. */
	lastSelection = $state.raw<WritingSelection | null>(null);
	/** The caret's line while the editor has focus and is writable, else null. */
	caret = $state.raw<CaretLine | null>(null);
	lastCaret = $state.raw<CaretLine | null>(null);
	/** Bumped each time `/` on an empty line asks for the Insert menu. */
	slash = $state(0);
	/** Room the phone's Insert bar takes at the bottom, so the caret scrolls clear of it. */
	bottomRoom = 0;
	/** Set by the selection bubble: moves focus into it (Alt F10), says if it could. */
	focusBubble: () => boolean = () => false;

	readonly markdown: boolean;
	readonly extension: Extension;

	constructor(options: { placeholder?: string; blocks?: boolean; markdown?: boolean } = {}) {
		this.markdown = options.markdown !== false;
		const text = this.markdown
			? writingSurface({
					placeholder: options.placeholder,
					onBubbleKey: () => this.focusBubble(),
					onSlash: options.blocks === false ? undefined : () => { this.slash += 1; }
				})
			: options.placeholder ? placeholderText(options.placeholder) : [];
		this.extension = [
			text,
			viewHandle((view) => {
				this.view = view;
			}),
			selectionReporter((next) => {
				this.selection = this.markdown ? next : null;
				if (next && this.markdown) this.lastSelection = next;
			}),
			caretReporter((next) => {
				this.caret = next;
				if (next) this.lastCaret = next;
			}),
			EditorView.scrollMargins.of(() => (this.bottomRoom ? { bottom: this.bottomRoom } : null))
		];
	}

	focus(): void {
		this.view?.focus();
	}
}
