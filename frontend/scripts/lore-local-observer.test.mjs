// Exercises the production LocalWorkspace observer with mocked I/O boundaries.
// Run: node --experimental-vm-modules --test frontend/scripts/lore-local-observer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = await readFile(new URL('../src/lib/loreLocalWorkspace.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function fixture() {
	const state = { version: 1, identity: 'identity', staged: { 'art.png': { path: 'art.png', localHash: 'selected', remoteEtag: 'base' } }, baselines: {} };
	const f = { active: true, state, scans: 0, requests: 0, calls: [], failRemote: false, failScan: false, scanWait: null, probeWait: null,
		changes: [{ path: 'art.png', kind: 'modified', localHash: 'new-save', remoteEtag: 'base' }] };
	const context = vm.createContext({ window: { __TAURI_INTERNALS__: {} } });
	async function synthetic(exports) {
		const m = new vm.SyntheticModule(Object.keys(exports), function () { for (const [k, v] of Object.entries(exports)) this.setExport(k, v); }, { context });
		await m.link(() => { throw new Error('Unexpected dependency'); }); await m.evaluate(); return m;
	}
	const api = await synthetic({
		fetchWithTimeout: async (_url, options) => {
			assert.ok(!options.method || options.method === 'GET', 'automatic checks must be GET-only');
			f.requests++; if (f.failRemote) throw new Error('offline');
			return { ok: true, status: 200 };
		},
		parseApiJson: async () => ({ files: [{ path: 'art.png', etag: 'base' }], auto_branch_on_upload: false })
	});
	const forbidden = () => { throw new Error('Detection invoked a mutation'); };
	const model = await synthetic({
		parseState: (s) => s,
		planChanges: () => ({ changes: f.changes, reconciled: { 'art.png': { localHash: 'new-save', remoteEtag: 'base' } } }),
		publishStaged: forbidden, stageChange: forbidden, keepLocal: forbidden
	});
	const native = await synthetic({ invoke: async (name, args) => {
		f.calls.push([name, args]);
		switch (name) {
			case 'lore_local_choose': return { handle: 'grant', folder: '/project', identity: 'identity', state };
			case 'lore_local_scan': f.scans++; if (f.scanWait) await f.scanWait; if (f.failScan) throw new Error('scan failed'); return { files: [], ignore: '' };
			case 'lore_local_watch_poll': if (f.probeWait) await f.probeWait; return { subscription: 'watch-1', revision: '7', quietForMs: 1000, error: null };
			case 'lore_local_watch_stop': return;
			default: throw new Error(`Unexpected native write/operation: ${name}`);
		}
	} });
	const mod = new vm.SourceTextModule(code, { context, importModuleDynamically: async (name) => {
		assert.equal(name, '@tauri-apps/api/core'); return native;
	} });
	await mod.link((name) => {
		if (name === './api/utils') return api;
		if (name === './loreLocalChanges') return model;
		throw new Error(`Unexpected import ${name}`);
	});
	await mod.evaluate();
	f.workspace = await mod.namespace.LocalWorkspace.connect('https://example.test', 225, 'account', () => f.active);
	return f;
}

test('automatic detection leaves baselines and exact staged versions unchanged', async () => {
	const f = await fixture(); const before = JSON.stringify(f.state);
	const result = await f.workspace.detect('token', true);
	assert.equal(result.changes[0].localHash, 'new-save'); assert.equal(JSON.stringify(f.state), before);
	assert.deepEqual(f.calls.map(([name]) => name), ['lore_local_choose', 'lore_local_scan']);
});
test('remote-only automatic checks reuse the latest local file scan', async () => {
	const f = await fixture(); await f.workspace.detect('token', true); await f.workspace.detect('token', false);
	assert.equal(f.scans, 1); assert.equal(f.requests, 4);
});
test('remote-only check without a cached scan performs one initial scan', async () => {
	const f = await fixture(); await f.workspace.detect('token', false); assert.equal(f.scans, 1);
});
test('offline detection uses cached manifest without modifying saved state', async () => {
	const f = await fixture(); await f.workspace.detect('token', true); f.failRemote = true;
	const before = JSON.stringify(f.state); const result = await f.workspace.detect('token', true);
	assert.equal(result.online, false); assert.match(result.notice, /last known server state/); assert.equal(JSON.stringify(f.state), before);
});
test('failed scan preserves the previous snapshot and makes no server requests', async () => {
	const f = await fixture(); const old = await f.workspace.detect('token', true); f.failScan = true;
	const requests = f.requests; await assert.rejects(f.workspace.detect('token', true), /scan failed/);
	assert.equal(f.workspace.snapshot, old); assert.equal(f.requests, requests);
});
test('account switching during a scan blocks subsequent server requests', async () => {
	const f = await fixture(); const wait = defer(); f.scanWait = wait.promise;
	const work = f.workspace.detect('token', true); f.active = false; wait.resolve();
	await assert.rejects(work, /account, server, or project changed/); assert.equal(f.requests, 0);
});
test('watcher stop is idempotent and bound to the original grant/subscription', async () => {
	const f = await fixture(); await f.workspace.probeChanges(); await f.workspace.stopWatching(); await f.workspace.stopWatching();
	const calls = f.calls.filter(([name]) => name === 'lore_local_watch_stop'); assert.equal(calls.length, 1);
	assert.equal(calls[0][1].handle, 'grant'); assert.equal(calls[0][1].subscription, 'watch-1');
});
test('late subscription after an account switch can still be cleaned up', async () => {
	const f = await fixture(); const wait = defer(); f.probeWait = wait.promise;
	const work = f.workspace.probeChanges(); f.active = false; wait.resolve();
	await assert.rejects(work, /account, server, or project changed/); await f.workspace.stopWatching();
	assert.equal(f.calls.at(-1)[0], 'lore_local_watch_stop');
});
test('inactive workspace cannot probe, scan, or contact a server', async () => {
	const f = await fixture(); f.active = false;
	await assert.rejects(f.workspace.probeChanges()); await assert.rejects(f.workspace.detect('old-token', true));
	assert.equal(f.calls.length, 1); assert.equal(f.requests, 0);
});
