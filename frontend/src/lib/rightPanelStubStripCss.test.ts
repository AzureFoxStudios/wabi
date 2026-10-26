import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(new URL('./components/RightStubStrip.css', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../styles/components/main-layout-part1.css', import.meta.url), 'utf8');
const mainLayout = readFileSync(new URL('./components/MainLayout.svelte', import.meta.url), 'utf8');

type MarkupTag = { name: string; attrs: string; depth: number };
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/**
 * The element tags of a Svelte template from `from` on, with their depth below the element that
 * opens there (that element is depth 0, its children 1). Svelte blocks ({#if}) add no element, so
 * they are skipped; attribute expressions may contain '>' (arrow functions) and are skipped whole.
 */
function markupTags(source: string, from: number): MarkupTag[] {
	const found: MarkupTag[] = [];
	const open: string[] = [];
	let index = from;
	while (index < source.length) {
		const lt = source.indexOf('<', index);
		if (lt < 0) break;
		if (source.startsWith('<!--', lt)) {
			index = source.indexOf('-->', lt) + 3;
			continue;
		}
		const head = /^<(\/?)([A-Za-z][\w.:-]*)/.exec(source.slice(lt, lt + 120));
		if (!head) {
			index = lt + 1;
			continue;
		}
		let end = lt + head[0].length;
		let braces = 0;
		let quote: string | null = null;
		for (; end < source.length; end += 1) {
			const char = source[end];
			if (quote) {
				if (char === quote && source[end - 1] !== '\\') quote = null;
			} else if (char === '"' || char === "'" || char === '`') quote = char;
			else if (char === '{') braces += 1;
			else if (char === '}') braces -= 1;
			else if (char === '>' && braces === 0) break;
		}
		const [, closing, name] = head;
		const attrs = source.slice(lt + head[0].length, end);
		index = end + 1;
		if (closing) {
			expect(open.pop(), `unbalanced </${name}>`).toBe(name);
			if (open.length === 0) break;
			continue;
		}
		found.push({ name, attrs, depth: open.length });
		if (!attrs.trimEnd().endsWith('/') && !VOID_ELEMENTS.has(name)) open.push(name);
	}
	expect(open, 'the element never closes').toEqual([]);
	return found;
}

function classesOf(attrs: string): string[] {
	return (/(?:^|\s)class="([^"{]*)/.exec(attrs)?.[1] ?? '').split(/\s+/).filter(Boolean);
}

/** The classes a direct child adds to the DOM: an element's own, or a component's root element's. */
function childClasses(tag: MarkupTag): string[] {
	if (!/^[A-Z]/.test(tag.name)) return classesOf(tag.attrs);
	const component = readFileSync(new URL(`./components/${tag.name}.svelte`, import.meta.url), 'utf8');
	// The template after the scripts, without snippet definitions (they render only where used).
	// Removed until none is left, so a nested or re-formed block cannot survive one pass.
	let template = component.slice(component.lastIndexOf('</script>') + '</script>'.length);
	for (let previous = ''; previous !== template; ) {
		previous = template;
		template = template.replace(/\{#snippet[\s\S]*?\{\/snippet\}/g, '');
	}
	const first = template.search(/<(?!svelte:|style\b|!--)[A-Za-z]/);
	expect(first, `${tag.name} has no root element`).toBeGreaterThan(-1);
	return classesOf(markupTags(template, first)[0].attrs);
}

/** The direct children of the element whose opening tag starts with `openTag` in MainLayout. */
function directChildren(openTag: string): MarkupTag[] {
	const start = mainLayout.indexOf(openTag);
	expect(start, `missing ${openTag}`).toBeGreaterThan(-1);
	return markupTags(mainLayout, start).filter((tag) => tag.depth === 1);
}

function stylesheets(dir: URL): string[] {
	const root = fileURLToPath(dir);
	return (readdirSync(root, { recursive: true }) as string[])
		.filter((file) => file.endsWith('.css'))
		.map((file) => readFileSync(`${root}/${file}`, 'utf8'));
}

function rule(source: string, selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
	expect(match, `missing CSS rule: ${selector}`).not.toBeNull();
	return match?.[1] ?? '';
}

/** Every declaration block written for exactly this selector (at the start of a line), joined. */
function rules(source: string, selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const bodies = [...source.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((match) => match[1]);
	expect(bodies.length, `missing CSS rule: ${selector}`).toBeGreaterThan(0);
	return bodies.join('\n');
}

// Contract (2026 rail redesign): the rail is a slim, always-present column that reserves its own
// width; a pinned panel makes room beside center stage, a peeked one floats over it.
describe('right rail geometry', () => {
	test('the rail is a fixed full-height column hugging the stub side', () => {
		const rail = rule(css, '.rail');
		expect(rail).toContain('position: fixed');
		expect(rail).toContain('width: var(--w-rail-w)');
		expect(rule(css, '.rail.side-right')).toContain('right: 0');
		expect(rule(css, '.rail.side-left')).toContain('left: 0');
	});

	test('the stage reserves rail + pinned dock width, so a pinned panel never covers it', () => {
		const reserve = rule(layout, '.app-container.rail-on');
		expect(reserve).toContain('padding-right: calc(var(--w-rail-w, 46px) + var(--w-dock-w, 0px))');
		expect(rule(layout, '.app-container.rail-on.rail-left')).toContain('padding-left: calc(var(--w-rail-w, 46px) + var(--w-dock-w, 0px))');
	});

	test('the panel zone hangs from the rail; its width comes from the clamp, not a CSS cap', () => {
		const zone = rules(layout, '.right-panel-zone');
		expect(zone).toContain('position: fixed');
		expect(zone).toContain('right: var(--w-rail-w, 46px)');
		expect(zone).toContain('box-shadow: none');
		// dockClamp.ts decides pin vs peek and the width; a viewport cap here would fight it.
		expect(zone).not.toContain('max-width');
		expect(layout).not.toContain('55vw');
		expect(rules(layout, '.right-panel-zone.stub-left')).toContain('left: var(--w-rail-w, 46px)');
	});

	test('pinned is plane 0: flat --w-bg2 with a --w-line hairline, no gradients or accent tint', () => {
		const body = rule(layout, '.right-panel-body');
		expect(body).toContain('background: var(--w-bg2)');
		expect(body).toContain('border-left: var(--w-bw) solid var(--w-line)');
		const section = layout.slice(layout.indexOf('/* The companion zone hangs'), layout.indexOf('.server-switcher-overlay'));
		expect(section.length).toBeGreaterThan(0);
		expect(section).not.toMatch(/gradient\(/);
		expect(section).not.toMatch(/rgba?\(|#[0-9a-f]{3,8}\b/i);
		expect(section).not.toContain('--accent-primary-color');
	});

	test('a peek floats with a --w-line-strong edge and the overlay shadow', () => {
		const peek = rule(layout, '.right-panel-zone.peek');
		expect(peek).toContain('box-shadow: var(--w-shadow)');
		expect(rule(layout, '.right-panel-zone.peek .right-panel-body')).toContain('border-left-color: var(--w-line-strong)');
		expect(rule(layout, '.right-panel-zone.peek.stub-left .right-panel-body')).toContain('border-right-color: var(--w-line-strong)');
	});

	test('the stage scrim is the full --w-scrim, under the peek and the rail', () => {
		const scrim = rule(layout, '.stage-scrim');
		expect(scrim).toContain('position: fixed');
		expect(scrim).toContain('background: var(--w-scrim)');
		const zIndex = (body: string) => Number(body.match(/z-index:\s*(\d+)/)?.[1]);
		expect(zIndex(scrim)).toBeLessThan(zIndex(rules(layout, '.right-panel-zone')));
		expect(rule(layout, '.stage-scrim.closing')).toContain('pointer-events: none');
	});

	test('resize edges are invisible at rest and show a 2px --w-accent line on hover and focus', () => {
		expect(rule(layout, '.resize-handle')).toContain('background: transparent');
		const line = rule(layout, '.resize-handle::before');
		expect(line).toContain('width: 2px');
		expect(line).toContain('background: transparent');
		const active = layout.match(/\.resize-handle:hover::before,\s*\.resize-handle:focus-visible::before,\s*\.resize-handle\.dragging::before\s*\{([^}]*)\}/)?.[1];
		expect(active).toContain('background: var(--w-accent)');
	});

	test('the companion edge sits on the panel side of the hairline, never over the stage scrollbar', () => {
		expect(rule(layout, '.resize-handle-right')).toContain('left: 0');
		expect(rule(layout, '.resize-handle-right::before')).toContain('left: 0');
		expect(rule(layout, '.right-panel-zone.stub-left .resize-handle-right')).toContain('right: 0');
		expect(rule(layout, '.right-panel-zone.stub-left .resize-handle-right::before')).toContain('right: 0');
	});

	test('"Obvious grab rails" keeps a plainly visible line at rest', () => {
		expect(rule(layout, '.app-container.obvious-grab-rails .resize-handle:not(:hover, :focus-visible, .dragging)::before')).toContain('background: var(--w-mute)');
	});

	test('the focused zone draws its ring above the opaque panel body', () => {
		expect(rule(layout, '.right-panel-zone:focus-visible')).toContain('outline: none');
		const ring = rule(layout, '.right-panel-zone:focus-visible::after');
		expect(ring).toContain('outline: 2px solid var(--w-accent)');
		expect(ring).toContain('outline-offset: -2px');
		expect(ring).toContain('pointer-events: none');
		expect(ring).toMatch(/z-index:/);
	});

	// Regression (layout guard round 1): an inert wrapper around the stage parts stopped stagebar.css
	// from hiding the standalone workspace bar at 1250px and wider, so desktop showed two top bars.
	test('the stage parts stay direct children of .chat-stack (inert goes on each part, not a wrapper)', () => {
		const children = directChildren('<div class="chat-stack"');
		const names = children.map((tag) => tag.name);
		expect(names).toContain('WorkspaceViewBar');
		expect(names).toContain('VoiceLiveStrip');
		expect(children.some((tag) => classesOf(tag.attrs).includes('chat-surface'))).toBe(true);
		expect(children.every((tag) => tag.name !== 'div' || classesOf(tag.attrs).length > 0)).toBe(true);
		expect(mainLayout).not.toContain('stage-covered');
		expect(mainLayout).toMatch(/const STAGE_PARTS = '\.workspace-view-bar, \.chat-surface, \.voice-live-strip'/);
	});

	test('every rule that targets a .chat-stack child with a child combinator still matches one', () => {
		const sheets = [...stylesheets(new URL('../styles/', import.meta.url)), ...stylesheets(new URL('./components/', import.meta.url))];
		// Each compound part runs to the next '.', ':' or '(', so a selector splits only one way.
		const targets = new Set(sheets.flatMap((sheet) => [...sheet.matchAll(/\.chat-stack(?:[:.][^\s,{>:.(]*(?:\([^)]*\))?)*\s*>\s*\.([\w-]+)/g)].map((match) => match[1])));
		const present = new Set(directChildren('<div class="chat-stack"').flatMap(childClasses));
		expect(present.has('workspace-view-bar')).toBe(true);
		for (const target of targets) expect(present.has(target), `.chat-stack > .${target} no longer matches`).toBe(true);
	});

	test('a stowed pin keeps its zone mounted, but not drawn, hit or reachable', () => {
		expect(mainLayout).toContain("$: zoneMounted = $layoutStore.rightPanelMode !== 'none';");
		expect(mainLayout).toContain('{#if zoneMounted || peekClosing}');
		expect(mainLayout).toContain('inert={zoneHidden}');
		const stowed = rule(layout, '.right-panel-zone.stowed');
		expect(stowed).toContain('opacity: 0');
		expect(stowed).toContain('content-visibility: hidden');
		expect(stowed).toContain('pointer-events: none');
		// Reduced motion gives every property a 0.01ms transition: nothing inherited may hide the zone,
		// and the zone itself comes back at once.
		expect(stowed).not.toMatch(/(^|[^-])visibility:/);
		expect(rules(layout, '.right-panel-zone')).toContain('transition: none');
	});

	test('items can be reordered by drag and show where they will land', () => {
		expect(css).toContain('.stub.dragging');
		expect(css).toContain('.stub.drop-before::after');
		expect(css).toContain('.stub.drop-after::after');
	});

	test('the rail is hidden in focus mode', () => {
		expect(css).toContain('.app-container.focus-mode) .rail');
	});
});

describe('rail menu and stowed note for assistive tech', () => {
	const strip = readFileSync(new URL('./components/RightStubStrip.svelte', import.meta.url), 'utf8');
	const menu = strip.slice(strip.indexOf('aria-label="Rail options"'), strip.indexOf('{#if drawerOpen}'));

	test('the stowed note is read only as a stub description, never as loose rail text', () => {
		expect(strip).toContain('<span id={stowedNoteId} hidden>{STOWED_NOTE}</span>');
	});

	test('unavailable rail menu items stay reachable by arrow keys and explain themselves', () => {
		expect(menu.length).toBeGreaterThan(0);
		// aria-disabled keeps an item focusable (WAI-ARIA menu pattern); native disabled would skip it.
		expect(menu).not.toMatch(/\sdisabled=\{/);
		expect(menu).toContain("aria-disabled={!$dockCanPin}");
		expect(menu).toContain("{$dockCanPin ? 'Pin' : 'Pin · needs a wider window'}");
		expect(css).toContain(".context-menu-item:is(:disabled, [aria-disabled='true'])");
		// The edges guard themselves, since a focusable unavailable item can still be activated.
		expect(strip).toMatch(/if \(index < 0 \|\| target < 0 \|\| target >= \$layoutStore\.stubStrip\.length\) return;/);
	});
});
