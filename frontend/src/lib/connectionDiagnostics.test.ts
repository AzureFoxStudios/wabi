import { afterEach, expect, mock, test } from 'bun:test';
import { describeConnectionFailure, isNetworkFailure } from './connectionDiagnostics';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('only a fetch that never completed counts as a network failure', () => {
	expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true);
	expect(isNetworkFailure(new Error('Invalid username or password'))).toBe(false);
});

test('each probe reports its own outcome', async () => {
	globalThis.fetch = mock(async (_url, init) => {
		if (init?.mode === 'no-cors') return { type: 'opaque', status: 0 } as Response;
		if (init?.headers) throw new TypeError('Failed to fetch');
		return new Response('{}', { status: 200 });
	}) as unknown as typeof fetch;
	const report = await describeConnectionFailure('https://wabi.example/');
	expect(report).toContain('Server: https://wabi.example/');
	expect(report).toContain('Reach server: answered');
	expect(report).toContain('Read response: HTTP 200');
	expect(report).toContain('With JSON request: failed (Failed to fetch)');
});
