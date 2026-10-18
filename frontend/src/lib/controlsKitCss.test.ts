import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Contract: design spec §7.1-§7.17, §7.25, §8.7-§8.8 (the control, overlay/state and prose kits)
// and critique foundation#9 (one selection grammar) / foundation#14 (no shadows on small tools).
// The stylesheets are read as text, like baseLayerCss.test.ts, so a regression fails without a
// browser. The dev specimen at /__kit_review renders every class checked here.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const controls = read('../styles/controls-kit.css');
const overlays = read('../styles/kit-overlays.css');
const prose = read('../styles/kit-prose.css');
const kits: Record<string, string> = {
	'controls-kit.css': controls,
	'kit-overlays.css': overlays,
	'kit-prose.css': prose
};
const reviewPage = read('../routes/__kit_review/+page.svelte');
const reviewLoad = read('../routes/__kit_review/+page.ts');

interface Rule {
	selectors: string[];
	body: string;
	/** Enclosing at-rule preludes, outermost first. */
	context: string[];
}

/** The stylesheet without comments. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');

/** Split a selector list on top-level commas (not the ones inside :where(), :is() or :not()). */
function splitSelectors(list: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of list) {
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			parts.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	parts.push(current.trim());
	return parts.filter(Boolean);
}

/** A small CSS rule reader: follows nested at-rule blocks, skips keyframe steps and @import. */
function rules(source: string): Rule[] {
	const css = code(source);
	const out: Rule[] = [];
	const stack: string[] = [];
	let buffer = '';
	for (let i = 0; i < css.length; i++) {
		const ch = css[i];
		if (ch === '{') {
			const prelude = buffer.trim().replace(/\s+/g, ' ');
			buffer = '';
			if (prelude.startsWith('@')) {
				stack.push(prelude);
				continue;
			}
			const end = css.indexOf('}', i);
			const body = css.slice(i + 1, end);
			if (!/^(from|to|[\d.]+%)/.test(prelude)) {
				out.push({ selectors: splitSelectors(prelude), body, context: [...stack] });
			}
			i = end;
		} else if (ch === '}') {
			stack.pop();
			buffer = '';
		} else if (ch === ';' && buffer.trim().startsWith('@')) {
			buffer = '';
		} else {
			buffer += ch;
		}
	}
	return out;
}

/** Every declaration of a rule body as [property, value]. */
function decls(body: string): Array<[string, string]> {
	return body
		.split(';')
		.map((d) => d.trim())
		.filter((d) => d.includes(':'))
		.map((d) => {
			const at = d.indexOf(':');
			return [d.slice(0, at).trim(), d.slice(at + 1).trim().replace(/\s+/g, ' ')] as [string, string];
		});
}

function decl(body: string, property: string): string | undefined {
	return decls(body).find(([p]) => p === property)?.[1];
}

/** Top-level rules (not inside @media) whose selector list contains exactly `selector`. */
function ruleFor(source: string, selector: string): Rule {
	const found = rules(source).filter((r) => r.context.length === 0 && r.selectors.includes(selector));
	expect(found.length).toBeGreaterThan(0);
	return found[0];
}

const allRules = Object.entries(kits).flatMap(([name, source]) => rules(source).map((rule) => ({ name, ...rule })));

// ---------- a small cascade: selector matching and specificity over a synthetic tree ----------
// Enough of CSS to answer "which rule wins on this element" for the kit's own selectors: type,
// universal, class, attribute, :is/:where/:not, :first-child and the four combinators. Every
// other pseudo-class (:hover, :empty, :has, :checked, …) is treated as not matching, which is
// right for non-empty, unhovered content. Rules that style a pseudo-element never match.

interface El {
	tag: string;
	cls: string[];
	children: El[];
	parent?: El;
}

function el(tag: string, cls: string[] = [], children: El[] = []): El {
	const node: El = { tag, cls, children };
	for (const child of children) child.parent = node;
	return node;
}

const prevSibling = (node: El) => {
	const siblings = node.parent?.children ?? [];
	const at = siblings.indexOf(node);
	return at > 0 ? siblings[at - 1] : undefined;
};

/** Split a complex selector into compounds and the combinators between them. */
function complex(selector: string): { compounds: string[]; combinators: string[] } {
	const compounds: string[] = [];
	const combinators: string[] = [];
	let depth = 0;
	let current = '';
	let pending: string | null = null;
	for (const ch of selector.trim()) {
		if (ch === '(' || ch === '[') depth++;
		if (ch === ')' || ch === ']') depth--;
		if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) {
			if (current) {
				compounds.push(current);
				current = '';
				pending = ' ';
			}
			if (ch !== ' ') pending = ch;
			continue;
		}
		if (pending !== null) {
			combinators.push(pending);
			pending = null;
		}
		current += ch;
	}
	if (current) compounds.push(current);
	return { compounds, combinators };
}

/** The simple selectors of one compound: `li.a[x]:is(p)` → ['li', '.a', '[x]', ':is(p)']. */
function simples(compound: string): string[] {
	const parts: string[] = [];
	const lead = compound.match(/^(\*|[a-zA-Z][\w-]*)/);
	let i = 0;
	if (lead) {
		parts.push(lead[0]);
		i = lead[0].length;
	}
	while (i < compound.length) {
		const start = i;
		if (compound[i] === '[') {
			i = compound.indexOf(']', i) + 1;
		} else if (compound[i] === '.' || compound[i] === '#') {
			i++;
			while (i < compound.length && /[\w-]/.test(compound[i])) i++;
		} else if (compound[i] === ':') {
			i++;
			if (compound[i] === ':') i++;
			while (i < compound.length && /[\w-]/.test(compound[i])) i++;
			if (compound[i] === '(') {
				let depth = 0;
				do {
					if (compound[i] === '(') depth++;
					if (compound[i] === ')') depth--;
					i++;
				} while (depth > 0 && i < compound.length);
			}
		} else {
			throw new Error(`cannot read selector part "${compound.slice(i)}"`);
		}
		parts.push(compound.slice(start, i));
	}
	return parts;
}

