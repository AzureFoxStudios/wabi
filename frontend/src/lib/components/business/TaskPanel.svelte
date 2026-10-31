<script lang="ts">
	/**
	 * Tasks (design contract §8.6, §7.21): My Planner's open tasks as a companion panel. In the
	 * shell's companion frame (panel id `planner-tasks`, `compact`) the frame owns row A (title,
	 * count, Unpin) and row B; this body is a filter row, the list and a quiet "Add task" row.
	 * Hosts without the frame (an in-surface split) get a small title row with Close.
	 *
	 * One task dialog everywhere: the title of a row and "Add task" open PlannerTaskDialog, the
	 * same dialog the board's New task uses. The checkbox completes a task, with Undo.
	 *
	 * Svelte 4 (`export let`) — matches the business tree.
	 */
	import { onDestroy } from 'svelte';
	import { todos, projects, updateTodo, type Todo } from '$lib/business';
	import { plannerUserById, getPlannerUserColor, getPlannerUserAvatarUrl, ensurePlannerDirectory } from '$lib/business/plannerUsers';
	import { dueLabel, priorityMark, spansSeveralProjects } from '$lib/business/plannerBoard';
	import { completeTask, startOfDay } from '$lib/business/plannerCalendar';
	import {
		TASKS_FILTERS,
		TASKS_PANEL_ID,
		emptyTasksWords,
		filterTasks,
		tasksPanelFilter,
		type TasksFilter
	} from '$lib/business/plannerTasksPanel';
	import { setPanelFrameCount } from '$lib/workspacePanels';
	import { toast } from '$lib/toast';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import PlannerAvatar from './PlannerAvatar.svelte';
	import PlannerTaskDialog from './PlannerTaskDialog.svelte';

	export let onClose: (() => void) | undefined = undefined;
	/** In the companion frame: no own title row (the frame names the panel and holds Unpin). */
	export let compact = false;
	/**
	 * Filter to start on for hosts without the frame (an in-surface split). The companion reads
	 * the shared filter that openPlannerTasksPanel() sets. 'upcoming' is the older name of 'week'.
	 */
	export let initialFilter: TasksFilter | 'upcoming' = 'all';

	ensurePlannerDirectory();

	let localFilter: TasksFilter = initialFilter === 'upcoming' ? 'week' : initialFilter;
	$: activeFilter = compact ? $tasksPanelFilter : localFilter;
	function setFilter(next: TasksFilter): void {
		if (compact) tasksPanelFilter.set(next);
		else localFilter = next;
	}

	const filterOptions = TASKS_FILTERS.map((option) =>
		option.value === 'week' ? { value: option.value, label: 'Week', title: 'Due in the next seven days' } : { ...option }
	);

	let now = Date.now();
	const clock = setInterval(() => (now = Date.now()), 60_000);

	$: list = filterTasks($todos, activeFilter, now);
	$: showProjects = spansSeveralProjects(list);
	$: empty = emptyTasksWords(activeFilter);
	$: if (compact) setPanelFrameCount(TASKS_PANEL_ID, list.length);

	onDestroy(() => {
		clearInterval(clock);
		if (compact) setPanelFrameCount(TASKS_PANEL_ID, null);
	});

	// ── the task dialog ──
	let dialogTodo: Todo | null = null;
	let creating = false;
	$: newDueDate = activeFilter === 'today' ? startOfDay(now).setHours(12) : undefined;

	function openTask(todo: Todo): void {
		creating = false;
		dialogTodo = todo;
	}
	function addTask(): void {
		dialogTodo = null;
		creating = true;
	}
	function closeDialog(): void {
		dialogTodo = null;
		creating = false;
	}

	function complete(todo: Todo): void {
		const { patch, undo } = completeTask(todo);
		updateTodo(todo.id, patch);
		toast(`Marked “${todo.title}” done`, {
			action: 'Undo',
			onAction: () => updateTodo(todo.id, { status: undo.status, completedAt: undo.completedAt })
		});
	}

	function projectName(projectId: string | undefined): string {
		return projectId ? ($projects.find((p) => p.id === projectId)?.name ?? '') : '';
	}
	function assigneeId(todo: Todo): number | undefined {
		const id = todo.assignedTo ? Number.parseInt(String(todo.assignedTo), 10) : NaN;
		return Number.isFinite(id) ? id : undefined;
	}
	function hours(minutes: number | undefined): string {
		if (!minutes || minutes <= 0) return '';
		const value = minutes / 60;
		return `${Number.isInteger(value) ? value : value.toFixed(1)}h`;
	}
</script>

<div class="task-panel" class:task-panel--frame={compact}>
	{#if !compact}
		<header class="tp-head">
			<h2 class="tp-title">Tasks <span class="tp-count">{list.length}</span></h2>
			{#if onClose}
				<Tooltip text="Close Tasks">
					<button type="button" class="w-ibtn w-ibtn--sm" aria-label="Close Tasks" on:click={onClose}><Icon name="x" /></button>
				</Tooltip>
			{/if}
		</header>
	{/if}

	<div class="tp-tools">
		<Segmented label="Show tasks" options={filterOptions} value={activeFilter} onchange={setFilter} class="tp-filter" />
	</div>

	<div class="tp-body">
		{#if list.length === 0}
			<EmptyState icon="checkSquare" as="h3" title={empty.title} text={empty.text} action="Add task" onaction={addTask} class="tp-empty" />
		{:else}
			<ul class="tp-list" aria-label={`${list.length} ${list.length === 1 ? 'task' : 'tasks'}`}>
				{#each list as todo (todo.id)}
					{@const due = dueLabel(todo, now)}
					{@const mark = priorityMark(todo.priority)}
					{@const person = assigneeId(todo)}
					{@const project = showProjects ? projectName(todo.projectId) : ''}
					<li class="tp-row">
						<input type="checkbox" class="w-check tp-row__check" aria-label={`Mark “${todo.title}” done`} checked={false} on:change={() => complete(todo)} />
						<div class="tp-row__text">
							<button type="button" class="tp-row__title" on:click={() => openTask(todo)}>{todo.title}</button>
							{#if due || mark || project || todo.estimatedMinutes}
								<div class="tp-row__meta">
									{#if due}
										<span class="tp-meta tp-meta--due" class:is-overdue={due.tone === 'overdue'} title={due.title}>
											<Icon name="calendar" size={14} />{due.text}
										</span>
									{/if}
									{#if mark}
										<span class="tp-meta tp-meta--mark"><span class="w-dot w-dot--{mark.tone}" aria-hidden="true"></span>{mark.word}</span>
									{/if}
									{#if project}<span class="tp-meta">{project}</span>{/if}
									{#if todo.estimatedMinutes}<span class="tp-meta">{hours(todo.estimatedMinutes)}</span>{/if}
								</div>
							{/if}
						</div>
						{#if person}
							{@const name = $plannerUserById.get(person)?.username ?? ''}
							<span class="tp-row__who" title={name ? `Assigned to ${name}` : undefined}>
								<PlannerAvatar {name} color={getPlannerUserColor($plannerUserById, person)} src={getPlannerUserAvatarUrl($plannerUserById, person)} size="sm" label={name ? `Assigned to ${name}` : ''} />
							</span>
						{/if}
					</li>
				{/each}
			</ul>
			<button type="button" class="tp-add" on:click={addTask}><Icon name="plus" size={16} />Add task</button>
		{/if}
	</div>
</div>

{#if dialogTodo || creating}
	<PlannerTaskDialog todo={dialogTodo} dueDate={creating ? newDueDate : undefined} onclose={closeDialog} />
{/if}
