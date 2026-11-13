/**
 * getSignedLoreUrl is the one path every Lore download, preview, citation chip and code panel
 * takes. A hostile server's answer must not leave this function unless it is a URL on that same
 * server (docs/audits/2026-11-hostile-server-audit.md, L1 and review finding F2).
 */
import { beforeEach, expect, mock, test } from 'bun:test';

const SERVER = 'https://wabi.example';
mock.module('$lib/socketConnection', () => ({ getSocket: () => null }));
const realServerUrl = await import('../serverUrl');
const serverUrlMock = () => ({ ...realServerUrl, getServerUrl: () => SERVER });
mock.module('../serverUrl', serverUrlMock);
mock.module('$lib/serverUrl', serverUrlMock);

let answer: unknown = {};
beforeEach(() => {
	(globalThis as any).fetch = async () => new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
});

const { getSignedLoreUrl } = await import('./lore');

test('a path on this server is returned as an absolute URL on this server', async () => {
	answer = { url: '/api/addons/lore/repos/1/files/a.png?sig=x' };
	expect(await getSignedLoreUrl('tok', 1, 'a.png')).toBe(`${SERVER}/api/addons/lore/repos/1/files/a.png?sig=x`);
});

test('script URLs and every other origin are refused, including slash tricks', async () => {
	for (const url of [
		'javascript:alert(document.domain)',
		'data:text/html,<script>alert(1)</script>',
		'blob:https://wabi.example/1',
		'https://evil.example/x',
		'//evil.example/x',
		'/\\evil.example/x',
		'https:\\\\evil.example\\x',
		'http://wabi.example/x',
		'https://wabi.example:8443/x',
		'https://user:pw@wabi.example/x'
	]) {
		answer = { url };
		await expect(getSignedLoreUrl('tok', 1, 'a.png')).rejects.toThrow();
	}
});