const pseudoName = (part: string) => part.match(/^::?([\w-]+)/)?.[1] ?? '';
const pseudoArg = (part: string) => (part.includes('(') ? part.slice(part.indexOf('(') + 1, -1) : '');
const legacyPseudoElements = ['before', 'after', 'marker', 'placeholder', 'selection'];

type Specificity = [number, number, number];
const higher = (a: Specificity, b: Specificity) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function specificity(selector: string): Specificity {
	const total: Specificity = [0, 0, 0];
	for (const compound of complex(selector).compounds) {
		for (const part of simples(compound)) {
			let s: Specificity = [0, 0, 0];
			if (part.startsWith('#')) s = [1, 0, 0];
			else if (part.startsWith('.') || part.startsWith('[')) s = [0, 1, 0];
			else if (part.startsWith('::') || legacyPseudoElements.includes(pseudoName(part))) s = [0, 0, 1];
			else if (part.startsWith(':')) {
				const name = pseudoName(part);
				if (name === 'where') s = [0, 0, 0];
				else if (['is', 'not', 'has'].includes(name)) s = splitSelectors(pseudoArg(part)).map(specificity).sort(higher).at(-1)!;
				else s = [0, 1, 0];
			} else if (part !== '*') s = [0, 0, 1];
			total[0] += s[0];
			total[1] += s[1];
			total[2] += s[2];
		}
	}
	return total;
}

function matchesCompound(node: El, compound: string): boolean {
	for (const part of simples(compound)) {
		if (part === '*') continue;
		if (part.startsWith('::') || legacyPseudoElements.includes(pseudoName(part))) return false;
		if (part.startsWith('.')) {
			if (!node.cls.includes(part.slice(1))) return false;
		} else if (part.startsWith('[') || part.startsWith('#')) {
			return false;
		} else if (part.startsWith(':')) {
			const name = pseudoName(part);
			const args = splitSelectors(pseudoArg(part));
			if (name === 'is' || name === 'where') {
				if (!args.some((s) => matches(node, s))) return false;
			} else if (name === 'not') {
				if (args.some((s) => matches(node, s))) return false;
			} else if (name === 'first-child') {
				if (prevSibling(node)) return false;
			} else {
				return false;
			}
		} else if (part !== node.tag) {
			return false;
		}
	}
	return true;
}

function matches(node: El, selector: string): boolean {
	const { compounds, combinators } = complex(selector);
	const from = (at: El | undefined, index: number): boolean => {
		if (!at || !matchesCompound(at, compounds[index])) return false;
		if (index === 0) return true;
		const combinator = combinators[index - 1];
		if (combinator === '>') return from(at.parent, index - 1);
		if (combinator === '+') return from(prevSibling(at), index - 1);
		if (combinator === '~') {
			for (let s = prevSibling(at); s; s = prevSibling(s)) if (from(s, index - 1)) return true;
			return false;
		}
		for (let a = at.parent; a; a = a.parent) if (from(a, index - 1)) return true;
		return false;
	};
	return from(node, compounds.length - 1);
}

/** The longhand a declaration sets for `property`, if any (margin and font shorthands expanded). */
function longhand(property: string, value: string, wanted: string): string | undefined {
	if (property === wanted) return value;
	const parts = value.split(/\s+(?![^(]*\))/);
	if (property === 'margin' && wanted === 'margin-top') return parts[0];
	if (property === 'margin' && wanted === 'margin-bottom') return parts[parts.length > 2 ? 2 : 0];
	if (property === 'margin-block' && wanted === 'margin-top') return parts[0];
	if (property === 'margin-block' && wanted === 'margin-bottom') return parts[1] ?? parts[0];
	if (property === 'font' && wanted === 'line-height') return value === 'inherit' ? 'inherit' : value.match(/\/\s*(calc\([^)]*\)|\S+)/)?.[1] ?? 'normal';
	return undefined;
}

/** The global element rules from base.css load before the kits. */
const base = read('../styles/base.css');
const cascadeRules = [...rules(base), ...rules(prose)].filter((r) => r.context.length === 0);

/** The winning value of `property` on `node` among base.css and the prose kit (top level only). */
function cascaded(node: El, property: string): string | undefined {
	let winner: { value: string; spec: Specificity; order: number } | undefined;
	cascadeRules.forEach((rule, order) => {
		for (const selector of rule.selectors) {
			if (!matches(node, selector)) continue;
			for (const [p, v] of decls(rule.body)) {
				const value = longhand(p, v, property);
				if (value === undefined) continue;
				const spec = specificity(selector);
				if (!winner || higher(spec, winner.spec) > 0 || (higher(spec, winner.spec) === 0 && order >= winner.order)) {
					winner = { value, spec, order };
				}
			}
		}
	});
	return winner?.value;
}

describe('kit files load together', () => {
	test('controls-kit.css imports the overlay and prose kits before any rule', () => {
		const css = code(controls).trim();
		expect(css.startsWith("@import './kit-overlays.css';")).toBe(true);
		const firstRule = css.indexOf('{');
		expect(css.indexOf("@import './kit-overlays.css';")).toBeLessThan(firstRule);
		expect(css.indexOf("@import './kit-prose.css';")).toBeGreaterThan(-1);
		expect(css.indexOf("@import './kit-prose.css';")).toBeLessThan(firstRule);
	});
});

