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
	'styles/components/kanban-board-part2.css': /^(:root\[data-(mode|char)='[a-z]+'\] )?\.(planner-task-dialog|planner)\b/,
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

	/** The declarations of the first rule whose selector list is exactly `selector`. */
	function block(css: string, selector: string): string {
		for (const match of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
			if (match[1].trim() === selector) return match[2];
		}
		return '';
	}

	test('the lane grid is the Planner\'s own: any other host keeps one flex row of lanes', () => {
		const board = read('styles/components/kanban-board-part1.css');
		// The shared project board sizes its lanes on a max-content row; a grid there would let
		// each 1fr track grow to the widest card.
		expect(block(board, '.kanban-board')).toMatch(/display:\s*flex/);
		expect(block(board, '.kanban-board')).not.toMatch(/grid/);
		expect(block(board, '.kanban-board.kanban-board--grid')).toMatch(/grid-template-columns:\s*repeat\(var\(--lanes, 4\), minmax\(240px, 1fr\)\)/);
		expect(block(board, '.kanban-board--grid > .kanban-column')).toMatch(/contain:\s*inline-size/);
		const gridRules = selectors(board).filter((selector, index, all) => all.indexOf(selector) === index && /grid-template-columns/.test(block(board, selector)));
		expect(gridRules.every((selector) => selector.includes('kanban-board--grid') || selector.includes('column-management'))).toBe(true);
	});

	test('the board and its lanes keep the role-painted scrollbars (§4.6)', () => {
		const board = read('styles/components/kanban-board-part1.css');
		expect(board).not.toMatch(/scrollbar-width:\s*none/);
		expect(board.includes('::-webkit-scrollbar')).toBe(false);
	});

	test('the card meta row is one mono face, the priority word included (§7.27)', () => {
		const mark = block(read('styles/components/kanban-board-part1.css'), '.kanban-board .card-mark');
		expect(mark).toMatch(/font:\s*inherit/);
		expect(mark).not.toMatch(/--w-t-caption/);
	});

	test('the lifted drag image wins over the placeholder it leaves behind', () => {
		const board = read('styles/components/kanban-board-part1.css');
		expect(board.indexOf('.kanban-board .kanban-card.is-lifting {')).toBeGreaterThan(board.indexOf('.kanban-board .kanban-card.dragging {'));
	});

	test('phone targets are 44px: the Planner strip, the board tools row and the lane switcher', () => {
		const header = readFileSync(join(SRC, 'lib/components/business/PlannerStageHeader.svelte'), 'utf8');
		const style = header.slice(header.indexOf('<style>'));
		expect(style).not.toMatch(/height:\s*(36|40)px/);
		expect(block(style, '.psh--tabs .psh-seg > button')).toMatch(/height:\s*44px/);
		expect(block(style, '.psh--phone .planner-new-primary')).toMatch(/width:\s*44px;\s*height:\s*44px/);
		const board = read('styles/components/kanban-board-part1.css');
		expect(block(board, '.kanban-container .planner-filter-btn')).toMatch(/height:\s*44px/);
		expect(block(board, '.kanban-container .planner-lane-switch > button')).toMatch(/height:\s*44px/);
	});
});

