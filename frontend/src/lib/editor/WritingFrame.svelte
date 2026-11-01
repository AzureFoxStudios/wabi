<!--
	The writing page (design contract §7.15, §8.7, §8.8): Markdown written in the reading face, not
	in a code field. One frame for every writing surface: WritingEditor (wiki, Notes) and
	Documents' CollaborativeText render their CodeMirror view inside it with
	`controller.extension`, and it adds the look, the selection bubble and Insert.

	- Type is the reading style (--w-t-read 17/30); headings take serif sizes and their `#`
	  markers hang in the left margin in faint mono when `hang` is on (a wide column). Inline
	  markers show faint on the caret's lines only; elsewhere checklists are checkboxes, bullets
	  dots, dividers hairlines and quotes keep only their rule. Caret and selection use --w-accent
	  (selection 28% mix). No box, no fill, no focus frame around the page: the caret shows where
	  you are.
	- Heading sizes are custom properties (--writing-h1 … --writing-h4 and their -lh line
	  heights), so a host whose page has its own title (the wiki) can demote them.
	- `blocks` adds the block handle and `/` (InsertMenu); `oncomment` adds Comment to the bubble.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import SelectionBubble from './SelectionBubble.svelte';
	import InsertMenu from './InsertMenu.svelte';
	import type { WritingController } from './writingController.svelte';
	import { isMobile } from '$lib/layoutStoreStates';

	interface Props {
		controller: WritingController;
		readonly?: boolean;
		/** Hang heading markers and the block handle in the left margin (needs ~56px of margin). */
		hang?: boolean;
		/** A phone: Insert docks above the keyboard instead of the margin handle (default: the phone layout). */
		phone?: boolean;
		/** The block handle, `/` and the phone bar (Insert). */
		blocks?: boolean;
		oncomment?: () => void;
		onimage?: () => void;
		imageBusy?: boolean;
		class?: string;
		children: Snippet;
	}

	let { controller, readonly = false, hang = false, phone, blocks = true, oncomment, onimage, imageBusy = false, class: className = '', children }: Props = $props();

	let host = $state<HTMLDivElement | null>(null);
	const onPhone = $derived(phone ?? $isMobile);
</script>

