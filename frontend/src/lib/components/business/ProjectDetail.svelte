<script lang="ts">
	/**
	 * My Planner — one project (design contract §8.6). A crumb row ("Projects › A field guide to
	 * belonging", with the project-tree toggle), the serif title with the project's colour as a dot
	 * (user data: a dot only), then one tools row: the Overview | Board | Reports segment, the ink
	 * "New sprint" (always visible), "Add sub-project" and ⋯ (Edit project, Delete project).
	 *
	 * - Overview: ProjectOverview (progress, next deadlines, work in progress, sub-projects).
	 * - Board: this project's tasks by lane, rows that open the task dialog; each lane adds a task
	 *   to this project.
	 * - Reports: the sprint line, four quiet figures, the burndown on roles (remaining in
	 *   --w-accent, done in --w-ok, the ideal dashed in --w-line-strong) or, when no task has a
	 *   time estimate, a plain sentence instead of a chart of guessed hours; and the Gantt chart.
	 *
	 * Svelte 4 (`export let`) — matches the business tree.
	 */
	import { projects, todos, sprints, visibleKanbanColumns, updateTodo, generateBurnChartData } from '$lib/business/store';
	import type { Project, Sprint, BurnChartDataPoint, Todo, TodoStatus } from '$lib/business/types';
	import { projectTasks } from '$lib/business/projectHierarchy';
	import { dueLabel, laneLabel } from '$lib/business/plannerBoard';
	import { completeTask } from '$lib/business/plannerCalendar';
	import { hasEstimates, progressWords, projectPath, projectStatus } from '$lib/business/plannerProjects';
	import { toast } from '$lib/toast';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import GanttChart from './GanttChart.svelte';
	import ProjectOverview from './ProjectOverview.svelte';
	import PlannerTaskDialog from './PlannerTaskDialog.svelte';

	export let selectedProject: Project;
	export let isReadOnly = false;
	export let onOpenProjectModal: (project?: Project, parentId?: string) => void = () => {};
	export let onDeleteProject: (project: Project) => void = () => {};
	export let onOpenSprintModal: (sprint?: Sprint) => void = () => {};
	export let onSelectProject: (project: Project) => void = () => {};
	/** Back to the inventory (the crumb's "Projects"). */
	export let onBack: () => void = () => {};
	/** The project tree beside the page, and its toggle. */
	export let treeOpen = false;
	export let onToggleTree: () => void = () => {};

	type DetailView = 'overview' | 'board' | 'reports';
	let detailView: DetailView = 'overview';
	const detailViews = [
		{ value: 'overview' as const, label: 'Overview' },
		{ value: 'board' as const, label: 'Board' },
		{ value: 'reports' as const, label: 'Reports' }
	];
	let activeTab: 'burndown' | 'gantt' = 'burndown';
	const chartTabs = [
		{ value: 'burndown' as const, label: 'Burndown' },
		{ value: 'gantt' as const, label: 'Gantt' }
	];
	/** Burn range control: auto (sprint/project) or fixed windows. */
	let burnRange: 'auto' | '30d' | '90d' = 'auto';

	const chartWidth = 600;
	const chartHeight = 250;
	const chartPadding = 40;
	const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
	const axisFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

	function formatDate(timestamp: number): string {
		return dateFormat.format(new Date(timestamp));
	}

	function getProjectSprints(projectId: string) {
		return $sprints.filter((s) => s.projectId === projectId);
	}

	function getActiveOrNextSprint(projectId: string): Sprint | null {
		const projectSprints = getProjectSprints(projectId);
		const now = Date.now();
		const activeSprint = projectSprints.find((s) => s.startDate <= now && s.endDate >= now);
		if (activeSprint) return activeSprint;
		const upcomingSprints = projectSprints.filter((s) => s.startDate > now).sort((a, b) => a.startDate - b.startDate);
		return upcomingSprints[0] || null;
	}

	// ── the project's tasks (this project and its sub-projects) ──
	$: path = projectPath($projects, selectedProject);
	$: status = projectStatus(selectedProject.status);
	$: scopeTasks = projectTasks($projects, $todos, selectedProject.id);
	$: ownTasks = $todos.filter((t) => t.projectId === selectedProject.id);
	$: doneCount = ownTasks.filter((t) => t.status === 'done').length;
	$: progressCount = ownTasks.filter((t) => t.status === 'in_progress').length;
	$: progress = ownTasks.length ? Math.round((doneCount / ownTasks.length) * 100) : 0;
	$: lanes = $visibleKanbanColumns.map((column) => ({
		id: column.id as TodoStatus,
		label: laneLabel(column),
		tasks: scopeTasks.filter((t) => t.status === column.id)
	}));

	// ── sprints and the burndown ──
	$: activeSprint = (void $sprints, getActiveOrNextSprint(selectedProject.id));
	$: hasSprints = (void $sprints, getProjectSprints(selectedProject.id).length > 0);
	$: burnStart =
		burnRange === '30d'
			? Date.now() - 30 * 24 * 60 * 60 * 1000
			: burnRange === '90d'
				? Date.now() - 90 * 24 * 60 * 60 * 1000
				: activeSprint?.startDate || selectedProject.startDate || selectedProject.createdAt;
	$: burnEnd =
		burnRange === '30d' || burnRange === '90d' ? Date.now() : activeSprint?.endDate || selectedProject.targetEndDate || Date.now();
	$: burnChartData = (void $todos, generateBurnChartData(selectedProject.id, burnStart, Math.max(burnStart + 24 * 60 * 60 * 1000, burnEnd)));
	$: latestBurnPoint = burnChartData.length ? burnChartData[burnChartData.length - 1] : null;
	$: estimated = hasEstimates(ownTasks);
	$: burnRanges = [
		{ value: 'auto' as const, label: activeSprint ? activeSprint.name : 'Project dates', title: 'The active sprint, or the project’s dates' },
		{ value: '30d' as const, label: '30 days' },
		{ value: '90d' as const, label: '90 days' }
	];

	function formatHours(value: number | undefined): string {
		const hours = value || 0;
		return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
	}

	function generateChartPath(data: BurnChartDataPoint[], key: 'remainingPoints' | 'completedPoints'): string {
		if (data.length === 0) return '';
		const maxPoints = Math.max(...data.map((d) => d.totalPoints), 1);
		const xScale = (chartWidth - chartPadding * 2) / Math.max(data.length - 1, 1);
		const yScale = (chartHeight - chartPadding * 2) / maxPoints;
		return data
			.map((point, i) => {
				const x = chartPadding + i * xScale;
				const y = chartHeight - chartPadding - point[key] * yScale;
				return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
			})
			.join(' ');
	}

	function generateIdealLine(data: BurnChartDataPoint[]): string {
		if (data.length === 0) return '';
		const totalPoints = data[0]?.totalPoints || 0;
		const maxPoints = Math.max(...data.map((d) => d.totalPoints), 1);
		const yScale = (chartHeight - chartPadding * 2) / maxPoints;
		const startY = chartHeight - chartPadding - totalPoints * yScale;
		return `M ${chartPadding} ${startY} L ${chartWidth - chartPadding} ${chartHeight - chartPadding}`;
	}

	$: maxScope = burnChartData.length ? Math.max(...burnChartData.map((d) => d.totalPoints), 1) : 1;

	// ── ⋯ project actions ──
	$: moreItems = [
		{ id: 'edit', label: 'Edit project…', icon: 'pencil', disabled: isReadOnly, hint: isReadOnly ? 'Read-only here' : undefined, onSelect: () => onOpenProjectModal(selectedProject) },
		{ id: 'sep', type: 'separator', label: '' },
		{ id: 'delete', label: 'Delete project…', icon: 'trash', danger: true, disabled: isReadOnly, onSelect: () => onDeleteProject(selectedProject) }
	] satisfies MenuEntry[];

	// ── tasks on the Board ──
	let dialogTodo: Todo | null = null;
	let newTaskLane: TodoStatus | null = null;

	function complete(todo: Todo): void {
		if (isReadOnly) return;
		const { patch, undo } = completeTask(todo);
		updateTodo(todo.id, patch);
		toast(`Marked “${todo.title}” done`, {
			action: 'Undo',
			onAction: () => updateTodo(todo.id, { status: undo.status, completedAt: undo.completedAt })
		});
	}