describe('Planner board markup', () => {
	const impl = readFileSync(join(SRC, 'lib/components/business/KanbanBoardImpl.svelte'), 'utf8');
	const columns = readFileSync(join(SRC, 'lib/components/business/KanbanBoardColumns.svelte'), 'utf8');

	test('the board is a named region, and the Planner asks for the lane grid', () => {
		expect(impl).toMatch(/class="kanban-board-wrapper"\s+role="region"\s+aria-label="Task board"/);
		expect(impl).toMatch(/<KanbanBoardColumns\s+layout="grid"/);
		expect(columns).toMatch(/export let layout: 'grid' \| 'row' = 'row'/);
	});

	test('the drag is marked only after the browser has taken the drag image', () => {
		const start = impl.slice(impl.indexOf('function handleDragStart'), impl.indexOf('function handleDragEnd'));
		expect(start).toMatch(/setTimeout\(\(\) => \{[\s\S]*draggingTodo = todo/);
		expect(start.slice(0, start.indexOf('setTimeout'))).not.toMatch(/draggingTodo = todo/);
	});

	test('a dialog opened from a card menu returns focus to the card', () => {
		expect(columns).toMatch(/openTaskField\?\.\(todo, field, document\.getElementById\(cardId\(todo\.id\)\)\)/);
		expect(impl).toMatch(/function openEditModal\(todo: Todo, field: TaskField = 'title', opener\?: HTMLElement \| null\)/);
	});

	test('deleting a column says what really happens to its tasks', () => {
		expect(impl).not.toMatch(/show the lane again from Edit columns/);
		expect(impl).toMatch(/Its tasks are kept but hidden until you add a column with the same name\./);
	});

	test('filters that hide every task say so, and Clear filters is not a second primary', () => {
		const empty = impl.slice(impl.indexOf('{#if filtersHideAll}'), impl.indexOf('{/if}', impl.indexOf('{#if filtersHideAll}')));
		expect(empty).toMatch(/title="No tasks match these filters"/);
		expect(empty).toMatch(/class="w-btn planner-clear-filters" on:click=\{clearFilters\}/);
		expect(empty).not.toMatch(/w-btn--primary|action="/);
	});
});

describe('Planner phone shell (§8.12)', () => {
	const header = readFileSync(join(SRC, 'lib/components/business/PlannerStageHeader.svelte'), 'utf8');
	const content = readFileSync(join(SRC, 'lib/components/business/PlannerWorkspaceContent.svelte'), 'utf8');
	const impl = readFileSync(join(SRC, 'lib/components/business/KanbanBoardImpl.svelte'), 'utf8');
	const markup = header.slice(0, header.indexOf('<style>'));

	test('the phone bar keeps the locality tag as its dot; only the words move to ⋯', () => {
		const row = markup.slice(markup.lastIndexOf('{:else}', markup.indexOf('stage-a__scope')), markup.indexOf('{#if !phone}'));
		expect(row).toMatch(/class="w-tag stage-a__chip stage-a__scope"/);
		expect(row).not.toMatch(/\{#if !phone\}[\s\S]*stage-a__scope/);
		expect(row).toMatch(/\{#if status && !phone\}<span class="stage-a__status" role="status">/);
		expect(content).toMatch(/subheading=\{\$isMobile \? `\$\{localityLabel\}\. \$\{localityTitle\} \$\{saveStatus\}\.` : localityTitle\}/);
	});

	test('the phone board has one tools row (view menu, Filter, New) and its panel keeps a name', () => {
		expect(content).toMatch(/\$: phoneBoard = onStage && \$isMobile && activeView === 'board';/);
		expect(content).toMatch(/\{:else if !phoneBoard && \$isMobile\}/);
		expect(content).toMatch(/aria-labelledby=\{phoneBoard \? undefined : `\$\{PANEL_ID\}-tab-\$\{activeView\}`\}/);
		expect(content).toMatch(/aria-label=\{phoneBoard \? VIEWS\.find/);
		expect(content).toMatch(/<PlannerStageHeader part="views"/);
		expect(content).toMatch(/<PlannerStageHeader part="new"/);
		expect(impl).toMatch(/class="w-seg planner-lane-switch" role="group" aria-label="Lanes"/);
	});
});

describe('planner board: companion Tasks panel, phone focus and lane switcher', () => {
	const content = readFileSync(join(SRC, 'lib/components/business/PlannerWorkspaceContent.svelte'), 'utf8');
	const board = readFileSync(join(SRC, 'lib/components/business/KanbanBoardImpl.svelte'), 'utf8');

	test('the ⋯ Tasks panel item opens the companion on the rail, not a private split', () => {
		expect(content).toContain('checked: $tasksPanelShown,');
		expect(content).toContain('onSelect: () => togglePlannerTasksPanel()');
		expect(content).not.toContain('planner-task-panel');
		expect(content).not.toContain('showTaskPanel');
		expect(read('lib/components/business/PlannerWorkspace.css')).not.toContain('.planner-task-resizer');
	});

	test('switching views moves focus to the new view control when the used control unmounted', () => {
		const set = content.slice(content.indexOf('function setActiveView('), content.indexOf('function focusViewControl('));
		expect(set).toContain('if (!active || active === document.body || !active.isConnected) focusViewControl(view);');
		expect(content).toContain('document.getElementById(`${PANEL_ID}-tab-${view}`)');
	});

	test('the lane switcher shows only while the lanes snap one per screen (under 600px)', () => {
		expect(board).toContain('$: laneSwitcher = compact && boardWidth > 0 && boardWidth < 600 && $visibleKanbanColumns.length > 1;');
		expect(board).toContain('{#if laneSwitcher}');
		expect(board).toContain('bind:clientWidth={boardWidth}');
	});

	test('the lane Add task row is a 44px target on touch', () => {
		expect(read('styles/components/kanban-board-part1.css')).toMatch(/@media \(pointer: coarse\) \{\s*\.kanban-board \.add-task-row \{\s*height: 44px;/);
	});
});
