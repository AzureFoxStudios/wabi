import { afterEach, describe, expect, test } from 'bun:test';
import { parseEndpointHealth, readEndpointHealth } from './endpointHealth';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('entry-point health', () => {
	test('accepts the two current server roles without inferring a writer from Anchor health', () => {
		expect(parseEndpointHealth({ service: 'wabi-server', role: 'authority', status: 'ok' })).toEqual({ role: 'authority', status: 'ok' });
		expect(parseEndpointHealth({ service: 'wabi-server', role: 'anchor', status: 'ok' })).toEqual({ role: 'anchor', status: 'ok' });
		expect(parseEndpointHealth({ service: 'wabi-server', role: 'authority', status: 'degraded' })).toEqual({ role: 'authority', status: 'degraded' });
	});

	test('refuses an absent, unknown or unrelated role', () => {
		for (const body of [{}, { service: 'wabi-server', role: 'helper', status: 'ok' }, { service: 'other', role: 'authority', status: 'ok' }, null]) {
			expect(() => parseEndpointHealth(body)).toThrow();
		}
	});

	test('probes the selected endpoint without an authorization header', async () => {
		let requestedUrl = '';
		let requestedInit: RequestInit | undefined;
		globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
			requestedUrl = String(url);
			requestedInit = init;
			return new Response(JSON.stringify({ service: 'wabi-server', role: 'anchor', status: 'ok' }));
		}) as typeof fetch;
		expect(await readEndpointHealth('https://site-b.example/')).toEqual({ role: 'anchor', status: 'ok' });
		expect(requestedUrl).toBe('https://site-b.example/health');
		expect(requestedInit?.headers).toBeUndefined();
		expect(requestedInit?.cache).toBe('no-store');
	});
});
