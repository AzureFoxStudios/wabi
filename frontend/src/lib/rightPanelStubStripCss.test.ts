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
		expect(stub).toContain('transform: translateX(24px)');
	});
});
