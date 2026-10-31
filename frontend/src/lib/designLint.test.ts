import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Design lint (design contract "Everything is a role", §4 "no gradients on surfaces… no glows,
// no frost"). Every stylesheet under src is scanned with comments removed. A file outside the
// ledger below must have none of these; a file in the ledger is older debt and may only go down.
// When a package pays debt off, lower (or delete) its line here: the second test fails until the
// ledger matches, so the number can never quietly climb back.
// Comments are removed by a loop that repeats ONE pattern until the text stops changing (never a
// single-pass replace).
const SRC = new URL('..', import.meta.url).pathname;

const RULES = {
	// Raw colours. Identity ink, roles and color-mix() of roles are the only colour sources.
	hex: /#[0-9a-fA-F]{3,8}\b/g,
	rgb: /\b(?:rgba?|hsla?)\(/g,
	named: /(?:^|[\s:,(])(?:white|black)(?=[\s;,)!])/gm,
	// Pre-role token families (--surface-*, --text-*, --accent-primary*, --border-subtle, --bg-*).
	legacy: /--(?:surface|text|accent-primary|border-subtle|bg)-[\w-]*/g,
	// The face is the theme's, never the platform's.
	systemUi: /system-ui/g,
	// No frost: backdrop-filter is allowed only to switch it off.
	frost: /backdrop-filter\s*:(?!\s*none)/g
} as const;
type Rule = keyof typeof RULES;

// Debt carried in from before the contract (counts at the commit that added this test). The
// projector letterbox in slides.css / present.css is deliberately black: it is the room around the
// slide, not app chrome.
const LEDGER: Record<string, Partial<Record<Rule, number>>> = {
	'lib/components/DesktopTitlebar.css': { legacy: 20 },
	'lib/components/FfxivReferencePanel.css': { hex: 10, rgb: 21, legacy: 27, frost: 1 },
	'lib/components/WhiteboardCanvas.css': { hex: 17, rgb: 3, legacy: 13, frost: 1 },
	'lib/components/ZipPreviewPanel.css': { hex: 16, rgb: 9, legacy: 17 },
	'lib/components/lore/loreWorkspace.css': { hex: 16, legacy: 4 },
	'lib/components/media-albums/MediaAlbumsTab.items.css': { hex: 2, rgb: 33, legacy: 38, named: 1, frost: 1 },
	'lib/components/media-albums/MediaAlbumsTab.layout.css': { rgb: 30, legacy: 31, frost: 1 },
	'lib/components/media-albums/MediaAlbumsTab.viewer.css': { rgb: 8, legacy: 11 },
	'lib/components/plugins/LineDm.css': { hex: 8, rgb: 20, legacy: 1, frost: 2 },
	'lib/components/plugins/YouTubeWatchEmbed.css': { hex: 16, rgb: 8, legacy: 9, named: 3 },
	'lib/components/readerCode.css': { hex: 20, systemUi: 2 },
	'lib/components/userPanel.css': { hex: 2, rgb: 1, legacy: 17, named: 3 },
	'lib/workspaces/present/present.css': { named: 1 },
	'lib/workspaces/slides.css': { named: 1 },
	'styles/accessibility.css': { rgb: 3, legacy: 8, frost: 2 },
	'styles/animations.css': { legacy: 3 },
	'styles/base.css': { legacy: 4 },
	'styles/character.css': { rgb: 2 },
	'styles/components/admin-center-stage.css': { hex: 83, rgb: 1, legacy: 75 },
	'styles/components/admin-tab.css': { hex: 5, rgb: 13, legacy: 56 },
	'styles/components/admin-workbench.css': { legacy: 30 },
	'styles/components/chat-core.css': { hex: 3, rgb: 2, legacy: 26 },
	'styles/components/chat-mobile.css': { rgb: 2, legacy: 14, named: 2, frost: 2 },
	'styles/components/controls.css': { legacy: 5 },
	'styles/components/desktop-hosting.css': { legacy: 17, named: 1 },
	'styles/components/gallery-channel.css': { rgb: 41, legacy: 2, named: 11 },
	'styles/components/gallery-feedback.css': { legacy: 1, named: 2 },
	'styles/components/main-layout-part1.css': { hex: 3, rgb: 4, legacy: 10, named: 1 },
	'styles/components/main-layout-part2.css': { rgb: 8, legacy: 13, frost: 1 },
	'styles/components/map-workspace-part1.css': { hex: 18, rgb: 52, legacy: 54 },
	'styles/components/map-workspace-part2.css': { hex: 12, rgb: 35, legacy: 20, named: 4 },
	'styles/components/ml-directions.css': { legacy: 30 },
	'styles/components/ml-lightbox.css': { hex: 6, rgb: 27, legacy: 36, frost: 1 },
	'styles/components/ml-mobile.css': { legacy: 13 },
	'styles/components/ml-spoiler.css': { rgb: 1, legacy: 2 },
	'styles/components/ml-translated.css': { legacy: 6 },
	'styles/components/model-viewer-3d.css': { hex: 31, legacy: 5 },
	'styles/components/payment-sheet.css': { hex: 11, rgb: 33, legacy: 18 },
	'styles/components/reader-tab.css': { hex: 52, systemUi: 5 },
	'styles/components/settings-mobile.css': { rgb: 1, legacy: 2 },
	'styles/components/sidebar-profile.css': { hex: 8, rgb: 11, legacy: 4 },
	'styles/components/steam-status.css': { hex: 11, rgb: 4, legacy: 3 },
	'styles/components/surfaces.css': { hex: 1, legacy: 16 },
	'styles/components/windowing.css': { hex: 27, rgb: 2, legacy: 14, named: 1, frost: 1 },
	'styles/neutral-branding.css': { rgb: 1, legacy: 2 },
	'styles/polish.css': { legacy: 7 },
	'styles/public-pages.css': { hex: 20, legacy: 27 },
	'styles/tokens.css': { hex: 28, rgb: 19, legacy: 58 },
	'styles/typography.css': { systemUi: 2 },
};

function cssFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...cssFiles(path));
		else if (name.endsWith('.css')) out.push(path);
	}
	return out;
}
function withoutComments(source: string): string {
	let previous = '';
	let current = source;
	while (current !== previous) {
		previous = current;
		current = current.replace(/\/\*[\s\S]*?\*\//, '');
	}
	return current;
}
const files = cssFiles(SRC).map((path) => path.slice(SRC.length)).sort();
const counts = new Map(
	files.map((file) => {
		const code = withoutComments(readFileSync(join(SRC, file), 'utf8'));
		const found: Partial<Record<Rule, number>> = {};
		for (const rule of Object.keys(RULES) as Rule[]) {
			const hits = code.match(RULES[rule])?.length ?? 0;
			if (hits) found[rule] = hits;
		}
		return [file, found] as const;
	})
);

describe('stylesheets draw only with roles', () => {
	test('the scan covers the app (sanity)', () => {
		expect(files.length).toBeGreaterThan(120);
		expect(files).toContain('styles/controls-kit.css');
		expect(files).toContain('lib/workspaces/workspace.css');
	});

	test('no stylesheet gains a raw colour, a legacy token, system-ui or frost', () => {
		const over: string[] = [];
		for (const [file, found] of counts) {
			for (const [rule, hits] of Object.entries(found) as [Rule, number][]) {
				const allowed = LEDGER[file]?.[rule] ?? 0;
				if (hits > allowed) over.push(`${file}: ${rule} ${hits} (allowed ${allowed})`);
			}
		}
		expect(over).toEqual([]);
	});

	test('the ledger only shrinks: paid-off debt is taken off it', () => {
		const stale: string[] = [];
		for (const [file, allowed] of Object.entries(LEDGER)) {
			const found = counts.get(file);
			if (!found) {
				stale.push(`${file}: no longer exists`);
				continue;
			}
			for (const [rule, ceiling] of Object.entries(allowed) as [Rule, number][]) {
				const hits = found[rule] ?? 0;
				if (hits < ceiling) stale.push(`${file}: ${rule} is ${hits} now (ledger says ${ceiling})`);
			}
		}
		expect(stale).toEqual([]);
	});
});

describe('the office tools have no legacy control layer', () => {
	test('workspace.css no longer restyles plain buttons and fields', () => {
		const css = withoutComments(readFileSync(join(SRC, 'lib/workspaces/workspace.css'), 'utf8'));
		expect(css).not.toContain(":where(button:not([class*='w-']))");
		expect(css).not.toContain(":where(:is(input, select, textarea):not([class*='w-']");
		expect(css).not.toContain('.workspace-home-note');
	});
});
