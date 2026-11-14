/**
 * Hostile server content in a real browser (docs/audits/2026-11-hostile-server-audit.md, question 1).
 *
 * A server controls every byte of message text, Reader documents, notes and Lore documents. The real
 * renderers (markdown.ts parseMessage, readerTabHelpers.ts renderReaderHtml, notes/render.ts renderNote,
 * lore/documentMarkdown.ts renderLoreDocument) are bundled, fed classic script-injection payloads,
 * inserted into a live Chromium page and inspected:
 *
 * - no payload may run script (each tries to call window.__pwned);
 * - no rendered element may carry an event-handler attribute, a script-capable URL
 *   (javascript:, vbscript:, data:text/html), or be a script/iframe/object/embed/form/base/meta/link/style;
 * - the math placeholders injected after sanitizing (markdown.ts renderMathSlots) must not land
 *   inside an attribute, where KaTeX's markup would break out of the quoted value.
 *
 * The page's own origin serves the bundle; any request to another host is recorded and refused.
 *
 *   node scripts/hostile-server-browser-smoke.mjs
 *   WABI_SMOKE_CHROMIUM_PATH=/path/to/chrome node scripts/hostile-server-browser-smoke.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(frontend, 'src/lib');
const work = await mkdtemp(path.join(tmpdir(), 'wabi-hostile-'));
const entry = path.join(work, 'entry.ts');
const bundle = path.join(work, 'bundle.js');
const posix = (value) => value.split(path.sep).join('/');

await writeFile(entry, `
import { parseMessage } from '${posix(lib)}/markdown';
import { renderReaderHtml } from '${posix(lib)}/components/readerTabHelpers';
import { renderNote } from '${posix(lib)}/notes/render';
import { renderLoreDocument } from '${posix(lib)}/lore/documentMarkdown';
import { renderWikiBody } from '${posix(lib)}/wiki/renderWikiBody';
window.wabiRender = {
	chat: (text) => parseMessage(text, []),
	chatKept: (text) => parseMessage(text, [], { remoteImages: false }),
	chatTables: (text) => parseMessage(text, [], { allowTables: true }),
	reader: (text) => renderReaderHtml(text, 'markdown'),
	readerHtml: (text) => renderReaderHtml(text, 'html'),
	readerKept: (text) => renderReaderHtml(text, 'html', { remoteMedia: false }),
	wiki: (text) => renderWikiBody(text, (title) => (title.trim() === 'Home' ? { pageId: 7 } : null)),
	note: (text) => renderNote(text),
	lore: (text) => renderLoreDocument(text)
};
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
	define: { 'import.meta.env.DEV': 'false', 'import.meta.env.SSR': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env': '{}' },
	logLevel: 'error',
	plugins: [{
		name: 'wabi',
		setup(builder) {
			builder.onResolve({ filter: /\?(raw|url|worker|inline)$/ }, () => ({ path: 'asset', namespace: 'stub' }));
			builder.onResolve({ filter: /^(path|fs|crypto)$/ }, () => ({ path: 'module', namespace: 'stub' }));
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
		}
	}]
});

const script = await readFile(bundle, 'utf8');
// The real stylesheets the chat renderer ships with (bundling drops CSS), so boxes measure true.
const mathCss = (await readFile(path.join(frontend, 'node_modules/katex/dist/katex.min.css'), 'utf8')).replace(/url\([^)]*\)/g, 'none')
	+ '\n' + await readFile(path.join(lib, 'katexContain.css'), 'utf8');
const server = createServer((request, response) => {
	const url = new URL(request.url, 'http://local');
	if (url.pathname === '/') {
		response.writeHead(200, { 'content-type': 'text/html' });
		response.end('<!doctype html><meta charset="utf-8"><title>hostile</title><style>' + mathCss + '#out > div { width: 600px; margin: 40px auto; }</style><body><div id="out"></div>'
			+ '<script>window.__pwned = []; window.pwn = (tag) => window.__pwned.push(String(tag));'
			+ 'sessionStorage.setItem("wabi.serverUrlSession", location.origin)</script><script src="/bundle.js"></script></body>');
	} else if (url.pathname === '/bundle.js') {
		response.writeHead(200, { 'content-type': 'text/javascript' });
		response.end(script);
	} else {
		response.writeHead(204);
		response.end();
	}
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// Every payload tries to call pwn('<name>') if it ever runs.
const P = (name) => `pwn('${name}')`;
const PAYLOADS = {
	scriptTag: `<script>${P('scriptTag')}</script>`,
	imgOnerror: `<img src=x onerror="${P('imgOnerror')}">`,
	svgOnload: `<svg onload="${P('svgOnload')}"></svg>`,
	svgScript: `<svg><script>${P('svgScript')}</script></svg>`,
	iframeSrcdoc: `<iframe srcdoc="<script>parent.${P('iframeSrcdoc')}</script>"></iframe>`,
	iframeJs: `<iframe src="javascript:parent.${P('iframeJs')}"></iframe>`,
	objectData: `<object data="data:text/html,<script>parent.${P('objectData')}</script>"></object>`,
	embed: `<embed src="data:text/html,<script>${P('embed')}</script>">`,
	formAction: `<form action="javascript:${P('formAction')}"><button>go</button></form>`,
	base: '<base href="https://evil.test/">',
	metaRefresh: '<meta http-equiv="refresh" content="0;url=https://evil.test/">',
	linkStylesheet: '<link rel="stylesheet" href="https://evil.test/x.css">',
	styleTag: '<style>body{background:url(https://evil.test/css.png)}</style>',
	styleAttr: '<span style="background:url(https://evil.test/sa.png)">x</span>',
	detailsToggle: `<details open ontoggle="${P('detailsToggle')}">x</details>`,
	mathml: `<math><mtext><table><mglyph><style><img src=x onerror="${P('mathml')}">`,
	noscriptMxss: `<noscript><p title="</noscript><img src=x onerror=${P('noscriptMxss')}>">`,
	mdJsLink: `[click](javascript:${P('mdJsLink')})`,
	mdJsLinkEntity: `[click](jav&#x09;ascript:${P('mdJsLinkEntity')})`,
	mdJsLinkCase: `[click](JaVaScRiPt:${P('mdJsLinkCase')})`,
	mdDataLink: `[click](data:text/html,<script>${P('mdDataLink')}</script>)`,
	mdVbLink: '[click](vbscript:msgbox(1))',
	htmlJsLink: `<a href="javascript:${P('htmlJsLink')}">x</a>`,
	htmlJsLinkSpaced: `<a href=" &#14;javascript:${P('htmlJsLinkSpaced')}">x</a>`,
	mdImageJs: `![x](javascript:${P('mdImageJs')})`,
	mdLinkTitleQuote: `[x](https://ok.test "a\\" onmouseover=\\"${P('mdLinkTitleQuote')}")`,
	autolink: `<javascript:${P('autolink')}>`,
	codeFence: '```html\n<img src=x onerror="' + P('codeFence') + '">\n```',
	inlineCode: '`<img src=x onerror="' + P('inlineCode') + '">`',
	spoiler: `||<img src=x onerror="${P('spoiler')}">||`,
	mention: `@<img/src/onerror=${P('mention')}>`,
	channelRef: `#x"><img src=x onerror=${P('channelRef')}>`,
	emoteInAttr: `[x](https://ok.test/:smile: "t")`,
	katexHref: `$\\href{javascript:${P('katexHref')}}{x}$`,
	katexUrl: `$\\url{javascript:${P('katexUrl')}}$`,
	katexHtmlData: `$\\htmlData{onclick=${P('katexHtmlData')}}{x}$`,
	katexError: `$\\frac{<img src=x onerror=${P('katexError')}>$`,
	mathInLinkTitle: '[x](https://ok.test "$x$")',
	katexGlyphs: '$\\sqrt{x^2} + \\overrightarrow{AB} + \\frac{a}{b}$',
	katexHugeRule: '$\\rule{100000em}{100000em}$ $\\kern{99999em}$',
	katexNegativeKern: 'a $x\\kern-5000em y$ b',
	katexNegativeHspace: '$$x\\hspace{-9000em}y$$',
	katexRaisebox: '$\\raisebox{-900em}{x}$ and $\\raisebox{900em}{y}$',
	katexStackedRules: '$$' + Array.from({ length: 60 }, () => '\\rule{20em}{20em}').join('\\\\') + '$$',
	mathInLinkHref: '[x](https://ok.test/$x$)',
	mathInImageAlt: '![$x$](/uploads/a.png)',
	mathErrorInTitle: `[x](https://ok.test "$\\frac{onmouseover=${P('mathErrorInTitle')}$")`,
	literalMathToken: '[x](https://ok.test "WABIMATH0X") $y$',
	literalCodeToken: '[x](https://ok.test "WABI_CODE_0_X") `y`',
	entityToken: 'WABI_ENTITY_0_X <img src=x onerror=' + P('entityToken') + '>',
	table: `| a |\n|---|\n| <img src=x onerror=${P('table')}> |`,
	htmlComment: `<!--><img src=x onerror=${P('htmlComment')}>-->`,
	nestedQuotes: `<a title="<img src=x onerror=${P('nestedQuotes')}>">x</a>`,
	svgUse: '<svg><use href="data:image/svg+xml,<svg id=x xmlns=http://www.w3.org/2000/svg><image href=1 onerror=pwn(1) /></svg>#x"/></svg>',
	dataSvgImg: '<img src="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 onload=%22pwn(1)%22/>">'
};
// F1 (review of this PR): a math or wiki placeholder inside a URL attribute must never be cut out
// after sanitizing, or `ja<marker>vascript:` becomes `javascript:`. Every marker spelling, in every
// URL-bearing attribute; the literal spellings are what a member can type.
const MARKERS = {
	inlineMath: '$x$',
	displayMath: '$$x$$',
	parenMath: '\\(x\\)',
	bracketMath: '\\[x\\]',
	envMath: '\\begin{aligned}x\\end{aligned}',
	literalMathOld: 'WABIMATH9X',
	literalMathOld0: 'WABIMATH0X',
	literalWikiOld: 'wabiwikilinkx9x',
	literalWikiOld0: 'wabiwikilinkx0x',
	wikiLink: '[[Home]]'
};
const ATTR_FORMS = {
	href: (m, n) => `<a href="ja${m}vascript:${P(n)}">click me</a>`,
	hrefSplitScheme: (m, n) => `<a href="java${m}script:${P(n)}">click me</a>`,
	src: (m, n) => `<img src="ja${m}vascript:${P(n)}">`,
	xlinkHref: (m, n) => `<svg><a xlink:href="ja${m}vascript:${P(n)}"><text>click me</text></a></svg>`,
	action: (m, n) => `<form action="ja${m}vascript:${P(n)}"><button>click me</button></form>`,
	formaction: (m, n) => `<button formaction="ja${m}vascript:${P(n)}">click me</button>`,
	style: (m, n) => `<span style="background:url(ja${m}vascript:${P(n)})">click me</span>`
};
for (const [markerName, marker] of Object.entries(MARKERS)) {
	for (const [formName, form] of Object.entries(ATTR_FORMS)) {
		const name = `marker_${markerName}_${formName}`;
		// A real slot elsewhere in the message, so literal markers would match one if they could.
		PAYLOADS[name] = `${form(marker, name)} and $y$ and [[Home]]`;
	}
}
const RENDERERS = ['chat', 'chatKept', 'chatTables', 'wiki', 'reader', 'readerHtml', 'readerKept', 'note', 'lore'];

const browser = await chromium.launch(process.env.WABI_SMOKE_CHROMIUM_PATH ? { executablePath: process.env.WABI_SMOKE_CHROMIUM_PATH } : {});
const pageErrors = [];
const dialogs = [];
const foreign = [];
const page = await browser.newPage();
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
await page.route('**/*', async (route) => {
	const url = route.request().url();
	if (new URL(url).origin === origin) return route.continue();
	foreign.push(url);
	return route.fulfill({ status: 404 });
});
await page.goto(origin);
await page.waitForFunction(() => Boolean(window.wabiRender));

