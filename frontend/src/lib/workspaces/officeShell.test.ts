import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';

// The office shell (design contract §7.23, §8.8). Sources are read as text: a regression that
// brings back a band, a raw id field or a hard-coded colour fails here.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const host = read('./WorkspaceHost.svelte');
const shell = read('./ArtifactShell.svelte');
const header = read('./OfficeEditorHeader.svelte');
const library = read('./ArtifactLibrary.svelte');
const handoff = read('./ArtifactHandoff.svelte');
const exportNotice = read('./FileExportNotice.svelte');
const css = read('./workspace.css');
const stripComments = (source: string) => {
	let previous = '';
	let current = source;
	while (current !== previous) {
		previous = current;
		current = current.replace(/\/\*[\s\S]*?\*\//, '');
	}
	return current;
};

describe('office host', () => {
	test('has no server settings band and no always-visible disable button', () => {
		expect(host).not.toContain('Workspace server settings');
		expect(host).not.toContain('workspace-host-controls');
		expect(host).not.toMatch(/Disable \{tool/);
	});

	test('the add-on gate says OPTIONAL ADD-ON · PREVIEW and keeps the consent facts verbatim', () => {
		expect(host).toContain('Optional add-on · {$_(\'maturity.preview\')}');
		expect(host).toContain('This addon is off on this device. Enabling it does not share files or enable the other office addon. Its editor loads only while you open the workspace.');
		expect(host).toContain('`Turn on ${info.name}`');
		expect(host).toContain('This minimal build excludes the authoring engine.');
	});

	test('loading is the 2px line plus a library skeleton, never only a sentence', () => {
		expect(host).toContain('<LoadLine active={opening}');
		expect(host).toContain('<Skeleton variant="card"');
		expect(host).not.toContain('Opening workspace…');
	});
});

describe('library', () => {
	test('a failed shared request shows an error notice, never "No shared …"', () => {
		expect(library).toContain("Couldn't reach the shared ${noun.many} on this server");
		expect(library).not.toMatch(/No accessible shared/);
		expect(library).toContain('{#if sharedLoading}');
	});

	test('empty states use the tool\'s own nouns and one primary per page', () => {
		expect(library).toContain('No {noun.many} on this device yet');
		expect(library).toContain("sheets: { one: 'spreadsheet', many: 'spreadsheets' }");
		expect(library).toContain("present: { one: 'presentation', many: 'presentations' }");
		expect(library.match(/w-btn w-btn--primary/g)?.length).toBe(1);
		expect(library).toContain("$_('maturity.preview')");
	});

	test('Present keeps a way to join a presentation by its link', () => {
		expect(library).toContain("openWorkspace('audience')");
		expect(existsSync(new URL('./WorkspaceShortcuts.svelte', import.meta.url))).toBe(false);
	});
});

describe('editor header in row A', () => {
	test('the shell registers the header with the stage masthead and clears it on destroy', () => {
		expect(shell).toContain('setStageHeader(HEADER_OWNER, {');
		expect(shell).toContain('component: OfficeEditorHeader,');
		expect(shell).toContain('clearStageHeader(HEADER_OWNER);');
		// No stacked bands or the old wall of buttons.
		expect(shell).not.toContain('workspace-bar');
		expect(shell).not.toContain('workspace-privacy');
		expect(shell).not.toContain('window.confirm');
	});

	test('the header carries the crumb, PREVIEW, the title field and the truthful locality', () => {
		expect(header).toContain('aria-label={`${crumb.label} library`}');
		expect(header).toContain("$_('maturity.preview')");
		expect(header).toContain('aria-label="Document title"');
		expect(header).toContain('Private · this device');
		expect(header).toContain('Server-readable');
		expect(header).toContain('role="status"');
	});

	test('on a phone Share… is the first row of ⋯, so row A keeps its room for the title', () => {
		expect(shell).toContain("...($isMobile && isOwner ? [{ id: 'share', label: 'Share…', icon: 'share', disabled: busy, onSelect: showSharing } satisfies MenuEntry] : []),");
		expect(shell).toContain("if (isOwner && !$isMobile) list.push({ id: 'share', label: 'Share…'");
	});

	test('the ⋯ menu keeps every capability the button wall had', () => {
		for (const label of ['Backup (.wabi.json)', 'Original file', 'Make private copy', 'Copy link', 'Freeze live editing', 'Resume collaboration…', 'Discuss in chat…', 'Create private task', 'Undo', 'Redo', 'Server sharing settings']) {
			expect(shell).toContain(`label: '${label}'`);
		}
		expect(shell).toContain('label: `Private drafts (${draftCount})`');
		expect(shell).toContain('label: `Turn off ${toolName} on this device…`');
	});
});

describe('share and discuss dialogs', () => {
	test('share is a kit dialog with a people picker, a role per person and no raw account ids', () => {
		expect(shell).toContain('<BaseModal isOpen={shareOpen}');
		expect(shell).toContain('aria-label="Person"');
		expect(shell).toContain('aria-label="Recipient permission"');
		expect(shell).toContain('aria-label={`Permission for ${recipientName(id)}`}');
		expect(shell).not.toContain('Recipient account ID');
		expect(shell).not.toMatch(/Account \$\{id\}/);
		expect(shell).toContain('The server operator can read this document. No public link is created.');
	});

	test('handoff results are toasts and the dialog is a kit dialog', () => {
		expect(handoff).toContain('export function showDiscussion()');
		expect(handoff).toContain('export async function createTask()');
		expect(handoff).toContain('<BaseModal isOpen={dialogOpen}');
		expect(handoff).not.toContain('<dialog');
	});

	test('export status is a toast with the exporter\'s words, never a band', () => {
		expect(exportNotice).toContain('toast(state.message');
		expect(exportNotice).not.toContain('<div');
	});
});

describe('workspace.css', () => {
	const code = stripComments(css);
	test('is on the roles: no system-ui, no legacy tokens, no raw colours or #0009 scrim', () => {
		expect(code).not.toContain('system-ui');
		expect(code).not.toMatch(/--surface-|--text-primary|--border-subtle|--accent-primary/);
		expect(code).not.toMatch(/#[0-9a-f]{3,8}\b/i);
		expect(code).not.toMatch(/rgba?\(/);
	});

	test('is unminified, and every office control is a kit control (no legacy control layer)', () => {
		expect(css.split('\n').length).toBeGreaterThan(200);
		expect(code).not.toContain(":where(button:not([class*='w-']))");
	});
});
