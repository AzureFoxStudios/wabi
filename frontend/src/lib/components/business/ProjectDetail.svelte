<script lang="ts">
	import { projects, todos, sprints, generateBurnChartData } from '$lib/business/store';
	import type { Project, Sprint, BurnChartDataPoint } from '$lib/business/types';
	import GanttChart from './GanttChart.svelte';

	export let selectedProject: Project;
	export let isReadOnly = false;
	export let onOpenProjectModal: (project?: Project, parentId?: string) => void = () => {};
	export let onDeleteProject: (project: Project) => void = () => {};
	export let onOpenSprintModal: (sprint?: Sprint) => void = () => {};

	let activeTab: 'burndown' | 'gantt' = 'burndown';
	let burnRangeSprint: Sprint | null = null;
	/** Burn range control: auto (sprint/project) or fixed windows. */
	let burnRange: 'auto' | '30d' | '90d' = 'auto';

	const chartWidth = 600;
	const chartHeight = 250;
	const chartPadding = 40;

	function getProjectPath(project: Project): string[] {
		const path: string[] = [];
		let current = project;
		while (current.parentId) {
			const parent = $projects.find(p => p.id === current.parentId);
			if (parent) {
				path.unshift(parent.name);
				current = parent;
			} else {
				break;
			}
		}
		return path;
	}

	function getProjectTodos(projectId: string) {
		return $todos.filter(t => t.projectId === projectId);
	}

	function getProjectSprints(projectId: string) {
		return $sprints.filter(s => s.projectId === projectId);
	}

	function getProjectProgress(projectId: string): number {
		const projectTodos = getProjectTodos(projectId);
		if (projectTodos.length === 0) return 0;
		const completed = projectTodos.filter(t => t.status === 'done').length;
		return Math.round((completed / projectTodos.length) * 100);
	}

	function getActiveOrNextSprint(projectId: string): Sprint | null {
		const projectSprints = getProjectSprints(projectId);
		const now = Date.now();
		const activeSprint = projectSprints.find(s => s.startDate <= now && s.endDate >= now);
		if (activeSprint) return activeSprint;
		const upcomingSprints = projectSprints.filter(s => s.startDate > now).sort((a, b) => a.startDate - b.startDate);
		return upcomingSprints[0] || null;
	}

	$: {
		void $sprints;
		burnRangeSprint = getActiveOrNextSprint(selectedProject.id);
	}
	$: burnStart =
		burnRange === '30d'
			? Date.now() - 30 * 24 * 60 * 60 * 1000
			: burnRange === '90d'
				? Date.now() - 90 * 24 * 60 * 60 * 1000
				: (burnRangeSprint?.startDate || selectedProject.startDate || selectedProject.createdAt);
	$: burnEnd =
		burnRange === '30d' || burnRange === '90d'
			? Date.now()
			: (burnRangeSprint?.endDate || selectedProject.targetEndDate || Date.now());
	$: burnChartData = generateBurnChartData(selectedProject.id, burnStart, Math.max(burnStart + 24 * 60 * 60 * 1000, burnEnd));
	$: latestBurnPoint = burnChartData.length ? burnChartData[burnChartData.length - 1] : null;
	$: activeSprint = getActiveOrNextSprint(selectedProject.id);
	$: hasSprints = getProjectSprints(selectedProject.id).length > 0;

	function formatHours(value: number | undefined): string {
		const hours = value || 0;
		return `${hours.toFixed(1)}h`;
	}

	function generateChartPath(data: BurnChartDataPoint[], key: 'remainingPoints' | 'completedPoints'): string {
		if (data.length === 0) return '';

		const maxPoints = Math.max(...data.map(d => d.totalPoints), 1);
		const xScale = (chartWidth - chartPadding * 2) / Math.max(data.length - 1, 1);
		const yScale = (chartHeight - chartPadding * 2) / maxPoints;

		return data.map((point, i) => {
			const x = chartPadding + i * xScale;
			const y = chartHeight - chartPadding - point[key] * yScale;
			return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
		}).join(' ');
	}

	function generateIdealLine(data: BurnChartDataPoint[]): string {
		if (data.length === 0) return '';

		const totalPoints = data[0]?.totalPoints || 0;
		const xScale = (chartWidth - chartPadding * 2) / Math.max(data.length - 1, 1);
		const yScale = (chartHeight - chartPadding * 2) / Math.max(totalPoints, 1);

		const startX = chartPadding;
		const startY = chartHeight - chartPadding - totalPoints * yScale;
		const endX = chartWidth - chartPadding;
		const endY = chartHeight - chartPadding;

		return `M ${startX} ${startY} L ${endX} ${endY}`;
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}
</script>

