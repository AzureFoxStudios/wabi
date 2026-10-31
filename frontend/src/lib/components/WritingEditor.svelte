<!--
	A value-driven writing page (design contract §7.15, §8.7, §8.8): the wiki editor and the Notes
	editor. It is CodeMirrorEditor in prose mode inside the shared WritingFrame, the same page,
	selection bubble and Insert path Documents' collaborative editor uses
	($lib/editor/WritingFrame.svelte, writingController.svelte.ts, writingSurface.ts).

	- `insert(kind)` / `insertText(text)` / `focus()` run Insert menu entries, uploaded image
	  Markdown and focus from the host (bind:this).
	- `onimage` adds Image… to the block handle's Insert menu (the host opens its own picker).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import type { Extension } from '@codemirror/state';
	import CodeMirrorEditor from '$lib/editor/CodeMirrorEditor.svelte';
	import WritingFrame from '$lib/editor/WritingFrame.svelte';
	import { WritingController } from '$lib/editor/writingController.svelte';
	import { insertAtSelection, insertText as insertTextAtSelection } from '$lib/editor/writingSurface';
	import type { InsertKind } from '$lib/editor/writingMarkdown';

	interface Props {
		value: string;
		onchange: (value: string) => void;
		/** Names the text area ("Page text", "Note text"). */
		ariaLabel: string;
		placeholder?: string;
		readonly?: boolean;
		/** Hang heading markers and the block handle in the left margin (needs ~56px of page margin). */
		hang?: boolean;
		/** Extra CodeMirror extensions (e.g. the Notes link completion). */
		extensions?: Extension;
		onimage?: () => void;
		imageBusy?: boolean;
		class?: string;
	}

	let { value, onchange, ariaLabel, placeholder, readonly = false, hang = false, extensions = [], onimage, imageBusy = false, class: className = '' }: Props = $props();

	// Built once per editor (the placeholder is read once; a host that needs another one remounts).
	const controller = new WritingController({ placeholder: untrack(() => placeholder) });
	const allExtensions = $derived<Extension>([controller.extension, extensions]);

	/** Run an Insert menu entry (a line kind or a block) at the caret. */
	export function insert(kind: InsertKind): void {
		if (controller.view && !readonly) insertAtSelection(controller.view, kind);
	}

	/** Put text (an uploaded image's Markdown) in place of the selection. */
	export function insertText(text: string): void {
		if (controller.view && !readonly) insertTextAtSelection(controller.view, text);
	}

	export function focus(): void {
		controller.focus();
	}
</script>

<WritingFrame {controller} {readonly} {hang} {onimage} {imageBusy} class="writing--value {className}">
	<CodeMirrorEditor code={value} language="markdown" prose {ariaLabel} {readonly} customExtensions={allExtensions} onupdate={onchange} />
</WritingFrame>

<style>
	/* CodeMirrorEditor's prose card: no edge, no fill, no inner scroller; the page scrolls. (One
	   class above CodeMirrorEditor's own scoped rules, so these win in any stylesheet order.) */
	:global(.writing.writing--value > .cm-editor.prose) {
		overflow: visible;
		border: 0;
		border-radius: 0;
		background: transparent;
	}
	:global(.writing.writing--value .cm-editor-host) {
		overflow: visible;
		font: inherit;
	}
	:global(.writing.writing--value .cm-editor-host .cm-editor) {
		height: auto;
	}
</style>
