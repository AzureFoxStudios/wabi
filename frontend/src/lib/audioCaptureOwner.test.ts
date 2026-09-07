import { describe, expect, test } from 'bun:test';
import { AudioCaptureOwner } from './audioCaptureOwner';
import type { LocalAudioCaptureSession } from './callingTypes';

function fixture() {
	const requests: { resolve: (session: LocalAudioCaptureSession) => void; reject: (error: Error) => void }[] = [];
	const disposed: LocalAudioCaptureSession[] = [];
	const committed: LocalAudioCaptureSession[] = [];
	const owner = new AudioCaptureOwner(() => new Promise((resolve, reject) => requests.push({ resolve, reject })), session => disposed.push(session));
	const commit = (session: LocalAudioCaptureSession) => { committed.push(session); };
	const session = () => ({}) as LocalAudioCaptureSession;
	return { owner, requests, disposed, committed, commit, session };
}

describe('shared microphone ownership', () => {
	test('concurrent joins acquire and publish one microphone', async () => {
		const f = fixture();
		const a = f.owner.ensure(f.commit);
		const b = f.owner.ensure(f.commit);
		expect(a).toBe(b);
		expect(f.requests).toHaveLength(1);
		const session = f.session();
		f.requests[0].resolve(session);
		expect(await a).toBe(session);
		expect(f.committed).toEqual([session]);
	});
	test('leaving during permission cancels immediately and disposes the late capture', async () => {
		const f = fixture();
		const pending = f.owner.ensure(f.commit);
		f.owner.clear();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		const late = f.session();
		f.requests[0].resolve(late);
		await Promise.resolve();
		expect(f.disposed).toEqual([late]);
		expect(f.committed).toHaveLength(0);
		expect(f.owner.current).toBeNull();
	});
	test('latest device selection wins regardless of permission completion order', async () => {
		const f = fixture();
		const oldRequest = f.owner.replace(f.commit);
		const latest = f.owner.replace(f.commit);
		await expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' });
		const current = f.session();
		f.requests[1].resolve(current);
		await latest;
		const stale = f.session();
		f.requests[0].resolve(stale);
		await Promise.resolve();
		expect(f.owner.current).toBe(current);
		expect(f.committed).toEqual([current]);
		expect(f.disposed).toEqual([stale]);
	});
	test('failed replacement preserves the current microphone; failed commit disposes only candidate', async () => {
		const f = fixture();
		const initial = f.owner.ensure(f.commit);
		const current = f.session();
		f.requests[0].resolve(current);
		await initial;
		const failure = f.owner.replace(f.commit);
		f.requests[1].reject(new Error('Device unavailable'));
		await expect(failure).rejects.toThrow('Device unavailable');
		expect(f.owner.current).toBe(current);
		const commitFailure = f.owner.replace(() => { throw new Error('Stream detached'); });
		const rejected = f.session();
		f.requests[2].resolve(rejected);
		await expect(commitFailure).rejects.toThrow('Stream detached');
		expect(f.disposed).toEqual([rejected]);
		expect(f.owner.current).toBe(current);
		f.owner.clear();
		expect(f.disposed).toEqual([rejected, current]);
	});
});
