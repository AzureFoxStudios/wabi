import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Foundation tokens (design contract §4.1-§4.5, §4.7, §11): the type scale, the ellipsis face,
// radii and lift, motion, shell metrics, and the bridge that points legacy names at roles.
const read = (path: string) => readFileSync(new URL(`../styles/${path}`, import.meta.url), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const typography = stripComments(read('typography.css'));
const fonts = stripComments(read('fonts.css'));
const character = stripComments(read('character.css'));
const tokens = stripComments(read('tokens.css'));

interface Block {
	selector: string;
	decls: Map<string, string>;
	body: string;
}

/** Flat rule blocks (selector + declarations); nested @media blocks are flattened to their rules. */
function blocks(css: string): Block[] {
	const out: Block[] = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	for (const match of css.matchAll(re)) {
		// Text before the brace, minus any statements (@import …;) that precede the rule.
		const selector = (match[1].split(';').pop() ?? '').trim().replace(/\s+/g, ' ');
		const decls = new Map<string, string>();
		for (const decl of match[2].split(';')) {
			const colon = decl.indexOf(':');
			if (colon < 0) continue;
			decls.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim().replace(/\s+/g, ' '));
		}
		out.push({ selector, decls, body: match[2] });
	}
	return out;
}

/** The first rule with this selector (optionally: the first that declares `name`). */
function block(css: string, selector: string, name?: string): Block {
	const found = blocks(css).find((candidate) => candidate.selector === selector && (!name || candidate.decls.has(name)));
	expect(found, `missing CSS rule: ${selector}`).toBeDefined();
	return found as Block;
}

/** Every value a custom property is given anywhere in a sheet. */
function valuesOf(css: string, name: string): string[] {
	return blocks(css).flatMap((candidate) => (candidate.decls.has(name) ? [candidate.decls.get(name) as string] : []));
}

// §4.1: [token, family, size, line height, weight]
const TYPE_SCALE: Array<[string, 'serif' | 'sans' | 'mono', number, number, number]> = [
	['display', 'serif', 32, 40, 600],
	['title', 'serif', 22, 28, 600],
	['heading', 'serif', 18, 24, 600],
	['subhead', 'serif', 15, 20, 600],
	['read', 'sans', 17, 30, 400],
	['chat', 'sans', 15, 24, 400],
	['label', 'sans', 14, 20, 500],
	['label-sm', 'sans', 13, 18, 500],
	['ui', 'sans', 14, 20, 400],
	['small', 'sans', 13, 18, 400],
	['caption', 'sans', 12, 16, 500],
	['kicker', 'mono', 11, 16, 500],
	['mono', 'mono', 12, 16, 400],
	['micro', 'mono', 11, 14, 400],
];
const LOADED_WEIGHTS = { serif: [400, 600], sans: [400, 500, 700], mono: [400, 500] };
const SHORTHAND = /^(\d{3}) calc\((\d+(?:\.\d+)?)px \* var\(--w-fs\)\) \/ calc\((\d+(?:\.\d+)?)px \* var\(--w-fs\)\) var\(--w-(serif|sans|mono)\)$/;

