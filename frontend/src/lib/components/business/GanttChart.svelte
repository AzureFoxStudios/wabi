<script lang="ts">
	import { projects, sprints, todos } from '$lib/business/store';
	import type { Project, Sprint, Todo } from '$lib/business/types';
	import PlannerAvatar from './PlannerAvatar.svelte';
	import {
		plannerUserById,
		getPlannerUserName,
		getPlannerUserColor,
		getPlannerUserAvatarUrl,
		parseAssigneeId
	} from '$lib/business/plannerUsers';

	export let selectedProjectId: string | null = null;

	// Get the selected project or all projects
	$: displayProjects = selectedProjectId
		? $projects.filter(p => p.id === selectedProjectId)
		: $projects.filter(p => !p.parentId); // Root projects only

	let minDate = Date.now();
	let maxDate = Date.now();
	let monthLabels: Date[] = [];

	function getProjectStartDate(project: Project): number {
		return project.startDate || project.createdAt;
	}

	function getProjectEndDate(project: Project): number {
		return project.targetEndDate || Date.now();
	}

	function startOfMonth(timestamp: number): number {
		const d = new Date(timestamp);
		return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
	}

	function endOfMonth(timestamp: number): number {
		const d = new Date(timestamp);
		return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
	}

	function buildMonthLabels(start: number, end: number): Date[] {
		const labels: Date[] = [];
		const cursor = new Date(start);
		cursor.setDate(1);
		cursor.setHours(0, 0, 0, 0);

		const hardStop = new Date(end);
		hardStop.setDate(1);
		hardStop.setHours(0, 0, 0, 0);

		while (cursor.getTime() <= hardStop.getTime()) {
			labels.push(new Date(cursor));
			cursor.setMonth(cursor.getMonth() + 1);
		}

		return labels;
	}

	/** Tasks with a due date on a project — the bars that make Gantt useful. */
	function getTasksForProject(projectId: string): Todo[] {
		return $todos
			.filter(t => t.projectId === projectId && t.dueDate && t.status !== 'archived')
			.sort((a, b) => (a.dueDate || 0) - (b.dueDate || 0));
	}

	// Calculate timeline bounds from project bars, sprint bands and task due dates
	$: {
		const timelineDates: number[] = [];
		for (const project of displayProjects) {
			timelineDates.push(getProjectStartDate(project), getProjectEndDate(project));
			for (const sprint of getSprintsForProject(project.id)) {
				timelineDates.push(sprint.startDate, sprint.endDate);
			}
			for (const task of getTasksForProject(project.id)) {
				timelineDates.push(task.dueDate as number);
			}
		}

		if (timelineDates.length === 0) {
			const now = Date.now();
			minDate = startOfMonth(now) - 15 * 24 * 60 * 60 * 1000;
			maxDate = endOfMonth(now) + 15 * 24 * 60 * 60 * 1000;
		} else {
			minDate = startOfMonth(Math.min(...timelineDates));
			maxDate = endOfMonth(Math.max(...timelineDates));
		}

		monthLabels = buildMonthLabels(minDate, maxDate);
	}

	const DAY_MS = 24 * 60 * 60 * 1000;

	// "Today" marker position (% of timeline)
	$: todayPct = Math.min(100, Math.max(0, ((Date.now() - minDate) / Math.max(1, maxDate - minDate)) * 100));

	// Format date for display
	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric'
		});
	}

	// Calculate bar position and width (percent of timeline span)
	function calculateBar(startDate: number | undefined, endDate: number | undefined) {
		const start = startDate || minDate;
		const end = endDate || start + DAY_MS; // point events still get a visible sliver
		const totalRange = Math.max(1, maxDate - minDate);
		const left = ((start - minDate) / totalRange) * 100;
		const width = Math.min(100 - left, Math.max(1.2, ((Math.max(end, start) - start) / totalRange) * 100));
		return { left, width };
	}

	// Task bar color by priority (progress color stays on the project bar)
	function getTaskBarColor(todo: Todo): string {
		switch (todo.priority) {
			case 'urgent': return 'var(--priority-urgent, #ff4d4d)';
			case 'high': return 'var(--priority-high, #f97316)';
			case 'medium': return 'var(--priority-medium, #f59e0b)';
			default: return 'var(--priority-low, #35d07f)';
		}
	}

	// Get progress color for project bars
	function getProgressColor(project: Project): string {
		const projectTodos = $todos.filter(t => t.projectId === project.id);
		if (projectTodos.length === 0) return '#8b5cf6';
		const completed = projectTodos.filter(t => t.status === 'done').length;
		const progress = (completed / projectTodos.length) * 100;

		if (progress === 100) return '#10b981';
		if (progress >= 75) return '#3b82f6';
		if (progress >= 50) return '#f59e0b';
		return '#ef4444';
	}

	// Get sprints for a project
	function getSprintsForProject(projectId: string): Sprint[] {
		return $sprints.filter(s => s.projectId === projectId);
	}

	// Calculate progress percentage
	function getProgress(projectId: string): number {
		const projectTodos = $todos.filter(t => t.projectId === projectId);
		if (projectTodos.length === 0) return 0;
		const completed = projectTodos.filter(t => t.status === 'done').length;
		return Math.round((completed / projectTodos.length) * 100);
	}
