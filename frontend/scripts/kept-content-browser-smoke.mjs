/**
 * Kept content in a real browser (privacy/remoteMedia.ts). The real chat renderer (markdown.ts
 * parseMessage), the real Reader renderer (readerTabHelpers.ts renderReaderHtml) and the real
 * message component (message/MessageContent.svelte with its children) are bundled, rendered into a
 * live Chromium page, and every request the page makes is recorded.
 *
 * Kept content must make no request to a host other than the page's own, including through
 * parser tricks, URL concatenation tricks in attachments, and HLS playlists served as same-origin
 * media. Each probe has a control (the same input as ordinary content) that must reach the other
 * host, so a harness that sees nothing cannot pass.
 *
 *   node scripts/kept-content-browser-smoke.mjs
 *   WABI_SMOKE_CHROMIUM_PATH=/path/to/chrome node scripts/kept-content-browser-smoke.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transformSync } from 'esbuild';
import { compile, compileModule } from 'svelte/compiler';
import { chromium } from 'playwright';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(frontend, 'src/lib');
const work = await mkdtemp(path.join(tmpdir(), 'wabi-kept-content-'));
const entry = path.join(work, 'entry.ts');
const bundle = path.join(work, 'bundle.js');
const posix = (value) => value.split(path.sep).join('/');

await writeFile(entry, `
import { mount } from 'svelte';
import { parseMessage } from '${posix(lib)}/markdown';
import { renderReaderHtml } from '${posix(lib)}/components/readerTabHelpers';
import MessageContent from '${posix(lib)}/components/message/MessageContent.svelte';
import { initI18n } from '${posix(lib)}/i18n';
import { markE2eeObserved } from '${posix(lib)}/e2eeEnvelope';
initI18n();
const noop = () => {};
function mountMessage(message, channel, kept) {
	const target = document.createElement('div');
	document.getElementById('out').append(target);
	const full = { id: 'm-' + Math.random().toString(36).slice(2), user: 'iris', userId: 'user-2', timestamp: 1, type: 'text', text: '', ...message };
	if (kept) markE2eeObserved(full);
	mount(MessageContent, { target, props: {
		message: full, messageText: String(full.text ?? ''), albumAnnouncementUploadName: null, translatedText: undefined,
		translationLoading: false, gifCaptionStyleClass: '', displayEnhancementSettingsStore: {}, currentChannel: channel.id, channels: [channel],
		onOpenMapPanel: noop, onOpenFullMapTab: noop, onOpenPreferredMapSurface: noop, onOpenDirectionsExternal: noop,
		onHandleAlbumActivate: noop, onTriggerAlbumUpload: noop, onOpenAlbumPanel: noop, onOpenAlbumPreview: noop,
		onEnlargeImage: noop, onEnlargeVideo: noop, onImageContextMenu: noop, onDownloadAttachment: noop,
		onOpenBlendImportSettings: noop, onOpenModelInDedicatedTab: noop, onHandleMarkdownContentClick: noop,
		LinkPreviewComponent: null, ensureLinkPreviewLoaded: noop, onHandleAlbumAnnouncementKeydown: noop
	} });
	target.dataset.probe = 'message';
	return target;
}
window.wabiRender = { parseMessage, renderReaderHtml, mountMessage };
`);

const appStub = 'export const browser = true; export const dev = false; export const building = false; export const version = "test";'
	+ ' export const goto = async () => {}; export const invalidate = async () => {}; export const afterNavigate = () => {}; export const beforeNavigate = () => {};'
	+ ' export const page = { subscribe(run) { run({ url: new URL(location.href), params: {} }); return () => {}; } };'
	+ ' export const navigating = { subscribe(run) { run(null); return () => {}; } };';

await build({
	entryPoints: [entry],
	bundle: true,
	outfile: bundle,
	format: 'iife',
	platform: 'browser',
	nodePaths: [path.join(frontend, 'node_modules')],
	conditions: ['svelte', 'browser'],
	mainFields: ['svelte', 'browser', 'module', 'main'],
	loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'text', '.woff2': 'empty', '.wasm': 'empty' },
	define: { 'import.meta.env.DEV': 'false', 'import.meta.env.SSR': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env': '{}', 'import.meta.glob': '__wabiGlob' },
	banner: { js: 'var __wabiGlob = () => ({});' },
	logLevel: 'error',
	plugins: [{
		name: 'wabi',
		setup(builder) {
			// Vite-only imports this page never uses (workers, wasm, raw assets, workspace add-ons).
			builder.onResolve({ filter: /\?(raw|url|worker|inline)$/ }, () => ({ path: 'asset', namespace: 'stub' }));
			builder.onResolve({ filter: /^@wabi\/workspace-|^(path|fs|crypto)$/ }, () => ({ path: 'module', namespace: 'stub' }));
			builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
			builder.onResolve({ filter: /^\$app\// }, (args) => ({ path: args.path, namespace: 'app' }));
			builder.onLoad({ filter: /.*/, namespace: 'app' }, () => ({ contents: appStub, loader: 'js' }));
			builder.onResolve({ filter: /^\$lib\// }, async (args) => {
				const base = path.join(lib, args.path.slice(5));
				for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
					try {
						if ((await stat(candidate)).isFile()) return { path: candidate };
					} catch {}
				}
				return { path: base };
			});
			builder.onLoad({ filter: /\.svelte$/ }, async (args) => {
				const source = await readFile(args.path, 'utf8');
				return { contents: compile(source, { filename: args.path, generate: 'client', css: 'injected' }).js.code, loader: 'js', resolveDir: path.dirname(args.path) };
			});
			builder.onLoad({ filter: /\.svelte\.(ts|js)$/ }, async (args) => {
				const js = transformSync(await readFile(args.path, 'utf8'), { loader: 'ts' }).code;
				return { contents: compileModule(js, { filename: args.path, generate: 'client' }).js.code, loader: 'js', resolveDir: path.dirname(args.path) };
			});
		}
	}]
});

