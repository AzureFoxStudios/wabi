import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { joinRelayRoom } from './relayRoom';

function socket() {
	return Object.assign(new EventEmitter(), { connected: true });
}
describe('relay room authorization', () => {
	test('ignores stale acknowledgments and receives header replay before completion', async () => {
		const s = socket();
		let request: any;
		const received: string[] = [];
		s.on('join-wabidb-call', value => { request = value; });
		s.on('wabidb-media', () => received.push('headers'));
		const join = joinRelayRoom(s, 'channel:one', 'one').then(() => received.push('joined'));
		s.emit('wabidb-call-joined', { ...request, requestId: 'stale' });
		await Promise.resolve();
		expect(received).toEqual([]);
		s.emit('wabidb-media', {});
		s.emit('wabidb-call-joined', request);
		await join;
		expect(received).toEqual(['headers', 'joined']);
		expect(s.listenerCount('disconnect')).toBe(0);
	});
	test('denial is a failure and cleans all waiters', async () => {
		const s = socket();
		s.on('join-wabidb-call', request => s.emit('wabidb-call-denied', { ...request, reason: 'not in roster' }));
		await expect(joinRelayRoom(s, 'channel:one', 'one')).rejects.toThrow('not in roster');
		expect(s.listenerCount('wabidb-call-joined')).toBe(0);
		expect(s.listenerCount('wabidb-call-denied')).toBe(0);
	});
	test('disconnect, leave cancellation and timeout all reject and clean up', async () => {
		for (const reason of ['disconnect', 'abort', 'timeout']) {
			const s = socket();
			const controller = new AbortController();
			const join = joinRelayRoom(s, 'channel:one', 'one', controller.signal, 5);
			if (reason === 'disconnect') s.emit('disconnect');
			if (reason === 'abort') controller.abort();
			await expect(join).rejects.toThrow();
			expect(s.listenerCount('wabidb-call-joined')).toBe(0);
			expect(s.listenerCount('disconnect')).toBe(0);
		}
	});
});