describe('type scale (§4.1)', () => {
	const scale = block(typography, ":root, [style*='--w-serif']");

	test('all 14 --w-t-* tokens exist with the contract values', () => {
		const names = [...scale.decls.keys()].filter((name) => name.startsWith('--w-t-'));
		expect(names.sort()).toEqual(TYPE_SCALE.map(([name]) => `--w-t-${name}`).sort());
		for (const [name, family, size, line, weight] of TYPE_SCALE) {
			const value = scale.decls.get(`--w-t-${name}`) ?? '';
			const parsed = value.match(SHORTHAND);
			expect(parsed, `--w-t-${name} is not a "weight calc(px*fs) / calc(px*fs) family" shorthand: ${value}`).not.toBeNull();
			const [, w, s, l, f] = parsed as RegExpMatchArray;
			expect([Number(w), Number(s), Number(l), f]).toEqual([weight, size, line, family]);
		}
	});

	test('line heights and sizes are whole pixels and only loaded weights are used', () => {
		for (const [name] of TYPE_SCALE) {
			const [, w, s, l, f] = (scale.decls.get(`--w-t-${name}`) ?? '').match(SHORTHAND) as RegExpMatchArray;
			expect(Number.isInteger(Number(s)), `--w-t-${name} size`).toBe(true);
			expect(Number.isInteger(Number(l)), `--w-t-${name} line height`).toBe(true);
			expect(LOADED_WEIGHTS[f as keyof typeof LOADED_WEIGHTS]).toContain(Number(w));
			expect(Number(s)).toBeGreaterThanOrEqual(11);
		}
	});

	test('every token has a .w-t-* utility that applies it', () => {
		for (const [name] of TYPE_SCALE) {
			expect(block(typography, `.w-t-${name}`).decls.get('font')).toBe(`var(--w-t-${name})`);
		}
		const kicker = block(typography, '.w-t-kicker').decls;
		expect(kicker.get('letter-spacing')).toBe('0.12em');
		expect(kicker.get('text-transform')).toBe('uppercase');
		// The font shorthand resets numeric variants, so tabular figures must follow it.
		expect(block(typography, '.w-t-mono').decls.get('font-variant-numeric')).toBe('tabular-nums');
		expect(block(typography, '.w-t-micro').decls.get('font-variant-numeric')).toBe('tabular-nums');
		expect(block(typography, '.w-t-display').decls.get('text-wrap')).toBe('balance');
		expect(block(typography, '.w-t-chat').decls.get('text-wrap')).toBe('pretty');
		expect(block(typography, '.w-t-read').decls.get('text-wrap')).toBe('pretty');
	});

	test('weights are never synthesized and sizes follow the interface scale', () => {
		expect(valuesOf(typography, 'font-synthesis-weight')).toEqual(['none']);
		expect(block(typography, ':root').decls.get('font-synthesis-weight')).toBe('none');
		expect(valuesOf(typography, '--w-fs')).toEqual(['var(--app-font-scale, 1)']);
	});
});

describe('Wabi Ellipsis face (§4.1)', () => {
	test('a Zen Kaku latin-400 face covers only U+2026', () => {
		const face = blocks(fonts).find((candidate) => candidate.selector === '@font-face' && candidate.decls.get('font-family') === "'Wabi Ellipsis'");
		expect(face, 'missing @font-face for Wabi Ellipsis').toBeDefined();
		expect(face?.decls.get('unicode-range')).toBe('U+2026');
		expect(face?.decls.get('src')).toContain('@fontsource/zen-kaku-gothic-new/files/zen-kaku-gothic-new-latin-400-normal.woff2');
	});

	test('it leads every Shippori serif stack', () => {
		const stacks = valuesOf(typography, '--w-serif');
		expect(stacks.length).toBeGreaterThanOrEqual(2); // default and Thai
		for (const stack of stacks) {
			expect(stack.startsWith("'Wabi Ellipsis', 'Shippori Mincho'"), stack).toBe(true);
		}
	});

	test('the pixel character keeps its own dot-matrix face first (Pixelify has a baseline ellipsis)', () => {
		const pixel = block(character, ":root[data-char='pixel']").decls;
		expect(pixel.get('--w-serif')?.startsWith("'Pixelify Sans'")).toBe(true);
	});
});

