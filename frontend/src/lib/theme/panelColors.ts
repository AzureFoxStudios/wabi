/**
 * Per-Panel Color Overrides
 *
 * Lets users give each major panel (server rail, left sidebar, center chat,
 * right panel) its own background — solid color OR gradient — with text that
 * automatically contrasts against the chosen background by default.
 *
 * ── Why this re-tints tokens instead of setting one background var ──────────
 * Every surface in a panel (the shell, plus members list, DMs, notes, message
 * bubbles, cards, headers) paints itself from the shared theme tokens
 * --surface-base / --surface-app / --surface-raised (+ their -rgb variants and
 * the legacy --bg-* aliases). On top of that, when a theme ships an ambient
 * effect, accessibility.css forces panel backgrounds with
 *   background: rgba(var(--surface-base-rgb), var(--surface-frost-opacity)) !important
 * so a single custom background var gets overridden and, worse, child surfaces
 * never follow.
 *
 * The robust fix: scope the ENTIRE surface palette (+ text tokens + opaque
 * frost) to each panel's container. Because CSS custom properties inherit down
 * the DOM, the whole panel — shell and all descendants — recolors together, and
 * the frosted `!important` rules now resolve to the panel's own color instead
 * of fighting it. We additionally paint the shell background explicitly (with
 * `!important` and elevated specificity) so an exact solid/gradient shows even
 * when ambient frosting is active.
 */

import type { PanelColorOverride, PanelColors } from '../../types/theme';

const STYLE_ELEMENT_ID = 'wabi-panel-overrides';

type Rgb = [number, number, number];

interface PanelSpec {
	key: keyof PanelColors;
	/** Container the scoped variables are attached to. */
	container: string;
	/** Element that actually paints the panel background. */
	shell: string;
	/** Center chat is solid-only (a gradient would hide behind opaque content). */
	solidOnly?: boolean;
}

const PANELS: PanelSpec[] = [
	{ key: 'serverRail', container: '.server-rail-container', shell: '.server-rail' },
	{ key: 'leftSidebar', container: '.channel-sidebar-container', shell: '.channel-sidebar' },
	{ key: 'center', container: '.main-content', shell: '.main-content', solidOnly: true },
	{ key: 'rightPanel', container: '.right-panel-container', shell: '.right-panel' }
];

/**
 * Parse a representative solid color out of a value that may be a hex color,
 * an rgb()/rgba() string, or a gradient (first color stop is used).
 */
function extractRgb(value: string): Rgb | null {
	if (!value) return null;

	const hexMatch = value.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
	if (hexMatch) {
		let hex = hexMatch[1];
		if (hex.length === 3) {
			hex = hex
				.split('')
				.map((c) => c + c)
				.join('');
		}
		return [
			parseInt(hex.slice(0, 2), 16),
			parseInt(hex.slice(2, 4), 16),
			parseInt(hex.slice(4, 6), 16)
		];
	}

	const rgbMatch = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
	if (rgbMatch) {
		return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
	}

	return null;
}

