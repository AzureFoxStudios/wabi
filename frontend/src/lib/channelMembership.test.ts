import { describe, expect, test } from 'bun:test';
import { createChannelMembership } from './channelMembership';

const jwt = (sub: string, generation = 1) => `header.${btoa(JSON.stringify({ sub, generation }))}.signature`;
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
const joined = (id = 'ch') => Response.json({ joined: true, channelId: id });

describe('channel membership ordering', () => {
	test('coalesces concurrent joins; loads content only after acknowledgment; rechecks later', async () => {
		const join = deferred<Response>();
		const calls: string[] = [];
		const access = createChannelMembership({ server: () => 'https://wabi.test', token: () => jwt('1'),
			fetch: async (url) => { calls.push(url); return url.endsWith('/join') ? join.promise.then(r => r.clone()) : Response.json({ pages: [] }); } });
		const room = access.ensure('ch');
		const content = access.fetchChannel('ch', 'https://wabi.test/api/wiki/ch/pages');
		expect(calls).toEqual(['https://wabi.test/api/channels/ch/join']);
		join.resolve(joined());
		await Promise.all([room, content]);
		expect(calls).toHaveLength(2);
		await access.ensure('ch');
		expect(calls).toHaveLength(3);
	});
	test('denial is not success or an empty list, never loads content, and is retryable', async () => {
		let calls = 0;
		const access = createChannelMembership({ server: () => 'https://wabi.test', token: () => jwt('1'),
			fetch: async () => { calls++; return Response.json({ error: 'Conversation membership required' }, { status: 403 }); } });
		await expect(access.fetchChannel('ch', 'https://wabi.test/api/wiki/ch/pages')).rejects.toThrow('Conversation membership required');
		await expect(access.ensure('ch')).rejects.toThrow('Conversation membership required');
		expect(calls).toBe(2);
	});
	test('rejects an HTML fallback or wrong-channel success', async () => {
		for (const response of [new Response('<html>SPA</html>'), joined('other')]) {
			const access = createChannelMembership({ server: () => 'https://wabi.test', token: () => jwt('1'), fetch: async () => response });
			await expect(access.ensure('ch')).rejects.toThrow('did not confirm');
		}
	});
	test('server/account switches and logout cancel delayed joins', async () => {
		for (const change of ['server', 'account', 'logout']) {
			let server = 'https://one.test', token: string | null = jwt('1');
			const join = deferred<Response>();
			const access = createChannelMembership({ server: () => server, token: () => token, fetch: () => join.promise });
			const work = access.ensure('ch');
			if (change === 'server') server = 'https://two.test';
			else token = change === 'account' ? jwt('2') : null;
			join.resolve(joined());
			await expect(work).rejects.toThrow('Session changed');
		}
	});
	test('same-account refresh uses the new token for content', async () => {
		let token = jwt('1');
		const access = createChannelMembership({ server: () => 'https://wabi.test', token: () => token,
			fetch: async (url, options) => {
				if (url.endsWith('/join')) { token = jwt('1', 2); return joined(); }
				expect(new Headers(options.headers).get('Authorization')).toBe(`Bearer ${token}`);
				return Response.json({ pages: [] });
			} });
		await access.fetchChannel('ch', 'https://wabi.test/api/wiki/ch/pages');
	});
	test('never sends a channel bearer to a different server URL', async () => {
		let calls = 0;
		const access = createChannelMembership({ server: () => 'https://wabi.test', token: () => jwt('1'), fetch: async () => { calls++; return joined(); } });
		await expect(access.fetchChannel('ch', 'https://elsewhere.test/api/wiki/ch/pages')).rejects.toThrow('another server');
		expect(calls).toBe(1);
	});
});
