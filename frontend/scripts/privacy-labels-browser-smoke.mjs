// Real application and isolated backend, rendered in headful Chromium.
// Verify privacy wording and the DM menu using disposable registered accounts.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { waitForAppShell } from './smoke-shell.mjs';
import { saveOpenAdmission } from './smoke-admission.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp('/tmp/wabi-privacy-ui-');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const backend = `http://127.0.0.1:${port}`;
saveOpenAdmission(`${scratch}/data`); // registers members directly; no saved policy means invite only
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
		body: JSON.stringify({ username: 'privacy_label_fixture', password: 'Local-mobile-fixture-9825!' })
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
		if (sessionStorage.getItem('privacy-fixture-seeded')) return;
		sessionStorage.setItem('privacy-fixture-seeded', '1');
		const scope = encodeURIComponent(backend);
		sessionStorage.setItem(`wabi_auth_token:${scope}`, account.accessToken);
		localStorage.setItem(`wabi_username:${scope}`, account.user.username);
		localStorage.setItem(`wabi_db_user_id:${scope}`, String(account.user.id));
		localStorage.setItem('notificationsEnabled', 'false');
	}, { backend, account });
	await page.goto(origin, { waitUntil: 'networkidle' });

    await waitForAppShell(page);
    const secondResponse = await fetch(`${backend}/api/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'privacy_fixture_peer', password: 'Local-peer-fixture-9825!' })
    });
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    const channelId = await page.evaluate(async (peer) => {
        const socket = await import('/src/lib/socket.ts');
        const result = await socket.createDM(String(peer.id));
        if (!result.ok) throw new Error(result.error);
        const other = { id: `user-${peer.id}`, dbUserId: peer.id, username: peer.username, color: '#98d8c8', status: 'offline' };
        const { layoutStore } = await import('/src/lib/layoutStore.ts');
        layoutStore.openDM(result.channelId, other);
        return result.channelId;
    }, second.user);
    // New DMs begin encryption-pending (e2639368; AGENTS.md product boundary), so the truthful label
    // for a DM whose peer has no registered device is "Encryption pending", not the old
    // "Server-readable by default". The label must agree with the Authority's own room status.
    const status = await (await fetch(`${backend}/api/e2ee/channels/${channelId}`, { headers: { Authorization: `Bearer ${account.accessToken}` } })).json();
    assert.equal(status.pendingDefault, true, 'Authority reports the new DM as encryption-pending');
    assert.equal(status.enabled, false, 'Authority has not enabled encryption before the peer has a device');
    const gate = page.locator('.dm-tab-active .dm-gate[data-gate="pending"]');
    await gate.getByText('Encryption pending', { exact: true }).waitFor();
    assert.equal(await page.locator('.dm-tab-active').getByText(/Experimental encryption|Server-readable by default/).count(), 0, 'no label claims encryption or a server-readable default the room does not have');
    await page.locator('.dm-tab-active .dm-head-title').getByText('privacy_fixture_peer', { exact: true }).waitFor();
    await page.screenshot({ path: `${scratch}/dm-privacy-desktop.png` });
    await page.getByRole('button', { name: 'Back to all DMs', exact: true }).click();
    await page.locator('.dm-tab .dm-row').filter({ hasText: 'privacy_fixture_peer' }).click({ button: 'right' });
    await page.getByText('Open conversation', { exact: true }).waitFor();
    assert.equal(await page.getByText(/Set Mode:|Privacy Mode:/).count(), 0, 'no cosmetic privacy mode controls');
    await page.getByText('Pin conversation', { exact: true }).click();
    await page.locator('.dm-tab .dm-row').filter({ hasText: 'privacy_fixture_peer' }).click({ button: 'right' });
    await page.getByText('Unpin conversation', { exact: true }).waitFor();
    await page.getByText('Open conversation', { exact: true }).click();
    // Wave 1a (ee9f7c34) moved Voice call out of the "Conversation actions" menu into an inline
    // header button; the menu keeps the remaining actions. Both must still be reachable.
    await page.locator('.dm-tab-active').getByRole('button', { name: 'Call privacy_fixture_peer', exact: true }).waitFor();
    await page.locator('.dm-tab-active').getByRole('button', { name: 'Conversation actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete conversation' }).waitFor();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${scratch}/dm-privacy-mobile.png` });
    assert.deepEqual(errors, [], 'no browser exceptions');
    console.log(`PASS actual DM creation, truthful privacy label and removal of cosmetic mode controls; evidence ${scratch}`);
} finally {
    await browser?.close(); await vite?.close(); server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000); } });
    log.end();
}
