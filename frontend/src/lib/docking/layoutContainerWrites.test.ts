import { describe, expect, mock, test } from 'bun:test';

mock.module('$app/environment', () => ({ browser: false }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async () => null }));
mock.module('$lib/api', () => ({ getApiBase: () => 'http://wabi.test' }));
mock.module('$lib/authSession', () => ({ getAuthToken: () => 'token' }));
mock.module('$lib/tauri-platform', () => ({ isTauriRuntime: () => false }));

const { mergeIntoServerContainer } = await import('./layoutPersistence');

describe('the shared /api/user/layout container', () => {
	test('overlapping writers run one GET-merge-PUT at a time, so no slot is lost', async () => {
		// A fake server whose GET is slow: without serialising, both writers read {} first and
		// the later PUT drops the earlier slot.
		let stored: Record<string, unknown> = { layout: { v: 1 } };
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			if (init?.method === 'PUT') {
				stored = JSON.parse(JSON.parse(String(init.body)).layoutJson);
				return new Response('{}', { status: 200 });
			}
			const snapshot = JSON.stringify(stored);
			await sleep(20);
			return new Response(JSON.stringify({ layoutJson: snapshot }), { status: 200 });
		}) as typeof fetch;
		try {
			const results = await Promise.all([
				mergeIntoServerContainer('token', 'railDensity', 'compact'),
				mergeIntoServerContainer('token', 'railSide', 'right'),
				mergeIntoServerContainer('token', 'layout', { v: 2 })
			]);
			expect(results).toEqual([true, true, true]);
			expect(stored).toEqual({ layout: { v: 2 }, railDensity: 'compact', railSide: 'right' });
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test('a failed write does not stop the next one', async () => {
		const realFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			calls += 1;
			if (calls === 1) throw new Error('offline');
			if (init?.method === 'PUT') return new Response('{}', { status: 200 });
			return new Response(JSON.stringify({ layoutJson: null }), { status: 200 });
		}) as typeof fetch;
		try {
			const first = mergeIntoServerContainer('token', 'railSide', 'left');
			const second = mergeIntoServerContainer('token', 'railDensity', 'roomy');
			expect(await first).toBe(true); // the GET failed; it starts from an empty container
			expect(await second).toBe(true);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
