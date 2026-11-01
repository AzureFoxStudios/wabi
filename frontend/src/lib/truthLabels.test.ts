import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Truth labels (design contract §9.2, §9.4; AGENTS.md rule 13). Member-facing text never claims
// verified or operator-blind end-to-end encryption, never calls something "Beta" or "Coming soon",
// and never shows developer instruments ("not wired yet", "not yet implemented", "Xfers").
// Every Svelte component and route under src, and every locale pack, is scanned with comments and
// console lines removed. Comments are removed by loops that repeat ONE pattern until the text stops
// changing (one loop per pattern, never a single-pass or chained replace).
const SRC = new URL('..', import.meta.url).pathname;

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...svelteFiles(path));
		else if (name.endsWith('.svelte')) out.push(path);
	}
	return out;
}
function removeAll(source: string, pattern: RegExp): string {
	let previous = '';
	let current = source;
	while (current !== previous) {
		previous = current;
		current = current.replace(pattern, '');
	}
	return current;
}
function visible(source: string): string {
	let text = removeAll(source, /<!--[\s\S]*?-->/);
	text = removeAll(text, /\/\*[\s\S]*?\*\//);
	text = removeAll(text, /console\.\w+\([^\n]*/);
	// Line comments, but not the // inside a URL ("https://…").
	text = removeAll(text, /(^|[^:'"\w])\/\/[^\n]*/m);
	return text;
}

// Phrases that are never member-facing words. "E2EE" is matched case-sensitively so code
// identifiers (e2ee, E2eeRoomStatus, dm-e2ee-v1) stay allowed.
const FORBIDDEN_ANY_CASE = [/end-to-end encrypt/i, /operator-blind/i, /stores nothing permanently/i, /not wired yet/i, /coming soon/i, /\bXfers\b/, /not yet implemented/i, /server-readable by default/i, />\s*Beta\s*</];
const FORBIDDEN_EXACT = [/(['"`>]|\s)E2EE(['"`<]|\s|\.)/];

// Developer-only surfaces (they 404 outside dev builds or never ship to members).
const DEV_ONLY = ['/routes/__', '/lib/showcase/'];

describe('member-facing words stay truthful', () => {
	const files = svelteFiles(SRC).filter((path) => !DEV_ONLY.some((part) => path.includes(part)));

	test('the scan covers the app (sanity)', () => {
		expect(files.length).toBeGreaterThan(300);
	});

	test.each([...FORBIDDEN_ANY_CASE, ...FORBIDDEN_EXACT].map((pattern) => [String(pattern), pattern] as const))('no component says %s', (_name, pattern) => {
		const hits = files.filter((path) => pattern.test(visible(readFileSync(path, 'utf8')))).map((path) => path.slice(SRC.length));
		expect(hits).toEqual([]);
	});

	test('no locale pack says any of them', () => {
		for (const locale of ['en', 'es', 'th']) {
			const strings: string[] = [];
			const walk = (value: unknown) => {
				if (typeof value === 'string') strings.push(value);
				else if (value && typeof value === 'object') Object.values(value).forEach(walk);
			};
			walk(JSON.parse(readFileSync(join(SRC, 'lib/i18n/locales', `${locale}.json`), 'utf8')));
			for (const pattern of [...FORBIDDEN_ANY_CASE, /\bE2EE\b/]) {
				expect(strings.filter((text) => pattern.test(text)), `${locale}: ${pattern}`).toEqual([]);
			}
		}
	});

	test('the privacy explanation is the contract’s words where privacy is explained', () => {
		const EXPLANATION = "New DMs and groups start encryption-pending and use experimental encryption once everyone's devices are ready. Sending server-readable instead needs each sender's choice. The encryption has not been independently verified, and it does not hide everything from the server operator.";
		expect(readFileSync(join(SRC, 'routes/privacy/+page.svelte'), 'utf8')).toContain(EXPLANATION);
		expect(readFileSync(join(SRC, 'lib/components/admin/PrivacyCenter.svelte'), 'utf8')).toContain(EXPLANATION);
	});
});

describe('developer instruments are not member UI (§9.4)', () => {
	test('Media albums keeps "add item by URL" for dev builds only', () => {
		const albums = readFileSync(join(SRC, 'lib/components/media-albums/MediaAlbumsTabImpl.svelte'), 'utf8');
		const gate = albums.indexOf('{#if import.meta.env.DEV}');
		expect(gate).toBeGreaterThan(-1);
		expect(albums.indexOf('Advanced: add item by URL')).toBeGreaterThan(gate);
	});

	test('Project Assistant shows steps as sentences, never raw JSON', () => {
		const assistant = readFileSync(join(SRC, 'lib/components/ProjectAssistant.svelte'), 'utf8');
		expect(assistant).not.toContain('JSON.stringify({arguments:step.arguments');
		expect(assistant).not.toContain('JSON.stringify(run.pending');
		expect(assistant).toContain('{stepSentence(step.arguments, step.result)}');
	});

	test('Transfers names trusted people instead of raw ids', () => {
		const transfers = readFileSync(join(SRC, 'lib/components/TransferCenter.svelte'), 'utf8');
		expect(transfers).toContain('{trustedName(userId)}');
		expect(transfers).not.toMatch(/<span class="trusted-user">\{userId\}<\/span>/);
	});
});
