import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Contract: design spec §4.6 (focus), §4.7 (motion), §7.13 (dialogs), §7.18 (message body) and
// §11 rows 1–2 (base layer, leaking globals). These read the stylesheets as text, like
// rightPanelStubStripCss.test.ts, so a regression in the base layer fails without a browser.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const base = read('../styles/base.css');
const polish = read('../styles/polish.css');
const motion = read('../styles/motion.css');
const accessibility = read('../styles/accessibility.css');
const markdown = read('../styles/components/ml-markdown.css');
const settingsShell = read('../styles/components/settings-shell.css');
const settingsMobile = read('../styles/components/settings-mobile.css');
const plannerSheets: Record<string, string> = {
	'calendar-view-part1.css': read('../styles/components/calendar-view-part1.css'),
	'kanban-board-part2.css': read('../styles/components/kanban-board-part2.css'),
	'projects-view-part2.css': read('../styles/components/projects-view-part2.css'),
	'todo-list.css': read('../styles/components/todo-list.css')
};

interface Rule {
	selectors: string[];
	body: string;
	/** Enclosing at-rule preludes, outermost first (e.g. "@media (max-width: 768px)"). */
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

/** A small CSS rule reader: strips comments, follows nested at-rule blocks, returns style rules. */
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
			if (prelude.startsWith('@') && !prelude.startsWith('@font-face')) {
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

function decl(body: string, property: string): string | undefined {
	const match = body.match(new RegExp(`(?:^|[;{\\s])${property.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\s*:\\s*([^;]+)`));
	return match?.[1].trim();
}

function find(source: string, predicate: (rule: Rule) => boolean): Rule[] {
	return rules(source).filter(predicate);
}

describe('base.css reset', () => {
	test('the margin/padding reset leaves <dialog> alone so native dialogs stay centered', () => {
		const resets = find(base, (r) => decl(r.body, 'margin') === '0' && decl(r.body, 'padding') === '0' && r.context.length === 0);
		expect(resets.length).toBe(1);
		const [reset] = resets;
		expect(reset.selectors.join(',')).toContain(':not(dialog)');
		// No universal selector may zero margins: that is what pinned every <dialog> to the top-left.
		for (const rule of rules(base)) {
			if (decl(rule.body, 'margin') === '0') {
				expect(rule.selectors.some((s) => /(^|\s|,)\*/.test(s))).toBe(false);
			}
		}
	});

	test('modal dialogs center with margin: auto', () => {
		const [modal] = find(base, (r) => r.selectors.includes('dialog:modal'));
		expect(modal).toBeDefined();
		expect(decl(modal.body, 'margin')).toBe('auto');
	});

	test('box-sizing stays border-box for every element and pseudo-element', () => {
		const [sizing] = find(base, (r) => r.selectors.includes('*') && r.selectors.includes('*::before'));
		expect(decl(sizing.body, 'box-sizing')).toBe('border-box');
	});

	test('buttons, inputs, selects and textareas inherit the UI face, colour and tracking', () => {
		const [controls] = find(base, (r) => ['button', 'input', 'select', 'textarea'].every((s) => r.selectors.includes(s)));
		expect(controls).toBeDefined();
		expect(decl(controls.body, 'font')).toBe('inherit');
		expect(decl(controls.body, 'color')).toBe('inherit');
		expect(decl(controls.body, 'letter-spacing')).toBe('inherit');
	});

	test('native controls follow the theme mode so inherited text stays readable on their fields', () => {
		expect(decl(find(base, (r) => r.selectors.includes(":root[data-mode='dark']"))[0].body, 'color-scheme')).toBe('dark');
		expect(decl(find(base, (r) => r.selectors.includes(":root[data-mode='light']"))[0].body, 'color-scheme')).toBe('light');
	});

	test('body draws from the roles and keeps the user ambient glow', () => {
		const [body] = find(base, (r) => r.selectors.includes('body') && r.context.length === 0);
		expect(decl(body.body, 'font-family')).toBe('var(--w-sans)');
		expect(decl(body.body, 'color')).toBe('var(--w-text)');
		expect(decl(body.body, 'background-color')).toBe('var(--w-bg)');
		expect(body.body).toContain('--bg-effect-color');
		expect(body.body).toContain('--bg-effect-intensity');
	});
});

describe('base.css focus and scrollbars', () => {
	test('there is one focus ring: a 2px accent outline, never a box-shadow glow', () => {
		const focusRules = find(base, (r) => r.selectors.some((s) => s.includes(':focus')));
		expect(focusRules.length).toBe(1);
		const [ring] = focusRules;
		expect(ring.selectors).toEqual([':focus-visible']);
		expect(decl(ring.body, 'outline')).toBe('2px solid var(--w-accent)');
		expect(decl(ring.body, 'outline-offset')).toBe('2px');
		expect(ring.body).not.toContain('box-shadow');
		expect(code(base)).not.toMatch(/\*:focus-visible/);
		expect(code(base)).not.toContain('--shadow-focus-ring');
	});

	test('scrollbars use a --w-line-strong thumb on a transparent track, not the accent', () => {
		const [thumb] = find(base, (r) => r.selectors.includes('::-webkit-scrollbar-thumb'));
		expect(decl(thumb.body, 'background-color')).toBe('var(--w-line-strong)');
		const [track] = find(base, (r) => r.selectors.includes('::-webkit-scrollbar-track'));
		expect(decl(track.body, 'background')).toBe('transparent');
		expect(code(base)).not.toContain('--accent-primary-color');
		expect(code(base)).not.toContain('--accent-secondary-color');
	});

	test('standard scrollbar properties apply only where ::-webkit-scrollbar is unsupported', () => {
		// Chromium 121+ drops every ::-webkit-scrollbar rule (and draws stepper arrows) on an
		// element with scrollbar-width/-color set, so these must never apply unconditionally.
		const universal = find(base, (r) => r.selectors.length === 1 && r.selectors[0] === '*');
		const standard = universal.filter((r) => decl(r.body, 'scrollbar-width') || decl(r.body, 'scrollbar-color'));
		const firefox = standard.find((r) => r.context.includes('@supports not selector(::-webkit-scrollbar)'));
		expect(decl(firefox!.body, 'scrollbar-width')).toBe('thin');
		expect(decl(firefox!.body, 'scrollbar-color')).toBe('var(--w-line-strong) transparent');
		// In webkit engines the inherited scrollbar-color is reset per element, so a legacy
		// container cannot switch the scrollers inside it back to native bars.
		const webkit = standard.find((r) => r.context.includes('@supports selector(::-webkit-scrollbar)'));
		expect(decl(webkit!.body, 'scrollbar-color')).toBe('auto');
		expect(decl(webkit!.body, 'scrollbar-width')).toBeUndefined();
		for (const rule of standard) expect(rule.context.length).toBe(1);
	});

	test('base.css paints only with roles: no raw hex or rgb colours', () => {
		expect(code(base)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
		expect(code(base)).not.toMatch(/\brgba?\(/);
	});
});

describe('message bodies are not scroll containers', () => {
	test('.markdown-content has no max-height or overflow', () => {
		for (const rule of rules(markdown)) {
			if (!rule.selectors.some((s) => /\.markdown-content$/.test(s))) continue;
			expect(decl(rule.body, 'max-height')).toBeUndefined();
			expect(decl(rule.body, 'overflow')).toBeUndefined();
			expect(decl(rule.body, 'overflow-y')).toBeUndefined();
		}
	});

	test('the competing 1.42 !important line-height is gone', () => {
		expect(code(markdown)).not.toMatch(/line-height:\s*1\.42/);
	});
});

describe('no leaking global form or modal rules', () => {
	test('no planner sheet styles every <form> in the app', () => {
		for (const [name, sheet] of Object.entries(plannerSheets)) {
			for (const rule of rules(sheet)) {
				for (const selector of rule.selectors) {
					// A bare `form` (optionally with a pseudo-class) is unscoped; a scoped one has a
					// combinator or :where() in front of it.
					expect(`${name}: ${/^form\b/.test(selector) ? selector : 'ok'}`).toBe(`${name}: ok`);
				}
			}
		}
	});

	test('todo-list.css keeps its form rule inside :where(.todo-container, .todo-task-modal)', () => {
		const formRules = find(plannerSheets['todo-list.css'], (r) => r.selectors.some((s) => /\bform$/.test(s)));
		expect(formRules.length).toBeGreaterThan(0);
		for (const rule of formRules) {
			for (const selector of rule.selectors) expect(selector).toMatch(/^:where\(\.todo-container, \.todo-task-modal\)/);
		}
	});

	test('the Settings frame caps its height in dvh at every desktop width', () => {
		const [frame] = find(settingsShell, (r) => r.selectors.includes('.modal-content.wabi-settings-modal') && r.context.length === 0);
		expect(frame.body).toMatch(/max-height:\s*min\(90dvh, 940px\)/);
		// A later, lower-specificity media rule must not be the one that carries the dvh cap.
		for (const rule of find(settingsShell, (r) => r.context.some((c) => c.includes('min-width: 769px')))) {
			expect(decl(rule.body, 'max-height')).toBeUndefined();
		}
	});

	test('Settings shell geometry applies only to the Settings dialog', () => {
		for (const [name, sheet] of [['settings-shell.css', settingsShell], ['settings-mobile.css', settingsMobile]] as const) {
			for (const rule of rules(sheet)) {
				for (const selector of rule.selectors) {
					if (!/\.modal-(content|header)/.test(selector)) continue;
					expect(`${name}: ${selector}`).toMatch(/wabi-settings-(modal|overlay)/);
				}
			}
		}
	});
});

describe('polish, motion and accessibility layers', () => {
	test('nothing scales, dims or moves on touch press', () => {
		const css = code(polish);
		expect(css).not.toMatch(/transform\s*:/);
		expect(css).not.toMatch(/scale\(/);
		expect(css).not.toMatch(/transition\s*:\s*all\b/);
		expect(css).not.toMatch(/@media \(hover: none\)/);
	});

	test('unreferenced legacy tooltip and loading overlay rules are gone', () => {
		expect(code(polish)).not.toContain('.tooltip');
		expect(code(polish)).not.toContain('.loading-overlay');
	});

	test('the unread badge is an ink pill that never animates', () => {
		const [badge] = find(polish, (r) => r.selectors.includes('.unread-badge'));
		expect(decl(badge.body, 'background')).toBe('var(--w-text)');
		expect(decl(badge.body, 'color')).toBe('var(--w-bg)');
		expect(decl(badge.body, 'animation')).toBe('none');
	});

	test('one global reduced-motion rule covers the system preference and the in-app switch', () => {
		const reduced = find(motion, (r) => r.selectors.includes('*') || r.selectors.some((s) => s.endsWith(' *')));
		const system = reduced.find((r) => r.context.some((c) => c.includes('prefers-reduced-motion: reduce')));
		const toggle = reduced.find((r) => r.selectors.includes(":root[data-motion='reduce'] *"));
		for (const rule of [system, toggle]) {
			expect(rule).toBeDefined();
			expect(decl(rule!.body, 'animation-duration')).toBe('0.01ms !important');
			expect(decl(rule!.body, 'transition-duration')).toBe('0.01ms !important');
		}
		expect(toggle!.selectors).toContain(":root[data-reduce-motion='true'] *");
	});

	test('chrome has no infinite animations', () => {
		expect(code(motion)).not.toMatch(/infinite/);
		expect(code(polish)).not.toMatch(/infinite/);
	});

	test('High Contrast has no electric-blue separators and no frost', () => {
		expect(code(accessibility)).not.toContain("[data-theme='high-contrast']");
		expect(code(accessibility)).not.toContain('--color-info');
		for (const rule of rules(accessibility)) {
			for (const selector of rule.selectors) {
				if (selector.includes('data-ambient')) expect(selector).toContain(":not([data-char='contrast'])");
			}
		}
	});

	test('ambient frost never makes a dialog see-through', () => {
		// Dialogs sit on a scrim; a translucent frame only lets the page read through the form.
		for (const rule of rules(accessibility)) {
			for (const selector of rule.selectors) {
				expect(selector).not.toMatch(/\.(modal-content|incoming-call-modal|wabi-settings-modal)\b/);
			}
		}
	});
});
