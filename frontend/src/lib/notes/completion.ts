import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { Transaction, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { parseNoteLinks } from './links';

type LinkableNote = { title: string; trashedAt: number | null };
export interface NoteCompletionRange { from: number; to: number; alias: string }
/** Uses the graph parser's exclusions, so editor suggestions agree with backlinks. */
export function noteCompletionRange(text: string, position: number): NoteCompletionRange | null {
	const before = text.slice(0, position);
	const match = /\[\[([^\[\]\n|]*)$/.exec(before);
	if (!match) return null;
	const opening = position - match[0].length;
	const probe = `${text.slice(0, opening)}[[Completion probe]]${text.slice(position)}`;
	if (!parseNoteLinks(probe).some(link => link.from === opening)) return null;
	const rest = text.slice(position).match(/^[^\n\r\[\]]*/)?.[0] ?? '';
	const boundary = position + rest.length;
	const closed = text.slice(boundary, boundary + 2) === ']]';
	const pipe = rest.indexOf('|');
	return { from: opening + 2, to: boundary + (closed ? 2 : 0), alias: pipe < 0 ? '' : rest.slice(pipe) };
}
export function noteCompletionSource(getNotes: () => readonly LinkableNote[]) {
	return (context: CompletionContext): CompletionResult | null => {
		const range = noteCompletionRange(context.state.doc.toString(), context.pos);
		if (!range) return null;
		return {
			from: range.from,
			options: getNotes().filter(note => note.trashedAt === null).map(note => ({
				label: note.title,
				type: 'text',
				detail: 'Local note',
				apply(view: EditorView) {
					// Recalculate at acceptance because the user may have typed more.
					const current = noteCompletionRange(view.state.doc.toString(), view.state.selection.main.head);
					if (!current) return;
					const insert = `${note.title}${current.alias}]]`;
					view.dispatch({ changes: { from: current.from, to: current.to, insert }, selection: { anchor: current.from + insert.length }, annotations: Transaction.userEvent.of('input.complete') });
				}
			}))
		};
	};
}
export function noteCompletionExtension(getNotes: () => readonly LinkableNote[]): Extension {
	return autocompletion({ override: [noteCompletionSource(getNotes)], activateOnTyping: true, defaultKeymap: true });
}
