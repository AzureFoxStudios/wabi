// Real headful Chromium, actual Svelte component and API helpers. Only HTTP
// responses and session/server boundaries are fixtures; no deployed accounts.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const csp = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security.csp;
const server = await createServer({
	root, configFile: false,
	resolve: { alias: { $lib: root + 'src/lib' } },
	server: { host: '127.0.0.1', port: 0, open: false, fs: { allow: [root] } },
	plugins: [svelte({ configFile: false }), {
		name: 'lore-connect-contract', enforce: 'pre',
		resolveId(id, importer) {
			if (id === '$app/environment') return '\0lore-environment';
			const resolved = id.startsWith('.') && importer ? fileURLToPath(new URL(id, `file://${importer}`)) : id;
			const entry = resolved.replace(root + 'src/lib/', '$lib/').replace(/\.ts$/, '');
			if (['$lib/serverUrl', '$lib/authSession', '$lib/api/authRefresh'].includes(entry)) return '\0lore-boundaries';
		},
		load(id) {
			if (id === '\0lore-environment') return 'export const browser=true; export const dev=true; export const building=false;';
			if (id === '\0lore-boundaries') return 'export const getServerUrl=()=>location.origin; export const normalizeServerUrl=value=>value; export const getAuthToken=()=>"fixture-access-token"; export const tryRefresh=async()=>false; export const setRefreshToken=()=>{};';
		},
		configureServer(vite) {
			vite.middlewares.use((req, res, next) => {
				if (req.url !== '/__lore_connect') return next();
				res.setHeader('Content-Type', 'text/html');
				res.setHeader('Content-Security-Policy', csp);
				res.end('<!doctype html><title>Wabi Connect credential verification</title><div id="harness"></div><script type="module" src="/test/lore-connect-browser-harness.ts"></script>');
			});
		}
	}]
});

