/**
 * My Planner views stay scoped, on roles and honest (design contract §5, §7.16, §8.6, §9).
 * The sheets read as text; the components are checked for the behaviour the markup promises
 * (a task title opens the task, only the checkbox completes it; day cells are gridcells, not
 * buttons holding buttons; the Journal's personal marker never claims privacy).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASIDE_BESIDE_FROM } from './plannerCalendar';

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

const raw = (path: string) => readFileSync(join(SRC, path), 'utf8');
const css = (path: string) => removeAll(raw(path), /\/\*[\s\S]*?\*\//g);

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
function selectors(sheet: string): string[] {
	const found: string[] = [];
	for (const match of sheet.matchAll(/([^{};]+)\{/g)) {
		const prelude = match[1].trim();
		if (!prelude || prelude.startsWith('@') || /^(from|to|\d+%)$/.test(prelude)) continue;
		found.push(...splitSelectors(prelude));
	}
	return found;
}

const SCOPED: Record<string, RegExp> = {
	'styles/components/calendar-view-part1.css': /^(:root\[data-char='contrast'\] )?\.planner\b/,
	'styles/components/calendar-view-part2.css': /^(:root\[data-char='contrast'\] )?\.planner\b/,
	'styles/components/diary-view-part1.css': /^\.planner\b/,
	'styles/components/diary-view-part2.css': /^\.planner\b/,
	'styles/components/projects-view-part1.css': /^(:root\[data-char='contrast'\] )?\.planner\b/,
	'styles/components/projects-view-part2.css': /^(:root\[data-char='contrast'\] )?\.planner\b/,
	'styles/components/task-panel.css': /^(:root\[data-char='contrast'\] )?\.task-panel\b/,
	'styles/components/todo-list.css': /^:where\(\.todo-(container|task-modal)/
};

describe('planner view sheets are scoped and on roles', () => {
	for (const [path, scope] of Object.entries(SCOPED)) {
		const sheet = css(path);

		test(`${path}: every selector stays inside its surface`, () => {
			const loose = selectors(sheet).filter((selector) => !scope.test(selector));
			expect(loose).toEqual([]);
		});

		test(`${path}: colours come from roles (no hex, rgb, named white/black)`, () => {
			expect(sheet).not.toMatch(/#[0-9a-f]{3,8}\b/i);
			expect(sheet).not.toMatch(/\brgba?\(/);
			expect(sheet).not.toMatch(/:\s*(white|black)\b/);
			expect(sheet).not.toMatch(/--(biz|planner|surface|text|accent-primary|bg|border)-/);
		});

		test(`${path}: no !important, no transition: all, no thin native scrollbars`, () => {
			expect(sheet).not.toContain('!important');
			expect(sheet).not.toMatch(/transition\s*:\s*all\b/);
			expect(sheet).not.toMatch(/scrollbar-width\s*:\s*thin/);
		});

		test(`${path}: text sizes follow --w-fs (type tokens or calc(… * var(--w-fs)))`, () => {
			for (const match of sheet.matchAll(/font(?:-size)?\s*:\s*([^;]+);/g)) {
				const value = match[1];
				if (/var\(--w-t-/.test(value) || /inherit/.test(value)) continue;
				expect(`${path}: ${value}`).toMatch(/var\(--w-fs/);
			}
		});
	}

	test('no planner view sheet declares the old global dialog and form classes', () => {
		for (const path of Object.keys(SCOPED)) {
			for (const selector of selectors(css(path))) {
				expect(`${path}: ${/^\.(modal|modal-overlay|modal-header|close-btn|form-group|form-row|submit-btn|cancel-btn|delete-btn|add-btn|today-btn|nav-btn)\b/.test(selector) ? selector : 'ok'}`).toBe(`${path}: ok`);
			}
		}
	});

	test('the today disc is the accent with the on-accent numeral; the cell is not tinted', () => {
		const sheet = css('styles/components/calendar-view-part1.css');
		const today = sheet.match(/\.planner \.cal-cell\.is-today \.cal-date \{([^}]*)\}/);
		expect(today?.[1]).toContain('background: var(--w-accent)');
		expect(today?.[1]).toContain('color: var(--w-on-accent)');
		expect(sheet).not.toMatch(/\.cal-cell\.is-today \{/);
	});

	test('event pills are an 18% tint of the person\'s colour into --w-raise, text on --w-text', () => {
		const sheet = css('styles/components/calendar-view-part1.css');
		const pill = sheet.match(/\.planner \.cal-pill \{([^}]*)\}/)?.[1] ?? '';
		expect(pill).toContain('background: color-mix(in srgb, var(--pill) 18%, var(--w-raise))');
		expect(pill).toContain('color: var(--w-text)');
		// The pill grows with a two-line title; it is never a fixed one-line height.
		expect(pill).toMatch(/min-height: calc\(22px \* var\(--w-fs\)\)/);
		expect(pill).not.toMatch(/(^|[^-])height: calc/);
	});

	test('pill and task titles take two lines before an ellipsis, never a one-line nowrap', () => {
		const sheet = css('styles/components/calendar-view-part1.css');
		for (const name of ['cal-pill__text', 'cal-task__text']) {
			const rule = sheet.match(new RegExp(`\\.planner \\.${name} \\{([^}]*)\\}`))?.[1] ?? '';
			expect(`${name}: ${rule.includes('-webkit-line-clamp: 2')}`).toBe(`${name}: true`);
			expect(rule).toContain('text-overflow: ellipsis');
		}
		expect(sheet).not.toMatch(/\.cal-(pill__title|task__title) \{[^}]*white-space: nowrap/);
	});

	test('a day\'s lines take the cell\'s free height without sizing the row; hidden lines leave', () => {
		const sheet = css('styles/components/calendar-view-part1.css');
		const lines = sheet.match(/\.planner \.cal-lines \{([^}]*)\}/)?.[1] ?? '';
		expect(lines).toContain('contain: size');
		expect(lines).toContain('flex: 1 1 0');
		expect(sheet).toMatch(/\.planner \.cal-lines > \[data-fit-hidden\] \{\s*display: none;/);
	});

	test('the side list is beside the month only from the width that keeps 140px days', () => {
		const sheet = css('styles/components/calendar-view-part1.css');
		expect(ASIDE_BESIDE_FROM).toBe(1256);
		expect(sheet).toContain(`@container planner-cal (min-width: ${ASIDE_BESIDE_FROM}px)`);
		expect(sheet).toMatch(/\.planner \.cal \{[^}]*container: planner-cal \/ inline-size/);
		expect(sheet).toMatch(/\.planner \.cal-aside \{\s*display: none;/);
		// The old stage tiers that squeezed seven columns beside a 216px list are gone.
		expect(sheet).not.toContain('216px');
	});

	test('"+N more" is a mono count in the head row; a narrow day drops the word, touch taps the whole day', () => {
		const sheet = css('styles/components/calendar-view-part1.css');
		expect(sheet).toMatch(/\.planner \.cal-cell \{[^}]*container: cal-day \/ inline-size/);
		expect(sheet).toMatch(/\.planner \.cal-date \{[^}]*margin-right: auto/);
		expect(sheet).toMatch(/@container cal-day \(max-width: [\d.]+em\) \{\s*\.planner \.cal-more__word \{\s*display: none;/);
		const coarse = sheet.slice(sheet.indexOf('@media (pointer: coarse)'));
		expect(coarse).toMatch(/\.planner \.cal-more \{\s*pointer-events: none;/);
	});

	test('touch targets: the kit sizes the add button (no smaller override), lines and the checkbox hit area reach 44px', () => {
		const sheet = css('styles/components/calendar-view-part1.css');
		const add = sheet.match(/\.planner \.cal-add\.w-ibtn \{([^}]*)\}/)?.[1] ?? '';
		expect(add).not.toMatch(/\b(width|height):/);
		const coarse = sheet.slice(sheet.indexOf('@media (pointer: coarse)'));
		expect(coarse).toMatch(/\.planner \.cal-pill \{[^}]*min-height: 44px/);
		expect(coarse).toMatch(/\.planner \.cal-task \{[^}]*min-height: 44px/);
		expect(coarse).toMatch(/\.planner \.cal-task__hit \{[^}]*min-height: 44px/);
		expect(sheet).not.toMatch(/\.cal-task__check\.w-check \{[^}]*width: 14px/);
	});

	test('the day dialog keeps sentence case and shows a priority word only for High and Urgent', () => {
		const sheet = css('styles/components/calendar-view-part2.css');
		const time = sheet.match(/\.planner \.day-detail-content \.event-time \{([^}]*)\}/)?.[1] ?? '';
		expect(time).not.toContain('text-transform');
		expect(sheet).toMatch(/\.event-time:is\(\.priority-medium, \.priority-low\) \{\s*display: none;/);
	});

	test('High Contrast steps the progress track back so a bar never reads as full', () => {
		const sheet = css('styles/components/projects-view-part1.css');
		expect(sheet).toMatch(/:root\[data-char='contrast'\] \.planner \.pj-bar \{\s*background: color-mix\(in srgb, var\(--w-line-strong\) \d+%, var\(--w-bg\)\);/);
	});

	test('project cards are objects on --w-lift with the first shadow', () => {
		const card = css('styles/components/projects-view-part1.css').match(/\.planner \.pj-card \{([^}]*)\}/)?.[1] ?? '';
		expect(card).toContain('background: var(--w-lift)');
		expect(card).toContain('box-shadow: var(--w-shadow-1)');
	});

	test('the Journal column is 680px', () => {
		expect(css('styles/components/diary-view-part1.css')).toMatch(/\.planner \.jr-column \{[^}]*max-width: 680px/);
	});
});

describe('the calendar never completes a task by accident', () => {
	const source = raw('lib/components/business/CalendarImpl.svelte');

	test('day cells are gridcells, never role=button holding buttons', () => {
		expect(source).toContain('role="gridcell"');
		expect(source).toContain('role="grid"');
		expect(source).not.toMatch(/class="day-cell"[\s\S]{0,200}role="button"/);
		expect(source).not.toMatch(/role="button"/);
	});

	test('the title opens the task; only the checkbox completes it', () => {
		expect(source).toMatch(/class="cal-task__title"[^>]*on:click=\{\(\) => openTask\(task\)\}/);
		expect(source).toMatch(/type="checkbox"[\s\S]{0,300}on:change=\{\(\) => complete\(task\)\}/);
		expect(source).not.toContain('toggleTaskComplete(task)');
		// The day dialog's task rows open the task too.
		expect(source).toContain('toggleTaskComplete={openTaskFromDay}');
	});

	test('completing offers Undo', () => {
		expect(source).toMatch(/toast\(`Marked[^`]*`, \{\s*action: 'Undo'/);
	});

	test('each day has its own "Add on <date>" button and overflow is "+N more", measured per cell', () => {
		expect(source).toContain('aria-label={`Add on ${dayMonthFormat.format(day)}`}');
		expect(source).toContain('use:fitDayLines={{ key, onfit: onFit }}');
		expect(source).not.toContain('cellLines(');
		// "+N more" sits in the head row beside the date, so the list spends its height on titles.
		const head = source.slice(source.indexOf('<div class="cal-cell__head">'), source.indexOf('<ul class="cal-lines"'));
		expect(head).toContain('<span>+{hidden}</span><span class="cal-more__word">more</span>');
		expect(head).toContain('{#if hidden > 0}');
		expect(source).not.toContain('data-fit-more');
		expect(source).toContain('{@const hidden = total ? Math.min(total, hiddenByDay[key] ?? 0) : 0}');
	});

	test('a click on the day itself opens the day; its controls keep their own action', () => {
		expect(source).toContain('on:click={(event) => onCellClick(event, day)}');
		expect(source).toMatch(/closest\('button, input, label, a'\)\) return;\s*openDayModal\(day\)/);
	});

	test('the side list steps aside for any Tasks list on screen; the head counts open the companion', () => {
		expect(source).toContain('$: showAside = !agenda && !$tasksListShown;');
		expect(source).toContain("openPlannerTasksPanel('overdue')");
		expect(source).toContain("openPlannerTasksPanel('week')");
		expect(source).not.toContain('tasksPanelShown');
	});

	test('no hard-coded colours or window.confirm', () => {
		const script = source.slice(source.indexOf('<script'), source.indexOf('</script>'));
		const template = source.slice(source.indexOf('</script>'));
		expect(template).not.toMatch(/#[0-9a-f]{6}\b/i);
		expect(script).not.toMatch(/\bconfirm\(/);
	});
});

describe('the Journal is honest and boxless', () => {
	const source = raw('lib/components/business/DiaryView.svelte');

	test('no lock emoji, and the personal marker never claims privacy', () => {
		expect(source).not.toContain('🔒');
		expect(source).not.toMatch(/title="Private"/);
		expect(source).toContain('It does not change who can read this entry.');
	});

	test('the locality is not repeated inside the Journal (row A says it once)', () => {
		expect(source).not.toMatch(/MY PLANNER · ON THIS DEVICE/);
		expect(source).not.toMatch(/Visibility: only on this device/);
	});

	test('entries use the one prose style and the kit empty state', () => {
		expect(source).toContain('class="w-prose jr-prose"');
		expect(source).toContain('<EmptyState');
		expect(source).not.toContain('class="empty-state"');
	});

	test('Enter in the Tags field never saves and closes the editor', () => {
		expect(source).toMatch(/journal-\$\{uid\}-tags`\}[^>]*on:keydown=\{keepEditingOnEnter\}/);
		expect(source).toMatch(/function keepEditingOnEnter[\s\S]{0,160}event\.key === 'Enter'[\s\S]{0,60}preventDefault\(\)/);
	});

	test('in My Planner the masthead New entry is the one primary: no second "Write today’s entry"', () => {
		expect(source).toContain("action={isReadOnly || embedded ? undefined : 'Write today’s entry'}");
		expect(source).toContain('(todayEntry || !embedded)');
		// A past day's own action is a default button beside the masthead's ink New entry.
		expect(source).toMatch(/\{:else if embedded && !onToday && !isReadOnly\}[\s\S]{0,600}<button type="button" class="w-btn" on:click=\{startEditing\}>Write this entry<\/button>/);
	});

	test('the personal marker is a switch row, delete asks first', () => {
		expect(source).toMatch(/<Switch labelledby=\{`journal-\$\{uid\}-personal`\}/);
		expect(source).toContain('confirmAction');
		expect(source).not.toMatch(/\bconfirm\('/);
	});
});

describe('the Tasks companion and the avatars', () => {
	test('TaskPanel opens the one task dialog instead of its own forms', () => {
		const source = raw('lib/components/business/TaskPanel.svelte');
		expect(source).toContain('<PlannerTaskDialog');
		expect(source).not.toContain('quick-add-form');
		expect(source).not.toContain('edit-task-form');
		expect(source).toContain('setPanelFrameCount(TASKS_PANEL_ID');
	});

	test('an in-surface TaskPanel registers as a Tasks list; beside another page it says where tasks live', () => {
		const source = raw('lib/components/business/TaskPanel.svelte');
		expect(source).toContain('onMount(() => (compact ? undefined : registerInSurfaceTasksList()));');
		expect(source).toContain("$: sayLocality = compact && $activeWorkspaceView !== 'planner';");
		expect(source).toContain("$_('locality.only_you_device')");
	});

	test('the companion manifest exists for the Tasks panel', () => {
		const panels = raw('lib/workspacePanels.ts');
		expect(panels).toMatch(/id: 'planner-tasks',\s*label: 'Tasks'/);
		expect(raw('lib/components/WorkspacePanelHost.svelte')).toContain('<TaskPanel compact />');
	});

	test('PlannerAvatar draws an identity stamp, never the raw colour with a white letter', () => {
		const source = raw('lib/components/business/PlannerAvatar.svelte');
		// Contract sizes only (§7.12): the smallest stamp is 20px, so the initial is never under 10px.
		expect(source).toContain("{ xs: 20, sm: 20, md: 28 }");
		expect(source).toContain("import { inkFor } from '$lib/theme/identity'");
		expect(source).toContain('background: var(--disc');
		expect(source).toContain('color: var(--on');
		expect(source).not.toMatch(/#ffffff|color: white/i);
	});

	test('the project inventory card is an article with a stretched button, not a button around headings', () => {
		const source = raw('lib/components/business/ProjectInventory.svelte');
		expect(source).toContain('<article class="pj-card"');
		expect(source).toMatch(/<h3 class="pj-card__name"[^>]*>\s*<button type="button" class="pj-card__hit"/);
		expect(source).not.toMatch(/<button class="card"/);
	});

	test('the project page keeps New sprint visible (a default button: the masthead New is the one primary)', () => {
		const source = raw('lib/components/business/ProjectDetail.svelte');
		expect(source).toMatch(/class="w-btn"[^>]*on:click=\{\(\) => onOpenSprintModal\(\)\}/);
		expect(source).not.toMatch(/w-btn--primary/);
		expect(source).toContain('Add time estimates to tasks to see a burndown');
		expect(source).not.toMatch(/stroke="#[0-9a-f]{3,6}"/i);
	});

	test('the burndown is drawn at its shown width, so its labels are never scaled', () => {
		const source = raw('lib/components/business/ProjectDetail.svelte');
		expect(source).toContain('bind:clientWidth={burnFrameWidth}');
		expect(source).toContain('width={chartWidth} height={chartHeight} viewBox="0 0 {chartWidth} {chartHeight}"');
		expect(source).not.toContain('preserveAspectRatio');
	});

	test('the Reports figures count the same tasks as the facts line and Overview', () => {
		const source = raw('lib/components/business/ProjectDetail.svelte');
		expect(source).toContain("$: doneCount = scopeTasks.filter((t) => t.status === 'done').length;");
		expect(source).toContain('<dd>{scopeTasks.length}</dd>');
	});
});

describe('planner views: recheck follow-ups', () => {
	test('"+N more" keeps one text line at every text size', () => {
		expect(css('styles/components/calendar-view-part1.css')).toMatch(/\.planner \.cal-more \{[^}]*height: calc\(20px \* var\(--w-fs\)\);/);
	});

	test('the Journal empty states name the New control the person can see (a bare + on the phone)', () => {
		const diary = raw('lib/components/business/DiaryView.svelte');
		expect(diary).toContain("$: newEntryWords = $isMobile ? '+' : 'New entry';");
		expect(diary).not.toContain("'Use New entry to write");
		expect(diary.match(/Use \$\{newEntryWords\} to write/g)?.length).toBe(2);
	});
});
