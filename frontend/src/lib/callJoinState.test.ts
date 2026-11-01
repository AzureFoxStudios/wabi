import { describe, expect, it } from 'bun:test';
import { get } from 'svelte/store';
import { CallJoinOfflineError, createCallJoinTracker, joinFailureText } from './callJoinState';

/**
 * Join / Listen pending and failure states (design contract §8.5, critique voice#15): a click that
 * fails must leave a visible, retryable state where it happened, never only a console line.
 */

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('createCallJoinTracker', () => {
	it('reads joining while the join runs and clears on success', async () => {
		const tracker = createCallJoinTracker();
		const join = deferred();
		const done = tracker.run('lounge', 'join', () => join.promise);
		expect(get(tracker.attempts).lounge).toEqual({ mode: 'join', status: 'joining' });
		join.resolve();
		expect(await done).toBe(true);
		expect(get(tracker.attempts).lounge).toBeUndefined();
	});

	it('ignores a second click while the same room is joining', async () => {
		const tracker = createCallJoinTracker();
		const join = deferred();
		let starts = 0;
		const first = tracker.run('lounge', 'listen', () => {
			starts++;
			return join.promise;
		});
		expect(await tracker.run('lounge', 'join', async () => void starts++)).toBe(false);
		expect(starts).toBe(1);
		expect(get(tracker.attempts).lounge).toEqual({ mode: 'listen', status: 'joining' });
		join.resolve();
		await first;
	});

	it('keeps a failure with a plain cause, logs the raw error, and lets Retry run again', async () => {
		const logged: unknown[] = [];
		const tracker = createCallJoinTracker((_id, error) => logged.push(error));
		const raw = new Error('ICE gathering timed out');
		expect(await tracker.run('lounge', 'join', () => Promise.reject(raw))).toBe(false);
		expect(get(tracker.attempts).lounge).toEqual({ mode: 'join', status: 'failed', failure: 'failed' });
		expect(logged).toEqual([raw]);
		expect(await tracker.run('lounge', 'join', () => Promise.resolve())).toBe(true);
		expect(get(tracker.attempts).lounge).toBeUndefined();
	});

	it('names a missing server connection as offline', async () => {
		const tracker = createCallJoinTracker();
		await tracker.run('cowork', 'listen', () => Promise.reject(new CallJoinOfflineError()));
		expect(get(tracker.attempts).cowork).toEqual({ mode: 'listen', status: 'failed', failure: 'offline' });
	});

	it('clears silently when the join is cancelled (AbortError)', async () => {
		const logged: unknown[] = [];
		const tracker = createCallJoinTracker((_id, error) => logged.push(error));
		await tracker.run('lounge', 'join', () => Promise.reject(new DOMException('cancelled', 'AbortError')));
		expect(get(tracker.attempts).lounge).toBeUndefined();
		expect(logged).toEqual([]);
	});

	it('dismiss closes a failure, and a dismissed run never writes back', async () => {
		const tracker = createCallJoinTracker();
		await tracker.run('lounge', 'join', () => Promise.reject(new Error('x')));
		tracker.dismiss('lounge');
		expect(get(tracker.attempts).lounge).toBeUndefined();

		const join = deferred();
		const pending = tracker.run('cowork', 'join', () => join.promise);
		tracker.dismiss('cowork');
		join.reject(new Error('late'));
		expect(await pending).toBe(false);
		expect(get(tracker.attempts).cowork).toBeUndefined();
	});

	it('tracks rooms independently', async () => {
		const tracker = createCallJoinTracker();
		const join = deferred();
		const lounge = tracker.run('lounge', 'join', () => join.promise);
		await tracker.run('cowork', 'listen', () => Promise.reject(new Error('x')));
		expect(Object.keys(get(tracker.attempts)).sort()).toEqual(['cowork', 'lounge']);
		join.resolve();
		await lounge;
		expect(Object.keys(get(tracker.attempts))).toEqual(['cowork']);
	});
});

describe('joinFailureText', () => {
	it('says the cause and what is unchanged, never the raw error', () => {
		expect(joinFailureText('offline', false)).toMatch(/not connected to the server/);
		expect(joinFailureText('failed', true)).toMatch(/other calls are unchanged/);
		expect(joinFailureText('failed', false)).toMatch(/Try again/);
	});
});
