/**
 * Call sites of finding W1 (docs/audits/2026-11-hostile-server-audit.md): board data names asset
 * URLs, and a member writes board data. The viewer's token may only go to this server.
 */
import { beforeEach, expect, mock, test } from 'bun:test';

const SERVER = 'https://wabi.example';
const realServerUrl = await import('../serverUrl');
const serverUrlMock = () => ({ ...realServerUrl, getServerUrl: () => SERVER });
mock.module('$lib/serverUrl', serverUrlMock);
mock.module('../serverUrl', serverUrlMock);
const realAuth = await import('../authSession');
const authMock = () => ({ ...realAuth, getAuthToken: () => 'viewer-token', getGuestSessionId: () => null });
mock.module('$lib/authSession', authMock);
mock.module('../authSession', authMock);

const sent: Array<{ url: string; authorization: string | null }> = [];
beforeEach(() => {
	sent.length = 0;
	(globalThis as any).fetch = async (input: string | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		sent.push({ url: String(input), authorization: headers.get('authorization') });
		return new Response('', { status: 404 });
	};
});

const { hydrateRasterLayer } = await import('./rasterLayers');
const { isProtectedWhiteboardImage } = await import('./boardRenderer');

test('a raster layer on another host is fetched without the viewer\'s token', async () => {
	await hydrateRasterLayer('evil-layer', 'https://evil.example/api/whiteboard/boards/1/files/1').catch(() => {});
	await hydrateRasterLayer('evil-layer-2', '//evil.example/x.png').catch(() => {});
	await hydrateRasterLayer('own-layer', '/api/whiteboard/boards/1/files/2').catch(() => {});
	expect(sent).toEqual([
		{ url: 'https://evil.example/api/whiteboard/boards/1/files/1', authorization: null },
		{ url: 'https://evil.example/x.png', authorization: null },
		{ url: `${SERVER}/api/whiteboard/boards/1/files/2`, authorization: 'Bearer viewer-token' }
	]);
});

test('only this server\'s own board files count as protected (they get the token)', () => {
	expect(isProtectedWhiteboardImage('/api/whiteboard/boards/1/files/2')).toBe(true);
	expect(isProtectedWhiteboardImage(`${SERVER}/api/whiteboard/boards/1/files/2`)).toBe(true);
	for (const src of ['https://evil.example/api/whiteboard/boards/1/files/1', '//evil.example/api/whiteboard/boards/1/files/1', 'http://wabi.example/api/whiteboard/boards/1/files/1']) {
		expect({ src, protected: isProtectedWhiteboardImage(src) }).toEqual({ src, protected: false });
	}
});
