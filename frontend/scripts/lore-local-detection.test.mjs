import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalDetection, DETECTION_TIMING as T } from '../src/lib/loreLocalDetection.ts';

const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
	const f = {
		time: 1000, active: true, visible: true, revision: '0', subscription: 'one', quiet: 1000,
		probeError: null, watchError: null, compareError: null, probeWait: null, compareWait: null,
		probes: 0, scans: [], reports: [], releases: 0, order: []
	};
	f.controller = new LocalDetection({
		active: () => f.active, visible: () => f.visible, now: () => f.time,
		probe: async () => {
			f.probes++; f.order.push('probe');
			if (f.probeWait) await f.probeWait;
			if (f.probeError) throw new Error(f.probeError);
			return { subscription: f.subscription, revision: f.revision, quietForMs: f.quiet, error: f.watchError };
		},
		compare: async (scan) => {
			f.scans.push(scan); f.order.push('compare-start');
			if (f.compareWait) await f.compareWait;
			if (f.compareError) throw new Error(f.compareError);
			f.order.push('compare-end');
		},
		release: async () => { f.releases++; f.order.push('release'); },
		status: (s) => f.reports.push(s)
	});
	f.tick = async (advance = 0) => { f.time += advance; await f.controller.tick(); await drain(); };
	return f;
}

