<script lang="ts">
	import NotesWorkspace from './NotesWorkspace.svelte';
	import { isSettledSave, stripEdges, stripPeekWidth, stripWheelDelta } from './keepNotesCompanion';

	/**
	 * Notes as a companion (compact) or on the page. The companion's frame (RightPanel) names it
	 * and carries "Open in center stage", so there is no second open button here (spec §8.4).
	 */
	let { compact = false }: { compact?: boolean } = $props();

	// A single Notes panel says "Only you · this device" once, in the frame's title row (§9.3), so
	// the compact empty line does not repeat it; center stage keeps the locality in its words.
	const COMPACT_EMPTY_MESSAGE = 'Keep personal notes, links and reminders here.';
	const PAGE_EMPTY_MESSAGE = 'Keep personal notes, links, and reminders on this device.';
	const LOCALITY = 'Only you · this device';

	/**
	 * The companion reads NotesWorkspace's chrome (that markup belongs to the notebook):
	 * - the ink tools strip (Pen, Eraser, Shapes) is the part of row B that scrolls sideways in a
	 *   narrow panel. When it cannot show every tool its width stops part-way through one (so the
	 *   cut label fades out and reads as "more"), each edge with tools out of view gets
	 *   `data-more-before/after`, which draws the alpha-mask fade, and a mouse wheel anywhere over
	 *   the editor tools moves the strip;
	 * - `noteUnsettled` (data-note-unsettled on this root) while the open note's save word is not
	 *   "Saved …", so the footer shows "Unsaved changes", "Saving…" or "Could not save" and hides
	 *   only the settled "Saved on this device" (said once on screen, by the Scratchpad band).
	 */
	let noteUnsettled = $state(false);

	function companionChrome(node: HTMLElement) {
		let strip: HTMLElement | null = null;
		let row: HTMLElement | null = null;
		let frame = 0;
		const edges = () => {
			if (!strip) return;
			const { before, after } = stripEdges(strip.scrollLeft, strip.scrollWidth, strip.clientWidth);
			strip.toggleAttribute('data-more-before', before);
			strip.toggleAttribute('data-more-after', after);
		};
		// The strip's room is the row's content box less the pinned tools beside it (they never
		// shrink), so it does not depend on the width this sets.
		const fit = () => {
			if (!strip || !row) return;
			const rowStyle = getComputedStyle(row);
			let available = row.clientWidth - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight);
			for (const child of row.children) if (child !== strip) available -= child.getBoundingClientRect().width;
			available -= parseFloat(getComputedStyle(strip).marginRight) || 0;
			const width = stripPeekWidth(available, [...strip.children].map((tool) => tool.getBoundingClientRect().width));
			if (width === null) strip.style.removeProperty('max-width');
			else strip.style.setProperty('max-width', `${Math.floor(width)}px`);
		};
		const queue = () => {
			if (!frame) frame = requestAnimationFrame(scan);
		};
		const sized = new ResizeObserver(queue);
		// Only the editor tools row takes a non-passive wheel listener, so scrolling the note and
		// the list stays passive.
		const wheel = (event: WheelEvent) => {
			const target = event.target;
			if (!strip || !(target instanceof Node)) return;
			const delta = stripWheelDelta({
				deltaX: event.deltaX,
				deltaY: event.deltaY,
				deltaMode: event.deltaMode,
				inStrip: strip.contains(target),
				scrollLeft: strip.scrollLeft,
				maxScroll: strip.scrollWidth - strip.clientWidth,
				pageWidth: strip.clientWidth
			});
			if (!delta) return;
			event.preventDefault();
			strip.scrollLeft += delta;
		};
		const scan = () => {
			frame = 0;
			const next = node.querySelector<HTMLElement>('.editor-tools .note-ink-tools');
			if (next !== strip) {
				if (row) {
					sized.unobserve(row);
					row.removeEventListener('wheel', wheel);
				}
				strip = next;
				row = strip?.parentElement ?? null;
				if (row) {
					sized.observe(row);
					row.addEventListener('wheel', wheel, { passive: false });
				}
			}
			fit();
			edges();
			const status = node.querySelector('footer .save-status');
			noteUnsettled = !!status && !isSettledSave(status.textContent ?? '');
		};
		const changes = new MutationObserver(queue);
		changes.observe(node, { childList: true, subtree: true, characterData: true });
		const scrolled = (event: Event) => {
			if (strip && event.target === strip) edges();
		};
		node.addEventListener('scroll', scrolled, true);
		scan();
		return {
			destroy() {
				if (frame) cancelAnimationFrame(frame);
				changes.disconnect();
				sized.disconnect();
				row?.removeEventListener('wheel', wheel);
				node.removeEventListener('scroll', scrolled, true);
			}
		};
	}
