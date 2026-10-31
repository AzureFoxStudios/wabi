import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The Documents editor (design contract §8.8, documents-wabi-ink.png; critiques office-docs#2,
// #5, #8). Sources are read as text: a regression that brings back the cream preview, the
// button bar, line numbers on prose or a third writing surface fails here. Comments are removed
// by a loop that repeats one pattern until nothing changes (never a single-pass replace).
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const page = read('./DocumentsWorkspace.svelte');
const text = read('./CollaborativeText.svelte');
const css = read('./documents.css');
const workspaceCss = read('./workspace.css');
const shell = read('./ArtifactShell.svelte');
const header = read('./OfficeEditorHeader.svelte');
const frame = read('../editor/WritingFrame.svelte');
const writer = read('../components/WritingEditor.svelte');
const stripComments = (source: string) => {
	let previous = '';
	let current = source;
	while (current !== previous) {
		previous = current;
		current = current.replace(/\/\*[\s\S]*?\*\//, '');
	}
	return current;
};

describe('the page', () => {
	test('has no preview panel, no button bar and no magic 48px offset', () => {
		for (const gone of ['Hide preview', 'Show preview', 'Export text', 'workspace-editor-split', 'document-tools', 'calc(100% - 48px)', '#f4f1e9', '#272932']) {
			expect(page).not.toContain(gone);
			expect(workspaceCss).not.toContain(gone);
		}
	});

	test('Write | Read live in row A and the text export in ⋯ Export', () => {
		expect(page).toContain("options: [{ value: 'write', label: 'Write' }, { value: 'read', label: 'Read' }]");
		expect(page).toContain('{modes} {exports}>');
		expect(page).toContain("markdown: { label: 'Markdown (.md)'");
		// Read is the same prose on the page, not a second panel.
		expect(page).toContain('<div class="w-prose document-read"');
	});

	test('the aside is CONTENTS (.w-outline, title first) and FACTS (.w-facts: Words, Reading, Edited, Format)', () => {
		expect(page).toContain('<nav class="w-outline document-outline" aria-label="Contents">');
		expect(page).toContain("aria-current={section < 0 ? 'location' : undefined} onclick={() => void jump(-1)}>{title}</button>");
		for (const term of ['Words', 'Reading', 'Edited', 'Format']) expect(page).toContain(`<dt>${term}</dt>`);
	});

	test('the sheet: display title, meta (who, when started) and a hairline before the text', () => {
		expect(page).toContain('<h1 class="document-title">{title}</h1>');
		expect(page).toContain('<PlannerAvatar name={author.name}');
		expect(page).toContain('<hr class="document-rule" />');
		// Locality is said once, in row A; the meta line does not repeat it.
		expect(page).not.toMatch(/document-meta[\s\S]{0,400}this device/);
	});

	test('errors are a notice at the top of the page, raw errors are logged, not shown', () => {
		expect(page).toContain('{@render failure()}');
		expect(page).toContain('error={errorDetail}');
		expect(page).toContain('e instanceof WorkspaceError || (e instanceof Error && e.constructor === Error) ? e.message : cause');
		expect(page).not.toContain('workspace-home-note');
	});

	test('documents.css follows the grid in the contract and draws only with roles', () => {
		const code = stripComments(css);
		expect(code).toContain('grid-template-columns: minmax(180px, 1fr) minmax(0, 680px) minmax(120px, 1fr);');
		expect(code).toContain('column-gap: 56px;');
		expect(code).toContain('font: 600 calc(38px * var(--w-fs)) / calc(46px * var(--w-fs)) var(--w-serif);');
		expect(code).not.toMatch(/#[0-9a-f]{3,8}\b/i);
		expect(code).not.toMatch(/rgba?\(/);
		expect(code).not.toMatch(/--surface-|--text-primary|system-ui/);
	});
});

describe('the text editor', () => {
	test('prose is the shared writing page; only HTML and code get line numbers', () => {
		expect(text).toContain('prose ? [controller.extension] : [lineNumbers(), highlightActiveLineGutter()]');
		expect(text).toContain('<WritingFrame {controller}');
		expect(text).not.toMatch(/--surface-|--text-primary|#eef0f8|#161826|system-ui/);
	});

	test('one writing surface for Documents, the wiki and Notes', () => {
		expect(writer).toContain('<WritingFrame {controller}');
		expect(frame).toContain('<SelectionBubble {controller}');
		expect(frame).toContain('<InsertMenu {controller}');
	});

	test('a shared document adds Comment to the bubble, which opens Comments on the selection', () => {
		expect(page).toContain('oncomment={shared ? () => shell?.commentOnSelection() : undefined}');
		expect(shell).toContain('export function commentOnSelection()');
	});
});

describe('row A on a phone, and no legacy control layer', () => {
	test('on a phone the modes leave row A for radio rows in ⋯', () => {
		expect(header).toContain('{#if modes && !$isMobile}');
		expect(shell).toContain("role: 'menuitemradio', checked: modes!.value === option.value");
	});

	test('no workspace-wide field layer restyles inputs, so rendered task-list checkboxes keep the kit box', () => {
		expect(workspaceCss).not.toMatch(/\.wabi-workspace :where\([^)]*\b(?:input|select|textarea)\b/);
	});
});
