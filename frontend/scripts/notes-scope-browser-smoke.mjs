// Real browser identity/session checks; isolated storage, no live accounts.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

let vite, browser;
try {
	vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { host: '127.0.0.1', port: 0, open: false }, plugins: [{
		name: 'notes-scope-fixture', configureServer(server) {
			server.middlewares.use('/favicon.ico', (_req, res) => { res.statusCode = 204; res.end(); });
			server.middlewares.use('/notes-scope-fixture', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><script>window.__SVELTEKIT_APP_VERSION__="fixture";window.__SVELTEKIT_EXPERIMENTAL_EXPLICIT_ENVIRONMENT_VARIABLES__=false;</script><title>Notes ownership test</title><p>Testing isolated notebook ownership.</p>'); });
		}
	}] });
	await vite.listen();
	const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
	browser = await chromium.launch({ headless: false, executablePath: process.env.WABI_CHROMIUM_PATH });
	const context = await browser.newContext();
	const a = await context.newPage(), b = await context.newPage();
	for (const page of [a, b]) {
		await page.goto(`${origin}/notes-scope-fixture`);
		await page.evaluate(async () => {
			window.scope = await import('/src/lib/notes/scope.ts');
			window.auth = await import('/src/lib/authSession.ts');
			window.server = await import('/src/lib/serverUrl.ts');
			window.presence = await import('/src/lib/presenceIdentity.ts');
			window.account = (endpoint, id = 17) => {
				window.auth.setStoredDbUserId(id, endpoint);
				window.auth.setAuthToken('isolated-test-token', endpoint);
				window.server.activeServerUrl.set(endpoint);
				window.presence.currentUser.set({ id: 'socket-only', dbUserId: id, isRegistered: true, username: 'Test', status: 'online', color: '#fff' });
			};
			window.unsub = window.scope.notebookOwner.subscribe(state => window.ownerState = state);
		});
	}
	const isolation = await a.evaluate(async () => {
		window.account('https://one.test/Case');
		const first = await window.scope.captureNotebookOwner();
		window.account('https://two.test/Case');
		const other = await window.scope.captureNotebookOwner();
		window.account('https://one.test/Case');
		const returned = await window.scope.captureNotebookOwner();
		window.account('https://one.test/case');
		const lower = await window.scope.captureNotebookOwner();
		return { first: first.scopeId, other: other.scopeId, returned: returned.scopeId, lower: lower.scopeId, retired: !first.isCurrent() };
	});
	assert.notEqual(isolation.first, isolation.other);
	assert.notEqual(isolation.first, isolation.lower);
	assert.equal(isolation.first, isolation.returned);
	assert.equal(isolation.retired, true, 'switch away/back permanently retires old saves');
	await a.waitForFunction(() => !!window.ownerState.owner);
	assert.equal(await a.evaluate(async () => {
		const before = window.ownerState.owner;
		window.presence.currentUser.update(user => ({ ...user, status: 'away' }));
		await Promise.resolve();
		return before === window.ownerState.owner && before.isCurrent();
	}), true, 'presence updates must preserve mounted drafts');
	assert.equal(await a.evaluate(async () => {
		window.presence.currentUser.update(user => ({ ...user, dbUserId: 99 }));
		try { await window.scope.captureNotebookOwner(); return false; } catch (error) { return error.code === 'unavailable'; }
	}), true, 'mismatched socket identity fails closed');

	for (const page of [a, b]) await page.evaluate(async () => {
		window.account('https://shared.test');
		window.captured = await window.scope.captureNotebookOwner();
	});
	await a.evaluate(() => window.auth.clearAuthSession('https://shared.test'));
	await b.waitForFunction(() => !window.auth.getAuthToken('https://shared.test'));
	assert.equal(await b.evaluate(() => window.captured.isCurrent()), false, 'other tab session token is retired by logout');
	assert.equal(await b.evaluate(async () => {
		window.account('https://shared.test');
		await window.scope.captureNotebookOwner();
		return window.captured.isCurrent();
	}), false, 'same-account login cannot revive previous session saves');

	const guest = await a.evaluate(async () => {
		window.server.activeServerUrl.set('https://guest.test');
		window.presence.currentUser.set(null);
		window.auth.setGuestSessionId('secret-guest-session-fixture', 'https://guest.test');
		const owner = await window.scope.captureNotebookOwner();
		window.auth.setGuestSessionId('another-secret-guest-session', 'https://guest.test');
		const replacement = await window.scope.captureNotebookOwner();
		return { id: owner.scopeId, next: replacement.scopeId, retired: !owner.isCurrent() };
	});
	assert.equal(guest.id.includes('secret'), false);
	assert.match(guest.id, /:guest:[a-f0-9]{64}$/);
	assert.notEqual(guest.id, guest.next);
	assert.equal(guest.retired, true);
	const offline = await a.evaluate(async () => {
		window.server.activeServerUrl.set('https://offline.test');
		window.presence.currentUser.set(null);
		let defaultRejected = false;
		try { await window.scope.captureNotebookOwner(); } catch { defaultRejected = true; }
		const first = await window.scope.chooseOfflineNotebook();
		const second = await window.scope.captureNotebookOwner();
		window.account('https://offline.test');
		const signedIn = await window.scope.captureNotebookOwner();
		return { defaultRejected, first: first.scopeId, second: second.scopeId, signedIn: signedIn.scopeId, retired: !first.isCurrent() };
	});
	assert.equal(offline.defaultRejected, true);
	assert.match(offline.first, /:offline:/);
	assert.equal(offline.first, offline.second);
	assert.notEqual(offline.first, offline.signedIn);
	assert.equal(offline.retired, true);
	assert.equal(await a.evaluate(async () => {
		window.server.activeServerUrl.set('https://blocked-offline.test');
		window.presence.currentUser.set(null);
		const write = Storage.prototype.setItem;
		Storage.prototype.setItem = function () { throw new DOMException('fixture quota', 'QuotaExceededError'); };
		try { await window.scope.chooseOfflineNotebook(); return false; }
		catch (error) { return error.code === 'unavailable'; }
		finally { Storage.prototype.setItem = write; }
	}), true, 'offline identity failure must not pretend the notebook was saved');
	console.log('PASS: Notes server/account identity, session retirement, two-window logout, guest hashing, presence stability and explicit offline scopes.');
} finally {
	await browser?.close();
	await vite?.close();
}
