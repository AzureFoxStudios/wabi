import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Markup and style contracts for the People, DMs and Notes companions and the Scratchpad tray
// (design contract §7.11, §7.21, §8.4, §9.3, §10). Each guards a regression found in review.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const tray = read('./QuickResourcesPanel.svelte');
const dmTab = read('./DMTab.svelte');
const people = read('./UserListTabImpl.svelte');
const peopleCss = read('./UserListTabImpl.css');
const notes = read('./KeepNotesView.svelte');

/** The CSS block that starts at `selector {` (first match after `from`), up to its closing brace. */
function block(source: string, selector: string, from = 0): string {
	const start = source.indexOf(`${selector} {`, from);
	if (start < 0) return '';
	return source.slice(start, source.indexOf('}', start) + 1);
}

describe('Scratchpad tray', () => {
	test('the editor mounts only once the Scratchpad view has been opened (it finds or creates the note)', () => {
		const tag = tray.indexOf('<QuickScratchpad');
		const guard = tray.lastIndexOf('{#if scratchpadOpened}', tag);
		expect(tag).toBeGreaterThan(0);
		expect(guard).toBeGreaterThan(0);
		expect(tray.indexOf('{/if}', guard)).toBeGreaterThan(tag);
		expect(tray).toContain('$: if (!collapsed && !showingDm) scratchpadOpened = true;');
	});

	test('the band line is not a live region; only a failure is announced', () => {
		expect(tray).not.toMatch(/<span class="scratch-status"[^>]*role=/);
		expect(tray).toContain('<span class="sr-only" role="alert">{bandAlert}</span>');
	});

	test('Enter on the resize separator collapses the tray and gives focus to the chevron', () => {
		const handler = tray.indexOf('function handleSeparatorKeydown');
		const at = tray.indexOf("event.key === 'Enter'", handler);
		const enter = tray.slice(at, tray.indexOf('return;', at));
		expect(handler).toBeGreaterThan(0);
		expect(enter).toContain('collapse();');
		expect(enter).toContain('toggleButton?.focus()');
	});

	test('the conversation view states who can read it and pauses sending like the DM composer', () => {
		expect(tray).toContain('<PrivacyBadge variant="colophon"');
		expect(tray).toContain('{#if dmCanSend}');
		expect(tray).toContain('!dmPolicy.pendingDefault && !dmPolicy.needsRekey');
	});
});