const result = await page.evaluate(async ({ payloads, renderers }) => {
	const out = document.getElementById('out');
	const findings = [];
	const rendered = {};
	const BAD_TAGS = new Set(['SCRIPT', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'FORM', 'BASE', 'META', 'LINK', 'STYLE', 'TEMPLATE', 'FOREIGNOBJECT']);
	const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster', 'background'];
	// An SVG in <img src> cannot run script (image context), so data:image/svg is flagged only elsewhere.
	const scriptUrl = (value, tag, attr) => {
		const compact = String(value).replace(/[\x00-\x20]+/g, '');
		if (/^(javascript|vbscript|data:text\/html)/i.test(compact)) return true;
		return /^data:image\/svg/i.test(compact) && !(tag === 'IMG' && attr === 'src');
	};
	for (const renderer of renderers) {
		for (const [name, payload] of Object.entries(payloads)) {
			const key = `${renderer}:${name}`;
			let html;
			try {
				html = window.wabiRender[renderer](payload);
			} catch (error) {
				findings.push(`${key}: renderer threw ${error}`);
				continue;
			}
			rendered[key] = html;
			const host = document.createElement('div');
			host.dataset.key = key;
			host.innerHTML = html;
			out.append(host);
			for (const element of host.querySelectorAll('*')) {
				const tag = element.tagName.toUpperCase();
				if (BAD_TAGS.has(tag)) findings.push(`${key}: <${tag.toLowerCase()}> element`);
				const inKatex = Boolean(element.closest('.katex, .katex-display, .katex-error'));
				for (const attribute of element.attributes) {
					const attr = attribute.name.toLowerCase();
					if (attr.startsWith('on')) findings.push(`${key}: event attribute ${attr} on <${tag.toLowerCase()}>`);
					if (URL_ATTRS.includes(attr) && scriptUrl(attribute.value, tag, attr)) findings.push(`${key}: script URL in ${attr}="${attribute.value}"`);
					if (attr === 'style' && !inKatex) findings.push(`${key}: style attribute outside KaTeX output`);
					// A real per-render marker must never be left in an attribute (a literal old-style
					// WABIMATH9X a member typed is plain text and matches nothing).
					if (/class=|<span/i.test(attribute.value) || /WABIMATH[0-9a-f]+N\d+X|wabiwikilink[0-9a-f]+n\d+x/.test(attribute.value)) findings.push(`${key}: markup or placeholder inside ${attr}="${attribute.value.slice(0, 60)}"`);
					if (!/^[a-z][a-z0-9:_-]*$/.test(attr)) findings.push(`${key}: malformed attribute name ${JSON.stringify(attr)} (markup broke out of a quoted value)`);
				}
			}
		}
	}
	// N5: every formula is a clipping box inside its message, whatever offsets its TeX asks for.
	const mathEscapes = [];
	let mathBoxes = 0;
	for (const host of out.children) {
		const outer = host.getBoundingClientRect();
		for (const root of host.querySelectorAll('.katex-display, .katex:not(.katex-display .katex)')) {
			mathBoxes += 1;
			const box = root.getBoundingClientRect();
			const style = getComputedStyle(root);
			const clips = style.overflow !== 'visible' && /paint|strict|content/.test(style.contain);
			const inside = box.left >= outer.left - 1 && box.right <= outer.right + 1 && box.top >= outer.top - 1 && box.bottom <= outer.bottom + 1;
			if (!clips || !inside) mathEscapes.push(`${host.dataset.key}: clips=${clips} box=${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)}x${Math.round(box.height)} message=${Math.round(outer.left)},${Math.round(outer.top)},${Math.round(outer.width)}x${Math.round(outer.height)}`);
		}
	}
	// Give any onload/onerror/timer a chance to fire.
	await new Promise((resolve) => setTimeout(resolve, 500));
	// Click every link and button. Ordinary web links are stopped before they navigate; anything
	// else is allowed to proceed, so a script URL that survived would run and call pwn().
	let clicked = 0;
	for (const element of out.querySelectorAll('a, button, [href], [formaction]')) {
		const raw = element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? element.getAttribute('formaction') ?? '';
		let web = false;
		try { web = ['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(raw, location.href).protocol) && !/^\s*[a-z][a-z0-9+.-]*:/i.test(raw.replace(/^(https?|mailto|tel):/i, '')); } catch {}
		if (!raw || web) element.addEventListener('click', (event) => event.preventDefault(), { once: true, capture: true });
		const form = element.closest('form');
		if (form) form.addEventListener('submit', (event) => { if (!/^javascript:/i.test(form.getAttribute('action') ?? '')) event.preventDefault(); }, { once: true });
		element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		clicked += 1;
		// A javascript: navigation runs as a task; the next click would cancel it, so let it run.
		if (raw && !web) await new Promise((resolve) => setTimeout(resolve, 25));
	}
	await new Promise((resolve) => setTimeout(resolve, 500));
	return { findings, pwned: [...window.__pwned], rendered, clicked, mathEscapes, mathBoxes };
}, { payloads: PAYLOADS, renderers: RENDERERS });

await browser.close();
server.close();
await rm(work, { recursive: true, force: true });

if (process.env.WABI_SMOKE_VERBOSE) console.log(JSON.stringify(result.rendered, null, 2));
console.log(JSON.stringify({ findings: result.findings, pwned: result.pwned, dialogs, foreign, pageErrors }, null, 2));

// Controls: the harness renders real markup, so a check that sees nothing cannot pass.
assert.match(result.rendered['chat:mathInLinkTitle'] ?? '', /<a /, 'control: the chat renderer produced a link');
assert.match(result.rendered['chat:katexError'] ?? '', /katex/, 'control: math reached KaTeX');
assert.match(result.rendered['reader:codeFence'] ?? '', /<pre/i, 'control: the Reader renders markdown');
assert.match(result.rendered['chat:mathInLinkTitle'] ?? '', /title="x"/, 'math inside a link title is kept as its TeX source, as plain text');
assert.doesNotMatch(result.rendered['chat:mathInLinkHref'] ?? '', /href=/, 'an href holding math is dropped whole, never edited');
assert.match(result.rendered['chat:mathInLinkHref'] ?? '', />x<\/a>/, 'the link text survives');
assert.match(result.rendered['wiki:marker_wikiLink_href'] ?? '', /href="#wikipage-7"/, 'control: a real wiki link is inserted');
assert.doesNotMatch(result.rendered['wiki:marker_wikiLink_href'] ?? '', /javascript/i, 'a wiki marker inside an href never leaves javascript: behind');
assert.match(result.rendered['chat:katexGlyphs'] ?? '', /<svg[^>]*>[\s\S]*<path[^>]* d="/, 'KaTeX SVG glyphs survive the final sanitizer pass');
assert.match(result.rendered['chat:katexGlyphs'] ?? '', /class="katex"[\s\S]*style="/, 'KaTeX inline styles survive the final sanitizer pass');
for (const size of (result.rendered['chat:katexHugeRule'] ?? '').matchAll(/(-?[\d.]+)em/g)) {
	assert.ok(Math.abs(Number(size[1])) <= 21, `KaTeX sizes are capped (saw ${size[0]})`);
}
assert.ok(result.mathBoxes > 30, `control: formulas were measured (${result.mathBoxes})`);
assert.deepEqual(result.mathEscapes, [], 'no formula draws outside its own clipped box or its message');
assert.ok(result.clicked > 200, `the smoke clicked every link and button (${result.clicked})`);

assert.deepEqual(result.pwned, [], 'no hostile payload ran script');
assert.deepEqual(dialogs, [], 'no hostile payload opened a dialog');
assert.deepEqual(result.findings, [], 'no rendered element carries handlers, script URLs, dangerous tags or broken attributes');
assert.deepEqual(foreign, [], 'rendering hostile text made no request to another host');
assert.deepEqual(pageErrors, [], 'no page errors');
console.log(`hostile-server browser smoke: ok (${Object.keys(PAYLOADS).length} payloads x ${RENDERERS.length} renderers)`);
