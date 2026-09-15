// Real application and isolated backend, rendered in headful Chromium.
// Desktop docks must not become unsolicited full-screen mobile overlays.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp('/tmp/wabi-embedded-identity-');
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
let browser, page;
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
	const origin = backend;
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

	const serverIdentity = await (await fetch(`${backend}/api/public/build-info`)).json();
	const clientIdentity = await (await fetch(`${backend}/wabi-client-build.json`)).json();
	assert.ok(serverIdentity.sourceRevision, 'stamped binary required');
	assert.equal(clientIdentity.sourceRevision, serverIdentity.sourceRevision);
	if (process.env.WABI_SOURCE_REVISION) assert.equal(serverIdentity.sourceRevision, process.env.WABI_SOURCE_REVISION);
	await page.locator('.workspace-trigger').waitFor({ timeout: 60000 });
	await page.locator('#wabi-boot-shell').waitFor({ state: 'detached', timeout: 60000 });
	await page.getByTitle('User Settings', { exact: true }).first().click();
	await page.getByRole('button', { name: 'About', exact: true }).click();
	const about = page.locator('.about-copy');
	await about.getByText(`Client v${clientIdentity.version}`, { exact: true }).waitFor();
	await about.getByText(`Source ${clientIdentity.sourceRevision.slice(0, 12)}`, { exact: true }).waitFor();
	await about.getByText(`Server v${serverIdentity.version} · ${serverIdentity.sourceRevision.slice(0, 12)}`, { exact: true }).waitFor();
	await page.screenshot({ path: `${scratch}/embedded-about.png` });
	assert.deepEqual(errors, [], 'embedded browser has no uncaught errors');
	console.log(`PASS embedded About client/server identity ${serverIdentity.sourceRevision}; evidence ${scratch}`);
} finally {
	await browser?.close(); server.kill('SIGTERM');
	await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000); } });
	log.end();
}