let browser;
const pending = [];
async function waitForPending() {
	for (let n = 0; n < 1000; n++) {
		if (pending.length) return;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error('Expected API request did not arrive');
}
const record = (suffix, prefix = 'abcdef012345') => ({ tokenHash: prefix + suffix.repeat(52), tokenHashPrefix: prefix, userId: 1, scopes: 'read', createdAtMicros: 123 });
const one = record('a'), two = record('b'), minted = record('c', '123456abcdef');
const result = [];
try {
	await server.listen();
	browser = await chromium.launch({ headless: false });
	const page = await browser.newPage();
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	const send = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
	let handler = route => new Promise(resolve => pending.push(() => resolve(send(route, 503, { error: 'Token service unavailable' }))));
	await page.route('**/api/addons/lore/**', route => handler(route));
	await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__lore_connect`);
	await page.waitForFunction(() => !!window.__loreConnect);
	await page.locator('#open-connect').click();
	await page.getByText('Loading tokens…', { exact: true }).waitFor();
	await waitForPending();
	pending.shift()();
	await page.getByRole('alert').filter({ hasText: 'Token service unavailable' }).waitFor();
	assert.equal(await page.getByText('No connect tokens.', { exact: true }).count(), 0);
	handler = route => send(route, 200, {});
	await page.getByRole('button', { name: 'Retry loading tokens' }).click();
	await page.getByRole('alert').filter({ hasText: 'invalid token list' }).waitFor();
	handler = route => send(route, 200, { tokens: [one, two] });
	await page.getByRole('button', { name: 'Retry loading tokens' }).click();
	await page.waitForFunction(() => document.querySelectorAll('.lore-connect-token-row').length === 2);
	result.push('loading, HTTP failure, malformed response and retry are distinct from an empty list');

	const deleted = [];
	handler = route => {
		assert.equal(route.request().method(), 'DELETE');
		deleted.push(route.request().url().split('/').at(-1));
		return send(route, 403, { error: 'Revocation denied' });
	};
	await page.getByRole('button', { name: 'Revoke token abcdef012345', exact: true }).first().click();
	await page.getByRole('alert').filter({ hasText: 'Revocation denied' }).waitFor();
	assert.equal(await page.locator('.lore-connect-token-row').count(), 2);
	assert.equal(deleted[0], one.tokenHash);
	handler = route => route.request().method() === 'DELETE' ? send(route, 200, { status: 'ok' }) : send(route, 200, { tokens: [two] });
	await page.getByRole('button', { name: 'Revoke token abcdef012345', exact: true }).first().click();
	await page.getByRole('status').filter({ hasText: 'Token revoked.' }).waitFor();
	await page.waitForFunction(() => document.querySelectorAll('.lore-connect-token-row').length === 1);
	result.push('failed revocation preserves rows; colliding display prefixes use exact revocation identifiers');

	handler = route => {
		if (route.request().method() === 'POST') {
			assert.equal(route.request().postDataJSON().scopes, 'read');
			return send(route, 200, { ...minted, token: 'wblore_' + 'c'.repeat(64) });
		}
		return send(route, 200, { tokens: [two, minted] });
	};
	await page.getByRole('combobox', { name: 'Token scope' }).selectOption('read');
	await page.getByRole('button', { name: 'Mint', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('#lore-connect-token')?.value.startsWith('wblore_'));
	handler = route => route.request().method() === 'DELETE' ? send(route, 200, { status: 'ok' }) : send(route, 200, { tokens: [two] });
	await page.getByRole('button', { name: 'Revoke token 123456abcdef', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('#lore-connect-token')?.value === '');
	result.push('read-only mint uses selected scope; revoking the displayed token clears its plaintext');

	// Delay a request in repository 101 while switching the mounted component.
	await page.getByRole('button', { name: 'Close connect panel' }).click();
	handler = route => new Promise(resolve => pending.push(() => resolve(send(route, 200, { tokens: [one] }))));
	await page.locator('#open-connect').click();
	await page.getByText('Loading tokens…', { exact: true }).waitFor();
	await waitForPending();
	handler = route => send(route, 200, { tokens: [minted] });
	await page.evaluate(() => window.__loreConnect.selectChannel('ch_66'));
	await page.getByRole('button', { name: 'Revoke token 123456abcdef', exact: true }).waitFor();
	pending.shift()();
	await page.waitForTimeout(100);
	assert.equal(await page.getByRole('button', { name: 'Revoke token abcdef012345', exact: true }).count(), 0);
	assert.equal(await page.getByLabel('Channel ID', { exact: true }).inputValue(), 'ch_66');
	handler = route => new Promise(resolve => pending.push(() => resolve(send(route, 200, { ...one, token: 'wblore_' + 'a'.repeat(64) }))));
	await page.getByRole('button', { name: 'Mint', exact: true }).click();
	await waitForPending();
	handler = route => send(route, 200, { tokens: [] });
	await page.evaluate(() => window.__loreConnect.selectChannel('ch_67'));
	await page.getByText('No connect tokens.', { exact: true }).waitFor();
	pending.shift()();
	await page.waitForTimeout(100);
	assert.equal(await page.locator('#lore-connect-token').inputValue(), '');
	result.push('late token lists and minted secrets cannot cross repository changes');
	assert.equal(await page.locator('.lore-connect-cmd-code').nth(1).textContent(), "wabi-sync link ch_67 ~/code/'Test project'");
	handler = route => new Promise(resolve => pending.push(() => resolve(send(route, 200, { ...one, token: 'wblore_' + 'a'.repeat(64) }))));
	await page.getByRole('button', { name: 'Mint', exact: true }).click();
	await waitForPending();
	await page.getByRole('button', { name: 'Close connect panel' }).click();
	pending.shift()();
	handler = route => send(route, 200, { tokens: [] });
	await page.locator('#open-connect').click();
	await page.getByText('No connect tokens.', { exact: true }).waitFor();
	assert.equal(await page.locator('#lore-connect-token').inputValue(), '');
	result.push('closing during mint never restores plaintext into a reopened panel');

	await page.getByRole('dialog').focus();
	await page.keyboard.press('Shift+Tab');
	assert.equal(await page.evaluate(() => document.activeElement === [...document.querySelectorAll('[role=dialog] button')].at(-1)), true);
	await page.keyboard.press('Tab');
	assert.equal(await page.getByRole('button', { name: 'Close connect panel' }).evaluate(el => el === document.activeElement), true);
	await page.keyboard.press('Escape');
	await page.getByRole('dialog').waitFor({ state: 'detached' });
	assert.equal(await page.locator('#open-connect').evaluate(el => el === document.activeElement), true);
	let invalidChannelRequests = 0;
	handler = route => { invalidChannelRequests++; return send(route, 200, { tokens: [] }); };
	await page.evaluate(() => window.__loreConnect.selectChannel('invalid'));
	await page.getByRole('alert').filter({ hasText: 'Open a connected channel' }).waitFor();
	assert.equal(invalidChannelRequests, 0, 'an unrelated repoId must never stand in for a channel ID');
	result.push('keyboard focus stays in the dialog and restores on close; invalid channel IDs fail locally');
	assert.deepEqual(errors, []);
	await page.screenshot({ path: '/tmp/wabi-lore-connect-contract.png' });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: '/tmp/wabi-lore-connect-narrow.png' });
	assert.equal(await page.locator('.lore-connect-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'credential controls fit the narrow panel');
	console.log(JSON.stringify({ status: 'passed', checks: result }, null, 2));
} finally {
	for (const resolve of pending) resolve();
	await browser?.close();
	await server.close();
}
