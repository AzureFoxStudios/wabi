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

describe('L1/F2: a Lore signed URL from the server is a URL on that same server', () => {
	const base = 'https://wabi.example';
	test('accepts absolute http(s) and this server\'s paths', () => {
		expect(checkedSignedLoreUrl('https://wabi.example/api/addons/lore/signed/abc', base)).toBe('https://wabi.example/api/addons/lore/signed/abc');
		expect(checkedSignedLoreUrl('/api/addons/lore/signed/abc', base)).toBe('https://wabi.example/api/addons/lore/signed/abc');
	});
	test('refuses javascript:, data:, blob:, other schemes and every other origin (F2)', () => {
		for (const value of [...SCRIPT_OR_OS_SCHEMES, 'https://evil.example/x', '/\\evil.example/x', 'https:\\\\evil.example\\x',
			'http://wabi.example/x', 'https://wabi.example:8443/x', 'https://wabi.example.evil.example/x']) {
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

describe('F1: placeholders are unguessable and never substituted by string', () => {
	test('each render gets a fresh hex nonce, so typed text cannot match a real marker', async () => {
		const { placeholderNonce } = await import('./htmlPlaceholders');
		const seen = new Set(Array.from({ length: 50 }, () => placeholderNonce()));
		expect(seen.size).toBe(50);
		for (const nonce of seen) expect(nonce).toMatch(/^[0-9a-f]{16}$/);
	});
	test('without a DOM nothing is substituted into an attribute: the result is empty, not rebuilt', async () => {
		const { substitutePlaceholders } = await import('./htmlPlaceholders');
		const html = '<a href="jaMARKv1Xascript:alert(1)">x</a> MARKv1X';
		const out = substitutePlaceholders(html, /MARKv\dX/g, new Map([['MARKv1X', { html: () => '<b>v</b>', text: 'v' }]]));
		expect(out).toBe('');
		expect(out).not.toContain('javascript:');
		// No slots: the input is returned as is (nothing to substitute).
		expect(substitutePlaceholders(html, /MARKv\dX/g, new Map())).toBe(html);
	});
	test('chat math and wiki links use the shared helper and sanitize last (wiring)', async () => {
		const { readFileSync } = await import('node:fs');
		const markdown = readFileSync(new URL('./markdown.ts', import.meta.url), 'utf8');
		expect(markdown).toMatch(/const token = `WABIMATH\$\{nonce\}N\$\{slots\.length\}X`;/);
		expect(markdown).toMatch(/extractMathPlaceholders\(text, placeholderNonce\(\)\)/);
		expect(markdown).toMatch(/return substitutePlaceholders\(html, MATH_TOKEN,/);
		expect(markdown).toMatch(/const final = mathSlots\.length \|\| !remoteImages \? sanitizeMessageHtml\(withMath/);
		expect(markdown).not.toMatch(/\.split\(slot\.token\)/);
		const wiki = readFileSync(new URL('./wiki/renderWikiBody.ts', import.meta.url), 'utf8');
		expect(wiki).toMatch(/return sanitizeMessageHtml\(substitutePlaceholders\(rendered,/);
		const channel = readFileSync(new URL('./components/WikiChannel.svelte', import.meta.url), 'utf8');
		expect(channel).not.toMatch(/wabiwikilinkx/);
		expect(channel).toMatch(/return renderWikiBodyHtml\(markdown, wikiLinkTarget\);/);
	});
});

describe('F4: blobs and file URLs built from server- or sender-typed bytes stay inert', () => {
	test('only raster images, audio, video, PDF and plain text keep their type', async () => {
		const { inertBlobType, isDisplayableImageType, inertBlob } = await import('./safeBlobType');
		for (const type of ['image/svg+xml', 'IMAGE/SVG+XML; charset=utf-8', 'text/html', 'application/xhtml+xml', 'text/xml',
			'application/xml', 'image/x-icon', 'multipart/x-mixed-replace', '', 'application/octet-stream', 'video/../html']) {
			expect({ type, inert: inertBlobType(type) }).toEqual({ type, inert: 'application/octet-stream' });
		}
		for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'audio/ogg', 'video/mp4', 'application/pdf', 'text/plain']) {
			expect(inertBlobType(type)).toBe(type);
		}
		expect(isDisplayableImageType('image/svg+xml')).toBe(false);
		const svg = new Blob(['<svg onload="x"/>'], { type: 'image/svg+xml' });
		expect(inertBlob(svg).type).toBe('application/octet-stream');
		expect(await inertBlob(svg).text()).toBe('<svg onload="x"/>');
	});
	test('file links from server data: no data:text/html or data:image/svg+xml, no other schemes', async () => {
		const { safeFileHref } = await import('./safeBlobType');
		expect(safeFileHref('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
		expect(safeFileHref('/uploads/a.png')).toBe('/uploads/a.png');
		expect(safeFileHref('https://wabi.example/uploads/a.png')).toBe('https://wabi.example/uploads/a.png');
		for (const url of ['data:text/html,<script>alert(1)</script>', 'data:image/svg+xml,<svg onload=alert(1)>', 'javascript:alert(1)', 'file:///etc/passwd', 'vbscript:x']) {
			expect(safeFileHref(url)).toBeNull();
		}
	});
	test('an encrypted SVG is not treated as an inline image', async () => {
		const { isEncryptedImageAttachment } = await import('./components/message/messageItemUtils');
		const meta = (mimeType: string) => ({ attachmentEncryption: { scheme: 'dm-e2ee-v1', iv: 'x', mimeType } });
		expect(isEncryptedImageAttachment(meta('image/png'))).toBe(true);
		expect(isEncryptedImageAttachment(meta('image/svg+xml'))).toBe(false);
		expect(isEncryptedImageAttachment(meta('text/html'))).toBe(false);
	});
	test('every untrusted blob site uses the rule (wiring)', async () => {
		const { readFileSync } = await import('node:fs');
		const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
		expect(read('./e2ee.ts')).toMatch(/return new Blob\(parts, \{ type: inertBlobType\(metadata\.mimeType\) \}\);/);
		const lore = read('./components/LoreChannel.svelte');
		expect(lore).toMatch(/URL\.createObjectURL\(getFileType\(file\.path\) === 'pdf' \? pdfPreviewBlob\(blob\) : inertBlob\(blob\)\)/);
		expect(lore).toMatch(/const url = URL\.createObjectURL\(inertBlob\(blob\)\);\s*thumbUrlByPath/);
		expect(lore).not.toMatch(/URL\.createObjectURL\(blob\)/);
		const files = read('./filesWorkspaceSession.ts');
		expect(files).toMatch(/const url = deps\.createObjectUrl\(inertBlob\(blob\)\);/);
		expect(/const IMAGE_EXT = new Set\(\[[^\]]*'svg'/.test(files)).toBe(false);
		expect(read('./forumStore.ts')).toMatch(/return safeFileHref\(url\) \?\? '';/);
	});
});