describe('kits paint only with roles', () => {
	test('no raw hex, rgb(), hsl() or named colours (color-mix of roles is the only mixing)', () => {
		for (const [name, source] of Object.entries(kits)) {
			const css = code(source);
			expect(`${name}: ${css.match(/#[0-9a-f]{3,8}\b/i)?.[0] ?? 'ok'}`).toBe(`${name}: ok`);
			expect(`${name}: ${css.match(/\b(rgba?|hsla?|oklch|lab|lch)\(/)?.[0] ?? 'ok'}`).toBe(`${name}: ok`);
		}
		const named = /(^|[\s,(])(white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|silver|gold)(?=$|[\s,)])/i;
		for (const rule of allRules) {
			for (const [property, value] of decls(rule.body)) {
				expect(`${rule.name} ${rule.selectors[0]} ${property}: ${named.test(value) ? value : 'ok'}`).toBe(
					`${rule.name} ${rule.selectors[0]} ${property}: ok`
				);
			}
		}
	});

	test('no legacy colour tokens', () => {
		for (const [name, source] of Object.entries(kits)) {
			const legacy = code(source).match(/--(surface-|accent-primary|accent-secondary|text-(?!decoration)|color-|border-subtle)[\w-]*/);
			expect(`${name}: ${legacy?.[0] ?? 'ok'}`).toBe(`${name}: ok`);
		}
	});

	test('no !important and no transition: all', () => {
		for (const [name, source] of Object.entries(kits)) {
			expect(`${name}: ${code(source).includes('!important') ? '!important' : 'ok'}`).toBe(`${name}: ok`);
		}
		for (const rule of allRules) {
			for (const [property, value] of decls(rule.body)) {
				if (property !== 'transition' && property !== 'transition-property') continue;
				expect(`${rule.selectors[0]}: ${/(^|,\s*)all\b/.test(value) ? value : 'ok'}`).toBe(`${rule.selectors[0]}: ok`);
			}
		}
	});
});

describe('kit type follows the scale', () => {
	const serifTokens = /--w-t-(display|title|heading|subhead)\b|var\(--w-serif\)/;
	const monoTokens = /--w-t-(kicker|mono|micro)\b|var\(--w-mono\)/;
	// Selectors whose element inherits a serif face set by its parent rule (the day rule's label).
	const serifContexts = [/^\.w-dayrule\b/];

	test('sans never uses 600 (labels are 500, emphasis 700); mono never 600; serif may', () => {
		for (const rule of allRules) {
			const font = decl(rule.body, 'font');
			const weight = decl(rule.body, 'font-weight') ?? font?.match(/^(\d{3})\s/)?.[1];
			if (!weight || !/^\d+$/.test(weight) || Number(weight) < 550 || Number(weight) >= 700) continue;
			const isSerif = serifTokens.test(rule.body) || rule.selectors.every((s) => serifContexts.some((re) => re.test(s)));
			const isMono = monoTokens.test(rule.body);
			expect(`${rule.name} ${rule.selectors.join(', ')}: weight ${weight} ${isSerif && !isMono ? 'serif' : 'not serif'}`).toBe(
				`${rule.name} ${rule.selectors.join(', ')}: weight ${weight} serif`
			);
		}
	});

	test('every pixel text size scales with --w-fs', () => {
		for (const rule of allRules) {
			for (const [property, value] of decls(rule.body)) {
				if (property !== 'font' && property !== 'font-size' && property !== 'line-height') continue;
				if (!/\d+px/.test(value)) continue;
				expect(`${rule.selectors[0]} ${property}: ${value.includes('var(--w-fs)') ? 'scales' : value}`).toBe(
					`${rule.selectors[0]} ${property}: scales`
				);
			}
		}
	});

	test('corners come from the radius tokens', () => {
		for (const rule of allRules) {
			for (const [property, value] of decls(rule.body)) {
				if (!/radius$/.test(property)) continue;
				const ok = value === '0' || value === 'inherit' || value.split(/\s+(?![^(]*\))/).every((v) => v === '0' || /^(var\(--(radius-(sm|inner|md|lg|xl)|w-pill|w-avr)\)|calc\(var\(--radius-\w+\) \+ \d+px\))$/.test(v));
				expect(`${rule.selectors[0]} ${property}: ${ok ? 'token' : value}`).toBe(`${rule.selectors[0]} ${property}: token`);
			}
		}
	});
});

describe('§7.1 button and §7.2 icon button', () => {
	test('.w-btn is 32px (sm 28, lg 40) on --radius-md with the label type', () => {
		const btn = ruleFor(controls, '.w-btn');
		expect(decl(btn.body, 'height')).toBe('32px');
		expect(decl(btn.body, 'padding')).toBe('0 12px');
		expect(decl(btn.body, 'border-radius')).toBe('var(--radius-md)');
		expect(decl(btn.body, 'font')).toBe('var(--w-t-label)');
		expect(decl(btn.body, 'white-space')).toBe('nowrap');
		expect(decl(ruleFor(controls, '.w-btn--sm').body, 'height')).toBe('28px');
		expect(decl(ruleFor(controls, '.w-btn--lg').body, 'height')).toBe('40px');
	});

	test('primary is ink on paper, never an accent fill', () => {
		const primary = ruleFor(controls, '.w-btn--primary');
		expect(decl(primary.body, 'background')).toBe('var(--w-text)');
		expect(decl(primary.body, 'color')).toBe('var(--w-bg)');
		for (const rule of rules(controls).filter((r) => r.selectors.some((s) => s.includes('.w-btn--primary')))) {
			expect(rule.body).not.toContain('--w-accent');
		}
	});

	test('hover never changes size or position', () => {
		for (const rule of allRules) {
			if (!rule.selectors.some((s) => s.includes(':hover'))) continue;
			for (const property of ['transform', 'scale', 'translate', 'width', 'height', 'padding', 'margin']) {
				expect(`${rule.selectors[0]} ${property}: ${decl(rule.body, property) ?? 'none'}`).toBe(`${rule.selectors[0]} ${property}: none`);
			}
		}
	});

	test('.w-ibtn is a 32px square (sm 28) with an 18px glyph', () => {
		const ibtn = ruleFor(controls, '.w-ibtn');
		expect(decl(ibtn.body, 'width')).toBe('32px');
		expect(decl(ibtn.body, 'height')).toBe('32px');
		expect(decl(ruleFor(controls, ':where(.w-ibtn) > :where(svg)').body, 'width')).toBe('18px');
		expect(decl(ruleFor(controls, '.w-ibtn--sm').body, 'width')).toBe('28px');
	});
});

