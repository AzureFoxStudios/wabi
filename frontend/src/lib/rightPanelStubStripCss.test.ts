import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(new URL('./components/RightStubStrip.css', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../styles/components/main-layout-part1.css', import.meta.url), 'utf8');
const mainLayout = readFileSync(new URL('./components/MainLayout.svelte', import.meta.url), 'utf8');
const panelCss = readFileSync(new URL('./components/RightPanel.css', import.meta.url), 'utf8');
const panelSvelte = readFileSync(new URL('./components/RightPanel.svelte', import.meta.url), 'utf8');
const panelSkin = readFileSync(new URL('../styles/surfaces/panel.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
/** `var(--w-rail-w)`, with or without a fallback (MainLayout's sheet may still carry one). */
const RAIL_W = String.raw`var\(--w-rail-w(?:, \d+px)?\)`;

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
		expect(reserve).toMatch(new RegExp(String.raw`padding-right: calc\(${RAIL_W} \+ var\(--w-dock-w, 0px\)\)`));
		expect(rule(layout, '.app-container.rail-on.rail-left')).toMatch(new RegExp(String.raw`padding-left: calc\(${RAIL_W} \+ var\(--w-dock-w, 0px\)\)`));
	});

	test('the panel zone hangs from the rail; its width comes from the clamp, not a CSS cap', () => {
		const zone = rules(layout, '.right-panel-zone');
		expect(zone).toContain('position: fixed');
		expect(zone).toMatch(new RegExp(`right: ${RAIL_W}`));
		expect(zone).toContain('box-shadow: none');
		// dockClamp.ts decides pin vs peek and the width; a viewport cap here would fight it.
		expect(zone).not.toContain('max-width');
		expect(layout).not.toContain('55vw');
		expect(rules(layout, '.right-panel-zone.stub-left')).toMatch(new RegExp(`left: ${RAIL_W}`));
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
		// The stage masthead (StageBar, §7.23) is one of the parts: it is mounted once above every workspace.
		expect(names).toContain('StageBar');
		expect(names).toContain('VoiceLiveStrip');
		expect(children.some((tag) => classesOf(tag.attrs).includes('chat-surface'))).toBe(true);
		expect(children.every((tag) => tag.name !== 'div' || classesOf(tag.attrs).length > 0)).toBe(true);
		expect(mainLayout).not.toContain('stage-covered');
		expect(mainLayout).toMatch(/const STAGE_PARTS = '\.stage-bar, \.chat-surface, \.voice-live-strip'/);
	});

	test('every rule that targets a .chat-stack child with a child combinator still matches one', () => {
		const sheets = [...stylesheets(new URL('../styles/', import.meta.url)), ...stylesheets(new URL('./components/', import.meta.url))];
		// Each compound part runs to the next '.', ':' or '(', so a selector splits only one way.
		const targets = new Set(sheets.flatMap((sheet) => [...sheet.matchAll(/\.chat-stack(?:[:.][^\s,{>:.(]*(?:\([^)]*\))?)*\s*>\s*\.([\w-]+)/g)].map((match) => match[1])));
		const present = new Set(directChildren('<div class="chat-stack"').flatMap(childClasses));
		expect(present.has('stage-bar')).toBe(true);
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
		// A plain stylesheet: Svelte's :global() would make the whole rule invalid here.
		expect(rule(css, '.app-container.focus-mode .rail')).toContain('display: none');
		expect(css).not.toContain(':global(');
		expect(panelCss).not.toContain(':global(');
	});
});

// Contract §7.22: 44px on --w-bg, vertical sans labels, the pinned stub a folder tab joined to the panel.
describe('stub rail (§7.22)', () => {
	test('the rail is 44px from tokens.css: no later override of --w-rail-w', () => {
		expect(tokens).toMatch(/--w-rail-w:\s*44px/);
		expect(css).not.toMatch(/--w-rail-w\s*:/);
		expect(css).not.toContain('46px');
	});

	test('the rail is page plane --w-bg with a hairline toward the stage, none where a pin joins it', () => {
		expect(rule(css, '.rail')).toContain('background: var(--w-bg)');
		expect(rule(css, '.rail.side-right')).toContain('box-shadow: inset var(--w-bw) 0 0 var(--w-line)');
		expect(rule(css, '.rail.side-left')).toContain('box-shadow: inset calc(-1 * var(--w-bw)) 0 0 var(--w-line)');
		expect(rule(css, '.rail.joined')).toContain('box-shadow: none');
	});

	test('stubs: 18px glyph over a vertical sans 500 11px label, padding 12 0 14, --w-mute', () => {
		const stub = rule(css, '.stub');
		expect(stub).toContain('padding: 12px 0 14px');
		expect(stub).toContain('color: var(--w-mute)');
		expect(stub).not.toMatch(/transition:\s*all/);
		const icon = rule(css, '.stub-icon');
		expect(icon).toContain('width: 18px');
		expect(icon).toContain('height: 18px');
		const label = rule(css, '.stub-label');
		expect(label).toContain('writing-mode: vertical-rl');
		expect(label).toContain('font: 500 calc(11px * var(--w-fs)) / 1 var(--w-sans)');
		expect(label).toContain('letter-spacing: 0.06em');
		expect(label).not.toContain('rotate');
		expect(rule(css, '.stub:hover')).toContain('background: color-mix(in srgb, var(--w-raise) 60%, transparent)');
		expect(rule(css, '.stub:focus-visible')).toContain('outline-offset: -2px');
	});

	test('the pinned stub is a folder tab: --w-bg2 fill, three outer hairlines, outer radius, --w-sig glyph', () => {
		expect(rules(css, '.stub.pinned,\n.stub.pinned:hover')).toContain('background: var(--w-bg2)');
		const right = rule(css, '.rail.side-right .stub.pinned');
		expect(right).toContain('inset 0 var(--w-bw) 0 var(--w-line)');
		expect(right).toContain('inset 0 calc(-1 * var(--w-bw)) 0 var(--w-line)');
		expect(right).toContain('inset calc(-1 * var(--w-bw)) 0 0 var(--w-line)');
		expect(right).not.toMatch(/inset var\(--w-bw\) 0 0/);
		expect(rule(css, '.rail.side-left .stub.pinned')).toContain('inset var(--w-bw) 0 0 var(--w-line)');
		expect(rule(css, '.stub')).toContain('border-radius: 0 var(--radius-md) var(--radius-md) 0');
		expect(rule(css, '.stub.pinned .stub-icon')).toContain('color: var(--w-sig)');
		// No accent ring or accent-soft pill: accent means state, the tab means place.
		expect(css).not.toContain('--w-accent-soft');
	});

	test('a peeked stub is a --w-raise fill with no tab join; a stowed pin has a quiet cue', () => {
		const peeked = rule(css, '.stub.peeked');
		expect(peeked).toContain('background: var(--w-raise)');
		expect(peeked).not.toContain('box-shadow');
		expect(rule(css, '.stub.stowed::before')).toContain('dashed var(--w-line-strong)');
	});

	test('High Contrast rings hover instead of filling it', () => {
		expect(rule(css, ":root[data-char='contrast'] .stub:not(.pinned):hover")).toContain('box-shadow: inset 0 0 0 1px var(--w-line-strong)');
	});

	test('badges are the kit small ink badge with a ring in the surface colour', () => {
		const strip = readFileSync(new URL('./components/RightStubStrip.svelte', import.meta.url), 'utf8');
		expect(strip).toContain('class="stub-badge w-badge w-badge--sm w-badge--ring"');
		expect(rule(css, '.stub-badge')).toContain('--w-badge-ring: var(--w-bg)');
		expect(rule(css, '.stub.pinned .stub-badge')).toContain('--w-badge-ring: var(--w-bg2)');
		expect(css).not.toContain('--w-on-accent');
	});

	test('"Add panels" sits in the 80px footer band under the footer rule', () => {
		const foot = rule(css, '.w-rail__foot');
		expect(foot).toContain('height: var(--w-foot, 80px)');
		expect(foot).toContain('border-top: var(--w-bw) solid var(--w-line)');
	});

	// Regression (review round 1): the stub list was `.rail-list`, a class the server rail also uses.
	// server-rail.css's padding pushed the folder tab 3px below the y = 96 rule, and this global sheet
	// restyled the server rail's list in turn.
	test('the stub list and footer have their own class names, shared with no other rail', () => {
		const strip = readFileSync(new URL('./components/RightStubStrip.svelte', import.meta.url), 'utf8');
		const serverRail = readFileSync(new URL('./components/ServerRail.svelte', import.meta.url), 'utf8');
		expect(strip).toContain('<div class="w-rail__list">');
		expect(strip).toContain('<div class="w-rail__foot">');
		expect(strip).not.toMatch(/class="rail-(list|foot)"/);
		expect(css).not.toMatch(/(^|[\s,}])\.rail-(list|foot)\b/m);
		expect(serverRail).not.toMatch(/w-rail__/);
		const list = rule(css, '.w-rail__list');
		expect(list).toContain('padding: 0');
		expect(list).toContain('gap: 2px');
		// The first stub starts 8px down the rail, so an 88px folder tab ends on the masthead rule.
		expect(rule(css, '.rail')).toContain('padding: 8px 0 0');
	});

	test('tooltips are the portaled kit tooltip, never a clipped ::after', () => {
		const strip = readFileSync(new URL('./components/RightStubStrip.svelte', import.meta.url), 'utf8');
		expect(css).not.toContain('attr(data-tip)');
		expect(strip).not.toContain('data-tip=');
		expect(strip).toContain("import Tooltip from './ui/Tooltip.svelte'");
		expect(strip).toMatch(/<Tooltip text=\{stubTip\(panel\)\} placement=\{tipSide\}/);
	});

	test('rail chrome is on roles only: no raw colours, legacy tokens or gradients', () => {
		expect(css).not.toMatch(/rgba?\(|#[0-9a-f]{3,8}\b|gradient\(/i);
		expect(css).not.toMatch(/--(surface|text|accent-primary|border)-/);
	});
});

// Contract §7.21: one frame for every companion.
describe('companion panel frame (§7.21)', () => {
	test('row A is 56px with a serif heading title and a mono count; row B is 40px with the masthead rule', () => {
		const rowA = rule(panelCss, '.w-panel__a');
		expect(rowA).toContain('height: var(--w-head-a, 56px)');
		expect(rule(panelCss, '.w-panel__title')).toContain('font: var(--w-t-heading)');
		expect(rule(panelCss, '.w-panel__count')).toContain('font: var(--w-t-mono)');
		const rowB = rule(panelCss, '.w-panel__b');
		expect(rowB).toContain('height: var(--w-head-b, 40px)');
		expect(rowB).toContain('border-bottom: var(--w-bw) solid var(--w-line)');
	});

	test('the frame paints no surface of its own: no gradients, glows or legacy tokens', () => {
		expect(panelCss).not.toMatch(/gradient\(|rgba?\(|#[0-9a-f]{3,8}\b/i);
		expect(panelCss).not.toMatch(/--(surface|text|accent-primary|border)-|--accent-rgb/);
		expect(rule(panelCss, '.right-panel')).not.toContain('background');
	});

	test('row A holds Open in center stage, Pin (peek with room) and Unpin/Close as icon buttons', () => {
		expect(panelSvelte).toContain("iconAction('Open in center stage', 'expand'");
		expect(panelSvelte).toContain("iconAction('Pin beside the page', 'pin'");
		expect(panelSvelte).toContain("iconAction(closeLabel(panel), 'x'");
		// The × of a peek ends the peek; an explicit Unpin takes only that panel (never closeRightPanel).
		expect(panelSvelte).toMatch(/if \(shownAsPeek\(panel\)\) endPeek\(\);\s*else layoutStore\.unpinOne\(panel\.id\);/);
		expect(panelSvelte).not.toContain('closeRightPanel');
	});

	// Regression (review round 1): "Open in center stage" removes this panel only. The DM route
	// asked MainLayout for nothing, so it closed every pin, a stowed one under the peek included.
	test('Open in center stage keeps the other pins: every route asks to keep the companion', () => {
		const open = panelSvelte.slice(panelSvelte.indexOf('function openInStage'), panelSvelte.indexOf('function toggleSection'));
		expect(open.length).toBeGreaterThan(0);
		const navigations = [...open.matchAll(/view: '(dm|chat)'[^}]*\}/g)].map((match) => match[0]);
		expect(navigations.length).toBe(3);
		for (const detail of navigations) expect(detail).toContain('preserveRightPanel: true');
		expect(open).toContain('if (pinned) layoutStore.unpinOne(panel.id);');
		expect(open).toContain('if (!endPeek() && !pinned) dismissPeek();');
	});

	// Regression (review round 1): the Wiki/Forum action used the raw stored choice, so a deleted
	// channel kept "Open in center stage" and navigated to a dead id.
	test('Open in center stage uses the channel the companion shows, not the stored choice', () => {
		const stage = panelSvelte.slice(panelSvelte.indexOf('function stageChannelFor'), panelSvelte.indexOf('function canOpenInStage'));
		expect(stage).toContain('panelChannelShown(panel.component, $panelChannelChoice, $panelChannelPicking, $channels, $currentChannel)');
		expect(stage).not.toMatch(/\$panelChannelChoice\.(wiki|forum)/);
	});

	test('stacked mode: 40px section headers that collapse, no ↑ ↓ × text glyphs', () => {
		expect(rule(panelCss, '.w-panel__sec')).toContain('height: 40px');
		expect(rules(panelCss, '.w-panel__sec-toggle')).toContain('font: 600 calc(15px * var(--w-fs))');
		// The top section's header is row A (56): the masthead rule stays at y = 96 in a stack too.
		expect(rule(panelCss, '.dock-section:first-child .w-panel__sec')).toContain('height: var(--w-head-a, 56px)');
		expect(panelSvelte).toContain('aria-expanded={!folded}');
		expect(panelSvelte).not.toMatch(/>[↑↓×]</);
	});

	// §7.21: a section header is title + count + chevron. Unpin lives on the rail; a section offers
	// Open in center stage like the panel's own row A; a stack held open as a peek gets a Close that
	// ends the peek and keeps the pins (its × used to unpin saved pins).
	test('stacked headers: no Unpin ×, Open in center stage where offered, Close only for a peek', () => {
		const stacked = panelSvelte.slice(panelSvelte.indexOf('{#if view.stacked}'), panelSvelte.indexOf('{:else if view.panel}'));
		expect(stacked.length).toBeGreaterThan(0);
		expect(stacked).not.toContain('Unpin');
		expect(stacked).not.toContain('unpinOne');
		expect(stacked).toContain("iconAction('Open in center stage', 'expand', () => openInStage(panel))");
		expect(stacked).toMatch(/\{#if index === 0 && stackShownAsPeek\}\s*(<!--[^>]*-->\s*)?\{@render iconAction\(stackCloseLabel, 'x', \(\) => endPeek\(\)\)\}/);
		expect(panelSvelte).toContain('const stackShownAsPeek = $derived(peeking && !$dockCanPin && otherPanel === null);');
	});

	// Review round 1: the sections split 50/50 and cut People mid-row above a mostly empty DMs section.
	test('stacked sections take their content up to an equal share, not a fixed split', () => {
		const stack = rule(panelCss, '.dock-stack');
		expect(stack).toContain('display: grid');
		expect(rule(panelCss, '.dock-section')).not.toMatch(/flex:\s*1 1 0/);
		expect(panelSvelte).toContain("collapsed.includes(panel.id) ? 'max-content' : 'minmax(120px, auto)'");
		expect(panelSvelte).toContain('style:grid-template-rows={stackRows}');
	});

	test('pins under a peek of another panel stay mounted, hidden', () => {
		expect(panelSvelte).toContain('hidden={view.hidden}');
		expect(rule(panelCss, '.w-panel__view[hidden]')).toContain('display: none');
	});

	test('panel field skin skips kit fields and dialogs opened from the panel; no frost', () => {
		const head = panelSkin.slice(0, panelSkin.indexOf('/* HELD FOR'));
		expect(head).toContain(":not(.w-field, .w-field *, .w-select, .w-select *, .modal-overlay *, [role='dialog'] *)");
		expect(head).not.toMatch(/backdrop-filter|!important|data-ambient/);
	});

	// §7.3: a chrome field (panel search) sits on the --w-line edge, like the kit's .w-field--chrome;
	// --w-line-strong is the form edge. Daylight uses the kit's 16% text mix so it reads at rest.
	test('legacy panel fields use the chrome edge, with the Daylight mix', () => {
		const head = panelSkin.slice(0, panelSkin.indexOf('/* HELD FOR'));
		expect(rule(head, ':root .right-panel')).toContain('--panel-field-edge: var(--w-line)');
		expect(rule(head, ":root[data-mode='light'] .right-panel")).toContain('--panel-field-edge: color-mix(in srgb, var(--w-text) 16%, transparent)');
		expect(head).toContain('border: var(--w-bw) solid var(--panel-field-edge);');
		expect(head).not.toContain('solid var(--w-line-strong)');
	});
});

describe('rail menu and stowed note for assistive tech', () => {
	const strip = readFileSync(new URL('./components/RightStubStrip.svelte', import.meta.url), 'utf8');
	const menu = strip.slice(strip.indexOf('const menuItems = $derived.by('), strip.indexOf('const menuPanel'));

	test('the stowed state is said in words in the stub tooltip, which describes the stub', () => {
		expect(strip).toContain("const STOWED_NOTE = 'Pinned, shown when there is room';");
		expect(strip).toContain('const stowed = isStowed(panel.id) ? ` · ${STOWED_NOTE.toLowerCase()}` : \'\';');
	});

	test('the rail menu is the one kit menu: Pin / Unpin first, then Move up / Move down / Remove', () => {
		expect(strip).toContain("import ContextMenu, { type MenuEntry } from './context-menu/ContextMenu.svelte'");
		expect(strip).toContain('ariaLabel="Rail options"');
		const order = ["id: 'unpin'", "id: 'pin'", "id: 'up'", "id: 'down'", "id: 'remove'"].map((id) => menu.indexOf(id));
		expect(order.every((index) => index > -1)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	test('unavailable rail menu items stay reachable and explain themselves', () => {
		expect(menu.length).toBeGreaterThan(0);
		// ContextMenu keeps disabled rows focusable (aria-disabled) and shows their hint.
		expect(menu).toContain('disabled: !$dockCanPin');
		expect(menu).toContain("hint: $dockCanPin ? undefined : 'Needs a wider window'");
		// The edges guard themselves, since a focusable unavailable item can still be activated.
		expect(strip).toMatch(/if \(index < 0 \|\| target < 0 \|\| target >= \$layoutStore\.stubStrip\.length\) return;/);
	});

	// Review round 1: with a panel pinned, hover and the peek key do nothing (§7.22), so the tooltip
	// must not promise a peek; the Rail group says when "Open on hover" applies.
	test('the peek hint is left out while a pinned panel or a held peek is on screen', () => {
		const tip = strip.slice(strip.indexOf('function stubTip'), strip.indexOf('const tipSide'));
		expect(tip).toContain("const peek = isOpen(panel.id) || panelCommitted() ? '' : ` · ${peekHint}`;");
		expect(strip).toContain('>Only while no panel is pinned</span>');
		expect(strip).toContain('labelledby={`${hoverLabelId} ${hoverNoteId}`}');
	});

	// Review round 1: every badge was announced as "N unread", Transfers included.
	test('a stub badge is named in words true for its panel', () => {
		const name = strip.slice(strip.indexOf('function stubName'), strip.indexOf('function badgeText'));
		expect(strip).toContain('aria-label={stubName(panel, badge)}');
		expect(name).toContain("if (panel.id === 'dms') return `${panel.label}, ${badge} unread`;");
		expect(name).toContain('incoming');
		expect(name).toContain('in progress');
		expect(name.match(/unread/g)?.length).toBe(1);
	});

	// Review round 1: ↓ from the last panel row landed on a segmented control, whose own arrows
	// then moved the rail to the other edge or turned hover-peek on.
	test('↑/↓ in the Add panels popover move between rows and never change a setting', () => {
		expect(strip).toContain('onkeydowncapture={handleActionKeys}');
		expect(strip).not.toMatch(/\sonkeydown=\{handleActionKeys\}/);
		const keys = strip.slice(strip.indexOf('function handleActionKeys'), strip.indexOf('function handleDrawerFocusOut'));
		expect(keys).toContain("event.target.closest('[role=\"radiogroup\"]')) event.stopPropagation();");
		expect(strip).toContain("const ROW_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);");
	});

	test('right-click and focus never swap the panel on screen', () => {
		const focus = strip.slice(strip.indexOf('function handleStubFocus'), strip.indexOf('function handleStubLeave'));
		expect(focus).not.toMatch(/peekPanel|openPanelFromRail|setDisplayedPanel/);
		const context = strip.slice(strip.indexOf('function handleStubContextMenu'), strip.indexOf('function togglePinFromMenu'));
		expect(context).not.toMatch(/peekPanel|openPanelFromRail|setDisplayedPanel|activeRightTab/);
		const enter = strip.slice(strip.indexOf('function handleStubEnter'), strip.indexOf('function handleStubFocus'));
		expect(enter).toContain('if (dragId || panelCommitted()) return;');
	});

	test('Add panels: rows with descriptions, then a Rail group with Side and Open on hover segments and Reset rail', () => {
		expect(strip).toContain('class="panel-tab-desc"');
		expect(strip).toContain('>Rail</h3>');
		expect(strip).toContain("options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]}");
		expect(strip).toContain("options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}");
		expect(strip).toContain('>Reset rail</button>');
		expect(rule(css, '.panel-drawer-item')).toContain('min-height: 40px');
	});
});