<div class="writing {className}" class:hang class:phone={onPhone} bind:this={host}>
	{@render children()}
	{#if blocks && !readonly && controller.markdown}
		<InsertMenu {controller} {host} {hang} phone={onPhone} {onimage} {imageBusy} />
	{/if}
	<SelectionBubble {controller} {host} {readonly} {oncomment} />
</div>

<style>
	.writing {
		--writing-hang-room: 40px;
		--writing-text-start: 0px;
		position: relative;
		min-width: 0;
		color: var(--w-text);
	}
	/* A hanging margin: the editor reaches into the page margin so heading markers can sit there,
	   and its text still starts on the column's edge. */
	.writing.hang {
		--writing-text-start: var(--writing-hang-room);
		margin-left: calc(-1 * var(--writing-hang-room));
	}
	/* The phone's Insert bar covers the bottom of the page; leave room to write above it. */
	.writing.phone {
		--writing-tail: 96px;
	}

	/* The page: no edge, no fill, no inner scroller (the host scrolls). */
	.writing :global(.cm-editor) {
		background: transparent;
		color: var(--w-text);
	}
	.writing :global(.cm-editor.cm-focused) {
		outline: none;
	}
	.writing :global(.cm-editor .cm-scroller) {
		overflow: visible;
		color: var(--w-text);
		font: var(--w-t-read);
	}
	.writing :global(.cm-editor .cm-content) {
		box-sizing: border-box;
		min-height: var(--writing-min, calc(320px * var(--w-fs)));
		padding: 0 0 var(--writing-tail, 48px);
		color: var(--w-text);
		font: var(--w-t-read);
		caret-color: var(--w-accent);
		text-wrap: pretty;
	}
	.writing.hang :global(.cm-editor .cm-content) {
		padding-left: var(--writing-hang-room);
	}
	.writing :global(.cm-editor .cm-line) {
		padding: 0;
	}
	.writing :global(.cm-editor .cm-cursor) {
		border-left: 2px solid var(--w-accent);
	}
	.writing :global(.cm-editor .cm-selectionLayer .cm-selectionBackground),
	.writing :global(.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground) {
		background: color-mix(in srgb, var(--w-accent) 28%, transparent);
	}
	.writing :global(.cm-editor .cm-content ::selection) {
		background: color-mix(in srgb, var(--w-accent) 28%, transparent);
	}
	.writing :global(.cm-editor .cm-placeholder) {
		color: var(--w-faint);
	}

	/* ---- Markdown structure (writingSurface.ts markdownLineStyles) ---- */
	.writing :global(.cm-w-marker) {
		color: var(--w-faint);
	}
	.writing :global(.cm-editor .cm-line.cm-w-heading) {
		padding-top: 10px;
		color: var(--w-text);
		font-family: var(--w-serif);
		font-weight: 600;
		letter-spacing: 0.005em;
	}
	.writing :global(.cm-w-h1) {
		font-size: var(--writing-h1, calc(28px * var(--w-fs)));
		line-height: var(--writing-h1-lh, calc(36px * var(--w-fs)));
	}
	.writing :global(.cm-w-h2) {
		font-size: var(--writing-h2, calc(22px * var(--w-fs)));
		line-height: var(--writing-h2-lh, calc(30px * var(--w-fs)));
	}
	.writing :global(.cm-w-h3) {
		font-size: var(--writing-h3, calc(18px * var(--w-fs)));
		line-height: var(--writing-h3-lh, calc(24px * var(--w-fs)));
	}
	.writing :global(:is(.cm-w-h4, .cm-w-h5, .cm-w-h6)) {
		font-size: var(--writing-h4, calc(16px * var(--w-fs)));
		line-height: var(--writing-h4-lh, calc(22px * var(--w-fs)));
	}
	.writing :global(.cm-w-hang) {
		font: 400 calc(15px * var(--w-fs)) / 1 var(--w-mono);
		letter-spacing: 0;
	}
	/* The `## ` marker hangs: its advance is cancelled by a negative start margin (the marker is
	   mono, so `ch` is its own glyph width), leaving the heading words on the column's edge with
	   about 14px between them and the marker. */
	.writing.hang :global(.cm-w-hang) {
		margin-left: calc(var(--hang, 3) * -1ch - 6px);
		margin-right: 6px;
	}
	/* (.cm-line.… so the line's own `padding: 0` above cannot undo the rule's inset.) */
	.writing :global(.cm-editor .cm-line.cm-w-quote) {
		padding-left: 20px;
		border-left: 2px solid var(--w-line-strong);
		font: 400 calc(19px * var(--w-fs)) / calc(30px * var(--w-fs)) var(--w-serif);
	}
	.writing :global(.cm-w-code) {
		background: var(--w-sink);
		font: 400 calc(14px * var(--w-fs)) / calc(22px * var(--w-fs)) var(--w-mono);
	}
	.writing :global(.cm-w-code.cm-w-fence) {
		color: var(--w-faint);
	}
	.writing :global(.cm-w-rule) {
		letter-spacing: 0.2em;
	}
	/* Off the caret's line a divider is a hairline across the column. */
	.writing :global(.cm-w-hr) {
		display: inline-block;
		width: 100%;
		height: var(--w-bw);
		vertical-align: middle;
		background: var(--w-line-strong);
	}
	/* Off the caret's line a bullet is a quiet dot where its `- ` was. */
	.writing :global(.cm-w-bullet) {
		display: inline-block;
		width: 1.25em;
		color: var(--w-faint);
	}
	/* Off the caret's line a checklist item is a real checkbox; a done item is struck through. */
	.writing :global(.cm-w-check) {
		display: inline-flex;
		align-items: center;
		width: 1.65em;
		height: 1em;
		vertical-align: -0.1em;
	}
	/* The box is the kit checkbox (.w-check), as in Read. */
	.writing :global(.cm-w-check input) {
		margin: 0;
		cursor: pointer;
	}
	.writing :global(.cm-w-check input:disabled) {
		cursor: default;
	}
	.writing :global(.cm-w-task.cm-w-done) {
		color: var(--w-mute);
		text-decoration: line-through;
		text-decoration-color: var(--w-faint);
	}
	.writing :global(.cm-w-strong) {
		font-weight: 700;
	}
	.writing :global(.cm-w-heading .cm-w-strong) {
		font-weight: inherit;
	}
	.writing :global(.cm-w-em) {
		font-style: italic;
	}
	.writing :global(.cm-w-strike) {
		text-decoration: line-through;
		text-decoration-color: var(--w-mute);
	}
	.writing :global(.cm-w-inline-code) {
		padding: 1px 0;
		border-radius: var(--radius-sm);
		background: var(--w-sink);
		font-family: var(--w-mono);
		font-size: 0.88em;
	}
	.writing :global(.cm-w-link) {
		color: var(--w-accent);
	}
</style>