/** WCAG relative luminance (0 = black, 1 = white). */
function relativeLuminance([r, g, b]: Rgb): number {
	const channel = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Linear mix of a color toward a target by amount (0..1). */
function mix([r, g, b]: Rgb, [tr, tg, tb]: Rgb, amount: number): Rgb {
	const m = (a: number, t: number) => Math.round(a + (t - a) * amount);
	return [m(r, tr), m(g, tg), m(b, tb)];
}

function rgbToHex([r, g, b]: Rgb): string {
	const h = (n: number) => n.toString(16).padStart(2, '0');
	return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbTriple([r, g, b]: Rgb): string {
	return `${r}, ${g}, ${b}`;
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/**
 * Auto-contrasting text palette for a background.
 * Falls back to light text when the background can't be parsed (e.g. a complex
 * gradient); users can always set an explicit text color instead.
 */
export function contrastText(bg: string): { base: string; secondary: string; muted: string } {
	const rgb = extractRgb(bg);
	const isLightBg = rgb ? relativeLuminance(rgb) > 0.5 : false;

	if (isLightBg) {
		return {
			base: '#141414',
			secondary: 'rgba(20, 20, 20, 0.72)',
			muted: 'rgba(20, 20, 20, 0.5)'
		};
	}
	return {
		base: '#f5f5f7',
		secondary: 'rgba(245, 245, 247, 0.72)',
		muted: 'rgba(245, 245, 247, 0.5)'
	};
}

function isActive(o: PanelColorOverride | undefined): o is PanelColorOverride {
	return !!o && o.enabled === true && !!o.bg && o.bg.trim().length > 0;
}

/**
 * Build the scoped CSS rules for a single active panel override.
 */
function buildRules(spec: PanelSpec, override: PanelColorOverride): string {
	const bg = override.bg!.trim();
	const isGradient = override.mode === 'gradient' && !spec.solidOnly;
	const rgb = extractRgb(bg);

	const containerDecls: string[] = [];

	// ── Surface palette (retint so all descendant surfaces follow) ──────────
	if (rgb) {
		const light = relativeLuminance(rgb) > 0.5;
		// "raised" gets a subtle elevation step for depth (buttons, cards, bubbles).
		const raised = mix(rgb, light ? BLACK : WHITE, 0.08);
		// "app" is the deepest layer — nudge slightly away from raised.
		const app = mix(rgb, light ? WHITE : BLACK, 0.05);

		const baseHex = rgbToHex(rgb);
		const raisedHex = rgbToHex(raised);
		const appHex = rgbToHex(app);
		const baseTriple = rgbTriple(rgb);
		const raisedTriple = rgbTriple(raised);
		const appTriple = rgbTriple(app);

		containerDecls.push(
			`--surface-base: ${baseHex};`,
			`--surface-app: ${appHex};`,
			`--surface-raised: ${raisedHex};`,
			`--surface-base-rgb: ${baseTriple};`,
			`--surface-app-rgb: ${appTriple};`,
			`--surface-raised-rgb: ${raisedTriple};`,
			// Legacy aliases still used directly by some components.
			`--bg-secondary: ${baseHex};`,
			`--bg-primary: ${appHex};`,
			`--bg-tertiary: ${raisedHex};`,
			`--bg-secondary-rgb: ${baseTriple};`,
			`--bg-primary-rgb: ${appTriple};`,
			`--bg-tertiary-rgb: ${raisedTriple};`
		);
	}

	// Keep the panel opaque so its color isn't washed out by ambient frosting.
	containerDecls.push('--surface-frost-opacity: 1;');

	// ── Text tokens (auto-contrast by default) ──────────────────────────────
	const autoText = override.autoText !== false;
	if (autoText) {
		const { base, secondary, muted } = contrastText(isGradient ? bg : rgbToHex(rgb ?? BLACK));
		containerDecls.push(
			`--text-heading: ${base};`,
			`--text-body: ${base};`,
			`--text-primary: ${base};`,
			`--text-secondary: ${secondary};`,
			`--text-tertiary: ${muted};`,
			`--text-muted: ${muted};`,
			`color: ${base};`
		);
	} else if (override.text && override.text.trim()) {
		const text = override.text.trim();
		containerDecls.push(
			`--text-heading: ${text};`,
			`--text-body: ${text};`,
			`--text-primary: ${text};`,
			`color: ${text};`
		);
	}

	const containerRule = `${spec.container} {\n\t${containerDecls.join('\n\t')}\n}`;

	// ── Shell background (explicit, wins over ambient `!important`) ──────────
	// `.app-container` prefix raises specificity above `[data-ambient] .shell`.
	const shellRule = `.app-container ${spec.container} ${spec.shell} {\n\tbackground: ${bg} !important;\n}`;

	return `${containerRule}\n\n${shellRule}`;
}

/**
 * Apply (or clear) per-panel color overrides by writing a scoped stylesheet.
 * Passing an empty/undefined map, or one with `enabled === false`, clears them.
 */
export function applyPanelColors(panelColors?: PanelColors | null): void {
	if (typeof document === 'undefined') return;

	const rules: string[] = [];
	if (panelColors && panelColors.enabled !== false) {
		for (const spec of PANELS) {
			const override = panelColors[spec.key] as PanelColorOverride | undefined;
			if (isActive(override)) {
				rules.push(buildRules(spec, override));
			}
		}
	}

	let styleEl = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;

	if (rules.length === 0) {
		if (styleEl) styleEl.textContent = '';
		return;
	}

	if (!styleEl) {
		styleEl = document.createElement('style');
		styleEl.id = STYLE_ELEMENT_ID;
		document.head.appendChild(styleEl);
	}
	styleEl.textContent = rules.join('\n\n');
}