</script>

<div class="gantt-container">
	<div class="gantt-header">
		<h2>Project Timeline {selectedProjectId ? '(Gantt)' : '(All Projects)'}</h2>
		<p class="gantt-info">
			Bars show project spans; thin rows are task due dates by priority. Colors: green complete, blue on track, amber behind.
		</p>
	</div>

	{#if displayProjects.length === 0}
		<div class="empty-state">
			<p>No projects to display</p>
		</div>
	{:else}
		<div class="gantt-chart" style="--pixels-per-day: 3px;">
			<!-- Timeline header -->
			<div class="gantt-timeline-header">
				<div class="gantt-labels"></div>
				<div class="gantt-bars">
					<div class="timeline-months">
						{#each monthLabels as monthDate}
							<div class="month-label">
								{monthDate.toLocaleDateString('en-US', {
									month: 'short',
									year: monthDate.getMonth() === 0 ? '2-digit' : undefined
								})}
							</div>
						{/each}
					</div>
				</div>
			</div>

			<!-- Project rows -->
			{#each displayProjects as project (project.id)}
				{@const projectBar = calculateBar(getProjectStartDate(project), getProjectEndDate(project))}
				<div class="gantt-row">
					<div class="gantt-label">
						<div class="project-title">{project.name}</div>
						<div class="project-meta">
							{getProgress(project.id)}% - {$todos.filter(t => t.projectId === project.id).length} tasks
						</div>
					</div>

					<div class="gantt-bars">
						<!-- Sprint bands (shaded ranges, name on hover) -->
						{#each getSprintsForProject(project.id) as sprint (sprint.id)}
							{@const band = calculateBar(sprint.startDate, sprint.endDate)}
							<div
								class="sprint-band"
								style="left: {band.left}%; width: {band.width}%"
								title="Sprint: {sprint.name} · {formatDate(sprint.startDate)} – {formatDate(sprint.endDate)}"
							></div>
						{/each}

						<!-- Main project bar -->
						<div
							class="gantt-bar-container"
							style="left: {projectBar.left}%; width: {projectBar.width}%"
						>
							<div
								class="gantt-bar"
								class:complete={getProgress(project.id) === 100}
								style="background-color: {getProgressColor(project)}"
								title="{formatDate(getProjectStartDate(project))} -> {formatDate(getProjectEndDate(project))}"
							>
								<span class="progress-label">{getProgress(project.id)}%</span>
							</div>
						</div>

						<!-- Task due-date bars under the project bar -->
						{#if getTasksForProject(project.id).length > 0}
							<div class="task-lane">
								{#each getTasksForProject(project.id).slice(0, 40) as todo (todo.id)}
									{@const bar = calculateBar(todo.dueDate, todo.dueDate)}
									{@const aid = parseAssigneeId(todo.assignedTo)}
									<div
										class="task-tick"
										style="left: {bar.left}%"
										class:done={todo.status === 'done'}
										title="{todo.title}{todo.status === 'done' ? ' ✓' : ''}{aid ? ` · ${getPlannerUserName($plannerUserById, aid)}` : ''} · due {formatDate(todo.dueDate as number)}"
									>
										<span class="task-stick" style="background: {getTaskBarColor(todo)}"></span>
										<PlannerAvatar
											name={getPlannerUserName($plannerUserById, aid)}
											color={getPlannerUserColor($plannerUserById, aid)}
											src={getPlannerUserAvatarUrl($plannerUserById, aid)}
											size="xs"
										/>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			{/each}

			<!-- Today marker line spanning the chart body -->
			<div class="today-marker" style="left: calc(180px + (100% - 180px) * {todayPct / 100})" title="Today"></div>
		</div>
	{/if}
</div>

<style>
	.gantt-container {
		padding: 1rem;
		background: var(--biz-bg-secondary, #1a2332);
		border-radius: 8px;
		overflow: hidden;
	}

	.gantt-header {
		margin-bottom: 1.5rem;
	}

	.gantt-header h2 {
		margin: 0 0 0.5rem 0;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 1.25rem;
	}

	.gantt-info {
		margin: 0;
		color: var(--biz-text-secondary, #94a3b8);
		font-size: 0.875rem;
	}

	.empty-state {
		padding: 2rem;
		text-align: center;
		color: var(--biz-text-secondary, #94a3b8);
	}

	.gantt-chart {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0;
		overflow-x: auto;
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 4px;
	}

	.gantt-timeline-header {
		display: flex;
		position: sticky;
		top: 0;
		z-index: 10;
		background: var(--biz-bg-tertiary, #243044);
		border-bottom: 2px solid var(--biz-border, #2d3a4d);
	}

	.gantt-labels {
		min-width: 180px;
		flex-shrink: 0;
	}

	.gantt-bars {
		flex: 1;
		position: relative;
	}

	.timeline-months {
		display: flex;
		height: 3rem;
		border-left: 1px solid var(--biz-border, #2d3a4d);
	}

	.month-label {
		flex: 1;
		min-width: 100px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--biz-text-secondary, #94a3b8);
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		border-right: 1px solid var(--biz-border, #2d3a4d);
		padding: 0 0.5rem;
	}

	.gantt-row {
		display: flex;
		flex-direction: column;
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
		background: var(--biz-bg-secondary, #1a2332);
	}

	.gantt-row:hover {
		background: var(--biz-bg-tertiary, #243044);
	}

	/* Top half of the row: label + project bar lane */
	.gantt-row > .gantt-label {
		display: none;
	}

	.gantt-row::before {
		content: '';
		order: -1;
	}

	/* Label column overlays via grid: keep DOM order but use a two-column grid */
	.gantt-row {
		display: grid;
		grid-template-columns: 180px 1fr;
	}

	.gantt-row .gantt-label {
		grid-row: 1 / span 2;
		min-height: 64px;
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.25rem;
		border-right: 1px solid var(--biz-border, #2d3a4d);
	}

	.gantt-row > .gantt-bars {
		grid-row: 1;
		min-height: 44px;
		display: flex;
		align-items: center;
	}

	.project-title {
		color: var(--biz-text-primary, #f1f5f9);
		font-weight: 600;
		font-size: 0.95rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.project-meta {
		color: var(--biz-text-secondary, #94a3b8);
		font-size: 0.75rem;
	}

	.gantt-bar-container {
		position: absolute;
		height: 22px;
		display: flex;
		align-items: center;
		z-index: 2;
	}

	.gantt-bar {
		width: 100%;
		height: 100%;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: filter 0.2s;
		border: 1px solid rgba(255, 255, 255, 0.2);
		position: relative;
		overflow: hidden;
	}

	.gantt-bar:hover {
		filter: brightness(1.15);
	}

	.gantt-bar.complete::after {
		content: '✓';
		position: absolute;
		right: 4px;
		color: white;
		font-weight: bold;
		font-size: 0.75rem;
	}

	.progress-label {
		color: white;
		font-size: 0.7rem;
		font-weight: 600;
		text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
	}

	/* Sprint bands: shaded full-height ranges */
	.sprint-band {
		position: absolute;
		top: 0;
		bottom: 0;
		background: color-mix(in srgb, #ffffff 7%, transparent);
		border-left: 1px dashed color-mix(in srgb, #ffffff 35%, transparent);
		border-right: 1px dashed color-mix(in srgb, #ffffff 20%, transparent);
		z-index: 1;
	}

	/* Task lane: thin due-date ticks with avatars */
	.task-lane {
		position: relative;
		grid-row: 2;
		height: 30px;
		border-top: 1px dashed color-mix(in srgb, var(--biz-border, #2d3a4d) 60%, transparent);
	}

	.task-tick {
		position: absolute;
		top: 3px;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		z-index: 3;
		cursor: default;
	}

	.task-stick {
		display: block;
		width: 4px;
		height: 16px;
		border-radius: 2px;
		margin-right: 2px;
	}

	.task-tick.done .task-stick {
		opacity: 0.45;
	}

	.task-tick.done :global(.planner-avatar) {
		opacity: 0.45;
	}

	/* Today marker */
	.today-marker {
		position: absolute;
		top: 48px; /* below sticky header */
		bottom: 0;
		width: 2px;
		background: linear-gradient(to bottom, transparent, var(--biz-warning, #f59e0b));
		pointer-events: none;
		z-index: 4;
	}

	@media (max-width: 768px) {
		.gantt-row {
			grid-template-columns: 120px 1fr;
		}

		.gantt-row .gantt-label {
			min-height: 56px;
		}

		.project-title {
			font-size: 0.85rem;
		}

		.month-label {
			min-width: 80px;
			font-size: 0.65rem;
		}
	}
</style>
