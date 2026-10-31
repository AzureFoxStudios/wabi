<!--
	The writing surface (design contract §7.15, §8.7, §8.8): Markdown written on the page in the
	reading face, not in a code field. The wiki editor and the Notes editor use it; it is
	CodeMirrorEditor in prose mode plus $lib/editor/writingSurface.

	- Type is the reading style (--w-t-read 17/30); headings take serif sizes and their `#`
	  markers hang in the left margin in faint mono when `hang` is on (a wide column); quote,
	  list and fence markers go faint. Caret and selection use --w-accent (selection 28% mix).
	  No box, no fill, no focus frame around the page: the caret shows where you are.
	- The selection bubble (§7.15, kit `.w-tool--bubble`, no shadow) appears for a non-empty
	  selection: Bold, Italic, Strikethrough | Link (Ctrl Shift K), Inline code. It sits 8px
	  below the selection's last line box, left-aligned to its start, and flips above when fewer
	  than 52px remain below inside the scroll viewport. Pointer presses never take focus from the
	  editor; Alt F10 moves focus into it (arrow keys move between keys, Esc goes back).
	- `insert(kind)` / `insertText(text)` / `focus()` run Insert menu entries, uploaded image
	  Markdown and focus from the host (bind:this).
	- Heading sizes are custom properties (--writing-h1 … --writing-h4 and their -lh line
	  heights), so a host whose page has its own title (the wiki) can demote them to match its
	  reading view.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import type { Extension } from '@codemirror/state';
	import type { EditorView } from '@codemirror/view';
	import CodeMirrorEditor from '$lib/editor/CodeMirrorEditor.svelte';
	import Icon from './ui/Icon.svelte';
	import Tooltip from './ui/Tooltip.svelte';
	import type { IconName } from './ui/icons';
	import {
		formatSelection,
		insertAtSelection,
		insertText as insertTextAtSelection,
		linkAtSelection,
		selectionReporter,
		viewHandle,
		writingSurface,
		type WritingSelection
	} from '$lib/editor/writingSurface';
	import { placeSelectionBubble, type Box, type InlineMark, type InsertKind } from '$lib/editor/writingMarkdown';

	interface Props {
		value: string;
		onchange: (value: string) => void;
		/** Names the text area ("Page text", "Note text"). */
		ariaLabel: string;
		placeholder?: string;
		readonly?: boolean;
		/** Hang heading markers in the left margin (needs ~40px of page margin). */
		hang?: boolean;
		/** Extra CodeMirror extensions (e.g. the Notes link completion). */
		extensions?: Extension;
		class?: string;
	}

	let { value, onchange, ariaLabel, placeholder, readonly = false, hang = false, extensions = [], class: className = '' }: Props = $props();

	let host = $state<HTMLDivElement | null>(null);
	let bubble = $state<HTMLDivElement | null>(null);
	let view: EditorView | null = null;
	let selection = $state<WritingSelection | null>(null);
	let lastSelection = $state<WritingSelection | null>(null);
	let bubbleFocused = $state(false);
	let keyIndex = $state(0);

	const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

	type Key = { id: InlineMark | 'link'; label: string; icon: IconName; shortcut: string };
	const KEYS: readonly (Key | null)[] = [
		{ id: 'bold', label: 'Bold', icon: 'bold', shortcut: `${mod} B` },
		{ id: 'italic', label: 'Italic', icon: 'italic', shortcut: `${mod} I` },
		{ id: 'strike', label: 'Strikethrough', icon: 'strike', shortcut: `${mod} Shift X` },
		null,
		{ id: 'link', label: 'Link', icon: 'link', shortcut: `${mod} Shift K` },
		{ id: 'code', label: 'Inline code', icon: 'code', shortcut: `${mod} E` }
	];
	const ACTIVE_KEYS = KEYS.filter((key): key is Key => key !== null);

	function focusBubble(): boolean {
		if (!selection || !bubble) return false;
		keyIndex = 0;
		bubble.querySelectorAll<HTMLButtonElement>('button')[0]?.focus();
		return true;
	}

	// Built once per editor: the reporter and handle keep this instance's view and selection
	// (the placeholder is read once; a host that needs another one remounts the editor).
	const surface: Extension = [
		writingSurface({ placeholder: untrack(() => placeholder), onBubbleKey: focusBubble }),
		viewHandle((next) => {
			view = next;
		}),
		selectionReporter((next) => {
			selection = next;
			if (next) lastSelection = next;
		})
	];
	const allExtensions = $derived<Extension>([surface, extensions]);

	const shown = $derived(!readonly && (selection !== null || (bubbleFocused && lastSelection !== null)));
	const marks = $derived((selection ?? lastSelection)?.marks ?? { bold: false, italic: false, strike: false, code: false });

	/** The visible part of the nearest scroller (or the window) around the editor. */
	function scrollViewport(node: HTMLElement): Box {
		const win: Box = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
		for (let parent = node.parentElement; parent; parent = parent.parentElement) {
			const { overflowY } = getComputedStyle(parent);
			if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') {
				const rect = parent.getBoundingClientRect();
				return { left: Math.max(rect.left, win.left), top: Math.max(rect.top, win.top), right: Math.min(rect.right, win.right), bottom: Math.min(rect.bottom, win.bottom) };
			}
		}
		return win;
	}

	let position = $state<{ left: number; top: number; above: boolean } | null>(null);
	$effect(() => {
		const current = selection ?? (bubbleFocused ? lastSelection : null);
		const node = host;
		const element = bubble;
		if (!current || !node || !shown) {
			position = null;
			return;
		}
		const frame = node.getBoundingClientRect();
		const size = { width: element?.offsetWidth || 196, height: element?.offsetHeight || 36 };
		const placed = placeSelectionBubble(current.start, current.end, scrollViewport(node), size);
		position = { left: placed.left - frame.left, top: placed.top - frame.top, above: placed.above };
	});

	function run(id: Key['id']) {
		if (!view || readonly) return;
		if (id === 'link') linkAtSelection(view);
		else formatSelection(view, id);
	}

	function bubbleKeydown(event: KeyboardEvent) {
		const count = ACTIVE_KEYS.length;
		let next = keyIndex;
		if (event.key === 'ArrowRight') next = (keyIndex + 1) % count;
		else if (event.key === 'ArrowLeft') next = (keyIndex - 1 + count) % count;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = count - 1;
		else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			bubbleFocused = false;
			view?.focus();
			return;
		} else return;
		event.preventDefault();
		keyIndex = next;
		bubble?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
	}

	/** Run an Insert menu entry (a line kind or a block) at the caret. */
	export function insert(kind: InsertKind): void {
		if (view && !readonly) insertAtSelection(view, kind);
	}

	/** Put text (an uploaded image's Markdown) in place of the selection. */
	export function insertText(text: string): void {
		if (view && !readonly) insertTextAtSelection(view, text);
	}

	export function focus(): void {
		view?.focus();
	}
