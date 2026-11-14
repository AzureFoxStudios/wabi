import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source contract for the phone side-panel sheet (`.mobile-right-overlay`, design contract §7.13,
 * §8.12). The sheet rests below the viewport (closed) and rises to y=0 (open). d833d9ab changed the
 * closed transform from translateX to translateY but added no `.visible` reset, so the open sheet
 * kept translateY(100%) and only the scrim showed — a phone user could not reach People, pins,
 * search or any right-dock panel. These guards read the source so that regression cannot return.
 */

const here = import.meta.dir;
const mobileCss = readFileSync(join(here, '..', 'styles', 'surfaces', 'mobile.css'), 'utf8');
const mainLayout = readFileSync(join(here, 'components', 'MainLayout.svelte'), 'utf8');

/** The body of a single CSS rule, e.g. `.mobile-right-overlay.visible { … }`. */
function ruleBody(css: string, selector: string): string {
	const start = css.indexOf(selector);
	expect(start, `${selector} must exist in mobile.css`).toBeGreaterThanOrEqual(0);
	const open = css.indexOf('{', start);
	const close = css.indexOf('}', open);
	return css.slice(open + 1, close);
}

describe('phone side-panel sheet (.mobile-right-overlay)', () => {
	test('the closed sheet sits below the viewport', () => {
		expect(ruleBody(mobileCss, '.mobile-right-overlay {')).toContain('transform: translateY(100%)');
	});

	test('the open (.visible) sheet resets the transform so it comes on screen', () => {
		const open = ruleBody(mobileCss, '.mobile-right-overlay.visible {');
		// Any value that lands the sheet at its resting position: `none`, or an explicit 0 offset.
		expect(open).toMatch(/transform:\s*(none|translateY\(0)/);
		expect(open).toContain('visibility: visible');
	});

	test('the sheet shows a loading state while its panel loads, never an empty sheet', () => {
		const overlay = mainLayout.slice(mainLayout.indexOf('<div class="mobile-right-overlay"'));
		const body = overlay.slice(0, overlay.indexOf('{/if}\n\t\t</div>'));
		expect(body).toContain('{#if RightPanelCmp}');
		expect(body).toContain('class="companion-loading" aria-busy="true"');
		expect(body).toContain('role="progressbar"');
	});

	test('every way out is wired: scrim tap, Back and Escape all close the right panel', () => {
		// The scrim over the stage closes the sheet on tap.
		expect(mainLayout).toContain(
			`<div class="mobile-panel-backdrop" aria-hidden="true" on:click={() => { layoutStore.showMobileChannels.set(false); layoutStore.closeRightPanel(); }}>`
		);
		// Back (popstate) pops the 'overlay' surface.
		expect(mainLayout).toMatch(/case 'overlay':\s*\n\s*layoutStore\.closeRightPanel\(\);/);
		// Escape closes the phone sheet too (isMobile is width-only, so a narrow desktop window shows
		// it with a keyboard present); a menu or dialog on top of it owns Escape first.
		expect(mainLayout).toContain('function handleMobileOverlayKeydown');
		expect(mainLayout).toContain('on:keydown={handleMobileOverlayKeydown}');
	});
});
