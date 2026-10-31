/**
 * The Planner board sheets stay scoped and on roles (design contract §5, §8.6): their generic
 * class names (.modal, .close-btn, .form-group, .filters…) used to be global and leaked into
 * every dialog in the app.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', '..');

/** Remove every match of one pattern, repeating until nothing changes (no partial leftovers). */
function removeAll(text: string, pattern: RegExp): string {
	let previous: string;
	do {
		previous = text;
		text = text.replace(pattern, '');
	} while (text !== previous);
	return text;
}

function read(path: string): string {
	return removeAll(readFileSync(join(SRC, path), 'utf8'), /\/\*[\s\S]*?\*\//g);
}

/** Split a selector list on top-level commas (not the ones inside :is()/:where()/:not()). */
function splitSelectors(prelude: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of prelude) {
		if (ch === '(') depth += 1;
		if (ch === ')') depth -= 1;
		if (ch === ',' && depth === 0) {
			parts.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

/** Every style-rule selector in a sheet (at-rule preludes and keyframe steps skipped). */
function selectors(css: string): string[] {
	const found: string[] = [];
	for (const match of css.matchAll(/([^{};]+)\{/g)) {
		const prelude = match[1].trim();
		if (!prelude || prelude.startsWith('@') || /^(from|to|\d+%)$/.test(prelude)) continue;
		found.push(...splitSelectors(prelude));
	}
	return found;
}

const SHEETS: Record<string, RegExp> = {
	'styles/components/kanban-board-part1.css': /^(:root\[data-(char|motion)='[a-z]+'\] )?\.(kanban-container|kanban-board|kanban-board-wrapper|planner)\b/,
	'styles/components/kanban-board-part2.css': /^(:root\[data-mode='(light|dark)'\] )?\.(planner-task-dialog|planner)\b/,
	'lib/components/business/PlannerWorkspace.css': /^\.(planner|planner-task-dialog)\b/
};

describe('Planner board sheets', () => {
	for (const [path, scope] of Object.entries(SHEETS)) {
		const css = read(path);

		test(`${path}: every rule is scoped to the board, the Planner or the task dialog`, () => {
			const loose = selectors(css).filter((selector) => !scope.test(selector));
			expect(loose).toEqual([]);
		});

		test(`${path}: colours come from roles only`, () => {
			expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
			expect(css.match(/\b(rgba?|hsla?)\(/g) ?? []).toEqual([]);
			expect(css.match(/:\s*(white|black)\b/g) ?? []).toEqual([]);
			expect(css.match(/var\(--(surface|text|accent-primary|border)-[a-z-]*/g) ?? []).toEqual([]);
		});

		test(`${path}: no overrides by force, no native scrollbar paint`, () => {
			expect(css.includes('!important')).toBe(false);
			expect(css.match(/scrollbar-(color|width:\s*thin)/g) ?? []).toEqual([]);
		});
	}

	test('the old global dialog rules are gone from the board sheets', () => {
		const board = read('styles/components/kanban-board-part1.css') + read('styles/components/kanban-board-part2.css');
		const globals = selectors(board).filter((selector) => /^\.(modal-overlay|modal|modal-header|close-btn|form-group|form-row|form-actions|filters|filter-select|column-settings|settings-btn|delete-btn|cancel-btn|submit-btn)\b/.test(selector));
		expect(globals).toEqual([]);
	});

	test('lanes have no colored bars and cards no priority stripe', () => {
		const board = read('styles/components/kanban-board-part1.css');
		expect(board.includes('.column-indicator')).toBe(false);
		expect(board.includes('.card-priority ')).toBe(false);
		expect(board).not.toMatch(/border-left:\s*\d/);
	});
});