describe('theme character: radii and lift (§4.4, §4.5)', () => {
	test('--radius-inner is added and the legacy radius values are unchanged', () => {
		const radii = block(character, ':root', '--radius-md').decls;
		expect(radii.get('--radius-sm')).toBe('calc(4px * var(--w-rs))');
		expect(radii.get('--radius-inner')).toBe('calc(6px * var(--w-rs))');
		expect(radii.get('--radius-md')).toBe('calc(8px * var(--w-rs))');
		expect(radii.get('--radius-lg')).toBe('calc(12px * var(--w-rs))');
		expect(radii.get('--radius-xl')).toBe('calc(16px * var(--w-rs))');
		expect(radii.get('--radius-2xl')).toBe('calc(24px * var(--w-rs))');
		// One radius scale: tokens.css no longer carries a second, fixed-pixel copy.
		expect(valuesOf(tokens, '--radius-md')).toEqual([]);
	});

	test('--w-shadow-1 is always a valid shadow, never none', () => {
		const values = valuesOf(character, '--w-shadow-1');
		expect(values.length).toBe(4);
		for (const value of values) expect(value).not.toBe('none');
		expect(block(character, ":root, :root[data-char='soft']").decls.get('--w-shadow-1')).toBe('0 0 0 0 transparent');
		expect(block(character, ":root[data-mode='light']").decls.get('--w-shadow-1')).toBe(
			'0 1px 2px color-mix(in srgb, var(--w-text) 10%, transparent), 0 0 0 0.5px color-mix(in srgb, var(--w-text) 4%, transparent)'
		);
		expect(block(character, ":root[data-char='pixel']").decls.get('--w-shadow-1')).toBe('2px 2px 0 var(--w-sink)');
		expect(block(character, ":root[data-char='contrast']").decls.get('--w-shadow-1')).toBe('0 0 0 0 transparent');
		for (const value of valuesOf(character, '--w-shadow')) expect(value).not.toBe('none');
	});

	test('High Contrast draws every rule solid, below the inline role on <html>', () => {
		const rule = block(character, ":root[data-char='contrast'], :root[data-char='contrast'] body");
		expect(rule.decls.get('--w-line')).toBe('var(--w-line-strong)');
	});
});

describe('scales and shell metrics (§4.2, §4.3, §4.7)', () => {
	const root = block(tokens, ':root').decls;

	test('spacing gains the 2px step', () => {
		expect(root.get('--space-0_5')).toBe('0.125rem');
		expect(root.get('--space-1')).toBe('0.25rem');
	});

	test('motion tokens', () => {
		expect(root.get('--w-dur-1')).toBe('120ms');
		expect(root.get('--w-dur-2')).toBe('180ms');
		expect(root.get('--w-dur-3')).toBe('240ms');
		expect(root.get('--w-ease')).toBe('cubic-bezier(0.2, 0, 0, 1)');
	});

	test('shell metrics', () => {
		expect(root.get('--w-head-a')).toBe('56px');
		expect(root.get('--w-head-b')).toBe('40px');
		expect(root.get('--w-mast')).toBe('calc(var(--w-head-a) + var(--w-head-b))');
		expect(root.get('--w-foot')).toBe('80px');
		expect(root.get('--w-sb-w')).toBe('264px');
		expect(root.get('--w-panel-w')).toBe('304px');
		expect(root.get('--w-rail-w')).toBe('44px');
		expect(root.get('--w-gutter')).toBe('32px');
		expect(root.get('--w-measure')).toBe('calc(600px * var(--w-fs))');
		expect(valuesOf(tokens, '--w-sb-w')).toContain('252px');
		expect(valuesOf(tokens, '--w-gutter')).toEqual(['32px', '24px', '16px']);
	});

	test('the legacy --text-* sizes are live and follow the interface scale', () => {
		const sizes: Record<string, number> = { xs: 11, sm: 13, base: 14, lg: 16, xl: 20, '2xl': 24 };
		for (const [name, px] of Object.entries(sizes)) {
			expect(root.get(`--text-${name}`)).toBe(`calc(${px}px * var(--w-fs))`);
			expect(root.get(`--font-size-${name}`)).toBe(`calc(${px}px * var(--w-fs))`);
		}
	});

	test('the z-index scale keeps the values the app resolved to before the merge', () => {
		const expected: Record<string, number> = {
			base: 0, sticky: 100, dropdown: 200, popover: 500, overlay: 1000, popout: 1200, call: 1400,
			modal: 1500, 'modal-surface': 1501, 'modal-nested': 1600, 'modal-nested-surface': 1601, settings: 1600,
			'call-shell': 1700, tooltip: 1700, 'call-focus': 1750, 'call-docked': 1800, 'call-controls': 1802,
			toast: 2000, 'settings-shell': 2100, 'settings-nested': 2200, 'floating-ui': 2250, 'call-overlay': 2300,
			lightbox: 12000,
		};
		for (const [name, z] of Object.entries(expected)) expect(valuesOf(tokens, `--z-${name}`)).toEqual([String(z)]);
	});

	test('no token is declared twice in one block (the old semantic/legacy precedence trap)', () => {
		for (const candidate of blocks(tokens)) {
			const names = [...candidate.body.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]);
			const dupes = names.filter((name, index) => names.indexOf(name) !== index);
			expect(dupes, `duplicates in ${candidate.selector}`).toEqual([]);
		}
	});
});

