/**
 * Kept content in a real browser (privacy/remoteMedia.ts): the real chat renderer
 * (markdown.ts parseMessage) and the real Reader renderer (readerTabHelpers.ts renderReaderHtml)
 * are bundled, their output is inserted into a live page, and every request the page makes is
 * recorded. With remote media off, nothing may reach another host, including through parser
 * tricks a regex would miss. With it on (the control), the same probes must reach the host, so a
 * silent harness cannot pass.
 *
 *   node scripts/kept-content-browser-smoke.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(frontend, 'src/lib');
const work = await mkdtemp(path.join(tmpdir(), 'wabi-kept-content-'));
const entry = path.join(work, 'entry.ts');
const bundle = path.join(work, 'bundle.js');

await import('node:fs/promises').then((fs) => fs.writeFile(entry, `
import { parseMessage } from '${lib}/markdown';
import { renderReaderHtml } from '${lib}/components/readerTabHelpers';
(window as any).wabiRender = { parseMessage, renderReaderHtml };
`));

const resolveLib = {
	name: 'wabi-lib',
	setup(builder) {
		builder.onResolve({ filter: /^\$lib\// }, async (args) => {
			const base = path.join(lib, args.path.slice(5));
			for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
				try {
					const stat = await import('node:fs/promises').then((fs) => fs.stat(candidate));
					if (stat.isFile()) return { path: candidate };
				} catch {}
			}
			return { path: base };
		});
		builder.onResolve({ filter: /^\$app\/environment$/ }, () => ({ path: 'app-env', namespace: 'stub' }));
		builder.onLoad({ filter: /^app-env$/, namespace: 'stub' }, () => ({ contents: 'export const browser = true; export const dev = false; export const building = false; export const version = "test";', loader: 'js' }));
	}
};

await build({
	entryPoints: [entry],
	bundle: true,
	outfile: bundle,
	format: 'iife',
	platform: 'browser',
	nodePaths: [path.join(frontend, 'node_modules')],
	loader: { '.css': 'empty', '.svelte': 'empty' },
	define: { 'import.meta.env.DEV': 'false', 'import.meta.env.SSR': 'false', 'import.meta.env': '{}' },
	plugins: [resolveLib],
	logLevel: 'error'
});

const script = await readFile(bundle, 'utf8');
const server = createServer((request, response) => {
	if (request.url === '/') {
		response.writeHead(200, { 'content-type': 'text/html' });
		response.end('<!doctype html><meta charset="utf-8"><title>kept</title><body><div id="out"></div><script src="/bundle.js"></script></body>');
	} else if (request.url === '/bundle.js') {
		response.writeHead(200, { 'content-type': 'text/javascript' });
		response.end(script);
	} else {
		response.writeHead(204);
		response.end();
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const CHAT_PROBES = {
	markdownImage: '![x](https://t.example.net/md.png)',
	imageAlias: '<image src="https://t.example.net/alias.gif">',
	altInjection: '<img src="x" alt="<img src=https://t.example.net/alt.gif ">',
	srcset: '<img srcset="https://t.example.net/s.png 2x" src="/uploads/ok-srcset.png">',
	protocolRelative: '<img src="//t.example.net/pr.gif">',
	apiProxy: '<img src="/api/image-proxy?url=https%3A%2F%2Ft.example.net%2Fproxy.png">'
};
const READER_PROBES = {
	video: '<video src="https://t.example.net/v.mp4" poster="https://t.example.net/poster.png" autoplay muted></video>',
	audio: '<audio autoplay><source src="https://t.example.net/a.mp3"></audio>',
	picture: '<picture><source srcset="https://t.example.net/p.webp"><img src="/uploads/ok-picture.png"></picture>',
	markdownImage: '![r](https://t.example.net/reader.png)',
	imageAlias: '<image src="https://t.example.net/reader-alias.gif">'
};

const browser = await chromium.launch(process.env.WABI_SMOKE_CHROMIUM_PATH ? { executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH } : {});
const results = {};
try {
	for (const remote of [false, true]) {
		const page = await browser.newPage();
		const seen = [];
		await page.route('**/*', async (route) => {
			const url = route.request().url();
			if (url.startsWith(origin)) return route.continue();
			seen.push(url);
			return route.fulfill({ status: 204 });
		});
		const localSeen = [];
		page.on('request', (request) => { if (request.url().startsWith(origin)) localSeen.push(new URL(request.url()).pathname + new URL(request.url()).search); });
		await page.goto(origin);
		await page.waitForFunction(() => Boolean(window.wabiRender));
		const rendered = {};
		for (const [name, text] of Object.entries(CHAT_PROBES)) {
			rendered[`chat:${name}`] = await page.evaluate(([text, remote]) => {
				const html = window.wabiRender.parseMessage(text, [], { remoteImages: remote });
				const host = document.createElement('div');
				host.innerHTML = html;
				document.getElementById('out').append(host);
				return html;
			}, [text, remote]);
		}
		for (const [name, text] of Object.entries(READER_PROBES)) {
			rendered[`reader:${name}`] = await page.evaluate(([text, remote]) => {
				const html = window.wabiRender.renderReaderHtml(text, 'markdown', { remoteMedia: remote });
				const host = document.createElement('div');
				host.innerHTML = html;
				document.getElementById('out').append(host);
				return html;
			}, [text, remote]);
		}
		// A server-hosted image (custom emoji live here) still renders when remote media is off.
		rendered.localImage = await page.evaluate((remote) => window.wabiRender.parseMessage('<img src="/uploads/emoji/ok.png" alt="ok">', [], { remoteImages: remote }), remote);
		await page.waitForTimeout(600);
		// Checked on the live DOM, as the browser parsed it: any element whose fetch attribute
		// resolves to another host.
		const remoteElements = await page.evaluate(() => {
			const out = [];
			for (const element of document.querySelectorAll('#out *')) {
				for (const name of ['src', 'srcset', 'poster', 'data']) {
					const value = element.getAttribute(name);
					if (!value) continue;
					for (const candidate of name === 'srcset' ? value.split(',').map((part) => part.trim().split(/\s+/)[0]) : [value]) {
						if (new URL(candidate, location.href).origin !== location.origin) out.push(`${element.localName}[${name}=${candidate}]`);
					}
				}
			}
			return out;
		});
		results[remote ? 'remoteOn' : 'remoteOff'] = { seen: [...new Set(seen)], localSeen: [...new Set(localSeen)], rendered, remoteElements };
		await page.close();
	}
} finally {
	await browser.close();
	server.close();
	await rm(work, { recursive: true, force: true });
}

