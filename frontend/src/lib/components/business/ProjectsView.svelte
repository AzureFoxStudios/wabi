<script lang="ts">
	import {
		projects,
		todos,
		sprints,
		addProject,
		updateProject,
		deleteProject,
		addSprint,
		generateBurnChartData
	} from '$lib/business/store';
	import type { Project, Sprint, BurnChartDataPoint } from '$lib/business/types';
	import { onMount } from 'svelte';

	let selectedProject: Project | null = null;
	let showProjectModal = false;
	let showSprintModal = false;
	let editingProject: Project | null = null;

	// Project form
	let projectName = '';
	let projectDescription = '';
	let projectColor = '#5865f2';
	let projectStartDate = '';
	let projectTargetDate = '';

	// Sprint form
	let sprintName = '';
	let sprintStartDate = '';
	let sprintEndDate = '';
	let sprintGoals = '';

	const colorOptions = [
		'#5865f2', '#3ba55d', '#faa81a', '#ed4245',
		'#9b59b6', '#e91e63', '#00bcd4', '#ff9800'
	];

	// Get todos for a project
	function getProjectTodos(projectId: string) {
		return $todos.filter(t => t.projectId === projectId);
	}

	// Get sprints for a project
	function getProjectSprints(projectId: string) {
		return $sprints.filter(s => s.projectId === projectId);
	}

	// Calculate project progress
	function getProjectProgress(projectId: string): number {
		const projectTodos = getProjectTodos(projectId);
		if (projectTodos.length === 0) return 0;
		const completed = projectTodos.filter(t => t.status === 'done').length;
		return Math.round((completed / projectTodos.length) * 100);
	}

	// Get burn chart data for selected project
	$: burnChartData = selectedProject ? generateBurnChartData(
		selectedProject.id,
		selectedProject.startDate || selectedProject.createdAt,
		selectedProject.targetEndDate || Date.now()
	) : [];

	// SVG chart dimensions
	const chartWidth = 600;
	const chartHeight = 250;
	const chartPadding = 40;

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

	// Modals
	function openProjectModal(project?: Project) {
		if (project) {
			editingProject = project;
			projectName = project.name;
			projectDescription = project.description || '';
			projectColor = project.color;
			projectStartDate = project.startDate ? new Date(project.startDate).toISOString().split('T')[0] : '';
			projectTargetDate = project.targetEndDate ? new Date(project.targetEndDate).toISOString().split('T')[0] : '';
		} else {
			resetProjectForm();
		}
		showProjectModal = true;
	}

	function resetProjectForm() {
		editingProject = null;
		projectName = '';
		projectDescription = '';
		projectColor = '#5865f2';
		projectStartDate = '';
		projectTargetDate = '';
	}

	function closeProjectModal() {
		showProjectModal = false;
		resetProjectForm();
	}

	function handleProjectSubmit() {
		if (!projectName.trim()) return;

		const projectData = {
			name: projectName.trim(),
			description: projectDescription.trim() || undefined,
			color: projectColor,
			startDate: projectStartDate ? new Date(projectStartDate).getTime() : undefined,
			targetEndDate: projectTargetDate ? new Date(projectTargetDate).getTime() : undefined,
			status: 'active' as const,
			createdBy: 'current-user'
		};

		if (editingProject) {
			updateProject(editingProject.id, projectData);
			if (selectedProject?.id === editingProject.id) {
				selectedProject = { ...selectedProject, ...projectData };
			}
		} else {
			const newProject = addProject(projectData);
			selectedProject = newProject;
		}

		closeProjectModal();
	}

	function handleDeleteProject(project: Project) {
		if (confirm(`Delete "${project.name}" and all its tasks?`)) {
			deleteProject(project.id);
			if (selectedProject?.id === project.id) {
				selectedProject = null;
			}
		}
	}

	function openSprintModal() {
		sprintName = '';
		sprintStartDate = '';
		sprintEndDate = '';
		sprintGoals = '';
		showSprintModal = true;
	}

	function closeSprintModal() {
		showSprintModal = false;
	}

	function handleSprintSubmit() {
		if (!selectedProject || !sprintName.trim() || !sprintStartDate || !sprintEndDate) return;

		addSprint({
			projectId: selectedProject.id,
			name: sprintName.trim(),
			startDate: new Date(sprintStartDate).getTime(),
			endDate: new Date(sprintEndDate).getTime(),
			goals: sprintGoals ? sprintGoals.split('\n').filter(g => g.trim()) : undefined,
			status: 'planned'
		});

		closeSprintModal();
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}

	function getStatusColor(status: Project['status']): string {
		switch (status) {
			case 'active': return '#3ba55d';
			case 'planning': return '#faa81a';
			case 'paused': return '#888';
			case 'completed': return '#5865f2';
			case 'cancelled': return '#ef4444';
			default: return '#888';
		}
	}