// An HLS playlist served as an ordinary .mp4 upload: Chromium sniffs and follows it.
const playlist = (host) => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nhttp://${host}/seg0.ts\n#EXT-X-ENDLIST\n`;
const script = await readFile(bundle, 'utf8');
const server = createServer((request, response) => {
	const url = new URL(request.url, 'http://local');
	if (url.pathname === '/') {
		response.writeHead(200, { 'content-type': 'text/html' });
		response.end('<!doctype html><meta charset="utf-8"><title>kept</title><body><div id="out"></div>'
			+ '<script>sessionStorage.setItem("wabi.serverUrlSession", location.origin)</script><script src="/bundle.js"></script></body>');
	} else if (url.pathname === '/bundle.js') {
		response.writeHead(200, { 'content-type': 'text/javascript' });
		response.end(script);
	} else if (url.pathname.startsWith('/uploads/hls-')) {
		response.writeHead(200, { 'content-type': 'video/mp4', 'x-content-type-options': 'nosniff' });
		response.end(playlist(`${url.pathname.slice('/uploads/hls-'.length).replace(/\.\w+$/, '')}.segments.test`));
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
	apiProxy: '<img src="/api/image-proxy?url=https%3A%2F%2Ft.example.net%2Fproxy.png">',
	apiProxyEncoded: '<img src="/api%2Fimage-proxy?url=https%3A%2F%2Ft.example.net%2Fproxy2.png">',
	apiProxySemicolon: '<img src="/api;x/image-proxy?url=https%3A%2F%2Ft.example.net%2Fproxy3.png">',
	apiProxyEmptySegment: '<img src="/;/api/image-proxy?url=https%3A%2F%2Ft.example.net%2Fproxy4.png">'
};
const READER_PROBES = {
	video: '<video src="https://t.example.net/v.mp4" poster="https://t.example.net/poster.png" autoplay muted></video>',
	audio: '<audio autoplay><source src="https://t.example.net/a.mp3"></audio>',
	picture: '<picture><source srcset="https://t.example.net/p.webp"><img src="/uploads/ok-picture.png"></picture>',
	markdownImage: '![r](https://t.example.net/reader.png)',
	imageAlias: '<image src="https://t.example.net/reader-alias.gif">',
	sameOriginHls: '<video src="/uploads/hls-reader.mp4" autoplay muted preload="auto"></video>',
	template: '<template><img src="https://t.example.net/tpl.png"></template>'
};
// BLOCKER 1 payloads: a fileUrl that string concatenation onto the server URL turned into another host.
const URL_TRICKS = ['.evil.test/pixel.png', '.file-dot-host.evil.test/pixel.png', 'file-bare-suffix.evil.test/pixel.png', '-file-dash-suffix.evil.test/pixel.png', ':8443/pixel.png'];
const DM = { id: 'dm-1', type: 'dm', name: 'iris' };
const TEXT = { id: 'general', type: 'text', name: 'general' };

const browser = await chromium.launch(process.env.WABI_SMOKE_CHROMIUM_PATH ? { executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH } : {});
const results = {};
const pageErrors = [];

/** A same-origin request that a path-normalising front proxy would route to a server endpoint. */
function isServerEndpointRequest(url) {
	let path = new URL(url).pathname;
	for (let i = 0; i < 4; i += 1) {
		try {
			const decoded = decodeURIComponent(path);
			if (decoded === path) break;
			path = decoded;
		} catch {
			break;
		}
	}
	const segments = path.replace(/\\/g, '/').split('/').map((segment) => segment.split(';')[0]).filter((segment) => segment && segment !== '.');
	return segments[0]?.toLowerCase() === 'api';
}

/** Exact host (and optionally path) match on a parsed URL; never a substring check. */
function isRequestTo(url, hostname, pathname) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	return parsed.hostname === hostname && (pathname === undefined || parsed.pathname === pathname);
}

async function openPage() {
	const page = await browser.newPage();
	const seen = [];
	const local = [];
	page.on('pageerror', (error) => pageErrors.push(String(error)));
	await page.route('**/*', async (route) => {
		const url = route.request().url();
		if (new URL(url).origin === origin) {
			local.push(url);
			return route.continue();
		}
		seen.push(url);
		return route.fulfill({ status: 404 });
	});
	await page.goto(origin, { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => Boolean(window.wabiRender), null, { timeout: 30_000 });
	return { page, seen, local };
}

/** Elements in the live DOM whose fetch attribute resolves to another host. */
const remoteElementsIn = (page, selector) => page.evaluate((selector) => {
	const out = [];
	for (const scope of document.querySelectorAll(selector)) {
		for (const element of scope.querySelectorAll('*')) {
			for (const name of ['src', 'srcset', 'poster', 'data']) {
				const value = element.getAttribute(name);
				if (!value) continue;
				for (const candidate of name === 'srcset' ? value.split(',').map((part) => part.trim().split(/\s+/)[0]) : [value]) {
					if (new URL(candidate, location.href).origin !== location.origin) out.push(`${element.localName}[${name}=${candidate}]`);
				}
			}
		}
	}
	return out;
}, selector);

/** Make every media element try to load and play, as a curious user would. */
const pokeMedia = (page) => page.evaluate(async () => {
	for (const media of document.querySelectorAll('video, audio')) {
		media.muted = true;
		media.preload = 'auto';
		try { media.load(); } catch {}
		await Promise.race([media.play().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 800))]);
	}
});