</script>

<div class="writing {className}" class:hang bind:this={host}>
	<CodeMirrorEditor code={value} language="markdown" prose {ariaLabel} {readonly} customExtensions={allExtensions} onupdate={onchange} />
	{#if shown}
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="w-tool w-tool--bubble writing-bubble"
			class:above={position?.above}
			role="toolbar"
			aria-label="Format selection"
			aria-orientation="horizontal"
			tabindex="-1"
			bind:this={bubble}
			style:left={position ? `${position.left}px` : undefined}
			style:top={position ? `${position.top}px` : undefined}
			style:visibility={position ? undefined : 'hidden'}
			onmousedown={(event) => event.preventDefault()}
			onfocusin={() => (bubbleFocused = true)}
			onfocusout={(event) => {
				if (!bubble?.contains(event.relatedTarget as Node | null)) bubbleFocused = false;
			}}
			onkeydown={bubbleKeydown}
		>
			{#each KEYS as key}
				{#if key}
					{@const index = ACTIVE_KEYS.indexOf(key)}
					<Tooltip text={key.label} shortcut={key.shortcut} placement={position?.above ? 'top' : 'bottom'}>
						<button
							type="button"
							class="w-ibtn"
							aria-label={key.label}
							aria-pressed={key.id === 'link' ? undefined : marks[key.id]}
							tabindex={index === keyIndex ? 0 : -1}
							onclick={() => run(key.id)}
						><Icon name={key.icon} /></button>
					</Tooltip>
				{:else}
					<span class="w-tool__sep" aria-hidden="true"></span>
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	.writing {
		--writing-hang-room: 40px;
		position: relative;
		min-width: 0;
		color: var(--w-text);
	}
	/* A hanging margin: the editor reaches into the page margin so heading markers can sit there,
	   and its text still starts on the column's edge. */
	.writing.hang {
		margin-left: calc(-1 * var(--writing-hang-room));
	}

	/* CodeMirrorEditor's prose card: no edge, no fill, no inner scroller; the page scrolls. */
	.writing :global(> .cm-editor) {
		overflow: visible;
		border: 0;
		border-radius: 0;
		background: transparent;
	}
	.writing :global(.cm-editor-host) {
		overflow: visible;
		font: inherit;
	}
	.writing :global(.cm-editor-host .cm-editor) {
		height: auto;
		background: transparent;
		color: var(--w-text);
	}
	.writing :global(.cm-editor-host .cm-editor.cm-focused) {
		outline: none;
	}
	.writing :global(.cm-editor-host .cm-scroller) {
		overflow: visible;
		color: var(--w-text);
		font: var(--w-t-read);
	}
	.writing :global(.cm-editor-host .cm-content) {
		box-sizing: border-box;
		min-height: var(--writing-min, calc(320px * var(--w-fs)));
		padding: 0 0 var(--writing-tail, 48px);
		color: var(--w-text);
		font: var(--w-t-read);
		caret-color: var(--w-accent);
		text-wrap: pretty;
	}
	.writing.hang :global(.cm-editor-host .cm-content) {
		padding-left: var(--writing-hang-room);
	}
	.writing :global(.cm-editor-host .cm-line) {
		padding: 0;
	}
	.writing :global(.cm-editor-host .cm-cursor) {
		border-left: 2px solid var(--w-accent);
	}
	.writing :global(.cm-editor-host .cm-selectionBackground),
	.writing :global(.cm-editor-host .cm-editor.cm-focused .cm-selectionBackground) {
		background: color-mix(in srgb, var(--w-accent) 28%, transparent);
	}
	.writing :global(.cm-editor-host .cm-content ::selection) {
		background: color-mix(in srgb, var(--w-accent) 28%, transparent);
	}
	.writing :global(.cm-editor-host .cm-placeholder) {
		color: var(--w-faint);
	}

	/* ---- Markdown structure (writingSurface.ts markdownLineStyles) ---- */
	.writing :global(.cm-w-marker) {
		color: var(--w-faint);
	}
	.writing :global(.cm-w-heading) {
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
	.writing :global(.cm-w-quote) {
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

	/* ---- the selection bubble: kit .w-tool--bubble (no shadow), above the text ---- */
	.writing-bubble {
		position: absolute;
		z-index: var(--z-dropdown, 20);
		animation: writing-bubble-in var(--w-dur-2) var(--w-ease);
	}
	.writing-bubble .w-ibtn:focus-visible {
		outline-offset: -2px;
	}
	@keyframes writing-bubble-in {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
	}
	.writing-bubble.above {
		animation-name: writing-bubble-in-above;
	}
	@keyframes writing-bubble-in-above {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.writing-bubble {
			animation: none;
		}
	}
	:global(:root[data-motion='reduce']) .writing-bubble {
		animation: none;
	}
	@media (pointer: coarse) {
		.writing-bubble .w-ibtn {
			width: 44px;
			height: 44px;
		}
	}
</style>
