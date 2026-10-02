import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./components/RightStubStrip.css', import.meta.url), 'utf8');

function rule(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
	expect(match, `missing CSS rule: ${selector}`).not.toBeNull();
	return match?.[1] ?? '';
}

describe('RightStubStrip folder-tab geometry', () => {
	test('closed tabs expose the full target', () => {
		expect(rule('.stub-strip')).toContain('width: 48px');
		expect(rule('.stub-strip.side-left .stub')).toContain('margin-left: 0');
	});
	test('pinning overlays center stage', () => {
		const layout = readFileSync(new URL('../styles/components/main-layout-part1.css', import.meta.url), 'utf8');
		const panel = layout.match(/\.right-panel-zone\s*\{([^}]*max-width:[^}]*)\}/)?.[1];
		expect(panel).toContain('position: fixed');
		expect(panel).toContain('z-index:');
		expect(layout).not.toContain('margin-left: 48px');
	});
	test('right-side floating strip follows the panel leading edge', () => {
		const anchor = rule('.stub-strip.floating.side-right');
		expect(anchor).toContain('left: 0');
		expect(anchor).toContain('right: auto');

		const stub = rule('.stub-strip.floating.side-right .stub');
		expect(stub).toContain('transform: translateX(-48px)');
	});

	test('left-side floating strip mirrors the leading-edge geometry', () => {
		const anchor = rule('.stub-strip.floating.side-left');
		expect(anchor).toContain('right: 0');
		expect(anchor).toContain('left: auto');

		const stub = rule('.stub-strip.floating.side-left .stub');
		expect(stub).toContain('margin-left: 0');
		expect(stub).toContain('transform: translateX(48px)');
	});
});