</script>

<div class="pj-detail">
	<nav class="pj-crumb" aria-label="Project">
		<Tooltip text={treeOpen ? 'Hide the project tree' : 'Show the project tree'}>
			<button type="button" class="w-ibtn pj-crumb__tree" aria-label="Project tree" aria-pressed={treeOpen} on:click={onToggleTree}>
				<Icon name="sidebarLeft" />
			</button>
		</Tooltip>
		<ol class="pj-crumb__list">
			<li><button type="button" class="pj-crumb__link" on:click={onBack}>Projects</button></li>
			{#each path as parent (parent.id)}
				<li>
					<Icon name="chevRight" size={14} class="pj-crumb__sep" />
					<button type="button" class="pj-crumb__link" on:click={() => onSelectProject(parent)}>{parent.name}</button>
				</li>
			{/each}
			<li>
				<Icon name="chevRight" size={14} class="pj-crumb__sep" />
				<span class="pj-crumb__here" aria-current="page">{selectedProject.name}</span>
			</li>
		</ol>
	</nav>

	<header class="pj-head">
		<h2 class="pj-title">
			<span class="pj-dot pj-dot--title" style:--project={selectedProject.color} aria-hidden="true"></span>
			<span>{selectedProject.name}</span>
		</h2>
		<p class="pj-facts">
			<span class="pj-facts__status"><span class="w-dot w-dot--{status.tone}" aria-hidden="true"></span>{status.word}</span>
			<span>{progressWords({ total: scopeTasks.length, done: scopeTasks.filter((t) => t.status === 'done').length })}</span>
			{#if selectedProject.targetEndDate}<span>Target {formatDate(selectedProject.targetEndDate)}</span>{/if}
		</p>
		{#if selectedProject.description}
			<p class="pj-desc">{selectedProject.description}</p>
		{/if}
	</header>

	<div class="pj-tools">
		<Segmented label="Project view" options={detailViews} bind:value={detailView} />
		<div class="pj-tools__end">
			<button type="button" class="w-btn" on:click={() => onOpenProjectModal(undefined, selectedProject.id)} disabled={isReadOnly} title={isReadOnly ? 'Read-only: sub-projects cannot be added here' : undefined}>
				<Icon name="plus" size={16} />Add sub-project
			</button>
			<button type="button" class="w-btn w-btn--primary" on:click={() => onOpenSprintModal()} disabled={isReadOnly} title={isReadOnly ? 'Read-only: sprints cannot be added here' : undefined}>
				<Icon name="plus" size={16} />New sprint
			</button>
			<Menu label="Project actions" triggerLabel="Project actions" class="w-ibtn" align="end" heading={selectedProject.name} items={moreItems}>
				<Icon name="more" />
			</Menu>
		</div>
	</div>

	{#if detailView === 'overview'}
		<ProjectOverview project={selectedProject} {onSelectProject} />
	{:else if detailView === 'board'}
		<!-- This project's tasks by lane; a title opens the task, the checkbox completes it. -->
		<div class="pj-board">
			{#each lanes as lane (lane.id)}
				<section class="pj-lane" aria-labelledby={`pj-lane-${lane.id}`}>
					<h3 class="pj-lane__head" id={`pj-lane-${lane.id}`}>{lane.label} <span class="pj-lane__count">{lane.tasks.length}</span></h3>
					{#if lane.tasks.length}
						<ul class="pj-rows">
							{#each lane.tasks as task (task.id)}
								{@const due = dueLabel(task)}
								<li class="pj-row" class:is-done={task.status === 'done'}>
									{#if task.status === 'done'}
										<Icon name="check" size={16} class="pj-row__done" />
									{:else}
										<input type="checkbox" class="w-check" aria-label={`Mark “${task.title}” done`} checked={false} disabled={isReadOnly} on:change={() => complete(task)} />
									{/if}
									<button type="button" class="pj-row__title" on:click={() => (dialogTodo = task)}>{task.title}</button>
									{#if due}<span class="pj-row__due" class:is-overdue={due.tone === 'overdue'} title={due.title}>{due.text}</span>{/if}
								</li>
							{/each}
						</ul>
					{/if}
					{#if !isReadOnly}
						<button type="button" class="pj-lane__add" on:click={() => (newTaskLane = lane.id)} aria-label={`Add task to ${lane.label}`}>
							<Icon name="plus" size={16} />Add task
						</button>
					{/if}
				</section>
			{/each}
		</div>
	{:else}
		<div class="pj-reports">
			<!-- Sprints: what is running, or a plain sentence; "New sprint" is always in the tools row. -->
			<section class="pj-sprint" aria-label="Sprint">
				{#if activeSprint}
					<div class="pj-sprint__line">
						<span class="w-kicker">{activeSprint.startDate <= Date.now() ? 'Active sprint' : 'Next sprint'}</span>
						<span class="pj-sprint__name">{activeSprint.name}</span>
						<span class="pj-sprint__range">{formatDate(activeSprint.startDate)} – {formatDate(activeSprint.endDate)}</span>
						<button type="button" class="w-btn w-btn--sm" on:click={() => onOpenSprintModal(activeSprint ?? undefined)}>Edit sprint</button>
					</div>
					{#if activeSprint.goals?.length}
						<ul class="pj-goals" aria-label="Sprint goals">
							{#each activeSprint.goals as goal}<li>{goal}</li>{/each}
						</ul>
					{/if}
				{:else}
					<p class="pj-sprint__none">
						{hasSprints ? 'No sprint is running right now.' : 'No sprints yet.'}
						Use New sprint to plan a stretch of work with an end date.
					</p>
				{/if}
			</section>

			<dl class="pj-figures">
				<div class="pj-figure"><dt>Tasks</dt><dd>{ownTasks.length}</dd></div>
				<div class="pj-figure"><dt>Done</dt><dd>{doneCount}</dd></div>
				<div class="pj-figure"><dt>In progress</dt><dd>{progressCount}</dd></div>
				<div class="pj-figure">
					<dt>Progress</dt>
					<dd>{progress}%</dd>
					<span class="pj-bar pj-bar--figure" aria-hidden="true"><span class="pj-bar__fill" style:width={`${progress}%`}></span></span>
				</div>
			</dl>

			{#if selectedProject.startDate || selectedProject.targetEndDate}
				<p class="pj-timeline">
					{#if selectedProject.startDate}<span>Started {formatDate(selectedProject.startDate)}</span>{/if}
					{#if selectedProject.targetEndDate}<span>Target {formatDate(selectedProject.targetEndDate)}</span>{/if}
				</p>
			{/if}

			<section class="pj-charts" aria-labelledby="pj-charts-title">
				<div class="pj-charts__head">
					<h3 class="pj-charts__title" id="pj-charts-title">Analysis</h3>
					<Segmented label="Chart" options={chartTabs} bind:value={activeTab} />
				</div>

				{#if activeTab === 'burndown'}
					{#if !estimated}
						<EmptyState
							icon="clock"
							as="p"
							title="Add time estimates to tasks to see a burndown"
							text="Turn on “Time estimate” in a task of this project; the chart follows the hours left."
							class="pj-empty"
						/>
					{:else if burnChartData.length > 1}
						<div class="pj-burn">
							<div class="pj-burn__top">
								<p class="pj-burn__facts">
									<span>Remaining <strong>{formatHours(latestBurnPoint?.remainingPoints)}</strong></span>
									<span>Scope <strong>{formatHours(burnChartData[0]?.totalPoints)}</strong></span>
								</p>
								<Segmented label="Burndown range" options={burnRanges} bind:value={burnRange} />
							</div>
							<svg class="pj-burn__chart" viewBox="0 0 {chartWidth} {chartHeight}" preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Burndown: ${formatHours(latestBurnPoint?.remainingPoints)} remaining of ${formatHours(burnChartData[0]?.totalPoints)}`}>
								<g class="pj-burn__grid">
									{#each [0, 0.25, 0.5, 0.75, 1] as ratio}
										{@const y = chartHeight - chartPadding - ratio * (chartHeight - chartPadding * 2)}
										<line x1={chartPadding} y1={y} x2={chartWidth - chartPadding} y2={y} />
										<text x={chartPadding - 8} y={y + 4} text-anchor="end">{formatHours(maxScope * ratio)}</text>
									{/each}
								</g>
								<path class="pj-burn__ideal" d={generateIdealLine(burnChartData)} />
								<path class="pj-burn__remaining" d={generateChartPath(burnChartData, 'remainingPoints')} />
								<path class="pj-burn__done" d={generateChartPath(burnChartData, 'completedPoints')} />
								<g class="pj-burn__axis">
									<text x={chartPadding} y={chartHeight - chartPadding + 20} text-anchor="start">{axisFormat.format(new Date(burnChartData[0].date))}</text>
									<text x={chartWidth - chartPadding} y={chartHeight - chartPadding + 20} text-anchor="end">{axisFormat.format(new Date(burnChartData[burnChartData.length - 1].date))}</text>
								</g>
							</svg>
							<ul class="pj-legend">
								<li><span class="pj-legend__key pj-legend__key--remaining" aria-hidden="true"></span>Remaining hours</li>
								<li><span class="pj-legend__key pj-legend__key--done" aria-hidden="true"></span>Done hours</li>
								<li><span class="pj-legend__key pj-legend__key--ideal" aria-hidden="true"></span>Ideal</li>
							</ul>
						</div>
					{:else}
						<EmptyState icon="clock" as="p" title="Not enough days to draw yet" text="The burndown starts once the range covers two days." class="pj-empty" />
					{/if}
				{:else}
					<GanttChart selectedProjectId={selectedProject.id} />
				{/if}
			</section>
		</div>
	{/if}
</div>

{#if dialogTodo}
	<PlannerTaskDialog todo={dialogTodo} {isReadOnly} onclose={() => (dialogTodo = null)} />
{:else if newTaskLane}
	<PlannerTaskDialog todo={null} status={newTaskLane} projectId={selectedProject.id} onclose={() => (newTaskLane = null)} />
{/if}
