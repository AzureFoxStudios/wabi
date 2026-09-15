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
const scratch = await mkdtemp('/tmp/wabi-profile-popout-');
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
 const subjectResponse = await fetch(`${backend}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'profile_subject', password: 'Local-profile-fixture-9825!' }) });
 assert.equal(subjectResponse.status, 200);
 const subject = (await subjectResponse.json()).user;
	process.env.VITE_SOCKET_URL = backend;
	process.env.VITE_WABI_LOCAL_MOCK = '0';
	vite = await createServer({ root, plugins: [{ name: 'profile-mount-fixture', resolveId(id) { if (id === 'virtual:profile-smoke') return '\0profile-smoke'; }, load(id) { if (id === '\0profile-smoke') return "export { mount, unmount } from 'svelte';"; } }], server: { host: '127.0.0.1', port: 0, open: false } });
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
 await page.evaluate(async subject => {
  const { mount, unmount } = await import('/@id/__x00__profile-smoke');
  const { default: Profile } = await import('/src/lib/components/UserPopoutImpl.svelte');
  const anchor = document.createElement('button'); anchor.textContent = 'Profile test anchor'; anchor.style.cssText = 'position:fixed;top:90px;left:500px'; document.body.append(anchor);
  const target = document.createElement('div'); document.body.append(target);
  window.openTestProfile = async (stable = true) => {
   if (window.profileFixture) await unmount(window.profileFixture);
   window.profileFixture = mount(Profile, { target, props: { user: { id: `user-${subject.id}`, username: subject.username, dbUserId: stable ? subject.id : undefined, color: '#999', status: 'offline', isRegistered: stable }, isOpen: true, isOwnProfile: false, anchorElement: anchor } });
  };
  window.subjectId = String(subject.id);
  await window.openTestProfile();
 }, subject);
 const popout = page.getByRole('dialog', { name: 'User profile' });
 const input = popout.getByRole('textbox', { name: 'Personal note', exact: true });
 const noteSection = popout.locator('.section').filter({ has: page.locator('textarea[aria-label="Personal note"]') });
 await input.waitFor();
 await page.waitForFunction(() => !document.querySelector('textarea[aria-label="Personal note"]').disabled);
 await input.fill('Remember the pilot feedback.');
 await popout.getByRole('button', { name: 'Save', exact: true }).click();
 await popout.getByRole('status').filter({ hasText: 'Saved on this device.' }).waitFor();
 assert.equal(await page.evaluate(async () => {
  const { captureNotebookOwner } = await import('/src/lib/notes/scope.ts');
  const { getUserNote } = await import('/src/lib/userNotes.ts');
  return (await getUserNote(await captureNotebookOwner(), window.subjectId)).text;
 }), 'Remember the pilot feedback.');
 await input.evaluate(element => element.scrollIntoView({ block: 'center' }));
 await page.screenshot({ path: `${scratch}/profile-saved.png` });
 await page.evaluate(() => window.openTestProfile());
 await page.waitForFunction(() => document.querySelector('textarea[aria-label="Personal note"]')?.value === 'Remember the pilot feedback.');
 assert.equal(await popout.count(), 1, 'one actual mounted popout after reopening');
 await noteSection.getByRole('button', { name: 'Clear', exact: true }).click();
 await popout.getByRole('status').filter({ hasText: 'Saved on this device.' }).waitFor();
 await page.evaluate(() => window.openTestProfile());
 await page.waitForFunction(() => !document.querySelector('textarea[aria-label="Personal note"]').disabled);
 assert.equal(await input.inputValue(), '');
 await page.evaluate(async () => {
  const { openNotebookDatabase } = await import('/src/lib/notes/db.ts');
  const db = await openNotebookDatabase(); window.profileDb = db; window.realTransaction = db.transaction.bind(db);
  db.transaction = (...args) => { const tx = window.realTransaction(...args); if (args[0] === 'profileNotes' && args[1] === 'readwrite') queueMicrotask(() => tx.abort()); return tx; };
 });
 await input.fill('Failed writing stays visible.');
 await popout.getByRole('button', { name: 'Save', exact: true }).click();
 await popout.getByRole('status').filter({ hasText: /could not be saved|abort|interrupted/i }).waitFor();
 assert.equal(await input.inputValue(), 'Failed writing stays visible.');
 await input.evaluate(element => element.scrollIntoView({ block: 'center' }));
 await page.screenshot({ path: `${scratch}/profile-save-failed.png` });
 await page.evaluate(async () => { window.profileDb.transaction = () => { throw new Error('Storage temporarily unavailable'); }; await window.openTestProfile(); });
 await popout.getByRole('status').filter({ hasText: 'Storage temporarily unavailable' }).waitFor();
 assert.equal(await input.inputValue(), 'Failed writing stays visible.');
 assert.equal(await popout.getByRole('button', { name: 'Download draft', exact: true }).isEnabled(), true);
 await page.evaluate(async () => { window.profileDb.transaction = window.realTransaction; await window.openTestProfile(); });
 await page.waitForFunction(() => document.querySelector('textarea[aria-label="Personal note"]')?.value === 'Failed writing stays visible.');
 await popout.getByRole('button', { name: 'Save', exact: true }).click();
 await popout.getByRole('status').filter({ hasText: 'Saved on this device.' }).waitFor();
 await page.evaluate(() => window.openTestProfile(false));
 await popout.getByRole('status').filter({ hasText: 'stable account identity' }).waitFor();
 assert.equal(await input.isDisabled(), true);
 await page.screenshot({ path: `${scratch}/profile-no-stable-identity.png` });
 assert.deepEqual(errors, [], 'no page errors');
 console.log(`PASS: real profile UI save/readback/reopen/clear, failed save and retained draft, missing stable subject. Evidence ${scratch}`);
} catch (error) {
 console.error(`Profile smoke failed; evidence ${scratch}`);
 await page?.screenshot({ path: `${scratch}/failure.png` }).catch(() => {});
 console.error(await page?.getByRole('dialog', { name: 'User profile' }).innerText().catch(() => 'No profile dialog'));
 throw error;
} finally {
 await browser?.close(); await vite?.close(); server.kill('SIGTERM');
 await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000); } });
 log.end();
}