<header class="project-header">
	<div class="header-info">
		<div class="project-color-large" style="background-color: {selectedProject.color}"></div>
		<div>
			{#if selectedProject.parentId}
				<div class="project-breadcrumb">
					{#each getProjectPath(selectedProject) as parentName}
						<span class="breadcrumb-item">{parentName}</span>
						<span class="breadcrumb-sep">/</span>
					{/each}
				</div>
			{/if}
			<h1>{selectedProject.name}</h1>
			{#if selectedProject.description}
				<p class="project-description">{selectedProject.description}</p>
			{/if}
		</div>
	</div>
	<div class="header-actions">
		<button class="sub-project-btn" on:click={() => onOpenProjectModal(undefined, selectedProject.id)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Add Sub-project'}>+ Sub-project</button>
		<button class="edit-btn" on:click={() => onOpenProjectModal(selectedProject)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Edit'}>Edit</button>
		<button class="delete-btn" on:click={() => onDeleteProject(selectedProject)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Delete'}>Delete</button>
	</div>
</header>

{#if activeSprint}
	<div class="sprint-indicator">
		<div class="sprint-info">
			<span class="sprint-badge" class:active={activeSprint.status === 'active'}>
				{activeSprint.status === 'active' ? 'Active Sprint' : 'Upcoming Sprint'}
			</span>
			<span class="sprint-name">{activeSprint.name}</span>
			<span class="sprint-range">
				{formatDate(activeSprint.startDate)} – {formatDate(activeSprint.endDate)}
			</span>
		</div>
		<button class="view-sprints-btn" on:click={() => onOpenSprintModal(activeSprint)}>
			Edit Sprint
		</button>
	</div>

	{#if activeSprint?.goals?.length}
		<div class="sprint-goals-section">
			<span class="goals-label">Goals</span>
			<ul class="goals-list">
				{#each activeSprint.goals as goal}
					<li>{goal}</li>
				{/each}
			</ul>
		</div>
	{/if}
{:else if hasSprints}
	<div class="sprint-indicator">
		<div class="sprint-info">
			<span class="sprint-badge">No Active Sprint</span>
		</div>
		<button class="view-sprints-btn" on:click={() => onOpenSprintModal()}>
			+ New Sprint
		</button>
	</div>
{:else}
	<div class="sprint-indicator no-sprints">
		<div class="sprint-info">
			<span class="sprint-badge">No Sprints</span>
			<span class="sprint-name">Get started by creating your first sprint</span>
		</div>
		<button class="view-sprints-btn" on:click={() => onOpenSprintModal()}>
			+ Create Sprint
		</button>
	</div>
{/if}

<div class="timeline-and-stats">
	{#if selectedProject.startDate || selectedProject.targetEndDate}
		<div class="timeline-section">
			<h2>Timeline</h2>
			<div class="timeline-dates">
				{#if selectedProject.startDate}
					<div class="timeline-date">
						<span class="date-label">Start</span>
						<span class="date-value">{formatDate(selectedProject.startDate)}</span>
					</div>
				{/if}
				{#if selectedProject.targetEndDate}
					<div class="timeline-date">
						<span class="date-label">Target</span>
						<span class="date-value">{formatDate(selectedProject.targetEndDate)}</span>
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<div class="stats-row">
		<div class="stat-card">
			<span class="stat-value">{getProjectTodos(selectedProject.id).length}</span>
			<span class="stat-label">Total Tasks</span>
		</div>
		<div class="stat-card">
			<span class="stat-value">{getProjectTodos(selectedProject.id).filter(t => t.status === 'done').length}</span>
			<span class="stat-label">Completed</span>
		</div>
		<div class="stat-card">
			<span class="stat-value">{getProjectTodos(selectedProject.id).filter(t => t.status === 'in_progress').length}</span>
			<span class="stat-label">In Progress</span>
		</div>
		<div class="stat-card">
			<div class="stat-progress">
				<span class="stat-value">{getProjectProgress(selectedProject.id)}%</span>
				<div class="stat-progress-bar">
					<div class="stat-progress-fill" style="width: {getProjectProgress(selectedProject.id)}%"></div>
				</div>
			</div>
			<span class="stat-label">Progress</span>
		</div>
	</div>
</div>

<div class="charts-section">
	<div class="section-header">
		<h2>Analysis</h2>
		<div class="tab-buttons">
			<button class="tab-btn" class:active={activeTab === 'burndown'} on:click={() => activeTab = 'burndown'}>
				Burndown
			</button>
			<button class="tab-btn" class:active={activeTab === 'gantt'} on:click={() => activeTab = 'gantt'}>
				Gantt
			</button>
		</div>
	</div>

	{#if activeTab === 'burndown'}
		<div class="range-picker" role="radiogroup" aria-label="Burn chart range">
			<button class="range-btn" class:active={burnRange === 'auto'} on:click={() => burnRange = 'auto'} title="Active sprint or project dates">
				Auto{burnRangeSprint ? ` · ${burnRangeSprint.name}` : ''}
			</button>
			<button class="range-btn" class:active={burnRange === '30d'} on:click={() => burnRange = '30d'}>Last 30d</button>
			<button class="range-btn" class:active={burnRange === '90d'} on:click={() => burnRange = '90d'}>Last 90d</button>
		</div>
	{/if}

	{#if activeTab === 'burndown'}
		<div class="tab-content">
			{#if burnChartData.length > 1}
				<div class="chart-container">
					<div class="burn-summary">
						<span>
							Remaining: <strong>{formatHours(latestBurnPoint?.remainingPoints)}</strong>
						</span>
						<span>
							Total Scope: <strong>{formatHours(burnChartData[0]?.totalPoints)}</strong>
						</span>
						{#if burnRangeSprint}
							<span class="burn-range-label">Sprint: {burnRangeSprint.name}</span>
						{/if}
					</div>
					<svg width="100%" viewBox="0 0 {chartWidth} {chartHeight}" preserveAspectRatio="xMidYMid meet">
						<g class="grid-lines">
							{#each [0, 0.25, 0.5, 0.75, 1] as ratio}
								<line
									x1={chartPadding}
									y1={chartHeight - chartPadding - ratio * (chartHeight - chartPadding * 2)}
									x2={chartWidth - chartPadding}
									y2={chartHeight - chartPadding - ratio * (chartHeight - chartPadding * 2)}
									stroke="var(--border-color, #2a2a4a)"
									stroke-width="1"
								/>
							{/each}
						</g>
						<path d={generateIdealLine(burnChartData)} fill="none" stroke="var(--text-secondary, #666)" stroke-width="2" stroke-dasharray="5,5" />
						<path d={generateChartPath(burnChartData, 'remainingPoints')} fill="none" stroke="#ef4444" stroke-width="3" />
						<path d={generateChartPath(burnChartData, 'completedPoints')} fill="none" stroke="#3ba55d" stroke-width="3" />
						<line x1={chartPadding} y1={chartPadding} x2={chartPadding} y2={chartHeight - chartPadding} stroke="var(--text-secondary, #888)" stroke-width="2" />
						<line x1={chartPadding} y1={chartHeight - chartPadding} x2={chartWidth - chartPadding} y2={chartHeight - chartPadding} stroke="var(--text-secondary, #888)" stroke-width="2" />
					</svg>
					<div class="chart-legend">
						<div class="legend-item"><span class="legend-color" style="background: #ef4444"></span><span>Remaining (h)</span></div>
						<div class="legend-item"><span class="legend-color" style="background: #3ba55d"></span><span>Completed (h)</span></div>
						<div class="legend-item"><span class="legend-line"></span><span>Ideal</span></div>
					</div>
				</div>
			{:else}
				<div class="no-chart-data">
					<p>Add tasks with optional time estimates to see the burndown</p>
				</div>
			{/if}
		</div>
	{:else if activeTab === 'gantt'}
		<div class="tab-content">
			<GanttChart selectedProjectId={selectedProject.id} />
		</div>
	{/if}
</div>
