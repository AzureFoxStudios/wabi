import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Component } from 'svelte';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ICONS, ICON_NAMES, ICON_STROKE, isIconName, type IconName } from './icons';

/** Glyphs the design contract (§6) and the reference mockups name explicitly. */
const REQUIRED: IconName[] = [
	'hash', 'book', 'forum', 'voice', 'dm', 'users', 'note', 'pages', 'sheet', 'present', 'calendarCheck',
	'bell', 'lockOpen', 'hourglass', 'lock', 'clock', 'headphones', 'micOff', 'mic', 'search', 'plus', 'x',
	'more', 'chevUp', 'chevDown', 'chevLeft', 'chevRight', 'chevUpDown', 'pin', 'clip', 'smile', 'smilePlus',
	'send', 'reply', 'forward', 'share', 'download', 'gear', 'sliders', 'check', 'bold', 'italic', 'strike',
	'link', 'code', 'heading', 'quote', 'list', 'listOrdered', 'checkSquare', 'image', 'minus', 'info', 'key',
	'shield', 'palette', 'accessibility', 'video', 'gamepad', 'puzzle', 'database', 'logout'
];

/** Collapse formatting differences so "the same drawing" is detected however it is spelled. */
function geometryKey(markup: string): string {
	return markup.replace(/\s+/g, ' ').replace(/\s*([<>/=])\s*/g, '$1').trim();
}

type IconProps = { name: IconName; size?: number | string; label?: string; class?: string };
/** Primitives under test take varied props; the assertions read the rendered markup. */
type AnyComponent = Component<any>;
let Icon: Component<IconProps>;
let directory = '';
const compiled = new Map<string, string>();

const fileUrl = (relative: string) => pathToFileURL(new URL(relative, import.meta.url).pathname).href;

/**
 * Compile one of the ui primitives for the server and write it next to its compiled
 * dependencies, so the tests render the real component without a bundler.
 */