describe('§5.2 selection grammar in the kit', () => {
	test('.w-seg selected key is paper with a line-strong ring, never an accent fill', () => {
		const selected = rules(controls).filter((r) => r.selectors.some((s) => s.includes('.w-seg') && /aria-(pressed|checked)='true'/.test(s) && !s.includes(':not(')));
		expect(selected.length).toBeGreaterThan(0);
		for (const rule of selected) {
			expect(rule.body).not.toContain('--w-accent');
			expect(rule.body).not.toContain('--w-on-accent');
		}
		const [paper] = selected.filter((r) => r.context.length === 0 && !r.selectors[0].startsWith(':root'));
		expect(decl(paper.body, 'background')).toBe('var(--w-bg)');
		expect(decl(paper.body, 'color')).toBe('var(--w-text)');
		expect(decl(paper.body, 'box-shadow')).toBe('0 0 0 var(--w-bw) var(--w-line-strong), var(--w-shadow-1)');
		const [daylight] = selected.filter((r) => r.selectors[0].startsWith(":root[data-mode='light']"));
		expect(decl(daylight.body, 'background')).toBe('var(--w-lift)');
	});

	test('no left bars: no inset side shadows and no coloured border-left', () => {
		for (const rule of allRules) {
			const shadow = decl(rule.body, 'box-shadow') ?? '';
			expect(`${rule.selectors[0]}: ${/inset\s+-?\d+px\s+0\s+0/.test(shadow) ? shadow : 'ok'}`).toBe(`${rule.selectors[0]}: ok`);
			const left = decl(rule.body, 'border-left') ?? '';
			expect(`${rule.selectors[0]}: ${/--w-(accent|sig|seal|danger)/.test(left) ? left : 'ok'}`).toBe(`${rule.selectors[0]}: ok`);
		}
	});

	test('High Contrast hover and highlight are rings', () => {
		const hc = allRules.filter((r) => r.selectors.some((s) => s.startsWith(":root[data-char='contrast']")));
		expect(hc.some((r) => r.selectors.some((s) => s.includes('.w-menu__item')) && decl(r.body, 'box-shadow') === 'inset 0 0 0 1px var(--w-line-strong)')).toBe(true);
		expect(hc.some((r) => r.selectors.some((s) => s.includes('.w-seg')) && decl(r.body, 'box-shadow') === 'inset 0 0 0 1px var(--w-line-strong)')).toBe(true);
	});
});

describe('§7.3-§7.9 controls and marks', () => {
	test('fields are 38px in forms and 32px in chrome; focus is an accent edge plus the ring', () => {
		expect(decl(ruleFor(controls, '.w-field').body, 'height')).toBe('38px');
		expect(decl(ruleFor(controls, '.w-field').body, 'background')).toBe('var(--w-sink)');
		expect(decl(ruleFor(controls, '.w-field--chrome').body, 'height')).toBe('32px');
		const focus = ruleFor(controls, '.w-field:focus-within');
		expect(decl(focus.body, 'border-color')).toBe('var(--w-accent)');
		expect(decl(focus.body, 'box-shadow')).toBe('var(--w-ring)');
		// The Daylight chrome edge must not outweigh the focus edge.
		const daylight = rules(controls).find((r) => r.selectors.some((s) => s.includes("data-mode='light'") && s.includes('.w-field--chrome')));
		expect(daylight?.selectors[0].startsWith(':where(')).toBe(true);
	});

	test('select trigger is a lifted 32px object; the applied state is accent-soft', () => {
		const select = ruleFor(controls, '.w-select');
		expect(decl(select.body, 'height')).toBe('32px');
		expect(decl(select.body, 'background')).toBe('var(--w-lift)');
		const applied = ruleFor(controls, '.w-select--applied');
		expect(decl(applied.body, 'background')).toBe('var(--w-accent-soft)');
		expect(decl(applied.body, 'border-color')).toBe('color-mix(in srgb, var(--w-accent) 45%, transparent)');
	});

	test('switch is 36×20; on is the accent track with the thumb moved 16px', () => {
		const sw = ruleFor(controls, '.w-switch');
		expect(decl(sw.body, 'width')).toBe('36px');
		expect(decl(sw.body, 'height')).toBe('20px');
		expect(decl(ruleFor(controls, '.w-switch::after').body, 'width')).toBe('14px');
		expect(decl(ruleFor(controls, ".w-switch[aria-checked='true']").body, 'background')).toBe('var(--w-accent)');
		expect(decl(ruleFor(controls, ".w-switch[aria-checked='true']::after").body, 'transform')).toBe('translateX(16px)');
	});

	test('the mixed checkbox draws a bar, and its rule outweighs the check shape', () => {
		const mixed = ruleFor(controls, ".w-check:is(:indeterminate, [aria-checked='mixed'])::before");
		expect(decl(mixed.body, 'clip-path')).toBe('none');
		// The shared check shape must not be written with a heavier :is() group.
		expect(code(controls)).not.toContain(":is(.w-check, .w-prose li > input[type='checkbox'])");
	});

	test('maturity tag and role word are 10px tracked uppercase mono', () => {
		for (const selector of ['.w-tag--mat', '.w-role']) {
			const rule = ruleFor(controls, selector);
			expect(decl(rule.body, 'font-size')).toBe('calc(10px * var(--w-fs))');
			expect(decl(rule.body, 'letter-spacing')).toBe('0.1em');
			expect(decl(rule.body, 'text-transform')).toBe('uppercase');
			expect(decl(rule.body, 'color')).toBe('var(--w-faint)');
		}
		expect(decl(ruleFor(controls, '.w-role').body, 'border')).toBeUndefined();
	});

	test('badges are ink pills; the seal chip is the only seal-tinted mark', () => {
		const badge = ruleFor(controls, '.w-badge');
		expect(decl(badge.body, 'background')).toBe('var(--w-text)');
		expect(decl(badge.body, 'color')).toBe('var(--w-bg)');
		expect(decl(badge.body, 'height')).toBe('18px');
		expect(decl(ruleFor(controls, '.w-badge--sm').body, 'height')).toBe('16px');
		expect(decl(badge.body, 'animation')).toBeUndefined();
		expect(decl(ruleFor(controls, '.w-seal').body, 'background')).toBe('var(--w-seal-soft)');
		for (const selector of ['.w-tag', '.w-tag--mat', '.w-role', '.w-badge']) {
			expect(ruleFor(controls, selector).body).not.toMatch(/--w-(seal|accent)/);
		}
	});

	test('settings rows are rules, not boxes', () => {
		const row = ruleFor(controls, '.w-srow');
		expect(decl(row.body, 'min-height')).toBe('68px');
		expect(decl(row.body, 'border-bottom')).toBe('var(--w-bw) solid var(--w-line)');
		expect(decl(row.body, 'background')).toBeUndefined();
		expect(decl(row.body, 'border-radius')).toBeUndefined();
		expect(decl(ruleFor(controls, '.w-disclosure').body, 'height')).toBe('40px');
		// The boxed legacy .w-row had no callers left; §7.11 reserves the name for the channel row,
		// so a leftover global box rule would land on every sidebar row.
		const legacy = allRules.filter((r) => r.selectors.some((s) => /(?<![\w-])\.w-(row|title|subtitle)(?![\w-])/.test(s)));
		expect(legacy.map((r) => r.selectors.join(', '))).toEqual([]);
	});
});

