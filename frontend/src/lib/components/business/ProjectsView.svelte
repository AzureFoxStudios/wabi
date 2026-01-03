<script lang="ts">
	import { currentUser } from '$lib/socket';
	import {
		projects,
		todos,
		sprints,
		addProject,
		updateProject,
		deleteProject,
		addSprint,
		updateSprint,
		deleteSprint,
		generateBurnChartData,
		projectTree,
		rootProjects
	} from '$lib/business/store';
	import type { Project, Sprint, BurnChartDataPoint } from '$lib/business/types';
	import { onMount } from 'svelte';
	import GanttChart from './GanttChart.svelte';

	let selectedProject: Project | null = null;
	let showProjectModal = false;
	let showSprintModal = false;
	let editingProject: Project | null = null;
	let editingSprint: Sprint | null = null;
	let expandedProjects: Set<string> = new Set();
	let activeTab: 'burndown' | 'gantt' = 'burndown';

	// Restore selected project on mount
	onMount(() => {
		const savedProjectId = localStorage.getItem('businessHubSelectedProject');
		if (savedProjectId) {
			const project = $projects.find(p => p.id === savedProjectId);
			if (project) {
				selectedProject = project;
				return;
			}
		}
		// If no saved project, select the first root project
		if ($rootProjects.length > 0) {
			selectedProject = $rootProjects[0];
		}
	});

	// Save selected project whenever it changes
	$: if (selectedProject) {
		localStorage.setItem('businessHubSelectedProject', selectedProject.id);
	}

	// Project form
	let projectName = '';
	let projectDescription = '';
	let projectColor = '#5865f2';
	let projectStartDate = '';
	let projectTargetDate = '';
	let projectParentId = '';

	// Get sub-projects for a parent
	function getSubProjects(parentId: string): Project[] {
		return $projects.filter(p => p.parentId === parentId);
	}

	// Toggle project expansion
	function toggleExpanded(projectId: string) {
		if (expandedProjects.has(projectId)) {
			expandedProjects.delete(projectId);
		} else {
			expandedProjects.add(projectId);
		}
		expandedProjects = expandedProjects; // Trigger reactivity
	}

	// Check if a project has children
	function hasChildren(projectId: string): boolean {
		return $projects.some(p => p.parentId === projectId);
	}

	// Get the full path of parent names for a project
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

	// Get active or next sprint
	function getActiveOrNextSprint(projectId: string): Sprint | null {
		const projectSprints = getProjectSprints(projectId);
		const now = Date.now();

		// Find active sprint (current date falls within sprint range)
		const activeSprint = projectSprints.find(s => s.startDate <= now && s.endDate >= now);
		if (activeSprint) return activeSprint;

		// Find next upcoming sprint
		const upcomingSprints = projectSprints.filter(s => s.startDate > now).sort((a, b) => a.startDate - b.startDate);
		return upcomingSprints[0] || null;
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
	function openProjectModal(project?: Project, parentId?: string) {
		if (project) {
			editingProject = project;
			projectName = project.name;
			projectDescription = project.description || '';
			projectColor = project.color;
			projectStartDate = project.startDate ? new Date(project.startDate).toISOString().split('T')[0] : '';
			projectTargetDate = project.targetEndDate ? new Date(project.targetEndDate).toISOString().split('T')[0] : '';
			projectParentId = project.parentId || '';
		} else {
			resetProjectForm();
			if (parentId) {
				projectParentId = parentId;
			}
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
		projectParentId = '';
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
			createdBy: $currentUser?.id || 'unknown',
			parentId: projectParentId || undefined
		};

		if (editingProject) {
			updateProject(editingProject.id, projectData);
			if (selectedProject?.id === editingProject.id) {
				selectedProject = { ...selectedProject, ...projectData };
			}
		} else {
			const newProject = addProject(projectData);
			selectedProject = newProject;
			// Auto-expand parent if creating a sub-project
			if (projectParentId) {
				expandedProjects.add(projectParentId);
				expandedProjects = expandedProjects;
			}
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

	function openSprintModal(sprint?: Sprint) {
		if (sprint) {
			editingSprint = sprint;
			sprintName = sprint.name;
			sprintStartDate = new Date(sprint.startDate).toISOString().split('T')[0];
			sprintEndDate = new Date(sprint.endDate).toISOString().split('T')[0];
			sprintGoals = sprint.goals?.join('\n') || '';
		} else {
			editingSprint = null;
			sprintName = '';
			sprintStartDate = '';
			sprintEndDate = '';
			sprintGoals = '';
		}
		showSprintModal = true;
	}

	function closeSprintModal() {
		showSprintModal = false;
		editingSprint = null;
	}

	function handleSprintSubmit() {
		if (!selectedProject || !sprintName.trim() || !sprintStartDate || !sprintEndDate) return;

		const sprintData = {
			name: sprintName.trim(),
			startDate: new Date(sprintStartDate).getTime(),
			endDate: new Date(sprintEndDate).getTime(),
			goals: sprintGoals ? sprintGoals.split('\n').filter(g => g.trim()) : undefined,
			status: editingSprint?.status || 'planned'
		};

		if (editingSprint) {
			updateSprint(editingSprint.id, sprintData);
		} else {
			addSprint({
				projectId: selectedProject.id,
				...sprintData
			});
		}

		closeSprintModal();
	}

	function handleDeleteSprint(sprint: Sprint) {
		if (confirm(`Delete sprint "${sprint.name}"?`)) {
			deleteSprint(sprint.id);
			closeSprintModal();
		}
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
				{#each $rootProjects as project (project.id)}
					{@const children = getSubProjects(project.id)}
					{@const isExpanded = expandedProjects.has(project.id)}
					<div class="project-tree-item">
						<div class="project-row">
							{#if children.length > 0}
								<button class="expand-btn" on:click|stopPropagation={() => toggleExpanded(project.id)}>
									{isExpanded ? '▼' : '▶'}
								</button>
							{:else}
								<span class="expand-placeholder"></span>
							{/if}
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
							<button class="add-sub-btn" on:click|stopPropagation={() => openProjectModal(undefined, project.id)} title="Add sub-project">+</button>
						</div>
						{#if isExpanded && children.length > 0}
							<div class="sub-projects">
								{#each children as subProject (subProject.id)}
									{@const subChildren = getSubProjects(subProject.id)}
									{@const subExpanded = expandedProjects.has(subProject.id)}
									<div class="project-tree-item sub">
										<div class="project-row">
											{#if subChildren.length > 0}
												<button class="expand-btn" on:click|stopPropagation={() => toggleExpanded(subProject.id)}>
													{subExpanded ? '▼' : '▶'}
												</button>
											{:else}
												<span class="expand-placeholder"></span>
											{/if}
											<button
												class="project-item"
												class:selected={selectedProject?.id === subProject.id}
												on:click={() => selectedProject = subProject}
											>
												<div class="project-color" style="background-color: {subProject.color}"></div>
												<div class="project-info">
													<span class="project-name">{subProject.name}</span>
													<span class="project-status" style="color: {getStatusColor(subProject.status)}">
														{subProject.status}
													</span>
												</div>
												<div class="project-progress-mini">
													<div class="progress-bar" style="width: {getProjectProgress(subProject.id)}%"></div>
												</div>
											</button>
											<button class="add-sub-btn" on:click|stopPropagation={() => openProjectModal(undefined, subProject.id)} title="Add sub-project">+</button>
										</div>
										{#if subExpanded && subChildren.length > 0}
											<div class="sub-projects level-2">
												{#each subChildren as subSubProject (subSubProject.id)}
													<div class="project-tree-item sub">
														<div class="project-row">
															<span class="expand-placeholder"></span>
															<button
																class="project-item"
																class:selected={selectedProject?.id === subSubProject.id}
																on:click={() => selectedProject = subSubProject}
															>
																<div class="project-color" style="background-color: {subSubProject.color}"></div>
																<div class="project-info">
																	<span class="project-name">{subSubProject.name}</span>
																	<span class="project-status" style="color: {getStatusColor(subSubProject.status)}">
																		{subSubProject.status}
																	</span>
																</div>
																<div class="project-progress-mini">
																	<div class="progress-bar" style="width: {getProjectProgress(subSubProject.id)}%"></div>
																</div>
															</button>
														</div>
													</div>
												{/each}
											</div>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					</div>
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
						{#if selectedProject.parentId}
							<div class="project-breadcrumb">
								{#each getProjectPath(selectedProject) as parentName, i}
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
					<button class="sub-project-btn" on:click={() => openProjectModal(undefined, selectedProject.id)}>+ Sub-project</button>
					<button class="edit-btn" on:click={() => openProjectModal(selectedProject)}>Edit</button>
					<button class="delete-btn" on:click={() => handleDeleteProject(selectedProject)}>Delete</button>
				</div>
			</header>

			<!-- Active/Next Sprint Indicator -->
			{@const activeSprint = getActiveOrNextSprint(selectedProject.id)}
			{@const hasSprints = getProjectSprints(selectedProject.id).length > 0}
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
					<button class="view-sprints-btn" on:click={() => openSprintModal(activeSprint)}>
						Edit Sprint
					</button>
				</div>

				<!-- Sprint Goals -->
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
					<button class="view-sprints-btn" on:click={() => openSprintModal()}>
						+ New Sprint
					</button>
				</div>
			{:else}
				<div class="sprint-indicator no-sprints">
					<div class="sprint-info">
						<span class="sprint-badge">No Sprints</span>
						<span class="sprint-name">Get started by creating your first sprint</span>
					</div>
					<button class="view-sprints-btn" on:click={() => openSprintModal()}>
						+ Create Sprint
					</button>
				</div>
			{/if}

			<!-- Project Timeline & Stats -->
			<div class="timeline-and-stats">
				<!-- Timeline -->
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

			<!-- Charts (Tabbed) -->
			<div class="charts-section">
				<div class="section-header">
					<h2>Analysis</h2>
					<div class="tab-buttons">
						<button
							class="tab-btn"
							class:active={activeTab === 'burndown'}
							on:click={() => activeTab = 'burndown'}
						>
							Burndown
						</button>
						<button
							class="tab-btn"
							class:active={activeTab === 'gantt'}
							on:click={() => activeTab = 'gantt'}
						>
							Gantt
						</button>
					</div>
				</div>

				{#if activeTab === 'burndown'}
					<div class="tab-content">
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
				{:else if activeTab === 'gantt'}
					<div class="tab-content">
						<GanttChart selectedProjectId={selectedProject.id} />
					</div>
				{/if}
			</div>
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
					<label for="projectParent">Parent Project</label>
					<select id="projectParent" bind:value={projectParentId}>
						<option value="">No parent (root project)</option>
						{#each $projects.filter(p => p.id !== editingProject?.id) as project}
							<option value={project.id}>{project.name}</option>
						{/each}
					</select>
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
				<h2>{editingSprint ? 'Edit Sprint' : 'New Sprint'}</h2>
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
					{#if editingSprint}
						<button type="button" class="delete-btn" on:click={() => handleDeleteSprint(editingSprint)}>Delete</button>
					{/if}
					<div style="flex: 1;"></div>
					<button type="button" class="cancel-btn" on:click={closeSprintModal}>Cancel</button>
					<button type="submit" class="submit-btn">{editingSprint ? 'Save Changes' : 'Create Sprint'}</button>
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
		background: transparent;
		border-radius: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		flex-shrink: 0;
		border: none;
	}

	.sidebar-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 0;
		border-bottom: none;
		margin-bottom: 0.5rem;
	}

	.sidebar-header h2 {
		margin: 0;
		font-size: 0.9rem;
		color: var(--biz-text-secondary, #94a3b8);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.add-project-btn {
		width: 28px;
		height: 28px;
		background: var(--biz-accent, #f59e0b);
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 1.2rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: background 0.2s;
	}

	.add-project-btn:hover {
		background: var(--biz-accent-hover, #d97706);
	}

	.projects-list {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
	}

	.empty-message {
		text-align: center;
		color: var(--biz-text-muted, #64748b);
		padding: 2rem 1rem;
		font-size: 0.9rem;
	}

	/* Tree Structure */
	.project-tree-item {
		margin-bottom: 2px;
	}

	.project-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.expand-btn {
		width: 20px;
		height: 20px;
		background: transparent;
		border: none;
		color: var(--biz-text-muted, #64748b);
		cursor: pointer;
		font-size: 0.6rem;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: color 0.2s;
	}

	.expand-btn:hover {
		color: var(--biz-accent, #f59e0b);
	}

	.expand-placeholder {
		width: 20px;
		flex-shrink: 0;
	}

	.add-sub-btn {
		width: 20px;
		height: 20px;
		background: transparent;
		border: none;
		color: var(--biz-text-muted, #64748b);
		cursor: pointer;
		font-size: 0.9rem;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		opacity: 0;
		transition: all 0.2s;
		border-radius: 4px;
	}

	.project-row:hover .add-sub-btn {
		opacity: 1;
	}

	.add-sub-btn:hover {
		color: var(--biz-accent, #f59e0b);
		background: var(--biz-bg-tertiary, #243044);
	}

	.sub-projects {
		margin-left: 20px;
		border-left: 1px solid rgba(45, 58, 77, 0.6);
		padding-left: 8px;
		margin-top: 0.25rem;
	}

	.sub-projects.level-2 {
		margin-left: 20px;
	}

	.project-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		padding: 0.6rem 0.8rem;
		background: rgba(36, 48, 68, 0.2);
		border: 1px solid transparent;
		border-radius: 6px;
		cursor: pointer;
		text-align: left;
		color: var(--biz-text-primary, #f1f5f9);
		transition: all 0.2s;
	}

	.project-item:hover {
		background: rgba(36, 48, 68, 0.4);
		border-color: rgba(245, 158, 11, 0.2);
	}

	.project-item.selected {
		background: var(--biz-accent, #f59e0b);
		border-color: var(--biz-accent, #f59e0b);
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
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 0.95rem;
	}

	.project-status {
		font-size: 0.7rem;
		text-transform: capitalize;
		opacity: 0.8;
	}

	.project-progress-mini {
		width: 40px;
		height: 4px;
		background: var(--biz-bg-tertiary, #243044);
		border-radius: 2px;
		overflow: hidden;
	}

	.project-item.selected .project-progress-mini {
		background: rgba(255, 255, 255, 0.3);
	}

	.progress-bar {
		height: 100%;
		background: var(--biz-accent, #f59e0b);
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
		color: var(--biz-text-primary, #f1f5f9);
	}

	.project-description {
		margin: 0;
		color: var(--biz-text-secondary, #94a3b8);
		font-size: 0.9rem;
	}

	.header-actions {
		display: flex;
		gap: 0.5rem;
	}

	/* Breadcrumb */
	.project-breadcrumb {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-bottom: 0.25rem;
		font-size: 0.8rem;
	}

	.breadcrumb-item {
		color: var(--biz-text-muted, #64748b);
	}

	.breadcrumb-sep {
		color: var(--biz-text-muted, #64748b);
		opacity: 0.5;
	}

	.edit-btn, .delete-btn, .sub-project-btn {
		padding: 0.5rem 1rem;
		border-radius: 8px;
		cursor: pointer;
		font-size: 0.85rem;
		transition: all 0.2s;
	}

	.sub-project-btn {
		background: var(--biz-bg-secondary, #1a2332);
		border: 1px solid var(--biz-accent, #f59e0b);
		color: var(--biz-accent, #f59e0b);
	}

	.sub-project-btn:hover {
		background: var(--biz-accent, #f59e0b);
		color: white;
	}

	.edit-btn {
		background: var(--biz-bg-secondary, #1a2332);
		border: 1px solid var(--biz-border, #2d3a4d);
		color: var(--biz-text-primary, #f1f5f9);
	}

	.edit-btn:hover {
		background: var(--biz-bg-tertiary, #243044);
	}

	.delete-btn {
		background: transparent;
		border: 1px solid var(--biz-danger, #ef4444);
		color: var(--biz-danger, #ef4444);
		padding: 0.5rem 1rem;
		border-radius: 8px;
		cursor: pointer;
		font-size: 0.85rem;
		transition: all 0.2s;
	}

	.delete-btn:hover {
		background: var(--biz-danger, #ef4444);
		color: white;
	}

	/* Stats Row */
	.stats-row {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 1.5rem;
		flex: 1;
	}

	.stat-card {
		background: transparent;
		border-radius: 0;
		padding: 0;
		text-align: center;
		border: none;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.stat-value {
		display: block;
		font-size: 2rem;
		font-weight: 700;
		color: var(--biz-accent, #f59e0b);
		line-height: 1;
		margin-bottom: 0.5rem;
	}

	.stat-label {
		font-size: 0.85rem;
		color: var(--biz-text-secondary, #94a3b8);
		text-transform: uppercase;
		letter-spacing: 0.5px;
		font-weight: 500;
	}

	.stat-progress {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
	}

	.stat-progress-bar {
		width: 100%;
		height: 6px;
		background: var(--biz-bg-tertiary, #243044);
		border-radius: 3px;
		overflow: hidden;
	}

	.stat-progress-fill {
		height: 100%;
		background: var(--biz-accent, #f59e0b);
		transition: width 0.3s;
		border-radius: 3px;
	}

	/* Burn Chart */
	.burn-chart-section {
		background: transparent;
		border-radius: 0;
		padding: 0;
		margin-bottom: 2rem;
		border: none;
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
		padding-bottom: 1.5rem;
	}

	.section-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1.5rem;
	}

	.section-header h2 {
		margin: 0;
		font-size: 1.1rem;
		color: var(--biz-text-primary, #f1f5f9);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
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
		color: var(--biz-text-secondary, #94a3b8);
	}

	.legend-color {
		width: 16px;
		height: 4px;
		border-radius: 2px;
	}

	.legend-line {
		width: 16px;
		height: 0;
		border-top: 2px dashed var(--biz-text-muted, #64748b);
	}

	.no-chart-data {
		text-align: center;
		padding: 2rem;
		color: var(--biz-text-muted, #64748b);
	}

	/* Sprints */
	.sprints-section {
		background: transparent;
		border-radius: 0;
		padding: 0;
		margin-bottom: 2rem;
		border: none;
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
		padding-bottom: 1.5rem;
	}

	.add-sprint-btn {
		padding: 0.4rem 0.8rem;
		background: var(--biz-accent, #f59e0b);
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 0.85rem;
		cursor: pointer;
		transition: background 0.2s;
	}

	.add-sprint-btn:hover {
		background: var(--biz-accent-hover, #d97706);
	}

	.sprints-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
		gap: 1rem;
	}

	.sprint-card {
		background: transparent;
		border-radius: 0;
		padding: 0.75rem 0;
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.sprint-card:last-child {
		border-bottom: none;
	}

	.sprint-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.25rem;
		flex: 1;
	}

	.sprint-header h3 {
		margin: 0;
		font-size: 0.95rem;
		color: var(--biz-text-primary, #f1f5f9);
		font-weight: 500;
	}

	.sprint-status {
		font-size: 0.7rem;
		padding: 0.2rem 0.5rem;
		background: transparent;
		border-radius: 0;
		text-transform: capitalize;
		color: var(--biz-text-secondary, #94a3b8);
		border: 1px solid var(--biz-border, #2d3a4d);
		font-weight: 500;
	}

	.sprint-status.active {
		background: transparent;
		border-color: var(--biz-success, #10b981);
		color: var(--biz-success, #10b981);
	}

	.sprint-dates {
		font-size: 0.8rem;
		color: var(--biz-text-secondary, #94a3b8);
		margin-bottom: 0.5rem;
	}

	.sprint-goals {
		margin: 0.5rem 0 0 1rem;
		padding: 0;
		font-size: 0.85rem;
		color: var(--biz-text-secondary, #94a3b8);
	}

	/* Timeline & Stats Container */
	.timeline-and-stats {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 3rem;
		margin-bottom: 1.5rem;
		padding: 0.75rem 0;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
	}

	/* Timeline */
	.timeline-section {
		background: transparent;
		border-radius: 0;
		padding: 0;
		border: none;
		flex: 0 0 auto;
	}

	.timeline-section h2 {
		margin: 0 0 0.75rem 0;
		font-size: 0.85rem;
		color: var(--biz-text-secondary, #94a3b8);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
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
		font-size: 0.75rem;
		color: var(--biz-text-muted, #64748b);
		text-transform: uppercase;
	}

	.date-value {
		font-weight: 600;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.95rem;
	}

	/* Sprint Indicator */
	.sprint-indicator {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
		padding: 0.5rem 0;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
		transition: all 0.2s;
	}

	.sprint-indicator.no-sprints {
		flex-direction: row;
		align-items: center;
		gap: 1rem;
	}

	.sprint-indicator.no-sprints .sprint-info {
		flex-direction: row;
		gap: 0.75rem;
		flex: 1;
	}

	.sprint-indicator.no-sprints .sprint-name {
		font-size: 0.9rem;
		font-weight: 400;
		display: none;
	}

	.sprint-info {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex: 1;
	}

	.sprint-badge {
		padding: 0.4rem 0.8rem;
		background: transparent;
		border: 1px solid var(--biz-text-secondary, #94a3b8);
		border-radius: 4px;
		font-size: 0.75rem;
		text-transform: uppercase;
		color: var(--biz-text-secondary, #94a3b8);
		font-weight: 600;
		white-space: nowrap;
	}

	.sprint-badge.active {
		background: var(--biz-success, #10b981);
		border-color: var(--biz-success, #10b981);
		color: white;
	}

	.sprint-name {
		font-size: 1rem;
		font-weight: 600;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.sprint-range {
		font-size: 0.85rem;
		color: var(--biz-text-secondary, #94a3b8);
	}

	.view-sprints-btn {
		padding: 0.5rem 1rem;
		background: var(--biz-accent, #f59e0b);
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 0.85rem;
		cursor: pointer;
		transition: all 0.2s;
		white-space: nowrap;
		opacity: 0;
		pointer-events: none;
	}

	.sprint-indicator:hover .view-sprints-btn {
		opacity: 1;
		pointer-events: auto;
	}

	.view-sprints-btn:hover {
		background: var(--biz-accent-hover, #d97706);
	}

	/* Sprint Goals */
	.sprint-goals-section {
		display: flex;
		gap: 1rem;
		margin-bottom: 1rem;
		padding: 0.75rem 0;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
	}

	.goals-label {
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--biz-text-secondary, #94a3b8);
		font-weight: 600;
		white-space: nowrap;
		margin-top: 0.25rem;
	}

	.goals-list {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.goals-list li {
		padding: 0.3rem 0.6rem;
		background: transparent;
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 4px;
		font-size: 0.85rem;
		color: var(--biz-text-secondary, #94a3b8);
	}

	/* Charts Section (Tabbed) */
	.charts-section {
		background: transparent;
		border-radius: 0;
		padding: 0;
		margin-bottom: 2rem;
		border: none;
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
		padding-bottom: 1.5rem;
	}

	.tab-buttons {
		display: flex;
		gap: 0.5rem;
	}

	.tab-btn {
		padding: 0.5rem 1rem;
		background: transparent;
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 6px;
		color: var(--biz-text-secondary, #94a3b8);
		font-size: 0.85rem;
		cursor: pointer;
		transition: all 0.2s;
		font-weight: 500;
	}

	.tab-btn:hover {
		border-color: var(--biz-accent, #f59e0b);
		color: var(--biz-accent, #f59e0b);
	}

	.tab-btn.active {
		background: var(--biz-accent, #f59e0b);
		border-color: var(--biz-accent, #f59e0b);
		color: white;
	}

	.tab-content {
		margin-top: 1.5rem;
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
		color: var(--biz-text-muted, #64748b);
		margin-bottom: 1rem;
	}

	.create-project-btn {
		padding: 0.75rem 1.5rem;
		background: var(--biz-accent, #f59e0b);
		color: white;
		border: none;
		border-radius: 8px;
		font-size: 1rem;
		cursor: pointer;
		transition: background 0.2s;
	}

	.create-project-btn:hover {
		background: var(--biz-accent-hover, #d97706);
	}

	/* Modal Styles */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.5);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.modal {
		background: rgba(26, 35, 50, 0.8);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		border-radius: 16px;
		width: 100%;
		max-width: 480px;
		border: 1px solid rgba(45, 58, 77, 0.6);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.1);
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1.5rem;
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 600;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.close-btn {
		background: transparent;
		border: none;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--biz-text-secondary, #94a3b8);
		font-size: 1.5rem;
		cursor: pointer;
		transition: all 0.2s;
		border-radius: 6px;
		flex-shrink: 0;
	}

	.close-btn:hover {
		color: var(--biz-text-primary, #f1f5f9);
		background: var(--biz-bg-tertiary, #243044);
	}

	form {
		padding: 1.5rem;
	}

	.form-group {
		margin-bottom: 1.5rem;
	}

	.form-group:last-of-type {
		margin-bottom: 1.5rem;
	}

	.form-group label {
		display: block;
		font-size: 0.8rem;
		margin-bottom: 0.5rem;
		color: var(--biz-text-secondary, #94a3b8);
		text-transform: uppercase;
		letter-spacing: 0.5px;
		font-weight: 600;
	}

	.form-group input,
	.form-group textarea,
	.form-group select {
		width: 100%;
		padding: 0.7rem;
		background: rgba(36, 48, 68, 0.4);
		backdrop-filter: blur(5px);
		-webkit-backdrop-filter: blur(5px);
		border: 1px solid rgba(45, 58, 77, 0.5);
		border-radius: 8px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.9rem;
		font-family: inherit;
		transition: all 0.2s;
	}

	.form-group input:hover,
	.form-group textarea:hover,
	.form-group select:hover {
		border-color: rgba(245, 158, 11, 0.3);
		background: rgba(36, 48, 68, 0.6);
	}

	.form-group input:focus,
	.form-group textarea:focus,
	.form-group select:focus {
		outline: none;
		border-color: var(--biz-accent, #f59e0b);
		background: rgba(36, 48, 68, 0.7);
		box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.15), inset 0 0 8px rgba(245, 158, 11, 0.1);
	}

	.form-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.color-picker {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.75rem;
		padding: 0.5rem;
		background: rgba(36, 48, 68, 0.3);
		backdrop-filter: blur(5px);
		-webkit-backdrop-filter: blur(5px);
		border-radius: 10px;
		border: 1px solid rgba(45, 58, 77, 0.4);
	}

	.color-option {
		width: 100%;
		aspect-ratio: 1;
		border-radius: 10px !important;
		border: 3px solid transparent;
		cursor: pointer;
		transition: all 0.2s;
		padding: 0;
		min-width: unset;
		min-height: unset;
		appearance: none;
		-webkit-appearance: none;
		-moz-appearance: none;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
	}

	.color-option:hover {
		transform: scale(1.08);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
	}

	.color-option.selected {
		border-color: rgba(255, 255, 255, 0.9);
		box-shadow: 0 0 0 2px rgba(36, 48, 68, 0.8), 0 0 20px rgba(255, 255, 255, 0.2);
		transform: scale(1);
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		margin-top: 2rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--biz-border, #2d3a4d);
	}

	.cancel-btn {
		padding: 0.7rem 1.5rem;
		background: transparent;
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 6px;
		color: var(--biz-text-secondary, #94a3b8);
		cursor: pointer;
		transition: all 0.2s;
		font-weight: 500;
		font-size: 0.9rem;
	}

	.cancel-btn:hover {
		background: var(--biz-bg-tertiary, #243044);
		color: var(--biz-text-primary, #f1f5f9);
		border-color: var(--biz-text-secondary, #94a3b8);
	}

	.submit-btn {
		padding: 0.7rem 1.5rem;
		background: var(--biz-accent, #f59e0b);
		border: none;
		border-radius: 6px;
		color: white;
		cursor: pointer;
		transition: all 0.2s;
		font-weight: 600;
		font-size: 0.9rem;
	}

	.submit-btn:hover {
		background: var(--biz-accent-hover, #d97706);
		transform: translateY(-1px);
		box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);
	}

	@media (max-width: 900px) {
		.projects-container {
			flex-direction: column;
		}

		.projects-sidebar {
			width: 100%;
			max-height: 200px;
		}

		.timeline-and-stats {
			flex-direction: column;
			align-items: stretch;
			gap: 1.5rem;
		}

		.stats-row {
			grid-template-columns: repeat(2, 1fr);
		}
	}
</style>