test('initial check scans, later idle ticks do not rehash or fetch', async () => {
	const f = fixture(); await f.tick(); await f.tick(T.poll); await f.tick(T.poll);
	assert.deepEqual(f.scans, [true]); assert.equal(f.probes, 3);
});
test('remote checks reuse the local scan rather than hash all files', async () => {
	const f = fixture(); await f.tick(); await f.tick(T.remote);
	assert.deepEqual(f.scans, [true, false]);
});
test('a settled local save automatically triggers comparison', async () => {
	const f = fixture(); await f.tick(); f.revision = '1'; await f.tick(T.poll);
	assert.deepEqual(f.scans, [true, true]);
});
test('a burst of editor writes is debounced', async () => {
	const f = fixture(); await f.tick(); f.revision = '1'; f.quiet = 0; await f.tick(100);
	f.revision = '2'; await f.tick(100); f.revision = '3'; await f.tick(100);
	assert.deepEqual(f.scans, [true]); f.quiet = T.quiet; await f.tick(T.quiet);
	assert.deepEqual(f.scans, [true, true]);
});
test('continuous writes cannot starve the changes list forever', async () => {
	const f = fixture(); await f.tick(); f.revision = '1'; f.quiet = 0; await f.tick(1);
	f.revision = '99'; await f.tick(T.maxDebounce);
	assert.deepEqual(f.scans, [true, true]);
});
test('remote detection still runs while local saves are being debounced', async () => {
	const f = fixture(); await f.tick(); f.revision = '1'; f.quiet = 0; await f.tick(T.remote);
	assert.deepEqual(f.scans, [true, false]);
});
test('events that happen during scanning are detected on the next tick', async () => {
	const f = fixture(); await f.tick(); const wait = defer(); f.compareWait = wait.promise; f.revision = '1';
	const job = f.controller.tick(); await drain(); f.revision = '2'; wait.resolve(); await job;
	f.compareWait = null; await f.tick(T.poll); assert.deepEqual(f.scans, [true, true, true]);
});
test('no overlapping checks during a slow scan', async () => {
	const f = fixture(); const wait = defer(); f.compareWait = wait.promise;
	const first = f.controller.tick(); await drain(); await f.controller.tick(); await f.controller.tick();
	assert.equal(f.probes, 1); assert.deepEqual(f.scans, [true]); wait.resolve(); await first;
});
test('manual publishing is invoked only by an explicit manual operation', async () => {
	const f = fixture(); let published = 0; let pulled = 0;
	await f.tick(); f.revision = '2'; await f.tick(T.remote); await f.tick(T.remote);
	assert.equal(published, 0); assert.equal(pulled, 0);
	await f.controller.runManual(async () => { published++; }); assert.equal(published, 1);
	await f.controller.runManual(async () => { pulled++; }); assert.equal(pulled, 1);
});
test('manual decisions wait for automatic comparison without racing it', async () => {
	const f = fixture(); const wait = defer(); f.compareWait = wait.promise;
	const check = f.controller.tick(); await drain();
	const manual = f.controller.runManual(async () => f.order.push('manual'));
	await drain(); assert.equal(f.order.includes('manual'), false);
	wait.resolve(); await check; await manual;
	assert.ok(f.order.indexOf('manual') > f.order.indexOf('compare-end'));
});
test('automatic detection does not interrupt a manual transfer', async () => {
	const f = fixture(); const wait = defer();
	const manual = f.controller.runManual(async () => wait.promise); await drain();
	await f.tick(); assert.equal(f.probes, 0); wait.resolve(); await manual; await drain();
	await f.tick(); assert.equal(f.probes, 1);
});
test('two queued manual operations are also serialized', async () => {
	const f = fixture(); const wait = defer(); const order = [];
	const one = f.controller.runManual(async () => { order.push('one-start'); await wait.promise; order.push('one-end'); });
	const two = f.controller.runManual(async () => order.push('two'));
	await drain(); assert.deepEqual(order, ['one-start']); wait.resolve(); await one; await two;
	assert.deepEqual(order, ['one-start', 'one-end', 'two']);
});
test('a failed manual operation does not break subsequent detection', async () => {
	const f = fixture(); await assert.rejects(f.controller.runManual(async () => { throw new Error('user transfer failed'); }));
	await drain(); await f.tick(); assert.deepEqual(f.scans, [true]);
});
test('paused detection performs no checks but still permits manual decisions', async () => {
	const f = fixture(); f.controller.setPaused(true); await f.tick(T.remote);
	assert.equal(f.probes, 0); let ran = false; await f.controller.runManual(async () => { ran = true; });
	assert.equal(ran, true); assert.equal(f.reports.at(-1).paused, true);
});
test('resume forces a comparison even with the same watcher revision', async () => {
	const f = fixture(); await f.tick(); f.controller.setPaused(true); f.controller.setPaused(false); await f.tick();
	assert.deepEqual(f.scans, [true, true]);
});
test('hidden windows do no scans or server polling', async () => {
	const f = fixture(); f.visible = false; await f.tick(T.audit); assert.equal(f.probes, 0);
});
test('returning to the window triggers an immediate fresh comparison', async () => {
	const f = fixture(); await f.tick(); f.visible = false; await f.tick();
	f.visible = true; f.controller.nudge(); await f.tick(); assert.deepEqual(f.scans, [true, true]);
});
test('focus hints coalesce', async () => {
	const f = fixture(); await f.tick(); for (let i = 0; i < 20; i++) f.controller.nudge();
	await f.tick(); await f.tick(); assert.deepEqual(f.scans, [true, true]);
});
test('a focus hint during comparison is not discarded', async () => {
	const f = fixture(); const wait = defer(); f.compareWait = wait.promise;
	const job = f.controller.tick(); await drain(); f.controller.nudge(); wait.resolve(); await job;
	f.compareWait = null; await f.tick(); assert.deepEqual(f.scans, [true, true]);
});
test('watcher restarts have distinct identities even when their revision is zero', async () => {
	const f = fixture(); await f.tick(); f.subscription = 'restarted'; await f.tick(T.poll);
	assert.deepEqual(f.scans, [true, true]);
});
test('periodic safety audit catches missed filesystem notifications', async () => {
	const f = fixture(); await f.tick(); await f.tick(T.audit); assert.deepEqual(f.scans, [true, true]);
});
test('watch startup failure falls back to periodic checking rather than silence', async () => {
	const f = fixture(); f.probeError = 'watch limit reached'; await f.tick();
	assert.deepEqual(f.scans, [true]); assert.match(f.reports.at(-1).warning, /checking periodically/);
	await f.tick(T.poll); assert.equal(f.probes, 1);
	await f.tick(T.fallback); assert.deepEqual(f.scans, [true, true]);
});
test('runtime watcher error is surfaced and does not apply files', async () => {
	const f = fixture(); f.watchError = 'OS watcher failed'; await f.tick();
	assert.match(f.reports.at(-1).warning, /OS watcher failed/);
});
test('successful watcher recovery clears its warning', async () => {
	const f = fixture(); f.probeError = 'unavailable'; await f.tick(); f.probeError = null;
	await f.tick(T.fallback); assert.equal(f.reports.at(-1).warning, '');
});
test('comparison failure backs off instead of hammering disk or server', async () => {
	const f = fixture(); f.compareError = 'offline'; await f.tick(); const probes = f.probes;
	await f.tick(T.poll); assert.equal(f.probes, probes); assert.match(f.reports.at(-1).warning, /offline/);
	f.compareError = null; await f.tick(5000); assert.equal(f.reports.at(-1).warning, '');
});
test('network reconnect hint overrides error backoff', async () => {
	const f = fixture(); f.compareError = 'offline'; await f.tick(); f.compareError = null;
	f.controller.nudge(); await f.tick(); assert.deepEqual(f.scans, [true, true]);
});
test('account/project changes stop the watcher without another probe', async () => {
	const f = fixture(); await f.tick(); f.active = false; await f.tick();
	assert.equal(f.probes, 1); assert.equal(f.releases, 1);
});
test('an account switch during native probe does not start a server comparison', async () => {
	const f = fixture(); const wait = defer(); f.probeWait = wait.promise;
	const job = f.controller.tick(); await drain(); f.active = false; wait.resolve(); await job;
	assert.deepEqual(f.scans, []); await f.controller.dispose(); assert.equal(f.releases, 1);
});
test('dispose waits for late native subscription before releasing it exactly once', async () => {
	const f = fixture(); const wait = defer(); f.probeWait = wait.promise;
	const job = f.controller.tick(); await drain(); const disposal = f.controller.dispose();
	assert.equal(f.releases, 0); wait.resolve(); await job; await disposal; await f.controller.dispose();
	assert.equal(f.releases, 1); assert.deepEqual(f.scans, []);
});
test('queued manual writes cannot run after disposal', async () => {
	const f = fixture(); const wait = defer(); f.probeWait = wait.promise;
	const job = f.controller.tick(); await drain(); let wrote = false;
	const manual = f.controller.runManual(async () => { wrote = true; });
	const rejected = assert.rejects(manual, /no longer active/);
	const disposal = f.controller.dispose(); wait.resolve(); await job; await rejected; await disposal;
	assert.equal(wrote, false);
});
test('pause arriving during a native probe stops further automatic comparison', async () => {
	const f = fixture(); const wait = defer(); f.probeWait = wait.promise;
	const job = f.controller.tick(); await drain(); f.controller.setPaused(true); wait.resolve(); await job;
	assert.deepEqual(f.scans, []);
});
test('hiding during a native probe defers comparison until return', async () => {
	const f = fixture(); const wait = defer(); f.probeWait = wait.promise;
	const job = f.controller.tick(); await drain(); f.visible = false; wait.resolve(); await job;
	assert.deepEqual(f.scans, []);
});
