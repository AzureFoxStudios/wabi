<!--
	Documents' text editor (design contract §8.8): the shared Yjs body in CodeMirror.

	- Markdown and plain text are prose: the shared writing page (WritingFrame), with no line
	  numbers or active-line gutter, the reading face, hanging `##` markers on a wide page, inline
	  markers on the caret's lines only, accent caret and selection. Markdown adds the selection
	  bubble (Comment on a shared document), the block handle and `/` for Insert.
	- HTML and code stay code: mono, faint line numbers, on the roles of every theme.
	- `reveal(offset)` puts the caret at a heading and scrolls it near the top (the outline);
	  `oncaret` reports the caret's offset (the current section).
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { EditorState, Compartment } from '@codemirror/state';
	import { EditorView, drawSelection, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
	import { defaultKeymap } from '@codemirror/commands';
	import { markdown } from '@codemirror/lang-markdown';
	import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
	import WritingFrame from '$lib/editor/WritingFrame.svelte';
	import { WritingController } from '$lib/editor/writingController.svelte';
	import type { ArtifactSession } from './session';
	import { textAnchor, textPosition } from './anchors';

	let {
		session,
		onselection,
		focusAnchor,
		oncaret,
		oncomment,
		hang = false,
		placeholder = 'Start writing, or type / for a block'
	}: {
		session: ArtifactSession;
		onselection?: (anchor: string | null) => void;
		focusAnchor?: string | null;
		oncaret?: (offset: number) => void;
		/** Comment on the selection (shared documents): adds Comment to the bubble. */
		oncomment?: () => void;
		/** A wide page: heading markers and the block handle hang in the margin. */
		hang?: boolean;
		placeholder?: string;
	} = $props();

	// The editor is keyed to one session (the shell remounts per document).
	const sessionState = untrack(() => session.state);
	const format = untrack(() => session.record.format);
	const prose = format === 'markdown' || format === 'text';
	const controller = new WritingController({
		markdown: format === 'markdown',
		placeholder: untrack(() => (format === 'markdown' ? placeholder : 'Start writing')),
		blocks: format === 'markdown'
	});

	let parent = $state<HTMLDivElement | null>(null);
	let view: EditorView | undefined;
	let mounted = $state(false);
	const permission = new Compartment();
	let readonly = $state(!untrack(() => session.editable));

	onMount(() => {
		if (!parent) return;
		view = new EditorView({
			parent,
			state: EditorState.create({
				doc: session.body.toString(),
				extensions: [
					prose ? [controller.extension] : [lineNumbers(), highlightActiveLineGutter()],
					drawSelection(),
					EditorView.lineWrapping,
					format === 'markdown' ? markdown() : [],
					keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
					yCollab(session.body, null, { undoManager: session.undo }),
					permission.of([EditorState.readOnly.of(!session.editable), EditorView.editable.of(session.editable)]),
					EditorView.contentAttributes.of({ 'aria-label': 'Document content', spellcheck: format === 'code' ? 'false' : 'true' }),
					EditorView.updateListener.of((update) => {
						if (!update.selectionSet) return;
						const selection = update.state.selection.main;
						onselection?.(textAnchor(session.body, selection.from, selection.to));
						oncaret?.(selection.head);
					})
				]
			})
		});
		mounted = true;
		return () => {
			mounted = false;
			view?.destroy();
			view = undefined;
		};
	});

	$effect(() => {
		const allowed = ($sessionState.meta, $sessionState.tick, session.editable);
		readonly = !allowed;
		if (mounted) view?.dispatch({ effects: permission.reconfigure([EditorState.readOnly.of(!allowed), EditorView.editable.of(allowed)]) });
	});
	$effect(() => {
		const anchor = focusAnchor;
		if (mounted && anchor && view) {
			const position = textPosition(session.doc, anchor);
			if (position) {
				view.dispatch({ selection: { anchor: position.from, head: position.to }, effects: EditorView.scrollIntoView(position.from, { y: 'center' }) });
				view.focus();
			}
		}
	});

	/** Put the caret at `offset` (a heading's line start) and bring it near the top of the page. */
	export function reveal(offset: number): void {
		if (!view) return;
		const at = Math.max(0, Math.min(offset, view.state.doc.length));
		view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: 96 }) });
		view.focus();
	}

	export function focus(): void {
		view?.focus();
	}
</script>

{#if prose}
	<WritingFrame {controller} {readonly} {hang} {oncomment} class="document-writing">
		<div class="document-editor" bind:this={parent}></div>
	</WritingFrame>
{:else}
	<div class="document-editor document-code" bind:this={parent}></div>
{/if}

<style>
	.document-editor :global(.cm-editor) {
		height: auto;
	}

	/* HTML and code: mono with faint line numbers, on the roles (no theme-independent colours). */
	.document-code :global(.cm-editor) {
		background: transparent;
		color: var(--w-text);
	}
	.document-code :global(.cm-editor.cm-focused) {
		outline: none;
	}
	.document-code :global(.cm-editor .cm-scroller) {
		overflow: visible;
		font: 400 calc(14px * var(--w-fs)) / calc(22px * var(--w-fs)) var(--w-mono);
	}
	.document-code :global(.cm-editor .cm-content) {
		min-height: calc(320px * var(--w-fs));
		padding: 0 0 48px;
		caret-color: var(--w-accent);
	}
	.document-code :global(.cm-editor .cm-gutters) {
		border: 0;
		background: transparent;
		color: var(--w-faint);
	}
	.document-code :global(.cm-editor .cm-activeLineGutter) {
		background: transparent;
		color: var(--w-mute);
	}
	.document-code :global(.cm-editor .cm-cursor) {
		border-left: 2px solid var(--w-accent);
	}
	.document-code :global(.cm-editor .cm-selectionLayer .cm-selectionBackground),
	.document-code :global(.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground) {
		background: color-mix(in srgb, var(--w-accent) 28%, transparent);
	}
</style>