try {
	// --- renderers: kept (remote media off) and control (on) -----------------------------------
	for (const remote of [false, true]) {
		const { page, seen, local } = await openPage();
		const rendered = {};
		for (const [name, text] of Object.entries(CHAT_PROBES)) {
			rendered[`chat:${name}`] = await page.evaluate(([text, remote]) => {
				const html = window.wabiRender.parseMessage(text, [], { remoteImages: remote });
				const host = document.createElement('div');
				host.className = 'probe';
				host.innerHTML = html;
				document.getElementById('out').append(host);
				return html;
			}, [text, remote]);
		}
		for (const [name, text] of Object.entries(READER_PROBES)) {
			rendered[`reader:${name}`] = await page.evaluate(([text, remote]) => {
				const html = window.wabiRender.renderReaderHtml(text, 'markdown', { remoteMedia: remote });
				const host = document.createElement('div');
				host.className = 'probe';
				host.innerHTML = html;
				document.getElementById('out').append(host);
				return html;
			}, [text, remote]);
		}
		rendered.localImage = await page.evaluate((remote) => window.wabiRender.parseMessage('<img src="/uploads/emoji/ok.png" alt="ok">', [], { remoteImages: remote }), remote);
		await pokeMedia(page);
		await page.waitForTimeout(1500);
		results[remote ? 'renderOn' : 'renderOff'] = {
			seen: [...new Set(seen)],
			endpointRequests: [...new Set(local)].filter(isServerEndpointRequest),
			rendered,
			remoteElements: await remoteElementsIn(page, '.probe')
		};
		await page.close();
	}

	// --- real message component: kept vs ordinary ----------------------------------------------
	{
		const { page, seen } = await openPage();
		await page.evaluate(([tricks, DM, TEXT]) => {
			const mount = window.wabiRender.mountMessage;
			for (const fileUrl of tricks) {
				mount({ type: 'file', text: 'Shared: a.png', fileUrl, fileName: 'a.png', fileSize: 1 }, DM, true);
				mount({ type: 'file', text: 'Shared 2 files', files: [{ fileUrl, fileName: 'a.png', fileSize: 1 }, { fileUrl, fileName: 'b.png', fileSize: 1 }] }, DM, true);
				// Ordinary rooms go through the same builder: no host change there either.
				mount({ type: 'file', text: 'Shared: a.png', fileUrl, fileName: 'a.png', fileSize: 1 }, TEXT, false);
			}
			mount({ type: 'file', text: 'Shared: clip.mp4', fileUrl: '/uploads/hls-kept.mp4', fileName: 'clip.mp4', fileSize: 5 }, DM, true);
			mount({ type: 'file', text: 'Shared 2 files', files: [{ fileUrl: '/uploads/hls-keptgallery.mp4', fileName: 'a.mp4', fileSize: 1 }, { fileUrl: '/uploads/hls-keptaudio.mp3', fileName: 'b.mp3', fileSize: 1 }] }, DM, true);
			mount({ type: 'gif', gifUrl: '//t.example.net/kept.gif', text: '' }, DM, true);
			mount({ type: 'emoji', emojiUrl: 'https://t.example.net/kept-emoji.png', emojiName: 'e' }, DM, true);
			mount({ text: 'https://t.example.net/kept-link.mp4 https://t.example.net/kept-link.png ![i](https://t.example.net/kept-md.png)' }, DM, true);
			mount({ type: 'file', text: 'Shared: x.png', fileUrl: 'https://gate.example.net/x.png', fileName: 'x.png', fileSize: 1 }, DM, true).classList.add('gated');
		}, [URL_TRICKS, DM, TEXT]);
		await pokeMedia(page);
		await page.waitForTimeout(1500);
		const keptSeen = [...new Set(seen)];
		const keptRemoteElements = await remoteElementsIn(page, '[data-probe="message"]');
		// The gate: nothing from gate.example.net until the click, then exactly that.
		const beforeClick = keptSeen.filter((url) => isRequestTo(url, 'gate.example.net'));
		await page.click('.gated .remote-media-gate__load');
		await page.waitForTimeout(800);
		const afterClick = [...new Set(seen)].filter((url) => isRequestTo(url, 'gate.example.net'));
		const keptHasPlayer = await page.evaluate(() => Boolean(document.querySelector('[data-probe="message"] video, [data-probe="message"] audio')));
		results.messageKept = { seen: keptSeen, remoteElements: keptRemoteElements, beforeClick, afterClick, keptHasPlayer };
		await page.close();
	}
	{
		// Control: the same HLS upload and remote media in a shared channel do reach other hosts.
		const { page, seen } = await openPage();
		await page.evaluate(([DM, TEXT]) => {
			const mount = window.wabiRender.mountMessage;
			mount({ type: 'file', text: 'Shared: clip.mp4', fileUrl: '/uploads/hls-control.mp4', fileName: 'clip.mp4', fileSize: 5 }, TEXT, false);
			mount({ type: 'gif', gifUrl: '//t.example.net/control.gif', text: '' }, TEXT, false);
		}, [DM, TEXT]);
		await pokeMedia(page);
		await page.waitForTimeout(2500);
		results.messageControl = { seen: [...new Set(seen)] };
		await page.close();
	}
	{
		// Observation (no app path plays decrypted audio/video inline today): is a blob: HLS
		// playlist followed to other hosts? Recorded so any future inline player knows.
		const { page, seen } = await openPage();
		await page.evaluate(async (body) => {
			const video = document.createElement('video');
			video.muted = true;
			video.preload = 'auto';
			video.src = URL.createObjectURL(new Blob([body], { type: 'video/mp4' }));
			document.body.append(video);
			video.load();
			await Promise.race([video.play().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1500))]);
		}, playlist('blob.segments.test'));
		await page.waitForTimeout(1500);
		results.blobPlaylist = { followed: seen.some((url) => isRequestTo(url, 'blob.segments.test')) };
		await page.close();
	}
} finally {
	await browser.close();
	server.close();
	await rm(work, { recursive: true, force: true });
}

