import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { confirmAction, isConfirmOpen, setConfirmMount, type ConfirmDialogProps } from './confirm';
import { modalFocus } from './actions/modalFocus';

type Shown = { props: ConfirmDialogProps; destroyed: boolean };

/** Records every dialog the service shows instead of rendering Svelte. */
function recordMounts() {
	const shown: Shown[] = [];
	setConfirmMount((props) => {
		const entry: Shown = { props, destroyed: false };
		shown.push(entry);
		return { destroy: () => (entry.destroyed = true) };
	});
	return shown;
}

const open = (shown: Shown[]) => shown.filter((entry) => !entry.destroyed);

afterEach(() => setConfirmMount(null));

describe('confirmAction', () => {
	test('resolves true when the action is chosen, and takes the dialog down', async () => {
		const shown = recordMounts();
		const answer = confirmAction({
			title: 'Delete this message?',
			body: 'It will be removed for everyone in #general.',
			confirm: 'Delete message',
			danger: true
		});
		expect(shown).toHaveLength(1);
		const { props } = shown[0];
		expect(props).toMatchObject({
			isOpen: true,
			title: 'Delete this message?',
			message: 'It will be removed for everyone in #general.',
			confirmText: 'Delete message',
			cancelText: 'Cancel',
			variant: 'danger'
		});
		expect(isConfirmOpen()).toBe(true);
		props.onConfirm();
		expect(await answer).toBe(true);
		expect(shown[0].destroyed).toBe(true);
		expect(isConfirmOpen()).toBe(false);
	});

	test('resolves false on Cancel; a non-destructive confirm uses the primary action', async () => {
		const shown = recordMounts();
		const answer = confirmAction({ title: 'Import this profile?', confirm: 'Import profile' });
		expect(shown[0].props.variant).toBe('info');
		expect(shown[0].props.message).toBe('');
		shown[0].props.onCancel();
		expect(await answer).toBe(false);
		expect(shown[0].destroyed).toBe(true);
	});

	test('answers once: a late second click cannot flip the result', async () => {
		const shown = recordMounts();
		const answer = confirmAction({ title: 'Leave this group?', confirm: 'Leave group', danger: true });
		shown[0].props.onCancel();
		shown[0].props.onConfirm();
		expect(await answer).toBe(false);
	});

	test('cancel: null leaves a single acknowledgement button', async () => {
		const shown = recordMounts();
		const answer = confirmAction({ title: 'Password changed', body: 'Use it next time you sign in.', confirm: 'OK', cancel: null });
		expect(shown[0].props.cancelText).toBeNull();
		shown[0].props.onConfirm();
		expect(await answer).toBe(true);
	});

	test('only one confirm is open at a time: a new request supersedes the open one', async () => {
		const shown = recordMounts();
		const first = confirmAction({ title: 'Delete this channel?', confirm: 'Delete channel', danger: true });
		const second = confirmAction({ title: 'Delete this channel?', confirm: 'Delete channel', danger: true });
		expect(await first).toBe(false);
		expect(shown).toHaveLength(2);
		expect(open(shown)).toHaveLength(1);
		expect(open(shown)[0]).toBe(shown[1]);
		// The superseded dialog's buttons are dead.
		shown[0].props.onConfirm();
		expect(isConfirmOpen()).toBe(true);
		shown[1].props.onConfirm();
		expect(await second).toBe(true);
		expect(open(shown)).toHaveLength(0);
	});

	test('a dialog that finishes loading after it was superseded is removed at once', async () => {
		let release: () => void = () => {};
		const handles: { destroyed: boolean }[] = [];
		setConfirmMount(
			() =>
				new Promise((resolve) => {
					const handle = { destroyed: false };
					handles.push(handle);
					release = () => resolve({ destroy: () => (handle.destroyed = true) });
				})
		);
		const first = confirmAction({ title: 'Delete this file?', confirm: 'Delete file', danger: true });
		const releaseFirst = release;
		setConfirmMount((props) => {
			queueMicrotask(() => props.onCancel());
			return { destroy() {} };
		});
		const second = confirmAction({ title: 'Delete this file?', confirm: 'Delete file', danger: true });
		releaseFirst();
		expect(await first).toBe(false);
		expect(await second).toBe(false);
		await Promise.resolve();
		expect(handles[0].destroyed).toBe(true);
	});

	test('resolves false, never true, when the dialog cannot be shown', async () => {
		const errors: unknown[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => void errors.push(args);
		try {
			setConfirmMount(() => {
				throw new Error('no document');
			});
			expect(await confirmAction({ title: 'Delete this?', confirm: 'Delete', danger: true })).toBe(false);
			setConfirmMount(() => Promise.reject(new Error('chunk failed')));
			expect(await confirmAction({ title: 'Delete this?', confirm: 'Delete', danger: true })).toBe(false);
			expect(isConfirmOpen()).toBe(false);
		} finally {
			console.error = originalError;
		}
		expect(errors).toHaveLength(2);
	});
});

describe('confirmAction with the real modal focus owner', () => {
	type Listener = (event: Event) => void;
	const saved = { document: (globalThis as Record<string, unknown>).document, HTMLElement: (globalThis as Record<string, unknown>).HTMLElement };

	afterEach(() => {
		(globalThis as Record<string, unknown>).document = saved.document;
		(globalThis as Record<string, unknown>).HTMLElement = saved.HTMLElement;
	});

	test('Esc resolves false through modalFocus, the action BaseModal puts on the dialog', async () => {
		// Just enough DOM for modalFocus: a document that dispatches keydown, and a dialog node.
		const listeners = new Set<Listener>();
		(globalThis as Record<string, unknown>).HTMLElement = class {};
		(globalThis as Record<string, unknown>).document = {
			activeElement: null,
			addEventListener: (type: string, listener: Listener) => type === 'keydown' && listeners.add(listener),
			removeEventListener: (type: string, listener: Listener) => type === 'keydown' && listeners.delete(listener)
		};
		const dialogNode = { isConnected: false, focus() {}, contains: () => false, querySelectorAll: () => [] };

		setConfirmMount((props) => {
			// ConfirmDialog passes its cancel handler to BaseModal as onClose, which owns Esc.
			const focus = modalFocus(dialogNode as unknown as HTMLElement, props.onCancel);
			return { destroy: () => focus.destroy?.() };
		});

		const answer = confirmAction({ title: 'Delete this message?', confirm: 'Delete message', danger: true });
		expect(listeners.size).toBe(1);
		const escape = new Event('keydown', { cancelable: true });
		Object.defineProperty(escape, 'key', { value: 'Escape' });
		for (const listener of [...listeners]) listener(escape);
		expect(escape.defaultPrevented).toBe(true);
		expect(await answer).toBe(false);
		// The dialog came down and released the keyboard.
		expect(listeners.size).toBe(0);
	});

	test('ConfirmDialog wires Esc/scrim/Cancel to cancel and is a labelled alertdialog on BaseModal', () => {
		const confirmSource = readFileSync(new URL('./components/ConfirmDialog.svelte', import.meta.url), 'utf8');
		const modalSource = readFileSync(new URL('./components/BaseModal.svelte', import.meta.url), 'utf8');
		expect(confirmSource).toContain('onClose={handleCancel}');
		expect(confirmSource).toContain('role="alertdialog"');
		expect(confirmSource).toContain("'w-btn--danger'");
		expect(confirmSource).toContain('w-btn w-btn--quiet');
		// The panel (not the scrim) is the dialog, owns focus, and is named by the title.
		expect(modalSource).toMatch(/class="w-dialog base-modal[^"]*"[\s\S]*?aria-modal="true"[\s\S]*?aria-labelledby=\{labelledBy\}[\s\S]*?use:modalFocus=\{onClose\}/);
		expect(modalSource).toMatch(/<div class="w-scrim base-modal-scrim" on:click=\{handleScrimClick\}><\/div>/);
		expect(modalSource).toContain('use:portal');
		expect(modalSource).not.toContain('#0f0c29');
	});
});

/**
 * The menu grammar lives in the module script of context-menu/ContextMenu.svelte (the one menu the
 * confirm flows are opened from). Compile it for the server, with its few imports pointed at real
 * files, so its exported helpers can be tested without a bundler.
 */
describe('menu grammar (context-menu/ContextMenu.svelte)', () => {
	type Row = { label: string; danger: boolean; disabled: boolean; role: string; checked?: boolean; nav: number };
	type Group = { kicker: string | null; rule: boolean; rows: Row[] };
	let sentenceCaseLabel: (label: string) => string;
	let arrangeMenu: (items: Record<string, unknown>[]) => Group[];
	let directory = '';

	const fileUrl = (relative: string) => pathToFileURL(new URL(relative, import.meta.url).pathname).href;
	function compileTo(file: string, relative: string, replacements: [RegExp, string][]): string {
		const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
		let code = compile(source, { generate: 'server', filename: file }).js.code.replace(
			/(from|import) ['"](svelte(?:\/[^'"]*)?)['"]/g,
			(_match, keyword, specifier) => `${keyword} ${JSON.stringify(import.meta.resolve(specifier))}`
		);
		for (const [pattern, target] of replacements) code = code.replace(pattern, `from ${JSON.stringify(target)}`);
		const path = join(directory, file.replace(/\.svelte$/, '.mjs'));
		writeFileSync(path, code);
		return pathToFileURL(path).href;
	}

	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), 'wabi-menu-'));
		const icons = fileUrl('./components/ui/icons.ts');
		const icon = compileTo('Icon.svelte', './components/ui/Icon.svelte', [[/from ['"]\.\/icons['"]/g, icons]]);
		const menu = compileTo('ContextMenu.svelte', './components/context-menu/ContextMenu.svelte', [
			[/from ['"]\$lib\/components\/ui\/icons['"]/g, icons],
			[/from ['"]\$lib\/actions\/portal['"]/g, fileUrl('./actions/portal.ts')],
			[/from ['"]\$lib\/components\/ui\/Icon\.svelte['"]/g, icon]
		]);
		({ sentenceCaseLabel, arrangeMenu } = await import(menu));
	});

	afterAll(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	test('sentence-cases legacy Title Case and ALL CAPS labels made of UI words', () => {
		expect(sentenceCaseLabel('View My Profile')).toBe('View my profile');
		expect(sentenceCaseLabel('Accept Friend Request')).toBe('Accept friend request');
		expect(sentenceCaseLabel('Set Local Nickname')).toBe('Set local nickname');
		expect(sentenceCaseLabel('Follow Channel With Alerts')).toBe('Follow channel with alerts');
		expect(sentenceCaseLabel('DELETE MESSAGE + UPLOADS')).toBe('Delete message + uploads');
		expect(sentenceCaseLabel('Open OS Window')).toBe('Open OS window');
	});

	test('never half-cases a label that carries a name, a place or an acronym', () => {
		expect(sentenceCaseLabel('Message Alice')).toBe('Message Alice');
		expect(sentenceCaseLabel('Make Gardener')).toBe('Make Gardener');
		expect(sentenceCaseLabel('Open Notes')).toBe('Open Notes');
		expect(sentenceCaseLabel('Promote to Lore…')).toBe('Promote to Lore…');
		expect(sentenceCaseLabel('Open in OS window')).toBe('Open in OS window');
		expect(sentenceCaseLabel('DM')).toBe('DM');
	});

	test('arranges rows: danger last, stray separators dropped, kickers start groups', () => {
		const groups = arrangeMenu([
			{ id: 'sep-top', type: 'separator' },
			{ id: 'delete', label: 'Delete Channel', danger: true },
			{ id: 'feed', label: 'Open Follow Feed', disabled: true },
			{ id: 'thread', label: 'Create Thread' },
			{ id: 'sep', type: 'separator' },
			{ id: 'sep-2', type: 'separator' },
			{ id: 'k', label: 'Move to folder', leading: '▸' },
			{ id: 'f1', label: 'Zines', leading: '●' },
			{ id: 'f2', label: 'Garden Notes', leading: '◦' },
			{ id: 'hidden', label: 'Hidden', hidden: true }
		]);
		expect(groups.map((group) => group.kicker)).toEqual([null, 'Move to folder', null]);
		expect(groups[0].rule).toBe(false);
		expect(groups[0].rows.map((row) => row.label)).toEqual(['Open follow feed', 'Create thread']);
		expect(groups[0].rows[0].disabled).toBe(true);
		// Folder names are user data: radio rows keep their case.
		expect(groups[1].rows.map((row) => [row.label, row.role, row.checked])).toEqual([
			['Zines', 'menuitemradio', true],
			['Garden Notes', 'menuitemradio', false]
		]);
		expect(groups[2]).toMatchObject({ rule: true, rows: [{ label: 'Delete channel', danger: true }] });
		expect(groups.flatMap((group) => group.rows.map((row) => row.nav))).toEqual([0, 1, 2, 3, 4]);
	});
});
