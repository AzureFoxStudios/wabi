/**
 * Boundaries from docs/audits/2026-11-hostile-server-audit.md that are pure functions. Each test
 * names the finding it keeps fixed. Renderer behaviour runs in Chromium in
 * scripts/hostile-server-browser-smoke.mjs; storage pins are in communityRoster.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { safeExternalHttpUrl } from './safeExternalUrl';
import { checkedSignedLoreUrl, pdfPreviewBlob } from './lore/linkSafety';
import { resolvesToServer, serverAssetHeaders } from './whiteboard/sameServerAuth';

const SCRIPT_OR_OS_SCHEMES = [
	'javascript:alert(1)',
	' JaVaScRiPt:alert(1)',
	'java\tscript:alert(1)',
	'data:text/html,<script>alert(1)</script>',
	'blob:https://wabi.example/0f1e',
	'file:///etc/passwd',
	'smb://host/share',
	'ms-msdt:/id PCWDiagnostic',
	'vbscript:msgbox(1)',
	'steam://run/1',
	'//evil.example/x'
];

describe('L3: server-chosen external links are http(s) only', () => {
	test('accepts absolute http(s) links', () => {
		expect(safeExternalHttpUrl('https://community.example/join')).toBe('https://community.example/join');
		expect(safeExternalHttpUrl(' http://community.example ')).toBe('http://community.example/');
	});
	test('refuses script, OS handler, protocol-relative and credentialed links', () => {
		for (const value of [...SCRIPT_OR_OS_SCHEMES, 'https://user:pw@evil.example/', '', null, 42, '/relative']) {
			expect(safeExternalHttpUrl(value)).toBeNull();
		}
	});
});

describe('L1: a Lore signed URL from the server is an http(s) link', () => {
	const base = 'https://wabi.example';
	test('accepts absolute http(s) and this server\'s paths', () => {
		expect(checkedSignedLoreUrl('https://wabi.example/api/addons/lore/signed/abc', base)).toBe('https://wabi.example/api/addons/lore/signed/abc');
		expect(checkedSignedLoreUrl('/api/addons/lore/signed/abc', base)).toBe('https://wabi.example/api/addons/lore/signed/abc');
	});
	test('refuses javascript:, data:, blob: and other schemes', () => {
		for (const value of SCRIPT_OR_OS_SCHEMES.filter((v) => !v.startsWith('//'))) {
			expect(checkedSignedLoreUrl(value, base)).toBeNull();
		}
		expect(checkedSignedLoreUrl('https://u:p@evil.example/x', base)).toBeNull();
		expect(checkedSignedLoreUrl(undefined, base)).toBeNull();
	});
});

describe('L2: the Lore PDF preview frame never gets a server-chosen type', () => {
	test('an HTML or SVG "PDF" is shown as application/pdf, keeping its bytes', async () => {
		for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', '']) {
			const preview = pdfPreviewBlob(new Blob(['<script>alert(1)</script>'], { type }));
			expect(preview.type).toBe('application/pdf');
			expect(await preview.text()).toBe('<script>alert(1)</script>');
		}
	});
	test('a real PDF blob is passed through unchanged', () => {
		const pdf = new Blob(['%PDF-1.7'], { type: 'application/pdf' });
		expect(pdfPreviewBlob(pdf)).toBe(pdf);
	});
});

describe('W1: board assets get credentials only from this server', () => {
	const server = 'https://wabi.example';
	test('same-origin paths and absolute URLs get the bearer token', () => {
		expect(serverAssetHeaders('/api/whiteboard/boards/1/files/2', server, 'tok', null)).toEqual({ Authorization: 'Bearer tok' });
		expect(serverAssetHeaders('https://wabi.example/uploads/x.png', server, 'tok', null)).toEqual({ Authorization: 'Bearer tok' });
		expect(serverAssetHeaders('/uploads/x.png', server, null, 'guest-1')).toEqual({ 'X-Session-Id': 'guest-1' });
	});
	test('another host, even with the board-file path, gets neither token nor guest session', () => {
		for (const url of [
			'https://evil.example/api/whiteboard/boards/1/files/1',
			'//evil.example/x.png',
			'https://wabi.example.evil.example/x',
			'http://wabi.example/x',
			'https://wabi.example:8443/x',
			'javascript:alert(1)'
		]) {
			expect(serverAssetHeaders(url, server, 'tok', 'guest-1')).toEqual({});
			expect(resolvesToServer(url, server)).toBe(false);
		}
	});
});

describe('C1: the client never imports code from a URL a server chose', () => {
	// Every dynamic import whose argument is not a string literal. Each entry was reviewed: the URL is
	// a constant in the file (a pinned CDN build of three.js / OpenCascade), or the user's own local
	// file (EffectsTab). The desktop CSP (script-src 'self') blocks the CDN ones there.
	const REVIEWED: Record<string, RegExp> = {
		'lib/components/plugins/model-loader.worker.ts': /const threeBase = 'https:\/\/esm\.sh\/three@[\d.]+';/,
		'lib/components/plugins/OcctCadViewer.svelte': /const THREE_BASE = 'https:\/\/esm\.sh\/three@[\d.]+';/,
		'lib/components/plugins/ThreeMFViewer.svelte': /const THREE_BASE = 'https:\/\/esm\.sh\/three@[\d.]+';/,
		'lib/components/plugins/ModelViewer3D.svelte': /const THREE_BASE = 'https:\/\/esm\.sh\/three@[\d.]+';/,
		'lib/cad/occtCad.worker.ts': /const OCCT_MODULE_URL = 'https:\/\/esm\.sh\/@sunbox\/occt-import-js@[\d.]+';/,
		'lib/effects/EffectsTab.svelte': /input\.files\?\.\[0\];[\s\S]{0,200}new Blob\(\[code\][\s\S]{0,120}import\(\/\* @vite-ignore \*\/ url\)/
	};
	test('only the reviewed fixed-URL loaders use a computed import()', async () => {
		const { readdirSync, readFileSync } = await import('node:fs');
		const path = await import('node:path');
		const src = path.resolve(import.meta.dir, '..');
		const found: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/\.(ts|js|svelte)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
					const source = readFileSync(full, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '');
					if (/\bimport\(\s*(\/\*[^*]*\*\/\s*)?[^'"`\s)]/.test(source)) found.push(path.relative(src, full).split(path.sep).join('/'));
				}
			}
		};
		walk(src);
		expect(found.sort()).toEqual(Object.keys(REVIEWED).sort());
		for (const [file, constant] of Object.entries(REVIEWED)) {
			expect({ file, reviewed: constant.test(readFileSync(path.join(src, file), 'utf8')) }).toEqual({ file, reviewed: true });
		}
	});
	test('the add-on loader maps ids to bundled modules and never imports a manifest entry', async () => {
		const { readFileSync } = await import('node:fs');
		const source = readFileSync(new URL('./addons/loader.ts', import.meta.url), 'utf8');
		const table = source.slice(source.indexOf('const BUNDLED_ADDON_LOADERS'), source.indexOf('};', source.indexOf('const BUNDLED_ADDON_LOADERS')));
		const imports = [...table.matchAll(/import\(([^)]*)\)/g)].map((match) => match[1].trim());
		expect(imports.length).toBeGreaterThan(3);
		for (const specifier of imports) expect(specifier).toMatch(/^'(\$lib\/|@wabi\/workspace-)[^']+'$/);
		expect(source.replace(/^\s*(\/\/|\*).*$/gm, '')).not.toMatch(/import\([^)]*frontendEntry/);
	});
});
