import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./components/RightStubStrip.css', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../styles/components/main-layout-part1.css', import.meta.url), 'utf8');

function rule(source: string, selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
	expect(match, `missing CSS rule: ${selector}`).not.toBeNull();
	return match?.[1] ?? '';
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
		const zone = rule(layout, '.right-panel-zone');
		expect(zone).toContain('position: fixed');
		expect(zone).toContain('right: var(--w-rail-w, 46px)');
		expect(zone).toContain('box-shadow: none');
		// dockClamp.ts decides pin vs peek and the width; a viewport cap here would fight it.
		expect(zone).not.toContain('max-width');
		expect(layout).not.toContain('55vw');
		expect(rule(layout, '.right-panel-zone.stub-left')).toContain('left: var(--w-rail-w, 46px)');
	});

	test('pinned is plane 0: flat --w-bg2 with a --w-line hairline, no gradients or accent tint', () => {
		const body = rule(layout, '.right-panel-body');
		expect(body).toContain('background: var(--w-bg2)');
		expect(body).toContain('border-left: var(--w-bw) solid var(--w-line)');
		const section = layout.slice(layout.indexOf('.right-panel-zone {'), layout.indexOf('.server-switcher-overlay'));
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
		expect(zIndex(scrim)).toBeLessThan(zIndex(rule(layout, '.right-panel-zone')));
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

	test('items can be reordered by drag and show where they will land', () => {
		expect(css).toContain('.stub.dragging');
		expect(css).toContain('.stub.drop-before::after');
		expect(css).toContain('.stub.drop-after::after');
	});

	test('the rail is hidden in focus mode', () => {
		expect(css).toContain('.app-container.focus-mode) .rail');
	});
});
