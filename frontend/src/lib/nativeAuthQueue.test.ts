import { expect, test } from 'bun:test';
import { NativeAuthQueue } from './nativeAuthQueue';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => resolve = r);
	return { promise, resolve };
}

test('logout deletes after an in-flight native write completes', async () => {
	const queue = new NativeAuthQueue();
	const write = deferred<void>(); const entered = deferred<void>();
	const calls: string[] = [];
	const save = queue.run('server-a', async () => { calls.push('write'); entered.resolve(); await write.promise; });
	await entered.promise;
	const logout = queue.run('server-a', async () => { calls.push('delete'); });
	expect(calls).toEqual(['write']);
	write.resolve(); await Promise.all([save, logout]);
	expect(calls).toEqual(['write', 'delete']);
});

test('a newer session fences bootstrap completion and skips queued older writes', async () => {
	const queue = new NativeAuthQueue();
	const read = deferred<void>(); const entered = deferred<void>();
	const calls: string[] = [];
	const bootstrap = queue.run('server-a', async current => {
		entered.resolve(); await read.promise;
		if (current()) calls.push('restore-old-account');
	});
	await entered.promise;
	const oldWrite = queue.run('server-a', async () => { calls.push('old-write'); });
	const logout = queue.run('server-a', async () => { calls.push('delete'); });
	read.resolve(); await Promise.all([bootstrap, oldWrite, logout]);
	expect(calls).toEqual(['delete']);
});

test('failed writes do not block deletion and independent servers stay independent', async () => {
	const queue = new NativeAuthQueue();
	const blocked = deferred<void>(); const entered = deferred<void>();
	const write = queue.run('server-a', async () => { entered.resolve(); await blocked.promise; throw new Error('locked store'); });
	await entered.promise;
	let otherSaved = false;
	await queue.run('server-b', async () => { otherSaved = true; });
	expect(otherSaved).toBe(true);
	let deleted = false;
	const deletion = queue.run('server-a', async () => { deleted = true; });
	blocked.resolve(); await expect(write).rejects.toThrow('locked store'); await deletion;
	expect(deleted).toBe(true);
});