describe('High Contrast: hover is a ring instead of a fill (§5.2)', () => {
	const hc = allRules.filter((r) => r.context.length === 0 && r.selectors.some((s) => s.startsWith(":root[data-char='contrast']")));
	const ring = 'inset 0 0 0 1px var(--w-line-strong)';
	const hcFor = (pattern: RegExp) => hc.filter((r) => r.selectors.some((s) => pattern.test(s)));

	test('default buttons, selects and reactions show a ring on hover (their idle edge already equals line-strong)', () => {
		for (const pattern of [/\.w-btn:where\(.*\):hover$/, /\.w-select:where\(.*\):hover$/, /\.w-react:hover$/]) {
			const found = hcFor(pattern);
			expect(`${pattern}: ${found.some((r) => decl(r.body, 'box-shadow') === ring) ? 'ring' : 'none'}`).toBe(`${pattern}: ring`);
		}
		// Primary and danger keep their own visible hover fills.
		const btn = hcFor(/\.w-btn:where\(.*\):hover$/)[0];
		expect(btn.selectors[0]).toContain('.w-btn--primary');
		expect(btn.selectors[0]).toContain('.w-btn--danger');
	});

	test('plain hover drops the fill; highlighted, selected and pressed keep it with the ring', () => {
		for (const pattern of [/\.w-btn:where\(.*\):hover$/, /\.w-ibtn:where\(.*\):hover$/, /\.w-menu__item:hover$/, /\.w-sheet__row:hover$/, /\.w-tool__quick:hover$/]) {
			const found = hcFor(pattern);
			expect(`${pattern}: ${found.some((r) => decl(r.body, 'background') === 'transparent') ? 'no fill' : 'fill'}`).toBe(`${pattern}: no fill`);
		}
		const highlighted = hcFor(/\.w-menu__item:is\(\[data-highlighted\]/)[0];
		expect(decl(highlighted.body, 'background')).toBe('var(--w-raise)');
		expect(decl(highlighted.body, 'box-shadow')).toBe(ring);
		const pressed = hcFor(/\.w-ibtn:is\(\[aria-pressed='true'\]/)[0];
		expect(decl(pressed.body, 'background')).toBe('var(--w-raise)');
		// The highlight rule comes after the plain hover rule, so a hovered highlighted row keeps its fill.
		const order = (pattern: RegExp) => rules(overlays).findIndex((r) => r.selectors.some((s) => pattern.test(s)));
		expect(order(/contrast'\] \.w-menu__item:is\(\[data-highlighted\]/)).toBeGreaterThan(order(/contrast'\] \.w-menu__item:hover$/));
	});
});

describe('forced colors keep every control state (§10)', () => {
	const forced = allRules.filter((r) => r.context.some((c) => c.includes('forced-colors: active')));
	const forcedFor = (selector: string) => forced.filter((r) => r.selectors.includes(selector));

	test('system colors appear only inside forced-colors blocks', () => {
		const system = /(^|[\s,(])(Canvas|CanvasText|Highlight|HighlightText|GrayText|ButtonFace|ButtonText|LinkText|Field|FieldText|Mark|MarkText|AccentColor|AccentColorText)(?=$|[\s,)])/;
		for (const rule of allRules) {
			if (rule.context.some((c) => c.includes('forced-colors'))) continue;
			for (const [property, value] of decls(rule.body)) {
				expect(`${rule.name} ${rule.selectors[0]} ${property}: ${system.test(value) ? value : 'ok'}`).toBe(`${rule.name} ${rule.selectors[0]} ${property}: ok`);
			}
		}
	});

	test('checked boxes, radios and switches are painted in Highlight; the check and thumb stay visible', () => {
		const checked = forcedFor(".w-check:is(:checked, :indeterminate, [aria-checked='true'], [aria-checked='mixed'])")[0];
		expect(decl(checked.body, 'background')).toBe('Highlight');
		expect(decl(forcedFor('.w-check::before')[0].body, 'background')).toBe('HighlightText');
		expect(decl(forcedFor('.w-check')[0].body, 'border-color')).toBe('CanvasText');
		expect(decl(forcedFor(".w-radio:is(:checked, [aria-checked='true'])")[0].body, 'border-color')).toBe('Highlight');
		expect(decl(forcedFor('.w-radio::before')[0].body, 'background')).toBe('Highlight');
		expect(decl(forcedFor(".w-switch[aria-checked='true']")[0].body, 'background')).toBe('Highlight');
		expect(decl(forcedFor('.w-switch::after')[0].body, 'background')).toBe('CanvasText');
		expect(decl(forcedFor(".w-switch[aria-checked='true']::after")[0].body, 'background')).toBe('HighlightText');
	});

	test('the selected segment key is the system selection, at least as heavy as the Daylight paper key', () => {
		const key = ":is([aria-pressed='true'], [aria-checked='true'], [aria-selected='true'], [aria-current='page'])";
		const rule = forcedFor(`.w-seg > ${key}`)[0];
		expect(decl(rule.body, 'background')).toBe('Highlight');
		expect(decl(rule.body, 'color')).toBe('HighlightText');
		const daylight = rules(controls).find((r) => r.context.length === 0 && r.selectors.includes(`:root[data-mode='light'] .w-seg > ${key}`))!;
		const heaviest = rule.selectors.map(specificity).sort(higher).at(-1)!;
		expect(higher(heaviest, specificity(daylight.selectors[0]))).toBeGreaterThanOrEqual(0);
	});

	test('the range opts out of forced colors and draws its fill and thumb in system colors', () => {
		expect(decl(forcedFor(":root input[type='range'].w-range")[0].body, 'forced-color-adjust')).toBe('none');
		expect(decl(forcedFor(":root input[type='range'].w-range::-webkit-slider-runnable-track")[0].body, 'background')).toContain('Highlight var(--w-range-fill, 0%)');
		expect(decl(forcedFor(":root input[type='range'].w-range::-webkit-slider-thumb")[0].body, 'background')).toBe('Highlight');
	});

	test('menu highlights, the load line and the outline mark survive', () => {
		expect(forced.some((r) => r.selectors.some((s) => s.startsWith('.w-menu__item:is(:hover')) && decl(r.body, 'background') === 'Highlight')).toBe(true);
		expect(decl(forcedFor('.w-loadline::before')[0].body, 'background')).toBe('Highlight');
		expect(forced.some((r) => r.selectors.some((s) => s.startsWith('.w-outline') && s.endsWith('::before')) && decl(r.body, 'background') === 'Highlight')).toBe(true);
	});
});

describe('touch targets reach 44px under a coarse pointer (§10)', () => {
	const coarse = allRules.filter((r) => r.context.some((c) => c.includes('pointer: coarse')));
	const coarseFor = (selector: string) => coarse.filter((r) => r.selectors.includes(selector));

	test('buttons, fields, selects, segment keys, choices and disclosures are 44px', () => {
		expect(decl(coarseFor('.w-btn')[0].body, 'height')).toBe('44px');
		expect(decl(coarseFor('.w-ibtn')[0].body, 'height')).toBe('44px');
		expect(decl(coarseFor('.w-select')[0].body, 'height')).toBe('44px');
		expect(decl(coarseFor(".w-seg > :is(button, a, [role='radio'], [role='tab'])")[0].body, 'height')).toBe('44px');
		expect(decl(coarseFor('.w-choice')[0].body, 'min-height')).toBe('44px');
		expect(decl(coarseFor('.w-disclosure')[0].body, 'height')).toBe('44px');
		expect(decl(coarseFor(":root input[type='range'].w-range")[0].body, 'height')).toBe('44px');
	});

	test('the switch, reactions and the toast action get an invisible 44px hit area without changing their drawing', () => {
		for (const selector of ['.w-switch::before', '.w-react::before', '.w-toast__action::before']) {
			const hit = coarseFor(selector)[0];
			expect(`${selector}: ${hit ? decl(hit.body, 'height') : 'missing'}`).toBe(`${selector}: 44px`);
			expect(decl(hit.body, 'width')).toBe('max(100%, 44px)');
			expect(decl(hit.body, 'position')).toBe('absolute');
			expect(decl(hit.body, 'background')).toBeUndefined();
		}
		expect(decl(coarseFor('.w-react')[0].body, 'position')).toBe('relative');
		expect(decl(coarseFor('.w-toast__action')[0].body, 'position')).toBe('relative');
		// The drawn switch stays 36×20 everywhere.
		expect(coarse.some((r) => r.selectors.includes('.w-switch') && (decl(r.body, 'width') || decl(r.body, 'height')))).toBe(false);
	});

	test('outline entries grow to 44px (18px line + 13px above and below)', () => {
		const entry = coarseFor('.w-outline :is(a, button)')[0];
		expect(decl(entry.body, 'padding-top')).toBe('13px');
		expect(decl(entry.body, 'padding-bottom')).toBe('13px');
	});
});

describe('§7.13-§7.16 overlays and states', () => {
	test('small floating tools carry no shadow (D19)', () => {
		const toolRules = rules(overlays).filter((r) => r.selectors.some((s) => /\.w-tool(--bubble)?(?![\w-])/.test(s)));
		expect(toolRules.length).toBeGreaterThan(0);
		for (const rule of toolRules) {
			const shadow = decl(rule.body, 'box-shadow');
			expect(`${rule.selectors.join(', ')}: ${shadow === undefined || shadow === 'none' ? 'flat' : shadow}`).toBe(`${rule.selectors.join(', ')}: flat`);
		}
		expect(decl(ruleFor(overlays, '.w-tool').body, 'border')).toBe('var(--w-bw) solid var(--w-line-strong)');
	});

	test('menus, popovers, dialogs, sheets and toasts use --w-shadow; the tooltip has none', () => {
		for (const selector of ['.w-menu', '.w-pop', '.w-dialog', '.w-sheet', '.w-toast']) {
			expect(`${selector}: ${decl(ruleFor(overlays, selector).body, 'box-shadow')}`).toBe(`${selector}: var(--w-shadow)`);
		}
		expect(decl(ruleFor(overlays, '.w-tip').body, 'box-shadow')).toBeUndefined();
	});

	test('tooltip and toast are inverse', () => {
		for (const selector of ['.w-tip', '.w-toast']) {
			const rule = ruleFor(overlays, selector);
			expect(decl(rule.body, 'background')).toBe('var(--w-text)');
			expect(decl(rule.body, 'color')).toBe('var(--w-bg)');
		}
		expect(decl(ruleFor(overlays, '.w-toast').body, 'width')).toBe('360px');
	});

	test('menu items are 32px with an inner radius and a raise highlight', () => {
		const item = ruleFor(overlays, '.w-menu__item');
		expect(decl(item.body, 'min-height')).toBe('32px');
		expect(decl(item.body, 'border-radius')).toBe('var(--radius-inner)');
		expect(decl(ruleFor(overlays, '.w-menu__item:hover').body, 'background')).toBe('var(--w-raise)');
		expect(decl(ruleFor(overlays, '.w-menu').body, 'min-width')).toBe('220px');
	});

	test('dialogs: sizes, the --w-bg page, and closed <dialog> elements stay hidden', () => {
		expect(decl(ruleFor(overlays, '.w-dialog--sm').body, '--w-dialog-w')).toBe('440px');
		expect(decl(ruleFor(overlays, '.w-dialog--md').body, '--w-dialog-w')).toBe('560px');
		expect(decl(ruleFor(overlays, '.w-dialog--lg').body, '--w-dialog-w')).toBe('760px');
		expect(decl(ruleFor(overlays, '.w-dialog--settings').body, '--w-dialog-w')).toBe('1040px');
		const dialog = ruleFor(overlays, '.w-dialog');
		expect(decl(dialog.body, 'background')).toBe('var(--w-bg)');
		expect(decl(dialog.body, 'border-radius')).toBe('var(--radius-xl)');
		expect(decl(dialog.body, 'margin')).toBe('auto');
		expect(decl(ruleFor(overlays, 'dialog.w-dialog:not([open])').body, 'display')).toBe('none');
		expect(decl(ruleFor(overlays, '.w-dialog__head').body, 'min-height')).toBe('64px');
	});

	test('the error notice is danger-edged; info and warn use the strong hairline', () => {
		const notice = ruleFor(overlays, '.w-notice');
		expect(decl(notice.body, 'grid-template-columns')).toBe('16px minmax(0, 1fr) auto');
		expect(decl(notice.body, 'border')).toBe('var(--w-bw) solid color-mix(in srgb, var(--w-danger) 45%, transparent)');
		expect(decl(notice.body, 'background')).toBe('color-mix(in srgb, var(--w-danger) 8%, var(--w-bg))');
		expect(decl(ruleFor(overlays, '.w-notice--info').body, 'border-color')).toBe('var(--w-line-strong)');
	});

	test('empty states are left-aligned and unboxed', () => {
		const empty = ruleFor(overlays, '.w-empty');
		expect(decl(empty.body, 'align-items')).toBe('flex-start');
		expect(decl(empty.body, 'border')).toBeUndefined();
		expect(decl(empty.body, 'background')).toBeUndefined();
		expect(decl(ruleFor(overlays, '.w-empty__enso').body, 'background')).toBe('var(--w-deco)');
	});

	test('Daylight lifts overlays and floating tools onto --w-lift', () => {
		const lift = rules(overlays).find((r) => r.selectors.some((s) => s.startsWith(":root[data-mode='light']") && s.includes('.w-tool')));
		expect(decl(lift!.body, 'background')).toBe('var(--w-lift)');
	});
});

describe('§8.7-§8.8 and §7.17 prose kit', () => {
	test('.w-prose reads at --w-t-read in a 68ch measure, never pre-wrapped', () => {
		const p = ruleFor(prose, '.w-prose');
		expect(decl(p.body, 'font')).toBe('var(--w-t-read)');
		expect(decl(p.body, 'max-width')).toBe('68ch');
		expect(decl(p.body, 'white-space')).toBe('normal');
		expect(decl(ruleFor(prose, '.w-prose > * + *').body, 'margin-top')).toBe('18px');
		const quote = ruleFor(prose, '.w-prose blockquote');
		expect(decl(quote.body, 'border-left')).toBe('2px solid var(--w-line-strong)');
		expect(decl(quote.body, 'font-style')).toBe('normal');
	});

	// The rhythm is checked as the cascade's outcome, with base.css's global `p` rule in play: a
	// heavier `.w-prose p { margin: 0 }` once zeroed every gap while the declarations still read 18px.
	describe('block rhythm wins the cascade', () => {
		const h2 = el('h2');
		const p1 = el('p');
		const p2 = el('p');
		const h3 = el('h3');
		const p3 = el('p');
		const ol = el('ol');
		const li = el('li', [], [el('p'), el('p')]);
		ol.children.push(li);
		li.parent = ol;
		const quote = el('blockquote', [], [el('p'), el('p')]);
		const hr = el('hr');
		const afterRule = el('p');
		el('div', ['w-prose'], [h2, p1, p2, h3, p3, ol, quote, hr, afterRule]);

		test('p + p is 18px', () => {
			expect(cascaded(p2, 'margin-top')).toBe('18px');
		});

		test('a heading sits 16px above what it introduces, and further from what came before it', () => {
			expect(cascaded(p1, 'margin-top')).toBe('16px');
			expect(cascaded(p3, 'margin-top')).toBe('16px');
			expect(cascaded(h3, 'margin-top')).toBe('28px');
		});

		test('lists and quotes keep 18px above; the first block after a rule starts flush', () => {
			expect(cascaded(ol, 'margin-top')).toBe('18px');
			expect(cascaded(quote, 'margin-top')).toBe('18px');
			expect(cascaded(afterRule, 'margin-top')).toBe('0');
		});

		test('nested paragraphs lose the global margins but keep their own spacing', () => {
			expect(cascaded(li.children[0], 'margin-top')).toBe('0');
			expect(cascaded(li.children[1], 'margin-top')).toBe('6px');
			expect(cascaded(quote.children[0], 'margin-top')).toBe('0');
			expect(cascaded(quote.children[1], 'margin-top')).toBe('12px');
			for (const p of [p1, p2, p3, li.children[0], quote.children[1]]) {
				expect(cascaded(p, 'margin-bottom')).toBe('0');
			}
		});

		test('paragraphs inherit the reading line instead of the global 1.5', () => {
			for (const p of [p1, p2, li.children[0], quote.children[0]]) {
				expect(cascaded(p, 'line-height')).toBe('inherit');
			}
		});

		test('no prose rule that can reach a direct-child paragraph zeroes its top margin with more weight than the rhythm', () => {
			const rhythm = specificity('.w-prose > * + *');
			for (const rule of rules(prose).filter((r) => r.context.length === 0)) {
				for (const selector of rule.selectors) {
					const top = decls(rule.body).map(([p, v]) => longhand(p, v, 'margin-top')).find((v) => v !== undefined);
					if (top !== '0' || !matches(p2, selector)) continue;
					expect(`${selector}: ${higher(specificity(selector), rhythm) > 0 ? 'outweighs' : 'ok'}`).toBe(`${selector}: ok`);
				}
			}
		});
	});

	test('tables keep their table role (no display: block); dialog paragraphs keep the body line', () => {
		expect(decl(ruleFor(prose, '.w-prose table').body, 'display')).toBeUndefined();
		expect(decl(ruleFor(overlays, '.w-dialog__body > p').body, 'line-height')).toBe('inherit');
	});

	test('the outline marks the current heading with a 2px --w-sig mark on a hairline', () => {
		expect(decl(ruleFor(prose, '.w-outline > :is(ol, ul)').body, 'border-left')).toBe('var(--w-bw) solid var(--w-line)');
		const mark = rules(prose).find((r) => r.selectors.some((s) => s.startsWith('.w-outline') && s.endsWith('::before')));
		expect(decl(mark!.body, 'width')).toBe('2px');
		expect(decl(mark!.body, 'background')).toBe('var(--w-sig)');
	});

	test('the unread rule is accent, never danger; the typing row is 24px', () => {
		expect(decl(ruleFor(prose, '.w-newrule::before').body, 'background')).toBe('color-mix(in srgb, var(--w-accent) 60%, transparent)');
		expect(code(prose)).not.toMatch(/\.w-newrule[^{]*\{[^}]*--w-danger/);
		expect(decl(ruleFor(prose, '.w-typing').body, 'height')).toBe('24px');
	});
});

describe('dev specimen route', () => {
	test('/__kit_review is a 404 outside dev builds', () => {
		expect(reviewLoad).toContain("from '$app/environment'");
		expect(reviewLoad).toMatch(/if\s*\(\s*!dev\s*\)\s*error\(\s*404/);
	});

	test('it renders every kit primitive and reads ?theme=', () => {
		const classes = [
			'w-btn', 'w-btn--primary', 'w-btn--quiet', 'w-btn--danger', 'w-btn--sm', 'w-btn--lg', 'w-split', 'w-btn__swap',
			'w-ibtn', 'w-ibtn--sm', 'w-ibtn--edge', 'w-ibtn--dot', 'w-field', 'w-field--chrome', 'w-kbd', 'w-label',
			'w-field-foot', 'w-field-error', 'w-field-count', 'w-select', 'w-select--applied', 'w-seg', 'w-switch',
			'w-check', 'w-radio', 'w-choice', 'w-range', 'w-tag', 'w-tag--mat', 'w-role', 'w-seal', 'w-badge',
			'w-badge--sm', 'w-badge--ring', 'w-count', 'w-react', 'w-srows', 'w-srow', 'w-srow--seal', 'w-disclosure',
			'w-pop', 'w-menu', 'w-menu__kicker', 'w-menu__item', 'w-menu__check', 'w-menu__key', 'w-menu__hint',
			'w-menu__item--danger', 'w-menu__item--seal', 'w-tool', 'w-tool--bubble', 'w-tip', 'w-toast', 'w-notice',
			'w-notice--info', 'w-notice--warn', 'w-empty', 'w-empty--enso', 'w-skel', 'w-loadline', 'w-dialog',
			'w-dialog--sm', 'w-dialog--md', 'w-dialog__note', 'w-dialog__foot--rule', 'w-sheet', 'w-scrim', 'w-prose',
			'w-outline', 'w-facts', 'w-dayrule', 'w-newrule', 'w-typing'
		];
		// The markup only: between the script and the page's own layout styles.
		const markup = reviewPage.slice(reviewPage.indexOf('</script>'), reviewPage.indexOf('<style>'));
		for (const name of classes) {
			expect(`${name}: ${new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(markup) ? 'rendered' : 'missing'}`).toBe(`${name}: rendered`);
		}
		expect(reviewPage).toContain("searchParams.get('theme')");
		expect(reviewPage).toContain('applyTheme');
	});
});