function compileComponent(file: string): string {
	const known = compiled.get(file);
	if (known) return known;
	const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
	const code = compile(source, { generate: 'server', filename: file })
		.js.code.replace(/(from|import) ['"](svelte(?:\/[^'"]*)?)['"]/g, (_match, keyword, specifier) => `${keyword} ${JSON.stringify(import.meta.resolve(specifier))}`)
		.replace(/from ['"]\.\/icons['"]/g, `from ${JSON.stringify(fileUrl('./icons.ts'))}`)
		.replace(/from ['"]\$lib\/actions\/portal['"]/g, `from ${JSON.stringify(fileUrl('../../actions/portal.ts'))}`)
		.replace(/from ['"]\.\/(\w+)\.svelte['"]/g, (_match, name) => `from ${JSON.stringify(compileComponent(`${name}.svelte`))}`);
	const path = join(directory, file.replace(/\.svelte$/, '.mjs'));
	writeFileSync(path, code);
	const url = pathToFileURL(path).href;
	compiled.set(file, url);
	return url;
}

async function load(file: string): Promise<AnyComponent> {
	return (await import(compileComponent(file))).default;
}

/** Server-rendered markup without the hydration comments (stripped until none remain). */
const html = (component: AnyComponent, props: Record<string, unknown>) => {
	let markup = render(component, { props }).body;
	let previous;
	do {
		previous = markup;
		markup = markup.replace(/<!--[^>]*-->/g, '');
	} while (markup !== previous);
	return markup;
};

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'wabi-ui-'));
	Icon = await load('Icon.svelte');
});

afterAll(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('icon registry', () => {
	test('covers every glyph the contract names', () => {
		const missing = REQUIRED.filter((name) => !isIconName(name));
		expect(missing).toEqual([]);
	});

	test('no two names share path data (one meaning per glyph)', () => {
		const seen = new Map<string, IconName>();
		const duplicates: string[] = [];
		for (const name of ICON_NAMES) {
			const key = geometryKey(ICONS[name]);
			const first = seen.get(key);
			if (first) duplicates.push(`${first} = ${name}`);
			else seen.set(key, name);
		}
		expect(duplicates).toEqual([]);
	});

	test('entries are geometry only on the 24px grid', () => {
		const offenders: string[] = [];
		for (const name of ICON_NAMES) {
			const markup = ICONS[name];
			if (!markup.trim()) offenders.push(`${name}: empty`);
			if (/<(?!\/?(path|circle|rect|ellipse|line|polyline|polygon)\b)/.test(markup)) offenders.push(`${name}: unexpected element`);
			if (/\s(fill|stroke|stroke-width|style|class|on\w+|transform|href)=/.test(markup)) offenders.push(`${name}: presentation attribute`);
			const numbers = (markup.match(/\b(?:x|y|cx|cy|width|height)="(-?[\d.]+)"/g) ?? []).map((attr) => Number(attr.split('"')[1]));
			if (numbers.some((value) => value < 0 || value > 24)) offenders.push(`${name}: outside the 24px grid`);
		}
		expect(offenders).toEqual([]);
	});

	test('isIconName only accepts registry names', () => {
		expect(isIconName('search')).toBe(true);
		expect(isIconName('toString')).toBe(false);
		expect(isIconName('')).toBe(false);
		expect(isIconName(undefined)).toBe(false);
	});
});

describe('<Icon>', () => {
	test('every name renders its registry geometry', () => {
		const failures: string[] = [];
		for (const name of ICON_NAMES) {
			const html = render(Icon, { props: { name } }).body;
			const firstShape = ICONS[name].match(/<(path|circle|rect|ellipse)\b/)?.[1];
			if (!html.includes(`data-icon="${name}"`)) failures.push(`${name}: no svg`);
			if (!firstShape || !html.includes(`<${firstShape}`)) failures.push(`${name}: geometry missing`);
		}
		expect(failures).toEqual([]);
	});

	test('draws on the contract grid and stroke, decorative by default', () => {
		const html = render(Icon, { props: { name: 'search', size: 16 } }).body;
		expect(html).toContain('viewBox="0 0 24 24"');
		expect(html).toContain('fill="none"');
		expect(html).toContain('stroke="currentColor"');
		expect(html).toContain(`stroke-width="${ICON_STROKE}"`);
		expect(html).toContain('stroke-linecap="round"');
		expect(html).toContain('stroke-linejoin="round"');
		expect(html).toContain('width="16"');
		expect(html).toContain('height="16"');
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain('focusable="false"');
		expect(html).not.toContain('role="img"');
	});

	test('a labelled glyph is announced as an image instead of hidden', () => {
		const html = render(Icon, { props: { name: 'lock', label: 'Experimental encryption' } }).body;
		expect(html).toContain('role="img"');
		expect(html).toContain('aria-label="Experimental encryption"');
		expect(html).not.toContain('aria-hidden');
	});

	test('passes the class through and keeps the base class', () => {
		const html = render(Icon, { props: { name: 'x', class: 'close-glyph', size: '100%' } }).body;
		expect(html).toMatch(/class="w-icon close-glyph/);
		expect(html).toContain('width="100%"');
	});
});


describe('ui primitives keep their ARIA contract', () => {
	test('Segmented: a radiogroup with one tab stop on the checked key', async () => {
		const Segmented = await load('Segmented.svelte');
		const options = [90, 100, 112, 125].map((value) => ({ value, label: `${value}%` }));
		const out = html(Segmented, { label: 'Text size', options, value: 112 });
		expect(out).toContain('role="radiogroup"');
		expect(out).toContain('aria-label="Text size"');
		expect(out.match(/role="radio"/g)).toHaveLength(4);
		expect(out.match(/aria-checked="true"/g)).toHaveLength(1);
		expect(out.match(/tabindex="0"/g)).toHaveLength(1);
		expect(out).toMatch(/aria-checked="true"[^>]*tabindex="0"|tabindex="0"[^>]*aria-checked="true"/);

		// A disabled checked key cannot take focus: the first enabled key keeps the group reachable.
		const blocked = html(Segmented, {
			label: 'Density',
			options: [
				{ value: 'cozy', label: 'Cozy', disabled: true },
				{ value: 'compact', label: 'Compact' }
			],
			value: 'cozy'
		});
		expect(blocked.match(/tabindex="0"/g)).toHaveLength(1);
		expect(blocked).toMatch(/tabindex="0">\s*<span>Compact/);

		const pressed = html(Segmented, { label: 'Mode', mode: 'pressed', options: [{ value: 'write', label: 'Write' }, { value: 'read', label: 'Read' }], value: 'read' });
		expect(pressed).toContain('role="group"');
		expect(pressed).not.toContain('role="radio"');
		expect(pressed).toContain('aria-pressed="true"');
		expect(pressed).toContain('aria-pressed="false"');
	});

	test('Switch: a button with role=switch, never ON/OFF text', async () => {
		const Switch = await load('Switch.svelte');
		const off = html(Switch, { labelledby: 'motion-label' });
		expect(off).toMatch(/<button[^>]*role="switch"/);
		expect(off).toContain('aria-checked="false"');
		expect(off).toContain('aria-labelledby="motion-label"');
		expect(off).not.toMatch(/>\s*(ON|OFF|On|Off)\s*</);
		expect(html(Switch, { label: 'Reduce motion', checked: true })).toContain('aria-checked="true"');
	});

	test('Notice: errors are alerts, info and warnings are status; raw errors are never shown', async () => {
		const Notice = await load('Notice.svelte');
		const error = html(Notice, {
			title: "Couldn't load documents",
			text: 'Your drafts on this device are unchanged.',
			onretry: () => {},
			error: new Error('ECONNRESET 10.0.0.4:443')
		});
		expect(error).toContain('role="alert"');
		expect(error).toContain('data-icon="alert"');
		expect(error).toMatch(/class="w-btn w-btn--sm[^"]*"[^>]*>Retry</);
		expect(error).not.toContain('ECONNRESET');

		const info = html(Notice, { tone: 'info', title: 'Sheets is off on this device' });
		expect(info).toContain('role="status"');
		expect(info).toMatch(/class="[^"]*w-notice--info/);
		expect(info).toContain('data-icon="info"');

		const warn = html(Notice, { tone: 'warn', title: 'Unsaved changes', ondismiss: () => {} });
		expect(warn).toContain('data-icon="warn"');
		expect(warn).toContain('aria-label="Dismiss"');
	});

	test('EmptyState: list glyph or the ensō, a title, one sentence, one primary action', async () => {
		const EmptyState = await load('EmptyState.svelte');
		const list = html(EmptyState, { icon: 'forum', title: 'No threads yet', text: 'Longer conversations live here.', action: 'New thread', onaction: () => {} });
		expect(list).toContain('data-icon="forum"');
		expect(list).toMatch(/<h2[^>]*class="w-empty__title[^"]*"[^>]*>No threads yet<\/h2>/);
		expect(list.match(/w-btn--primary/g)).toHaveLength(1);
		expect(list).not.toContain('w-empty--enso');

		const top = html(EmptyState, { variant: 'top', title: 'Nothing on this device yet', as: 'p' });
		expect(top).toContain('w-empty--enso');
		expect(top).toMatch(/class="w-empty__enso[^"]*" aria-hidden="true"/);
		expect(top).not.toContain('data-icon=');
		expect(top).not.toContain('<button');
	});

	test('Skeleton: a status region with a spoken label and hidden placeholder rows', async () => {
		const Skeleton = await load('Skeleton.svelte');
		for (const variant of ['message', 'member', 'row', 'card', 'text']) {
			const out = html(Skeleton, { variant, rows: 3, label: 'Loading messages' });
			expect(out).toContain('role="status"');
			expect(out).toMatch(/class="sr-only[^"]*">Loading messages</);
			expect(out.match(/aria-hidden="true"/g)).toHaveLength(3);
			expect(out).toContain(`w-skeleton--${variant}`);
		}
	});

	test('LoadLine renders nothing while inactive', async () => {
		const LoadLine = await load('LoadLine.svelte');
		expect(html(LoadLine, { active: false })).not.toContain('w-loadline');
	});

	test('Tooltip: its markup is only the wrapper; the bubble is built in script, never a moved template node', () => {
		// A portaled template node can be the last node of the component's DOM range; unmounting
		// it inside {#each}, {#key} or mount() then removed every later sibling. The bubble is now
		// created in an effect, so the compiled templates hold no tooltip and nothing is portaled.
		const source = readFileSync(new URL('./Tooltip.svelte', import.meta.url), 'utf8');
		const client = compile(source, { generate: 'client', filename: 'Tooltip.svelte' }).js.code;
		const templates = [...client.matchAll(/from_html\(`([^`]*)`/g)].map((match) => match[1]);
		expect(templates).toHaveLength(1);
		expect(templates[0]).toMatch(/^<span class="w-tip-anchor[^"]*"><!><\/span>$/);
		expect(client).not.toMatch(/\bportal\b/);
		expect(client).not.toContain('role="tooltip"');
	});

	test('Tooltip: renders nothing of its own on the server (the bubble needs a document)', async () => {
		const Tooltip = await load('Tooltip.svelte');
		expect(html(Tooltip, { text: 'Search messages', shortcut: 'Ctrl K' }).trim()).toBe('');
	});
});