describe('legacy bridge (§11)', () => {
	const bridge = block(tokens, 'body').decls;
	const BRIDGED = [
		'--surface-app', '--surface-base', '--surface-raised', '--surface-sunken', '--surface-hover', '--surface-selected',
		'--surface-card', '--surface-popover', '--surface-input', '--surface-modal', '--surface-panel', '--surface-overlay',
		'--surface-modal-overlay', '--text-heading', '--text-body', '--text-secondary', '--text-muted', '--text-placeholder',
		'--text-link', '--text-on-accent', '--accent-primary', '--accent-primary-color', '--accent-secondary',
		'--accent-secondary-color', '--accent-color', '--border-subtle', '--border-default', '--border-strong',
		'--border-focus', '--border-error', '--shadow-focus-ring', '--font-family-sans', '--font-family-mono',
	];

	test('every legacy color, border, focus and face name resolves through a --w-* role', () => {
		for (const name of BRIDGED) {
			const value = bridge.get(name);
			expect(value, `${name} is not bridged`).toBeDefined();
			expect(value, name).toMatch(/var\(--w-[\w-]+/);
		}
	});

	test('the bridge carries no raw colors, gradients or indigo fallbacks', () => {
		for (const [name, value] of bridge) {
			expect(value, name).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|gradient\(/i);
		}
		// The bridged names are not also defined on :root, where the inline palette would shadow them.
		const root = block(tokens, ':root').decls;
		for (const name of BRIDGED) expect(root.has(name), `${name} also on :root`).toBe(false);
	});

	test('the semantic meaning is kept: page, field well, quiet text, hairline, control edge', () => {
		expect(bridge.get('--surface-app')).toBe('var(--w-bg)');
		expect(bridge.get('--surface-raised')).toBe('var(--w-raise)');
		expect(bridge.get('--surface-input')).toBe('var(--w-sink)');
		expect(bridge.get('--text-heading')).toBe('var(--w-text)');
		expect(bridge.get('--text-secondary')).toBe('var(--w-mute)');
		expect(bridge.get('--text-muted')).toBe('var(--w-faint)');
		expect(bridge.get('--accent-primary-color')).toBe('var(--w-accent)');
		expect(bridge.get('--text-on-accent')).toBe('var(--w-on-accent)');
		expect(bridge.get('--border-subtle')).toBe('var(--w-line)');
		expect(bridge.get('--border-strong')).toBe('var(--w-line-strong)');
		expect(bridge.get('--shadow-focus-ring')).toBe('0 0 0 3px var(--w-accent-soft)');
		expect(bridge.get('--font-family-sans')).toBe('var(--w-sans)');
	});

	test('--w-on-accent only ever labels an accent fill', () => {
		// It is chosen against --w-accent, so on the page or a tinted band (the pinned bar is 18%
		// warning over the page) it can be white on pale amber. Text there is --w-text.
		const onAccent = [...bridge].filter(([, value]) => value.includes('--w-on-accent')).map(([name]) => name);
		expect(onAccent).toEqual(['--text-on-accent']);
		expect(bridge.get('--pinned-text-dark')).toBe('var(--w-text)');
	});

	test('the dead indigo-era triplets are gone instead of bridged', () => {
		expect(tokens).not.toMatch(/--color-(background|text|border|accent|status)-[\w-]*rgb\s*:/);
		expect(tokens).not.toContain('129, 140, 248');
		expect(tokens).not.toContain('99, 102, 241');
	});
});