const { renderOff: off, renderOn: on, messageKept: kept, messageControl: control } = results;
console.log(JSON.stringify({
	renderOff: { seen: off.seen, endpointRequests: off.endpointRequests, remoteElements: off.remoteElements },
	renderOnEndpointRequests: on.endpointRequests,
	renderOn: { seen: on.seen },
	messageKept: kept,
	messageControl: control,
	blobPlaylist: results.blobPlaylist,
	pageErrors
}, null, 2));

// Renderers.
assert.deepEqual(off.seen, [], 'renderers, remote media off: no request may reach another host');
assert.deepEqual(off.remoteElements, [], 'renderers, remote media off: no element still points at another host');
assert.deepEqual(off.endpointRequests, [], 'renderers, remote media off: no request to a server endpoint (/api/, ;params, %2F)');
assert.ok(on.endpointRequests.length >= 4, 'control: with remote media on, the proxy-URL probes do reach the server endpoint paths');
assert.ok(!/<template\b/i.test(off.rendered['reader:template']), 'kept Reader content keeps no <template>');
assert.ok(!/<(video|audio|source|track)\b/i.test(off.rendered['reader:sameOriginHls']), 'kept Reader content keeps no audio/video, same-origin included');
assert.match(off.rendered.localImage, /<img[^>]+src="\/uploads\/emoji\/ok\.png"/, 'a server-hosted image still renders');
assert.match(off.rendered['chat:markdownImage'], /<a [^>]*href="https:\/\/t\.example\.net\/md\.png"/, 'a markdown image becomes a link');
// The chat sanitizer drops srcset itself, so only the Reader's <picture> exercises srcset here.
for (const probe of ['md.png', 'alias.gif', 'pr.gif', 'reader.png', 'reader-alias.gif', 'v.mp4', 'poster.png', 'a.mp3', 'p.webp']) {
	assert.ok(on.seen.some((url) => isRequestTo(url, 't.example.net', `/${probe}`)), `control: with remote media on, ${probe} is requested (the harness sees requests)`);
}
const hlsSupported = on.seen.some((url) => isRequestTo(url, 'reader.segments.test'));

// Real message component.
assert.deepEqual(kept.seen, [], 'kept messages: no request to another host (URL tricks, HLS uploads, GIF, emoji, links)');
assert.deepEqual(kept.remoteElements, [], 'kept messages: no element points at another host');
assert.equal(kept.keptHasPlayer, false, 'kept messages: no audio/video player, same-origin included');
assert.deepEqual(kept.beforeClick, [], 'gate: nothing from the attachment host before the click');
assert.ok(kept.afterClick.some((url) => isRequestTo(url, 'gate.example.net', '/x.png')), 'gate: the click loads the attachment');
assert.ok(control.seen.some((url) => isRequestTo(url, 't.example.net', '/control.gif')), 'control: an ordinary GIF loads from its host');
if (hlsSupported) {
	assert.ok(control.seen.some((url) => isRequestTo(url, 'control.segments.test')), 'control: an ordinary same-origin .mp4 that is an HLS playlist pulls segments from another host');
} else {
	console.log('note: this Chromium build does not follow HLS; the HLS controls were skipped');
}
assert.deepEqual(pageErrors, [], 'no page errors');
console.log(`blob: HLS playlist followed to another host: ${results.blobPlaylist.followed ? 'yes' : 'no'}`);
console.log('kept-content browser smoke: ok');
