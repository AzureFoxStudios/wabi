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
const scratch = await mkdtemp('/tmp/wabi-planner-ui-');
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
		if (sessionStorage.getItem('planner-fixture-seeded')) return;
		sessionStorage.setItem('planner-fixture-seeded', '1');
		localStorage.setItem('business_data', '{broken older planner bytes');
		const scope = encodeURIComponent(backend);
		sessionStorage.setItem(`wabi_auth_token:${scope}`, account.accessToken);
		localStorage.setItem(`wabi_username:${scope}`, account.user.username);
		localStorage.setItem(`wabi_db_user_id:${scope}`, String(account.user.id));
		localStorage.setItem('notificationsEnabled', 'false');
	}, { backend, account });
	await page.goto(origin, { waitUntil: 'networkidle' });

	async function openPlanner() {
		await page.locator('.workspace-trigger').waitFor({ timeout: 60000 });
		await page.locator('.workspace-trigger').click();
		await page.getByRole('dialog', { name: 'Choose workspace' }).getByRole('button', { name: 'Planner', exact: true }).click();
		await page.locator('.chat-surface .planner-account .planner-surface').waitFor();
	}
	await openPlanner();
	const center = page.locator('.chat-surface .planner-account');
	await center.getByRole('button', { name: 'Add calendar event', exact: true }).click();
	await page.getByPlaceholder('Event title', { exact: true }).fill('Account A appointment');
	await page.getByRole('button', { name: 'Create Event', exact: true }).click();
	await page.waitForFunction(async () => !(await import('/src/lib/business/deviceStorage.ts')).capturePlannerSession().session.dirty);
	const original = await page.evaluate(async () => (await import('/src/lib/business/snapshot.ts')).getBusinessDataSnapshot());
	assert.equal(original.calendarEvents.length, 1);
	assert.equal(original.calendarEvents[0].title, 'Account A appointment');
	assert.equal(await page.evaluate(() => localStorage.getItem('business_data')), '{broken older planner bytes');
	await page.screenshot({ path: `${scratch}/planner-desktop.png` });
	// A real export can be re-imported without losing or duplicating work.
	await center.locator('input[type=file]').setInputFiles({ name: 'own.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...original, version: '1.0', exportedAt: new Date().toISOString() })) });
	await page.getByText(/Added 0 items/).waitFor();
	await center.locator('input[type=file]').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
	await page.getByText(/Missing or invalid todos/).waitFor();
	assert.equal(await page.evaluate(async () => (await import('/src/lib/business/snapshot.ts')).getBusinessDataSnapshot().calendarEvents.length), 1);
	const responseB = await fetch(`${backend}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'planner_second_account', password: 'Local-second-fixture-9825!' }) });
	assert.equal(responseB.status, 200);
	const accountB = await responseB.json();
	async function switchAccount(next) {
		await page.evaluate(async ({ next, backend }) => {
			const auth = await import('/src/lib/authSession.ts');
			auth.clearAuthSession(backend);
			auth.setAuthToken(next.accessToken, backend);
			auth.setStoredDbUserId(next.user.id, backend);
			auth.setStoredUsername(next.user.username, backend);
		}, { next, backend });
		await page.reload({ waitUntil: 'domcontentloaded' });
		await openPlanner();
	}
	await switchAccount(accountB);
	assert.equal(await page.evaluate(async () => (await import('/src/lib/business/snapshot.ts')).getBusinessDataSnapshot().calendarEvents.length), 0, 'account B cannot read A');
	await switchAccount(account);
	assert.equal(await page.evaluate(async () => (await import('/src/lib/business/snapshot.ts')).getBusinessDataSnapshot().calendarEvents[0]?.title), 'Account A appointment', 'A returns to its original saved state');
	const seriesStart = await page.evaluate(async () => {
		const store = await import('/src/lib/business/store.ts');
		const start = new Date(); start.setDate(start.getDate() - 7); start.setHours(9, 0, 0, 0);
		store.addCalendarEvent({ title: 'Weekly review', startDate: start.getTime(), allDay: false, createdBy: 'fixture', recurring: { frequency: 'weekly', interval: 1 } });
		await (await import('/src/lib/business/deviceStorage.ts')).flushBusinessStorage();
		return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
	});
	await page.waitForFunction(() => document.querySelectorAll('.chat-surface button[aria-label="Edit event Weekly review"]').length >= 2);
	await center.getByRole('button', { name: 'Edit event Weekly review', exact: true }).last().click();
	await page.getByRole('heading', { name: 'Edit recurring series' }).waitFor();
	assert.equal(await page.locator('#startDate').inputValue(), seriesStart, 'occurrence edits keep the original series start');
	await page.getByRole('button', { name: 'Close event editor', exact: true }).click();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: `${scratch}/planner-mobile.png` });
	assert.deepEqual(errors, [], 'no browser exceptions');
	console.log(`PASS Planner UI create/save/import/reject/account isolation/recurrence series; evidence ${scratch}`);
} finally {
	await browser?.close(); await vite?.close(); server.kill('SIGTERM');
	await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000); } });
	log.end();
}
