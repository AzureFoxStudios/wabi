// Real application and isolated backend, rendered in headful Chromium.
// Desktop docks must not become unsolicited full-screen mobile overlays.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp('/tmp/wabi-notebook-ui-');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const backend = `http://127.0.0.1:${port}`;
const server = spawn(process.env.WABI_SMOKE_SERVER_BINARY || fileURLToPath(new URL('../../target/release/wabi-server', import.meta.url)),
	['--data-dir', `${scratch}/data`, '--host', '127.0.0.1', '--port', String(port)],
	{ cwd: scratch, env: { PATH: process.env.PATH, WABI_LOG_DIR: `${scratch}/logs` }, stdio: ['ignore', 'pipe', 'pipe'] });
const log = createWriteStream(`${scratch}/server.log`, { mode: 0o600 });
server.stdout.pipe(log); server.stderr.pipe(log);
let browser, vite, page;
try {
	let ready = false;
	for (let attempt = 0; attempt < 150; attempt++) {
		if (server.exitCode !== null) throw new Error(`Isolated backend exited: ${scratch}`);
		try { ready = (await fetch(`${backend}/readyz`)).ok; } catch { /* starting */ }
		if (ready) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.ok(ready, 'isolated backend ready');
	const registration = await fetch(`${backend}/api/auth/register`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username: 'mobile_panel_fixture', password: 'Local-mobile-fixture-9825!' })
	});
	assert.equal(registration.status, 200);
	const account = await registration.json();
	process.env.VITE_SOCKET_URL = backend;
	process.env.VITE_WABI_LOCAL_MOCK = '0';
	vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, open: false } });
	await vite.listen();
	const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
	browser = await chromium.launch({ headless: false, executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH });
	page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.setDefaultTimeout(15000);
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.addInitScript(({ backend, account }) => {
		const scope = encodeURIComponent(backend);
		sessionStorage.setItem(`wabi_auth_token:${scope}`, account.accessToken);
		localStorage.setItem(`wabi_username:${scope}`, account.user.username);
		localStorage.setItem(`wabi_db_user_id:${scope}`, String(account.user.id));
		localStorage.setItem('notificationsEnabled', 'false');
	}, { backend, account });
	await page.goto(origin, { waitUntil: 'networkidle' });
	await page.locator('.workspace-trigger').waitFor({ timeout: 60000 });
	await page.waitForFunction(async () => (await import('/src/lib/layoutStoreStates.ts')).layoutLoaded);
	await page.evaluate(async () => {
		const { layoutStore } = await import('/src/lib/layoutStore.ts');
		layoutStore.closeRightPanel();
		layoutStore.pinPanel('users');
		layoutStore.rightPanelWidth.set(360);
	});
	await page.locator('.workspace-trigger').click();
	await page.getByRole('dialog', { name: 'Choose workspace' }).getByRole('button', { name: 'Notes', exact: true }).click();
	await page.locator('.chat-surface .notes-workspace').waitFor();
	const center = page.locator('.chat-surface .notes-workspace');
	await center.getByRole('button', { name: 'New note', exact: true }).first().click();
	await page.waitForFunction(() => document.querySelector('.chat-surface input[aria-label="Note title"]')?.value.startsWith('Untitled note'));
	await center.getByRole('textbox', { name: 'Note title', exact: true }).fill('Arrival');
	await center.getByRole('textbox', { name: 'Note text', exact: true }).fill('A calm place to begin.\n\nSee [[Next steps|what comes next]].');
	await center.getByRole('status').filter({ hasText: 'Saved on this device' }).waitFor();
	await center.getByRole('button', { name: 'Create Next steps', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('.chat-surface input[aria-label="Note title"]')?.value === 'Next steps');
	await center.getByRole('textbox', { name: 'Note text', exact: true }).fill('Invite a few people. Keep the experience clear.');
	await center.getByRole('status').filter({ hasText: 'Saved on this device' }).waitFor();
	await center.locator('.note-links').getByRole('button', { name: 'Arrival', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('.chat-surface input[aria-label="Note title"]')?.value === 'Arrival');
	await center.locator('.note-links').getByRole('button', { name: 'Next steps', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('.chat-surface input[aria-label="Note title"]')?.value === 'Next steps');
	await center.getByRole('textbox', { name: 'Note title', exact: true }).fill('First pilot');
	await center.getByRole('status').filter({ hasText: 'Saved on this device' }).waitFor();
	await center.locator('.note-links').getByRole('button', { name: 'Arrival', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('.chat-surface input[aria-label="Note title"]')?.value === 'Arrival');
	assert.ok((await center.getByRole('textbox', { name: 'Note text', exact: true }).innerText()).includes('[[First pilot|what comes next]]'));
	const editorBox = await center.getByRole('textbox', { name: 'Note text', exact: true }).boundingBox();
	assert.ok(editorBox.height > 300, 'editor uses available center height');
	await page.screenshot({ path: `${scratch}/notebook-desktop.png` });
	const archivePromise = page.waitForEvent('download');
	await center.getByRole('button', { name: 'Export Markdown archive', exact: true }).click();
	const archive = await archivePromise;
	assert.equal(archive.suggestedFilename(), 'wabi-notebook-markdown.tar');
	await archive.saveAs(`${scratch}/notebook.tar`);
	// Accept completion through the actual editor keyboard path.
	const textEditor = center.getByRole('textbox', { name: 'Note text', exact: true });
	await textEditor.press('Control+End');
	await textEditor.press('Enter');
	await textEditor.pressSequentially('[[Fir');
	await page.getByRole('option').filter({ hasText: 'First pilot' }).waitFor();
	await textEditor.press('Enter');
	assert.ok((await textEditor.innerText()).includes('[[First pilot]]'));
	await center.getByRole('status').filter({ hasText: 'Saved on this device' }).waitFor();
	await center.getByRole('button', { name: 'Read note', exact: true }).click();
	await page.screenshot({ path: `${scratch}/notebook-reading.png` });
	await center.getByRole('article', { name: 'Note reading view' }).getByRole('link', { name: 'what comes next', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('.chat-surface input[aria-label="Note title"]')?.value === 'First pilot');
	await center.getByRole('button', { name: 'Edit note', exact: true }).click();
	await center.locator('.note-links').getByRole('button', { name: 'Arrival', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('.chat-surface input[aria-label="Note title"]')?.value === 'Arrival');
	const sanitized = await page.evaluate(async () => {
		const { renderNote } = await import('/src/lib/notes/render.ts');
		const element = document.createElement('div');
		element.innerHTML = renderNote('<img src=x onerror="window.noteAttack=1"><script>window.noteAttack=1</script> [bad](javascript:alert(1)) `[[literal]]` [[First pilot|safe]]');
		return { dangerous: element.querySelectorAll('img,script,[onerror],a[href^="javascript:"]').length, links: element.querySelectorAll('a[href^="#wabi-note-"]').length, literal: element.querySelector('code')?.textContent };
	});
	assert.deepEqual(sanitized, { dangerous: 0, links: 1, literal: '[[literal]]' });
	await center.getByText('Note actions', { exact: true }).click();
	await center.getByRole('button', { name: 'Open a copy in Reader', exact: true }).click();
	await page.getByRole('button', { name: 'Return to note', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('.chat-surface input[aria-label="Note title"]')?.value === 'Arrival');

	// Reusing a deleted title requires an explicit reconnect in the real UI.
	await page.evaluate(async () => {
		const { get } = await import('/node_modules/svelte/src/store/index-client.js');
		const { notebookOwner } = await import('/src/lib/notes/scope.ts');
		const { LocalNotebook } = await import('/src/lib/notes/db.ts');
		const { openNotesSurface } = await import('/src/lib/notesWorkspace.ts');
		const owner = get(notebookOwner).owner;
		const book = new LocalNotebook(owner);
		const old = await book.create('Reused destination', 'Original');
		const source = await book.create('Reconnect fixture', '[[Reused destination]]');
		const removed = await book.setTrashed(old.id, old.revision, true);
		await book.permanentlyDelete(old.id, removed.revision);
		const replacement = await book.create('Reused destination', 'Replacement');
		const { announceNotebookChange } = await import('/src/lib/notes/editor.ts');
		announceNotebookChange(owner.scopeId);
		openNotesSurface({ scopeId: owner.scopeId, noteId: source.id });
		return { sourceId: source.id, targetId: replacement.id };
	});
	await center.getByRole('button', { name: 'Reconnect to Reused destination', exact: true }).click();
	await center.locator('.note-links').getByRole('button', { name: 'Reused destination', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('.chat-surface input[aria-label="Note title"]')?.value === 'Reused destination');
	assert.equal(await textEditor.innerText(), 'Replacement');
	await center.locator('.note-row').filter({ has: page.locator('strong', { hasText: /^Arrival$/ }) }).click();
	await page.waitForFunction(() => document.querySelector('.chat-surface input[aria-label="Note title"]')?.value === 'Arrival');
	await center.getByText('Note actions', { exact: true }).click();
	await center.getByRole('button', { name: 'Move to Trash', exact: true }).click();
	await center.getByRole('button', { name: 'Restore note', exact: true }).click();
	await center.getByRole('button', { name: 'Restore note', exact: true }).waitFor({ state: 'hidden' });
	await center.getByRole('searchbox', { name: 'Search notes', exact: true }).fill('pilot');
	await page.waitForFunction(() => document.querySelectorAll('.chat-surface .note-row').length === 2);
	assert.equal(await center.locator('.note-row').count(), 2, 'search includes titles and body');
	await center.getByRole('searchbox', { name: 'Search notes', exact: true }).fill('');
	// A delayed destructive action must not follow the selection to another note.
	await page.evaluate(async () => {
		const { LocalNotebook } = await import('/src/lib/notes/db.ts');
		const original = LocalNotebook.prototype.save;
		window.restoreNotebookSave = () => { LocalNotebook.prototype.save = original; };
		LocalNotebook.prototype.save = async function (...args) {
			await new Promise(resolve => { window.releaseNotebookSave = resolve; });
			return original.apply(this, args);
		};
	});
	await center.getByRole('textbox', { name: 'Note text', exact: true }).fill('[[First pilot|what comes next]]\nA delayed save must keep its original note identity.');
	await center.getByText('Note actions', { exact: true }).click();
	await center.getByRole('button', { name: 'Move to Trash', exact: true }).click();
	await page.waitForFunction(() => typeof window.releaseNotebookSave === 'function');
	await center.locator('.note-row').filter({ hasText: 'First pilot' }).filter({ hasNotText: 'Arrival' }).first().click();
	await page.waitForFunction(() => document.querySelector('.chat-surface input[aria-label="Note title"]')?.value === 'First pilot');
	await page.evaluate(() => { window.restoreNotebookSave(); window.releaseNotebookSave(); });
	await page.waitForFunction(() => !document.querySelector('.chat-surface input[aria-label="Note title"]')?.disabled);
	const trashStates = await page.evaluate(async () => {
		const { LocalNotebook } = await import('/src/lib/notes/db.ts');
		const { captureNotebookOwner } = await import('/src/lib/notes/scope.ts');
		return (await new LocalNotebook(await captureNotebookOwner()).list()).filter(note => ['Arrival', 'First pilot'].includes(note.title)).map(note => note.trashedAt);
	});
	assert.deepEqual(trashStates, [null, null], 'changing selection cancels pending trash instead of redirecting it');
	// Both editors point at exactly the same persistent scratchpad record.
	const scratchpad = page.getByRole('textbox', { name: 'Scratchpad text', exact: true }).first();
	await scratchpad.fill('Keep this thought beside the main workspace.');
	await page.locator('.quick-scratchpad .scratchpad-footer').getByRole('status').filter({ hasText: 'Saved on this device' }).waitFor();
	await page.getByRole('button', { name: 'Full', exact: true }).first().click();
	await page.waitForFunction(() => document.querySelector('.chat-surface [aria-label="Note text"]')?.textContent === 'Keep this thought beside the main workspace.');
	await center.getByRole('textbox', { name: 'Note text', exact: true }).fill('The full editor and scratchpad share this note.');
	await center.getByRole('status').filter({ hasText: 'Saved on this device' }).waitFor();
	await page.waitForFunction(() => document.querySelector('textarea[aria-label="Scratchpad text"]')?.value === 'The full editor and scratchpad share this note.');
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForFunction(() => document.documentElement.dataset.shell === 'mobile');
	assert.equal(await page.locator('.mobile-right-overlay').evaluate(node => getComputedStyle(node).boxShadow), 'none', 'closed mobile panel casts no shadow onto center stage');
	await center.getByRole('textbox', { name: 'Note text', exact: true }).waitFor();
	assert.ok(await center.getByRole('textbox', { name: 'Note text', exact: true }).isVisible());
	await page.screenshot({ path: `${scratch}/notebook-mobile.png` });
	await page.evaluate(async () => { (await import('/src/lib/theme/themeStore.ts')).themeStore.setThemeId('light'); });
	await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
	assert.equal(await page.locator('.mobile-right-overlay').evaluate(node => getComputedStyle(node).boxShadow), 'none', 'light theme keeps the closed sheet shadow hidden');
	await page.screenshot({ path: `${scratch}/notebook-mobile-light.png` });
	assert.deepEqual(errors, [], 'no uncaught application errors');
	console.log(`PASS: note creation, save acknowledgement, follow/backlinks, atomic alias rename, editor height, completion, safe reading view, explicit reconnect, Reader return, portable archive download, trash/restore, search, shared scratchpad Full, mobile. Screenshots: ${scratch}`);
} catch (error) {
	console.error('Notebook UI fixture:', scratch);
	if (page) {
		await page.screenshot({ path: `${scratch}/failure.png` }).catch(() => {});
		console.error(await page.locator('.chat-surface').innerText().catch(() => 'No center surface'));
		console.error(await page.evaluate(async () => {
			const { captureNotebookOwner } = await import('/src/lib/notes/scope.ts');
			const { LocalNotebook } = await import('/src/lib/notes/db.ts');
			const book = new LocalNotebook(await captureNotebookOwner());
			const notes = await book.list();
			return { notes, links: await Promise.all(notes.map(note => book.outgoing(note.id))) };
		}).catch(error => error.message));
	}
	throw error;
} finally {
	await browser?.close();
	await vite?.close();
	server.kill('SIGTERM');
	await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000); } });
	log.end();
}
