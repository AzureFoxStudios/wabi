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

	test('the panel zone sits beside the rail, and only a peek carries a shadow', () => {
		const zone = layout.match(/\.right-panel-zone\s*\{([^}]*max-width:[^}]*)\}/)?.[1];
		expect(zone).toContain('position: fixed');
		expect(zone).toContain('right: var(--w-rail-w, 46px)');
		expect(zone).toContain('box-shadow: none');
		expect(rule(layout, '.right-panel-zone.peek')).toContain('box-shadow');
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