</script>

{#if compact}
	<div class="keep-notes-compact" data-note-unsettled={noteUnsettled || undefined} use:companionChrome>
		<!-- A stacked section header names the panel without its locality tag: there the words are
		     said here, once, above the notebook (see the style block). -->
		<p class="keep-notes-scope"><span class="w-tag">{LOCALITY}</span></p>
		<NotesWorkspace
			title="Notes"
			showHeader={false}
			compact
			emptyMessage={COMPACT_EMPTY_MESSAGE}
			placeholder="Write a note…"
		/>
	</div>
{:else}
	<NotesWorkspace
		title="Notes"
		showHeader
		emptyMessage={PAGE_EMPTY_MESSAGE}
		placeholder="Write a note…"
	/>
{/if}

<style>
	/*
	 * Companion skin for NotesWorkspace (design contract §2.1 rules not boxes, §7.21, §8.4 Notes).
	 * NotesWorkspace belongs to the wiki + notes package; until it restyles the notebook itself,
	 * these rules are scoped to the companion so center-stage Notes is untouched:
	 * - row B (40px, its hairline = the masthead rule at y = 96) is the list tools on the list, and
	 *   the editor tools while a note is open;
	 * - list rows are 44px: title, then the date in mono; the preview line and the color bar go
	 *   (a person's color never paints a bar, §5.5);
	 * - the open note is a serif title over prose at 15/26: no boxed title, no boxed editor, quiet
	 *   tools and footer actions.
	 * Selectors that meet the panel's legacy field skin (surfaces/panel.css, :root .right-panel …,
	 * specificity 0,4,1) or NotesWorkspace's narrow rules start at :root to outrank them.
	 */
	.keep-notes-compact {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		overflow: hidden;
	}
	.keep-notes-compact > :global(.notes-host) {
		flex: 1 1 auto;
		min-height: 0;
	}

	/* Locality, once per screen: the single panel's row A carries the tag; a stacked section header
	   does not, so the section says it above its row B. */
	.keep-notes-scope {
		display: none;
		flex: none;
		margin: 0;
		padding: 0 12px 8px 20px;
	}
	:global(.dock-section) .keep-notes-scope {
		display: flex;
	}

	.keep-notes-compact :global(.notes-workspace) {
		background: transparent;
	}
	.keep-notes-compact :global(.notes-workspace .note-list) {
		background: transparent;
	}

	/* ---------- row B on the list: search + new note ---------- */
	.keep-notes-compact :global(.notes-workspace .list-tools) {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		box-sizing: border-box;
		height: var(--w-head-b);
		padding: 0 12px 8px 20px;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace .list-tools input[type='search']) {
		box-sizing: border-box;
		height: 32px;
		min-height: 0;
		padding: 0 10px;
		border: var(--w-bw) solid var(--w-line-strong);
		border-radius: var(--radius-md);
		background: var(--w-sink);
		box-shadow: none;
		color: var(--w-text);
		font: var(--w-t-ui);
		text-overflow: ellipsis;
	}
	.keep-notes-compact :global(.notes-workspace .list-tools input::placeholder) {
		color: var(--w-faint);
		opacity: 1;
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace .list-tools input[type='search']:focus) {
		border-color: var(--w-accent);
		box-shadow: var(--w-ring);
		outline: none;
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace .list-tools button) {
		display: inline-grid;
		flex: none;
		place-items: center;
		box-sizing: border-box;
		width: 32px;
		height: 32px;
		min-height: 0;
		padding: 0;
		border: var(--w-bw) solid var(--w-line);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--w-mute);
		font: 400 calc(18px * var(--w-fs)) / 1 var(--w-sans);
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace .list-tools button:hover:not(:disabled)) {
		background: var(--w-raise);
		color: var(--w-text);
	}

	/* Notes | Trash: a quiet tab strip under row B. */
	.keep-notes-compact :global(.notes-workspace .list-tabs) {
		padding: 0 12px 0 20px;
	}
	.keep-notes-compact :global(.notes-workspace .list-tabs button) {
		min-height: 36px;
		padding: 0 2px;
		margin-right: 18px;
		border-bottom-width: 2px;
		color: var(--w-mute);
		font: var(--w-t-label);
		letter-spacing: 0;
		text-transform: none;
	}
	.keep-notes-compact :global(.notes-workspace .list-tabs button:last-child) {
		margin-right: 0;
		padding: 0 6px;
	}

	/* ---------- list rows: 44px, title, date at the end in mono ---------- */
	.keep-notes-compact :global(.notes-workspace .note-rows) {
		padding: 6px 8px 12px;
	}
	.keep-notes-compact :global(.notes-workspace .note-row) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		column-gap: 12px;
		box-sizing: border-box;
		min-height: 44px;
		margin: 0;
		padding: 0 12px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		transition: background-color var(--w-dur-1) var(--w-ease);
	}
	.keep-notes-compact :global(.notes-workspace .note-row:hover) {
		background: color-mix(in srgb, var(--w-raise) 70%, transparent);
	}
	.keep-notes-compact :global(.notes-workspace .note-row.selected),
	.keep-notes-compact :global(.notes-workspace .note-row.selected:hover) {
		background: var(--w-raise);
	}
	/* High Contrast: hover is a ring, not a fill; the selected row keeps its fill under the ring. */
	:global(:root[data-char='contrast']) .keep-notes-compact :global(.notes-workspace .note-row:hover),
	:global(:root[data-char='contrast']) .keep-notes-compact :global(.notes-workspace .note-row.selected) {
		box-shadow: inset 0 0 0 1px var(--w-line-strong);
	}
	:global(:root[data-char='contrast']) .keep-notes-compact :global(.notes-workspace .note-row:not(.selected):hover) {
		background: transparent;
	}
	.keep-notes-compact :global(.notes-workspace .note-row strong) {
		min-width: 0;
		overflow: hidden;
		color: var(--w-text);
		font: var(--w-t-label);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.keep-notes-compact :global(.notes-workspace .note-row > span) {
		display: none;
	}
	.keep-notes-compact :global(.notes-workspace .note-row small) {
		color: var(--w-faint);
		font: var(--w-t-micro);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.keep-notes-compact :global(.notes-workspace .list-empty) {
		padding: 24px 12px;
		color: var(--w-mute);
		font: var(--w-t-ui);
	}
	.keep-notes-compact :global(.notes-workspace .notebook-settings) {
		padding: 8px 12px;
		border-top: var(--w-bw) solid var(--w-line);
	}

	/* ---------- quiet actions: text buttons with no box (Notes settings, the editor tools, the
	   footer, note links). The tool that is on reads as selected (raise fill, text ink). ---------- */
	:global(:root) .keep-notes-compact :global(.notes-workspace :is(.notebook-settings, .editor-tools, footer, .note-links) button),
	:global(:root) .keep-notes-compact :global(.notes-workspace footer .note-actions > summary) {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 8px;
		box-sizing: border-box;
		width: auto;
		min-width: 0;
		height: 32px;
		min-height: 0;
		margin: 0;
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		box-shadow: none;
		color: var(--w-mute);
		font: var(--w-t-ui);
		white-space: nowrap;
		cursor: pointer;
		transition: background-color var(--w-dur-1) var(--w-ease), color var(--w-dur-1) var(--w-ease);
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace .notebook-settings button) {
		width: 100%;
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace :is(.notebook-settings, .editor-tools, footer, .note-links) button svg) {
		flex: none;
		width: 16px;
		height: 16px;
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace :is(.notebook-settings, .editor-tools, footer, .note-links) button:hover:not(:disabled)),
	:global(:root) .keep-notes-compact :global(.notes-workspace footer .note-actions > summary:hover) {
		background: color-mix(in srgb, var(--w-raise) 70%, transparent);
		color: var(--w-text);
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace .editor-tools button[aria-pressed='true']),
	:global(:root) .keep-notes-compact :global(.notes-workspace footer .note-actions[open] > summary) {
		background: var(--w-raise);
		color: var(--w-text);
		font-weight: 500;
	}
	:global(:root[data-char='contrast']) .keep-notes-compact :global(.notes-workspace :is(.notebook-settings, .editor-tools, footer, .note-links) button:hover:not(:disabled)),
	:global(:root[data-char='contrast']) .keep-notes-compact :global(.notes-workspace .editor-tools button[aria-pressed='true']),
	:global(:root[data-char='contrast']) .keep-notes-compact :global(.notes-workspace footer .note-actions > summary:is(:hover, [open] > *)) {
		box-shadow: inset 0 0 0 1px var(--w-line-strong);
	}
	:global(:root[data-char='contrast']) .keep-notes-compact :global(.notes-workspace :is(.notebook-settings, .editor-tools, footer, .note-links) button:not([aria-pressed='true']):hover:not(:disabled)) {
		background: transparent;
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace :is(.notebook-settings, .editor-tools, footer, .note-links) button:focus-visible),
	:global(:root) .keep-notes-compact :global(.notes-workspace footer .note-actions > summary:focus-visible) {
		outline: 2px solid var(--w-accent);
		outline-offset: -2px;
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace footer .note-actions > summary) {
		list-style: none;
	}
	.keep-notes-compact :global(.notes-workspace footer .note-actions > summary::-webkit-details-marker) {
		display: none;
	}

	/* ---------- row B while a note is open: the editor tools ----------
	   One 40px row on the masthead rule. "All notes" (and "Back") hold the start; Preview and the
	   Download icon hold the end, so they never scroll away (the link hint names Preview). The ink
	   tools between them are the only part that gives way: at the default 304px panel the row fits,
	   and narrower the strip scrolls sideways with an alpha-mask fade on each edge that has more
	   (§4.5), a wheel over the row moves it, and focus scrolls the focused tool clear of the fade. */
	:global(:root) .keep-notes-compact :global(.notes-workspace .editor-tools) {
		display: flex;
		flex: none;
		flex-wrap: nowrap;
		align-items: center;
		justify-content: flex-start;
		gap: 0;
		box-sizing: border-box;
		min-width: 0;
		height: var(--w-head-b);
		/* 14px + the tool's 6px: "All notes" starts on the title's 20px line. */
		padding: 0 6px 8px 14px;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace .editor-tools button) {
		padding: 0 6px;
		font: var(--w-t-small);
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace .editor-tools .note-ink-tools) {
		--keep-fade-start: 0px;
		--keep-fade-end: 0px;
		display: flex;
		flex: 0 1 auto;
		gap: 0;
		min-width: 0;
		/* Pushed to the end beside Preview, with a little room for its fade before Preview. */
		margin-inline: auto 4px;
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
		scroll-padding-inline: 16px;
		scrollbar-width: none;
	}
	.keep-notes-compact :global(.notes-workspace .editor-tools .note-ink-tools::-webkit-scrollbar) {
		display: none;
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace .editor-tools .note-ink-tools button) {
		padding: 0 5px;
	}
	.keep-notes-compact :global(.notes-workspace .editor-tools .note-ink-tools[data-more-before]) {
		--keep-fade-start: 16px;
	}
	.keep-notes-compact :global(.notes-workspace .editor-tools .note-ink-tools[data-more-after]) {
		--keep-fade-end: 16px;
	}
	.keep-notes-compact :global(.notes-workspace .editor-tools .note-ink-tools:is([data-more-before], [data-more-after])) {
		-webkit-mask-image: linear-gradient(to right, transparent, var(--w-text) var(--keep-fade-start), var(--w-text) calc(100% - var(--keep-fade-end)), transparent);
		mask-image: linear-gradient(to right, transparent, var(--w-text) var(--keep-fade-start), var(--w-text) calc(100% - var(--keep-fade-end)), transparent);
	}
	/* Download: a small icon button (§7.2 --sm) at the end of the row. */
	:global(:root) .keep-notes-compact :global(.notes-workspace .editor-tools > button:last-child) {
		justify-content: center;
		width: 28px;
		padding: 0;
	}

	/* ---------- the open note: a serif title over prose at 15/26, no boxes ---------- */
	:global(:root) .keep-notes-compact :global(.notes-workspace input.note-title) {
		flex: none;
		box-sizing: border-box;
		width: 100%;
		height: auto;
		min-height: 0;
		margin: 0;
		padding: 16px 20px 4px;
		border: 0;
		border-radius: 0;
		background: transparent;
		box-shadow: none;
		color: var(--w-text);
		font: var(--w-t-heading);
		text-overflow: ellipsis;
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace input.note-title::placeholder) {
		color: var(--w-faint);
		opacity: 1;
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace input.note-title:focus) {
		border: 0;
		box-shadow: none;
		outline: none;
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace input.note-title:focus-visible) {
		outline: 2px solid var(--w-accent);
		outline-offset: -2px;
	}
	.keep-notes-compact :global(.notes-workspace .note-text),
	.keep-notes-compact :global(.notes-workspace .note-reading) {
		box-sizing: border-box;
		padding: 0 6px 12px;
	}
	.keep-notes-compact :global(.notes-workspace .note-reading) {
		padding: 12px 20px 20px;
		color: var(--w-text);
	}
	/* The editor wrapper (CodeMirrorEditor's prose card) paints no edge and no fill here. */
	.keep-notes-compact :global(.notes-workspace .note-text > .cm-editor),
	.keep-notes-compact :global(.notes-workspace .note-text .cm-editor-host .cm-editor) {
		border-color: transparent;
		border-radius: 0;
		background: transparent;
	}
	/* Writing in the note shows the caret, not a 2px accent box around the whole page (the prose
	   theme's .cm-focused outline): the open note is a page, not a field (§2.1). */
	.keep-notes-compact :global(.notes-workspace .note-text .cm-editor-host .cm-editor.cm-focused) {
		outline: none;
	}
	.keep-notes-compact :global(.notes-workspace .note-text .cm-content),
	.keep-notes-compact :global(.notes-workspace .note-text .cm-scroller),
	.keep-notes-compact :global(.notes-workspace .note-reading) {
		color: var(--w-text);
		font: 400 calc(15px * var(--w-fs)) / calc(26px * var(--w-fs)) var(--w-sans);
	}
	.keep-notes-compact :global(.notes-workspace .note-text .cm-content) {
		padding: 8px 0;
	}

	/* Link hints and the footer: hairline rules, quiet words. */
	.keep-notes-compact :global(.notes-workspace .note-links) {
		gap: 4px;
		padding: 6px 12px 6px 20px;
		color: var(--w-faint);
		font: var(--w-t-small);
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace .note-links button) {
		height: 28px;
		color: var(--w-text);
	}
	.keep-notes-compact :global(.notes-workspace footer) {
		gap: 4px;
		padding: 8px 12px 8px 20px;
	}
	/* The open note's save word. Settled ("Saved on this device") it would say the locality a
	   second time on this screen, right above the Scratchpad band's own line (§9.3: once per
	   screen; row A says it), so it stays for assistive tech only. While the note has unsaved
	   changes, is saving, conflicts or could not save, it shows (KeepNotesView marks the root
	   data-note-unsettled); a failure also shows as the editor's notice (role=alert). */
	.keep-notes-compact :global(.notes-workspace footer .save-status) {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
	}
	.keep-notes-compact[data-note-unsettled] :global(.notes-workspace footer .save-status) {
		position: static;
		flex: 0 1 auto;
		width: auto;
		min-width: 0;
		height: auto;
		margin: 0;
		padding: 0 8px;
		clip: auto;
		color: var(--w-mute);
		font: var(--w-t-micro);
		text-overflow: ellipsis;
	}
	.keep-notes-compact :global(.notes-workspace footer .note-actions) {
		margin-inline-start: auto;
	}
	/* The note actions popover: an overlay on the kit's menu surface. */
	:global(:root) .keep-notes-compact :global(.notes-workspace .note-actions-menu) {
		gap: 2px;
		padding: 6px;
		border: var(--w-bw) solid var(--w-line-strong);
		border-radius: var(--radius-lg);
		background: var(--w-bg2);
		box-shadow: var(--w-shadow);
	}
	:global(:root) .keep-notes-compact :global(.notes-workspace .note-actions-menu button) {
		justify-content: flex-start;
		width: 100%;
		color: var(--w-text);
	}

	/* Touch: every action reaches 44px. Row B keeps the frame's 40px geometry, like People and DMs
	   (the masthead rule stays at y = 96): its tools stay 32px tall and each reaches 44px with an
	   invisible target from the top of row B to 4px under its rule, over the title's top padding
	   (the panel body clips anything above row B). Text tools are at least 44px wide; the
	   Download icon reaches sideways. The ink strip clips what overflows it, so it carries that
	   reach as padding. */
	@media (pointer: coarse) {
		:global(:root) .keep-notes-compact :global(.notes-workspace :is(.notebook-settings, footer, .note-links) button),
		:global(:root) .keep-notes-compact :global(.notes-workspace footer .note-actions > summary) {
			height: 44px;
		}
		:global(:root) .keep-notes-compact :global(.notes-workspace .editor-tools button) {
			position: relative;
			min-width: 44px;
		}
		.keep-notes-compact :global(.notes-workspace .editor-tools button::before) {
			content: '';
			position: absolute;
			top: 0;
			bottom: -12px;
			left: 0;
			right: 0;
		}
		:global(:root) .keep-notes-compact :global(.notes-workspace .editor-tools > button:last-child) {
			width: 32px;
			min-width: 32px;
		}
		.keep-notes-compact :global(.notes-workspace .editor-tools > button:last-child::before) {
			left: -6px;
			right: -6px;
		}
		:global(:root) .keep-notes-compact :global(.notes-workspace .editor-tools .note-ink-tools) {
			padding-block-end: 12px;
			margin-block-end: -12px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.keep-notes-compact :global(.notes-workspace .note-row),
		:global(:root) .keep-notes-compact :global(.notes-workspace :is(.notebook-settings, .editor-tools, footer, .note-links) button) {
			transition: none;
		}
	}
</style>
