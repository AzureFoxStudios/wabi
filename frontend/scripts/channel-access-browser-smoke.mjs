// Headful browser wiring check: real workspace stores/API helpers, fixture
// HTTP/session boundaries, and the desktop CSP. Not a live-server UI sign-off.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const csp = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security.csp;
const server = await createServer({
	root, configFile: false, resolve: { alias: { $lib: root + 'src/lib' } },
	server: { host: '127.0.0.1', port: 0, open: false, fs: { allow: [root] } },
	plugins: [{
		name: 'channel-access-contract', enforce: 'pre',
		resolveId(id, importer) {
			if (id === '$app/environment') return '\0channel-environment';
			const resolved = id.startsWith('.') && importer ? fileURLToPath(new URL(id, `file://${importer}`)) : id;
			const entry = resolved.replace(root + 'src/lib/', '$lib/').replace(/\.ts$/, '');
			if (['$lib/serverUrl', '$lib/authSession', '$lib/api/authRefresh'].includes(entry)) return '\0channel-boundaries';
			if (entry === '$lib/socket') return '\0channel-users';
			if (entry === '$lib/socketConnection') return '\0channel-socket';
			if (entry === '$lib/wabidb') return '\0channel-offline';
			if (entry === '$lib/api') return '\0channel-admin-api';
		},
		load(id) {
			if (id === '\0channel-environment') return 'export const browser=true; export const dev=true; export const building=false;';
			if (id === '\0channel-boundaries') return 'export const getServerUrl=()=>location.origin; export const normalizeServerUrl=value=>value; export const getAuthToken=()=>"fixture-access-token"; export const tryRefresh=async()=>false; export const setRefreshToken=()=>{};';
			if (id === '\0channel-users') return 'import { writable } from "svelte/store"; export const users=writable([]);';
			if (id === '\0channel-socket') return 'import { writable } from "svelte/store"; window.__fixtureSocket={id:"first",connected:true,emits:[],emit(...args){this.emits.push(args);}}; export const getSocket=()=>window.__fixtureSocket; export const socket=writable(window.__fixtureSocket); export const connected=writable(true);';
			if (id === '\0channel-offline') return 'export const getWabiDB=()=>null;';
			if (id === '\0channel-admin-api') return 'export const createChannelApi=()=>{throw Error("unused");}; export const deleteChannelApi=createChannelApi;';
		},
		configureServer(vite) {
			vite.middlewares.use((req, res, next) => {
				if (req.url !== '/__channel_access') return next();
				res.setHeader('Content-Type', 'text/html');
				res.setHeader('Content-Security-Policy', csp);
				res.end('<!doctype html><title>Wabi channel authorization verification</title><p>Workspace API contract harness</p><script type="module" src="/test/channel-access-browser-harness.ts"></script>');
			});
		}
	}]
});

let browser;
try {
	await server.listen();
	browser = await chromium.launch({ headless: false });
	const page = await browser.newPage();
	const errors = [], requests = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.route('**/api/**', async route => {
		const req = route.request(), path = new URL(req.url()).pathname;
		if (!path.startsWith('/api/')) return route.continue(); // Vite source modules also live in src/lib/api.
		requests.push(path);
		assert.equal(req.headers().authorization, 'Bearer fixture-access-token');
		const send = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
		if (path.endsWith('/join')) {
			const channel = path.split('/').at(-2);
			if (channel === 'denied') return send(403, { error: 'Conversation membership required' });
			if (channel === 'stale') await page.evaluate(() => { window.__fixtureSocket.id = 'replacement'; });
			return send(200, { joined: true, channelId: channel });
		}
		if (path === '/api/wiki/wiki/pages') return send(200, { pages: [{ pageId: 'p', channelId: 'wiki', title: 'Authorized page', body: 'canary' }] });
		if (path === '/api/albums') return send(200, { albums: [{ id: 'alb_1', scope_type: 'channel', scope_id: 'gallery', name: 'Authorized album' }] });
		throw new Error(`Unexpected request: ${path}`);
	});
	await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__channel_access`);
	await page.waitForFunction(() => !!window.__channelAccess);
	const result = await page.evaluate(() => window.__channelAccess.run());
	assert.equal(result.wiki[0].title, 'Authorized page');
	assert.equal(result.wikiError, null);
	assert.equal(result.forumError, 'Conversation membership required');
	assert.deepEqual(result.forum, []);
	assert.equal(result.albums[0].name, 'Authorized album');
	assert.deepEqual(requests, ['/api/channels/wiki/join', '/api/wiki/wiki/pages',
		'/api/channels/denied/join', '/api/channels/gallery/join', '/api/albums']);
	await page.evaluate(() => window.__channelAccess.join('room'));
	assert.deepEqual(await page.evaluate(() => window.__fixtureSocket.emits), [['join-channel', 'room']]);
	await page.evaluate(() => window.__channelAccess.join('stale'));
	assert.deepEqual(await page.evaluate(() => window.__fixtureSocket.emits), [['join-channel', 'room']]);
	await page.evaluate(() => { window.__fixtureSocket.id = undefined; window.__fixtureSocket.connected = false; });
	await page.evaluate(() => window.__channelAccess.join('before-connect'));
	assert.deepEqual(await page.evaluate(() => window.__fixtureSocket.emits), [['join-channel', 'room'], ['join-channel', 'before-connect']]);
	assert.deepEqual(errors, []);
	console.log('PASS: actual wiki/forum/album and channelStore wiring waits for membership, authenticates reads, surfaces denial, rejects replaced socket generations and retains pre-connect DM joins under desktop CSP in headful Chromium.');
} finally {
	await browser?.close();
	await server.close();
}
