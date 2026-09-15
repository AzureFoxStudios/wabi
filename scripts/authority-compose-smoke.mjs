// Fresh bind-mounted Compose pilot. All resources belong to a unique temp project.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const option = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const runtime = option('--runtime', 'docker');
assert.ok(['docker', 'podman'].includes(runtime), 'runtime must be docker or podman');
const image = option('--image');
assert.ok(image, 'Usage: node scripts/authority-compose-smoke.mjs --runtime docker|podman --image candidate-image');
const scratch = await mkdtemp('/tmp/wabi-compose-pilot-');
await chmod(scratch, 0o700);
const project = `wabi-pilot-${scratch.split('-').at(-1).toLowerCase()}`;
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const env = Object.fromEntries(['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
// Deployment env files and WABI_* values are intentionally absent.
const run = (args, required = true) => {
	const result = spawnSync(runtime, args, { cwd: scratch, env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
	if (required) assert.equal(result.status, 0, `${runtime} ${args[0]} failed: ${result.error?.message || result.stderr}`);
	return result.stdout || result.stderr || '';
};
const compose = (...args) => run(['compose', '-p', project, '-f', `${scratch}/compose.json`, ...args]);
await writeFile(`${scratch}/source.yml`, await readFile(fileURLToPath(new URL('../docker-compose.yml', import.meta.url))), { mode: 0o600 });
// Resolve the real service definitions without reading any operator .env file.
const config = JSON.parse(run(['compose', '-p', project, '-f', `${scratch}/source.yml`, 'config', '--format', 'json']));
config.services = Object.fromEntries(['wabi-storage-init', 'wabi-server'].map(name => {
	const service = config.services[name];
	assert.ok(service, `canonical ${name} service exists`);
	delete service.build;
	service.image = image;
	service.container_name = `${project}-${name}`;
	if (name === 'wabi-server') {
		service.ports = [{ target: 3000, published: String(port), host_ip: '127.0.0.1', protocol: 'tcp' }];
		service.restart = 'no';
	}
	return [name, service];
}));
await writeFile(`${scratch}/compose.json`, JSON.stringify(config, null, 2), { mode: 0o600 });
const origin = `http://127.0.0.1:${port}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready() {
	for (let attempt = 0; attempt < 300; attempt++) {
		try { if ((await fetch(`${origin}/readyz`)).ok) return; } catch { /* Starting. */ }
		await pause(200);
	}
	throw new Error('Compose Authority did not become ready');
}
async function api(path, method = 'GET', body, token) {
	const response = await fetch(origin + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
	assert.ok(response.ok, `${method} ${path}: ${response.status}`);
	return response.json();
}
try {
	compose('up', '-d', '--no-build');
	await ready();
	const html = await (await fetch(origin)).text();
	assert.ok(/^<!doctype html/i.test(html), 'embedded SPA served');
	const asset = html.match(/(?:src|href)="([^" ]+\.(?:js|css))"/)?.[1];
	assert.ok(asset, 'embedded SPA references assets');
	const assetResponse = await fetch(new URL(asset, origin));
	assert.ok(assetResponse.ok, 'embedded asset exists');
	assert.match(assetResponse.headers.get('content-type') || '', /css|javascript/, 'asset is not an HTML fallback');
	const account = await api('/api/auth/register', 'POST', { username: 'compose_fixture', password: 'Disposable-Compose-Fixture-2026!' });
	const me = await api('/api/user/me', 'GET', undefined, account.accessToken);
	assert.equal(me.isOwner, true);
	const channel = await api('/api/channels', 'POST', { name: 'compose-pilot', channel_type: 'text' }, account.accessToken);
	await api(`/api/channels/${channel.id}/retention`, 'PUT', { retention: 'forever' }, account.accessToken);
	await api('/api/messages', 'POST', { channel_id: channel.id, content: 'Persists across container restart', message_type: 'text' }, account.accessToken);
	compose('restart', 'wabi-server');
	await ready();
	const restored = await api('/api/user/me', 'GET', undefined, account.accessToken);
	assert.equal(restored.userId, me.userId); assert.equal(restored.isOwner, true);
	const result = await api(`/api/messages/${channel.id}`, 'GET', undefined, account.accessToken);
	assert.ok(result.messages.some(message => message.content === 'Persists across container restart'));
	let rendered = false;
	if (process.env.WABI_SMOKE_CHROMIUM_PATH) {
		const { chromium } = await import('../frontend/node_modules/playwright/index.mjs');
		const browser = await chromium.launch({ headless: false, executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH });
		try {
			const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
			const errors = []; page.on('pageerror', error => errors.push(error.message));
			await page.addInitScript(({ origin, account }) => {
				const scope = encodeURIComponent(origin);
				sessionStorage.setItem(`wabi_auth_token:${scope}`, account.accessToken);
				localStorage.setItem(`wabi_username:${scope}`, account.user.username);
				localStorage.setItem(`wabi_db_user_id:${scope}`, String(account.user.id));
				localStorage.setItem('notificationsEnabled', 'false');
			}, { origin, account });
			await page.goto(origin, { waitUntil: 'networkidle' });
			await page.locator('.workspace-trigger').waitFor({ timeout: 60000 });
			await page.locator('.workspace-trigger').click();
			await page.getByRole('dialog', { name: 'Choose workspace' }).getByRole('button', { name: 'Notes', exact: true }).click();
			await page.locator('.chat-surface .notes-workspace').waitFor();
			await page.locator('#wabi-boot-shell').waitFor({ state: 'detached', timeout: 30000 });
			await page.screenshot({ path: `${scratch}/embedded-workspace.png` });
			assert.deepEqual(errors, [], 'embedded frontend runtime errors');
			rendered = true;
		} finally { await browser.close(); }
	}
	const identity = run(['image', 'inspect', image, '--format', '{{.Id}}']).trim();
	await writeFile(`${scratch}/report.json`, JSON.stringify({ status: 'passed', runtime, image, identity, project, embeddedSpa: true, headfulWorkspace: rendered, firstOwner: true, restartWithOriginalToken: true, persistedMessage: true, completedAt: new Date().toISOString(), limits: ['Local container engine only', 'Optional profiles disabled', 'No independent clean host or production data'] }, null, 2), { mode: 0o600 });
	console.log(`PASS: fresh ${runtime} Compose install and restart; report ${scratch}/report.json`);
} finally {
	await writeFile(`${scratch}/container.log`, run(['compose', '-p', project, '-f', `${scratch}/compose.json`, 'logs', '--no-color'], false), { mode: 0o600 });
	run(['compose', '-p', project, '-f', `${scratch}/compose.json`, 'down'], false);
}
