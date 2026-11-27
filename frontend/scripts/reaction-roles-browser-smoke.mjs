// Real application and isolated backend. The owner links an emoji on a message to a role from the
// message menu; a second account presses that emoji under the message and gets the role, then
// presses it again and gives it up.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { waitForAppShell } from './smoke-shell.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp('/tmp/wabi-reaction-roles-ui-');
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
let browser, vite;
const api = async (account, method, path, body) => {
	const response = await fetch(`${backend}/api${path}`, {
		method, headers: { 'Content-Type': 'application/json', ...(account ? { Authorization: `Bearer ${account.accessToken}` } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const text = await response.text();
	let json; try { json = JSON.parse(text); } catch { json = text; }
	assert.ok(response.ok, `${method} ${path} -> ${response.status} ${text.slice(0, 200)}`);
	return json;
};
const register = username => api(null, 'POST', '/auth/register', { username, password: 'Local-roles-fixture-9825!' });
try {
	let ready = false;
	for (let attempt = 0; attempt < 150; attempt++) {
		if (server.exitCode !== null) throw new Error(`Isolated backend exited: ${scratch}`);
		try { ready = (await fetch(`${backend}/readyz`)).ok; } catch { /* starting */ }
		if (ready) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.ok(ready, 'isolated backend ready');
	const owner = await register('roles_owner');
	const member = await register('roles_member');
	const roleId = `community-${crypto.randomUUID()}`;
	await api(owner, 'PUT', '/server-center/community-roles', {
		expectedRevision: 0, channelRoles: {},
		roles: [{ id: roleId, name: 'Banana Jammers', description: '', selfAssignable: true }]
	});
	const listed = await api(owner, 'GET', '/channels');
	const rooms = Array.isArray(listed) ? listed : listed.channels;
	const room = rooms.find(channel => (channel.type ?? channel.channel_type ?? channel.kind) === 'text' || channel.name === 'general');
	assert.ok(room, `a text room exists: ${JSON.stringify(rooms).slice(0, 300)}`);
	const roomId = room.id ?? room.channel_id;
	await api(member, 'POST', `/channels/${roomId}/join`);
	const holders = async () => (await api(owner, 'GET', '/server-center/role-holders')).holders[String(member.user.id)] ?? [];

	process.env.VITE_SOCKET_URL = backend;
	process.env.VITE_WABI_LOCAL_MOCK = '0';
	vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, open: false } });
	await vite.listen();
	const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
	browser = await chromium.launch({ headless: process.env.WABI_SMOKE_HEADLESS === '1', executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH });
	const errors = [];
	const open = async (account) => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		page.setDefaultTimeout(20000);
		page.on('pageerror', error => errors.push(error.message));
		await page.addInitScript(({ backend, account }) => {
			if (sessionStorage.getItem('roles-fixture-seeded')) return;
			sessionStorage.setItem('roles-fixture-seeded', '1');
			const scope = encodeURIComponent(backend);
			sessionStorage.setItem(`wabi_auth_token:${scope}`, account.accessToken);
			localStorage.setItem(`wabi_username:${scope}`, account.user.username);
			localStorage.setItem(`wabi_db_user_id:${scope}`, String(account.user.id));
			localStorage.setItem('notificationsEnabled', 'false');
		}, { backend, account });
		await page.goto(origin, { waitUntil: 'networkidle' });
		await waitForAppShell(page);
		await page.locator(`[data-drop-anchor="channel"][data-channel-id="${roomId}"]`).click();
		return page;
	};

	// The owner posts and links an emoji on the message to the role.
	const staff = await open(owner);
	const composer = staff.locator('textarea, [contenteditable="true"]').first();
	await composer.click();
	await staff.keyboard.type('Pick your fruit');
	await staff.keyboard.press('Enter');
	const message = staff.locator('[data-message-id]').filter({ hasText: 'Pick your fruit' }).first();
	await message.waitFor();
	const messageId = await message.getAttribute('data-message-id');
	await message.click({ button: 'right' });
	await staff.getByText('Role reactions…', { exact: true }).click();
	const dialog = staff.getByRole('dialog').filter({ hasText: 'Role reactions' });
	await dialog.getByRole('button', { name: 'Add an emoji', exact: true }).click();
	await dialog.locator('.reaction-emoji-trigger').click();
	await dialog.locator('.reaction-emoji-search input').fill('banana');
	await dialog.locator('[data-emoji-option]').first().click();
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await dialog.waitFor({ state: 'detached' });
	const chipFor = page => page.locator(`[data-message-id="${messageId}"] .reaction-btn`).filter({ hasText: 'Banana Jammers' });
	await chipFor(staff).waitFor();
	await staff.screenshot({ path: `${scratch}/role-reaction-set.png` });

	// The member sees the emoji with the role's name, presses it and has the role.
	const person = await open(member);
	assert.deepEqual(await holders(), []);
	await chipFor(person).waitFor();
	await chipFor(person).click();
	await person.getByText('You now have the role Banana Jammers').waitFor();
	assert.deepEqual(await holders(), [roleId]);
	await person.locator(`[data-message-id="${messageId}"] .reaction-btn.user-reacted`).filter({ hasText: 'Banana Jammers' }).waitFor();
	await person.screenshot({ path: `${scratch}/role-reaction-held.png` });

	// Pressing it again gives the role up.
	await chipFor(person).click();
	await person.getByText('You no longer have the role Banana Jammers').waitFor();
	assert.deepEqual(await holders(), []);
	// The emoji stays under the message for the next person.
	await chipFor(person).waitFor();
	assert.deepEqual(errors, [], 'no browser exceptions');
	console.log(`PASS role reactions: set up from the message menu, pressed to get and give up a role; evidence ${scratch}`);
} finally {
	await browser?.close(); await vite?.close(); server.kill('SIGTERM');
	await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000); } });
	log.end();
}
