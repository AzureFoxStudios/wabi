import { expect, mock, test } from 'bun:test';

// Isolate module/fetch/timer control from the process-wide Bun module cache.
mock.module('../src/lib/api/utils', () => ({
	getApiBase: () => 'https://policy.test',
	fetchWithTimeout: () => { throw new Error('Unexpected generic request'); },
	safeJsonParse: (response: Response) => response.json()
}));
const { getAdminPolicy, saveAdminPolicy } = await import('../src/lib/api/admin');

test('policy deadline remains armed through JSON consumption, for reads and writes', async () => {
	const originalFetch = globalThis.fetch;
	const originalSetTimeout = globalThis.setTimeout;
	let aborted = 0;
	globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: any[]) =>
		originalSetTimeout(handler, delay === 8000 ? 5 : delay, ...args)) as typeof setTimeout;
	globalThis.fetch = (async (_url: unknown, init: RequestInit) => ({
		ok: true,
		json: () => new Promise((_resolve, reject) => {
			init.signal!.addEventListener('abort', () => { aborted++; reject(new DOMException('Aborted response body', 'AbortError')); }, { once: true });
		})
	})) as typeof fetch;
	try {
		await expect(getAdminPolicy('fixture', 'frontend_app_metadata')).rejects.toThrow('Aborted response body');
		await expect(saveAdminPolicy('fixture', 'frontend_app_metadata', {})).rejects.toThrow('Invalid response');
		expect(aborted).toBe(2);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.setTimeout = originalSetTimeout;
	}
}, 1000);