</script>

<div class="projects-container">
	<aside class="projects-sidebar">
		<div class="sidebar-header">
			<h2>Projects</h2>
			<button class="add-project-btn" on:click={() => openProjectModal()}>+</button>
		</div>
		<div class="projects-list">
			{#if $projects.length === 0}
				<p class="empty-message">No projects yet</p>
			{:else}
				{#each $projects as project (project.id)}
					<button
						class="project-item"
						class:selected={selectedProject?.id === project.id}
						on:click={() => selectedProject = project}
					>
						<div class="project-color" style="background-color: {project.color}"></div>
						<div class="project-info">
							<span class="project-name">{project.name}</span>
							<span class="project-status" style="color: {getStatusColor(project.status)}">
								{project.status}
							</span>
						</div>
						<div class="project-progress-mini">
							<div class="progress-bar" style="width: {getProjectProgress(project.id)}%"></div>
						</div>
					</button>
				{/each}
			{/if}
		</div>
	</aside>

	<main class="project-main">
		{#if selectedProject}
			<header class="project-header">
				<div class="header-info">
					<div class="project-color-large" style="background-color: {selectedProject.color}"></div>
					<div>
						<h1>{selectedProject.name}</h1>
						{#if selectedProject.description}
							<p class="project-description">{selectedProject.description}</p>
						{/if}
					</div>
				</div>
				<div class="header-actions">
					<button class="edit-btn" on:click={() => openProjectModal(selectedProject)}>Edit</button>
					<button class="delete-btn" on:click={() => handleDeleteProject(selectedProject)}>Delete</button>
				</div>
			</header>

			<!-- Stats Row -->
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
					<span class="stat-value">{getProjectProgress(selectedProject.id)}%</span>
					<span class="stat-label">Progress</span>
				</div>
			</div>

			<!-- Progress Bar -->
			<div class="progress-section">
				<div class="progress-header">
					<span>Overall Progress</span>
					<span>{getProjectProgress(selectedProject.id)}%</span>
				</div>
				<div class="progress-track">
					<div class="progress-fill" style="width: {getProjectProgress(selectedProject.id)}%"></div>
				</div>
			</div>

			<!-- Burn Chart -->
			<div class="burn-chart-section">
				<div class="section-header">
					<h2>Burn Down Chart</h2>
				</div>
				{#if burnChartData.length > 1}
					<div class="chart-container">
						<svg width="100%" viewBox="0 0 {chartWidth} {chartHeight}" preserveAspectRatio="xMidYMid meet">
							<!-- Grid lines -->
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

							<!-- Ideal line -->
							<path
								d={generateIdealLine(burnChartData)}
								fill="none"
								stroke="var(--text-secondary, #666)"
								stroke-width="2"
								stroke-dasharray="5,5"
							/>

							<!-- Remaining points line -->
							<path
								d={generateChartPath(burnChartData, 'remainingPoints')}
								fill="none"
								stroke="#ef4444"
								stroke-width="3"
							/>

							<!-- Completed points line -->
							<path
								d={generateChartPath(burnChartData, 'completedPoints')}
								fill="none"
								stroke="#3ba55d"
								stroke-width="3"
							/>

							<!-- Axes -->
							<line
								x1={chartPadding}
								y1={chartPadding}
								x2={chartPadding}
								y2={chartHeight - chartPadding}
								stroke="var(--text-secondary, #888)"
								stroke-width="2"
							/>
							<line
								x1={chartPadding}
								y1={chartHeight - chartPadding}
								x2={chartWidth - chartPadding}
								y2={chartHeight - chartPadding}
								stroke="var(--text-secondary, #888)"
								stroke-width="2"
							/>
						</svg>
						<div class="chart-legend">
							<div class="legend-item">
								<span class="legend-color" style="background: #ef4444"></span>
								<span>Remaining</span>
							</div>
							<div class="legend-item">
								<span class="legend-color" style="background: #3ba55d"></span>
								<span>Completed</span>
							</div>
							<div class="legend-item">
								<span class="legend-line"></span>
								<span>Ideal</span>
							</div>
						</div>
					</div>
				{:else}
					<div class="no-chart-data">
						<p>Add tasks to this project to see the burn chart</p>
					</div>
				{/if}
			</div>

			<!-- Sprints -->
			<div class="sprints-section">
				<div class="section-header">
					<h2>Sprints</h2>
					<button class="add-sprint-btn" on:click={openSprintModal}>+ Add Sprint</button>
				</div>
				{#if getProjectSprints(selectedProject.id).length === 0}
					<p class="empty-message">No sprints yet. Create one to organize your work!</p>
				{:else}
					<div class="sprints-list">
						{#each getProjectSprints(selectedProject.id) as sprint}
							<div class="sprint-card">
								<div class="sprint-header">
									<h3>{sprint.name}</h3>
									<span class="sprint-status" class:active={sprint.status === 'active'}>
										{sprint.status}
									</span>
								</div>
								<div class="sprint-dates">
									{formatDate(sprint.startDate)} - {formatDate(sprint.endDate)}
								</div>
								{#if sprint.goals?.length}
									<ul class="sprint-goals">
										{#each sprint.goals as goal}
											<li>{goal}</li>
										{/each}
									</ul>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Project Timeline -->
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
		{:else}
			<div class="no-project-selected">
				<p>Select a project or create a new one</p>
				<button class="create-project-btn" on:click={() => openProjectModal()}>
					Create Project
				</button>
			</div>
		{/if}
	</main>
</div>

<!-- Project Modal -->
{#if showProjectModal}
	<div class="modal-overlay" on:click={closeProjectModal}>
		<div class="modal" on:click|stopPropagation>
			<div class="modal-header">
				<h2>{editingProject ? 'Edit Project' : 'New Project'}</h2>
				<button class="close-btn" on:click={closeProjectModal}>&times;</button>
			</div>
			<form on:submit|preventDefault={handleProjectSubmit}>
				<div class="form-group">
					<label for="projectName">Name *</label>
					<input id="projectName" type="text" bind:value={projectName} required />
				</div>

				<div class="form-group">
					<label for="projectDesc">Description</label>
					<textarea id="projectDesc" bind:value={projectDescription} rows="2"></textarea>
				</div>

				<div class="form-group">
					<label>Color</label>
					<div class="color-picker">
						{#each colorOptions as color}
							<button
								type="button"
								class="color-option"
								class:selected={projectColor === color}
								style="background-color: {color}"
								on:click={() => projectColor = color}
							></button>
						{/each}
					</div>
				</div>

				<div class="form-row">
					<div class="form-group">
						<label for="startDate">Start Date</label>
						<input id="startDate" type="date" bind:value={projectStartDate} />
					</div>
					<div class="form-group">
						<label for="targetDate">Target End Date</label>
						<input id="targetDate" type="date" bind:value={projectTargetDate} />
					</div>
				</div>

				<div class="form-actions">
					<button type="button" class="cancel-btn" on:click={closeProjectModal}>Cancel</button>
					<button type="submit" class="submit-btn">
						{editingProject ? 'Save Changes' : 'Create Project'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<!-- Sprint Modal -->
{#if showSprintModal}
	<div class="modal-overlay" on:click={closeSprintModal}>
		<div class="modal" on:click|stopPropagation>
			<div class="modal-header">
				<h2>New Sprint</h2>
				<button class="close-btn" on:click={closeSprintModal}>&times;</button>
			</div>
			<form on:submit|preventDefault={handleSprintSubmit}>
				<div class="form-group">
					<label for="sprintName">Name *</label>
					<input id="sprintName" type="text" bind:value={sprintName} placeholder="Sprint 1" required />
				</div>

				<div class="form-row">
					<div class="form-group">
						<label for="sprintStart">Start Date *</label>
						<input id="sprintStart" type="date" bind:value={sprintStartDate} required />
					</div>
					<div class="form-group">
						<label for="sprintEnd">End Date *</label>
						<input id="sprintEnd" type="date" bind:value={sprintEndDate} required />
					</div>
				</div>

				<div class="form-group">
					<label for="sprintGoals">Goals (one per line)</label>
					<textarea id="sprintGoals" bind:value={sprintGoals} rows="3" placeholder="Complete user auth&#10;Fix critical bugs&#10;Deploy to staging"></textarea>
				</div>

				<div class="form-actions">
					<button type="button" class="cancel-btn" on:click={closeSprintModal}>Cancel</button>
					<button type="submit" class="submit-btn">Create Sprint</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<style>
	.projects-container {
		display: flex;
		height: 100%;
		gap: 1rem;
	}

	/* Sidebar */
	.projects-sidebar {
		width: 280px;
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		flex-shrink: 0;
	}

	.sidebar-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem;
		border-bottom: 1px solid var(--border-color, #2a2a4a);
	}

	.sidebar-header h2 {
		margin: 0;
		font-size: 1rem;
	}

	.add-project-btn {
		width: 28px;
		height: 28px;
		background: var(--accent, #5865f2);
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 1.2rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.projects-list {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
	}

	.empty-message {
		text-align: center;
		color: var(--text-secondary, #888);
		padding: 2rem 1rem;
		font-size: 0.9rem;
	}

	.project-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.75rem;
		background: transparent;
		border: none;
		border-radius: 8px;
		cursor: pointer;
		text-align: left;
		color: var(--text-primary, #eee);
		transition: background 0.2s;
		margin-bottom: 0.25rem;
	}

	.project-item:hover {
		background: var(--bg-tertiary, #1f2937);
	}

	.project-item.selected {
		background: var(--accent, #5865f2);
	}

	.project-color {
		width: 4px;
		height: 32px;
		border-radius: 2px;
		flex-shrink: 0;
	}

	.project-info {
		flex: 1;
		min-width: 0;
	}

	.project-name {
		display: block;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.project-status {
		font-size: 0.75rem;
		text-transform: capitalize;
	}

	.project-progress-mini {
		width: 40px;
		height: 4px;
		background: var(--bg-tertiary, #1f2937);
		border-radius: 2px;
		overflow: hidden;
	}

	.project-item.selected .project-progress-mini {
		background: rgba(255, 255, 255, 0.3);
	}

	.progress-bar {
		height: 100%;
		background: var(--accent, #5865f2);
		transition: width 0.3s;
	}

	.project-item.selected .progress-bar {
		background: white;
	}

	/* Main Content */
	.project-main {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow-y: auto;
	}

	.project-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 1.5rem;
	}

	.header-info {
		display: flex;
		gap: 1rem;
	}

	.project-color-large {
		width: 8px;
		border-radius: 4px;
	}

	.project-header h1 {
		margin: 0 0 0.25rem 0;
		font-size: 1.5rem;
	}

	.project-description {
		margin: 0;
		color: var(--text-secondary, #888);
		font-size: 0.9rem;
	}

	.header-actions {
		display: flex;
		gap: 0.5rem;
	}

	.edit-btn, .delete-btn {
		padding: 0.5rem 1rem;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.85rem;
	}

	.edit-btn {
		background: var(--bg-secondary, #16213e);
		border: 1px solid var(--border-color, #2a2a4a);
		color: var(--text-primary, #eee);
	}

	.delete-btn {
		background: transparent;
		border: 1px solid #ef4444;
		color: #ef4444;
	}

	.delete-btn:hover {
		background: #ef4444;
		color: white;
	}

	/* Stats Row */
	.stats-row {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 1rem;
		margin-bottom: 1.5rem;
	}

	.stat-card {
		background: var(--bg-secondary, #16213e);
		border-radius: 8px;
		padding: 1rem;
		text-align: center;
	}

	.stat-value {
		display: block;
		font-size: 1.5rem;
		font-weight: 700;
	}

	.stat-label {
		font-size: 0.8rem;
		color: var(--text-secondary, #888);
	}

	/* Progress Section */
	.progress-section {
		background: var(--bg-secondary, #16213e);
		border-radius: 8px;
		padding: 1rem;
		margin-bottom: 1.5rem;
	}

	.progress-header {
		display: flex;
		justify-content: space-between;
		margin-bottom: 0.5rem;
		font-size: 0.9rem;
	}

	.progress-track {
		height: 8px;
		background: var(--bg-tertiary, #1f2937);
		border-radius: 4px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: var(--accent, #5865f2);
		transition: width 0.3s;
	}

	/* Burn Chart */
	.burn-chart-section {
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		padding: 1rem;
		margin-bottom: 1.5rem;
	}

	.section-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}

	.section-header h2 {
		margin: 0;
		font-size: 1rem;
	}

	.chart-container {
		padding: 1rem;
	}

	.chart-legend {
		display: flex;
		justify-content: center;
		gap: 2rem;
		margin-top: 1rem;
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
		color: var(--text-secondary, #888);
	}

	.legend-color {
		width: 16px;
		height: 4px;
		border-radius: 2px;
	}

	.legend-line {
		width: 16px;
		height: 0;
		border-top: 2px dashed var(--text-secondary, #666);
	}

	.no-chart-data {
		text-align: center;
		padding: 2rem;
		color: var(--text-secondary, #888);
	}

	/* Sprints */
	.sprints-section {
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		padding: 1rem;
		margin-bottom: 1.5rem;
	}

	.add-sprint-btn {
		padding: 0.4rem 0.8rem;
		background: var(--accent, #5865f2);
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.sprints-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
		gap: 1rem;
	}

	.sprint-card {
		background: var(--bg-tertiary, #1f2937);
		border-radius: 8px;
		padding: 1rem;
	}

	.sprint-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.5rem;
	}

	.sprint-header h3 {
		margin: 0;
		font-size: 1rem;
	}

	.sprint-status {
		font-size: 0.75rem;
		padding: 0.2rem 0.5rem;
		background: var(--bg-secondary, #16213e);
		border-radius: 4px;
		text-transform: capitalize;
	}

	.sprint-status.active {
		background: rgba(59, 165, 93, 0.2);
		color: #3ba55d;
	}

	.sprint-dates {
		font-size: 0.8rem;
		color: var(--text-secondary, #888);
		margin-bottom: 0.5rem;
	}

	.sprint-goals {
		margin: 0.5rem 0 0 1rem;
		padding: 0;
		font-size: 0.85rem;
		color: var(--text-secondary, #aaa);
	}

	/* Timeline */
	.timeline-section {
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		padding: 1rem;
	}

	.timeline-section h2 {
		margin: 0 0 1rem 0;
		font-size: 1rem;
	}

	.timeline-dates {
		display: flex;
		gap: 2rem;
	}

	.timeline-date {
		display: flex;
		flex-direction: column;
	}

	.date-label {
		font-size: 0.8rem;
		color: var(--text-secondary, #888);
	}

	.date-value {
		font-weight: 500;
	}

	/* No Project Selected */
	.no-project-selected {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		text-align: center;
	}

	.no-project-selected p {
		color: var(--text-secondary, #888);
		margin-bottom: 1rem;
	}

	.create-project-btn {
		padding: 0.75rem 1.5rem;
		background: var(--accent, #5865f2);
		color: white;
		border: none;
		border-radius: 8px;
		font-size: 1rem;
		cursor: pointer;
	}

	/* Modal Styles */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.modal {
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		width: 100%;
		max-width: 450px;
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem;
		border-bottom: 1px solid var(--border-color, #2a2a4a);
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.1rem;
	}

	.close-btn {
		background: transparent;
		border: none;
		color: var(--text-secondary, #888);
		font-size: 1.5rem;
		cursor: pointer;
	}

	form {
		padding: 1rem;
	}

	.form-group {
		margin-bottom: 1rem;
	}

	.form-group label {
		display: block;
		font-size: 0.85rem;
		margin-bottom: 0.35rem;
		color: var(--text-secondary, #aaa);
	}

	.form-group input,
	.form-group textarea {
		width: 100%;
		padding: 0.6rem;
		background: var(--bg-tertiary, #1f2937);
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 6px;
		color: var(--text-primary, #eee);
		font-size: 0.9rem;
	}

	.form-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.color-picker {
		display: flex;
		gap: 0.5rem;
	}

	.color-option {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		border: 2px solid transparent;
		cursor: pointer;
	}

	.color-option.selected {
		border-color: white;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.cancel-btn {
		padding: 0.6rem 1rem;
		background: transparent;
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 6px;
		color: var(--text-secondary, #aaa);
		cursor: pointer;
	}

	.submit-btn {
		padding: 0.6rem 1rem;
		background: var(--accent, #5865f2);
		border: none;
		border-radius: 6px;
		color: white;
		cursor: pointer;
	}

	@media (max-width: 900px) {
		.projects-container {
			flex-direction: column;
		}

		.projects-sidebar {
			width: 100%;
			max-height: 200px;
		}

		.stats-row {
			grid-template-columns: repeat(2, 1fr);
		}
	}
</style>