describe('DMs companion', () => {
	test('the hover tray runs the full row height on the row surface (no sliced glyphs)', () => {
		const rule = block(dmTab, '.dm-row-tray');
		expect(rule).toContain('top: var(--w-bw);');
		expect(rule).toContain('bottom: var(--w-bw);');
		expect(rule).toContain('background: var(--dm-surface);');
		expect(rule).not.toContain('translate:');
	});

	test('while the tray shows, both lines end in an ellipsis at its edge; the time and badge step out', () => {
		const fine = dmTab.slice(dmTab.indexOf('@media not all and (pointer: coarse)'));
		expect(fine).toContain('.dm-row-shell:is(:hover, :focus-within) .dm-row-text {');
		expect(block(fine, '.dm-row-shell:is(:hover, :focus-within) .dm-row-text')).toContain('padding-inline-end: calc(var(--dm-tray-n, 3) * 30px + 2px);');
		expect(block(fine, '.dm-row-shell:is(:hover, :focus-within) :is(.dm-row-time, .dm-row-badge)')).toContain('display: none;');
		expect(dmTab).toContain('--dm-tray-n: ${trayButtons}');
		expect(dmTab).toContain('style={row.style}');
	});

	test('row B controls stay 32px under a coarse pointer and reach 44px through a pseudo-element', () => {
		const coarse = dmTab.slice(dmTab.indexOf('@media (pointer: coarse)'));
		expect(coarse).toMatch(/\.dm-rowb :global\(\.w-ibtn\) \{\s*width: 32px;/);
		expect(coarse).not.toMatch(/\.dm-tab :global\(\.w-ibtn\) \{\s*width: 44px;/);
		const reach = block(coarse, '.dm-rowb :global(.w-ibtn)::before');
		expect(reach).toContain('bottom: calc(-12px - var(--w-bw));');
		// Offsets start at the padding box, inside the 1px edge: 30 + 2 × (6 + 1) = 44px wide.
		expect(reach).toContain('left: calc(-6px - var(--w-bw));');
		expect(reach).toContain('right: calc(-6px - var(--w-bw));');
		// The field reaches down only under itself, so a tap inside the text still lands in it.
		expect(block(coarse, '.dm-find::before')).toContain('top: 100%;');
	});

	test('in an open conversation, row B stacks above the conversation tools that start at its rule', () => {
		const coarse = dmTab.slice(dmTab.indexOf('@media (pointer: coarse)'));
		const head = block(coarse, '.dm-active-head');
		expect(head).toContain('position: relative;');
		expect(head).toContain('z-index: 1;');
	});

	test('touch sizing and focus offsets stay on DMTab’s own buttons, never nested surfaces', () => {
		expect(dmTab).not.toContain('.dm-tab :global(.w-ibtn)');
		expect(dmTab).not.toContain('.dm-tab :global(.w-ibtn:focus-visible)');
	});

	test('High Contrast hover keeps the selected conversation’s fill', () => {
		expect(dmTab).toContain(":global(:root[data-char='contrast']) .dm-row-shell:not(.is-selected):hover .dm-row {");
	});
});

describe('People companion', () => {
	test('row B controls stay 32px under a coarse pointer (the masthead rule stays at y = 96)', () => {
		const coarse = peopleCss.slice(peopleCss.indexOf('@media (pointer: coarse)'));
		expect(coarse).not.toMatch(/\.people-filter \{\s*width: 44px;\s*height: 44px;/);
		expect(coarse).toContain('height: 32px;');
		const reach = block(coarse, '.user-list-tab .people-filter::before');
		expect(reach).toContain('bottom: calc(-12px - var(--w-bw));');
		expect(reach).toContain('left: calc(-6px - var(--w-bw));');
		expect(reach).toContain('right: calc(-6px - var(--w-bw));');
		expect(block(coarse, '.user-list-tab .people-find::before')).toContain('top: 100%;');
	});

	test('names are set in --w-text; identity ink stays on the stamp', () => {
		expect(people).toContain('<ProfileName username={row.name} font={row.user.usernameFont} />');
	});

	test('group counts are read from visually hidden words, not aria-label on a span', () => {
		expect(people).not.toMatch(/class="w-count"[^>]*aria-label/);
		expect(people).toContain('<span class="sr-only">{countWords(group.rows.length)}</span>');
	});

	test('a search or the Offline filter shows Offline as a plain heading, not a toggle that does nothing', () => {
		expect(people).toContain("{#if group.kind === 'offline' && !offlineForced}");
		expect(people).toContain("$: offlineForced = (isEnhanced && peopleShow === 'offline') || friendSearchQuery.trim() !== '';");
	});

	test('without the add-on, row B still holds the panel description, so the masthead rule stays', () => {
		const otherwise = people.slice(people.indexOf('{:else}', people.indexOf('{#if isEnhanced}')));
		expect(otherwise.slice(0, 200)).toContain('<div class="people-rowb">');
		expect(otherwise.slice(0, 200)).toContain('<p class="w-panel__desc">{PEOPLE_DESCRIPTION}</p>');
	});

	test('free text describes a row instead of joining its name', () => {
		expect(people).toContain('aria-describedby={row.description ? row.sublineId : undefined}');
	});
});

describe('Notes companion', () => {
	test('the open note title outranks the panel field skin (:root .right-panel …, 0,4,1)', () => {
		expect(notes).toContain(':global(:root) .keep-notes-compact :global(.notes-workspace input.note-title) {');
		const title = block(notes, ':global(:root) .keep-notes-compact :global(.notes-workspace input.note-title)');
		expect(title).toContain('border: 0;');
		expect(title).toContain('background: transparent;');
		expect(title).toContain('font: var(--w-t-heading);');
	});

	test('the open note is a page: the prose editor draws no focus box (the caret shows focus)', () => {
		expect(block(notes, '.keep-notes-compact :global(.notes-workspace .note-text .cm-editor-host .cm-editor.cm-focused)')).toContain('outline: none;');
	});

	test('the editor tools are row B: 40px with the masthead hairline', () => {
		const tools = block(notes, ':global(:root) .keep-notes-compact :global(.notes-workspace .editor-tools)');
		expect(tools).toContain('height: var(--w-head-b);');
		expect(tools).toContain('border-bottom: var(--w-bw) solid var(--w-line);');
	});

	test('only the ink tools scroll; All notes, Preview and Download never scroll out of view', () => {
		const tools = block(notes, ':global(:root) .keep-notes-compact :global(.notes-workspace .editor-tools)');
		expect(tools).not.toContain('overflow-x');
		expect(tools).toContain('flex-wrap: nowrap;');
		const strip = block(notes, ':global(:root) .keep-notes-compact :global(.notes-workspace .editor-tools .note-ink-tools)');
		expect(strip).toContain('overflow-x: auto;');
		expect(strip).toContain('flex: 0 1 auto;');
		expect(strip).toContain('min-width: 0;');
		// Focus scrolls a tool clear of the fade.
		expect(strip).toContain('scroll-padding-inline: 16px;');
	});

	test('the strip fades with an alpha mask only on an edge that has tools out of view', () => {
		const fade = block(notes, '.keep-notes-compact :global(.notes-workspace .editor-tools .note-ink-tools:is([data-more-before], [data-more-after]))');
		expect(fade).toContain('mask-image: linear-gradient(to right, transparent, var(--w-text) var(--keep-fade-start)');
		expect(notes).toContain("strip.toggleAttribute('data-more-before', before);");
		expect(notes).toContain("strip.toggleAttribute('data-more-after', after);");
		// Its end always cuts through a tool, so the fade reads as more, never as an empty gap.
		expect(notes).toContain('const width = stripPeekWidth(available,');
		// A wheel over the row moves the strip; nobody has to know about Shift.
		expect(notes).toContain("row.addEventListener('wheel', wheel, { passive: false });");
	});

	test('under a coarse pointer row B stays 40px: tools stay 32px and reach 44px downward', () => {
		const coarse = notes.slice(notes.indexOf('@media (pointer: coarse)'));
		expect(coarse).not.toMatch(/\.editor-tools\) \{\s*height:/);
		expect(coarse).not.toContain(':is(.notebook-settings, .editor-tools, footer, .note-links) button),');
		const reach = block(coarse, '.keep-notes-compact :global(.notes-workspace .editor-tools button::before)');
		expect(reach).toContain('top: 0;');
		expect(reach).toContain('bottom: -12px;');
		// The strip clips what overflows it, so it carries the reach as padding.
		const strip = block(coarse, ':global(:root) .keep-notes-compact :global(.notes-workspace .editor-tools .note-ink-tools)');
		expect(strip).toContain('padding-block-end: 12px;');
		expect(strip).toContain('margin-block-end: -12px;');
	});

	test('the footer hides only a settled save; unsaved, saving and failed saves show', () => {
		expect(notes).toContain('data-note-unsettled={noteUnsettled || undefined}');
		expect(notes).toContain("noteUnsettled = !!status && !isSettledSave(status.textContent ?? '');");
		const shown = block(notes, '.keep-notes-compact[data-note-unsettled] :global(.notes-workspace footer .save-status)');
		expect(shown).toContain('position: static;');
		expect(shown).toContain('clip: auto;');
	});

	test('a stacked section, whose header has no locality tag, says it once', () => {
		expect(notes).toContain('<p class="keep-notes-scope"><span class="w-tag">{LOCALITY}</span></p>');
		expect(notes).toContain(":global(.dock-section) .keep-notes-scope {");
	});
});