const off = results.remoteOff;
const on = results.remoteOn;
console.log(JSON.stringify({ remoteOff: { seen: off.seen, localSeen: off.localSeen, srcset: off.rendered['chat:srcset'] }, remoteOn: { seen: on.seen } }, null, 2));

assert.deepEqual(off.seen, [], 'remote media off: no request may reach another host');
assert.ok(!off.localSeen.some((url) => url.startsWith('/api/')), 'remote media off: no request to a server proxy endpoint');
assert.deepEqual(off.remoteElements, [], 'remote media off: no element in the page still points at another host');
assert.ok(on.remoteElements.length > 0, 'control: with remote media on, remote elements are present');
assert.match(off.rendered.localImage, /<img[^>]+src="\/uploads\/emoji\/ok\.png"/, 'a server-hosted image still renders');
assert.match(off.rendered['chat:markdownImage'], /<a [^>]*href="https:\/\/t\.example\.net\/md\.png"/, 'a markdown image becomes a link');
// The chat sanitizer drops srcset itself, so only the Reader's <picture> exercises srcset here.
for (const probe of ['md.png', 'alias.gif', 'pr.gif', 'reader.png', 'reader-alias.gif', 'v.mp4', 'poster.png', 'a.mp3', 'p.webp']) {
	assert.ok(on.seen.some((url) => url.includes(probe)), `control: with remote media on, ${probe} is requested (the harness can see requests)`);
}
console.log('kept-content browser smoke: ok');
