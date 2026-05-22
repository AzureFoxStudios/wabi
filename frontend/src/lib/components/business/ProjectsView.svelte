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

	// Props
	export let isReadOnly = false;

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
	let projectWillSign = false;

	// Sprint form
	let sprintWillSign = false;

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
	let burnRangeSprint: Sprint | null = null;
	$: {
		void $sprints;
		burnRangeSprint = selectedProject ? getActiveOrNextSprint(selectedProject.id) : null;
	}
	$: burnChartData = selectedProject ? generateBurnChartData(
		selectedProject.id,
		burnRangeSprint?.startDate || selectedProject.startDate || selectedProject.createdAt,
		burnRangeSprint?.endDate || selectedProject.targetEndDate || Date.now()
	) : [];
	$: latestBurnPoint = burnChartData.length ? burnChartData[burnChartData.length - 1] : null;

	function formatHours(value: number | undefined): string {
		const hours = value || 0;
		return `${hours.toFixed(1)}h`;
	}

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
			projectWillSign = !!project.signedBy;
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
		projectWillSign = false;
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
			createdBy: $currentUser?.dbUserId ? String($currentUser.dbUserId) : ($currentUser?.id || 'unknown'),
			parentId: projectParentId || undefined,
			signedBy: projectWillSign ? ($currentUser?.username || 'Guest') : undefined,
			visibility: projectWillSign ? ('public' as const) : ('private' as const)
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
			sprintWillSign = !!sprint.signedBy;
		} else {
			editingSprint = null;
			sprintName = '';
			sprintStartDate = '';
			sprintEndDate = '';
			sprintGoals = '';
			sprintWillSign = false;
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
			status: editingSprint?.status || 'planned',
			createdBy: $currentUser?.dbUserId ? String($currentUser.dbUserId) : ($currentUser?.id || 'unknown'),
			signedBy: sprintWillSign ? ($currentUser?.username || 'Guest') : undefined,
			visibility: sprintWillSign ? ('public' as const) : ('private' as const)
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
					<button class="sub-project-btn" on:click={() => openProjectModal(undefined, selectedProject.id)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Add Sub-project'}>+ Sub-project</button>
					<button class="edit-btn" on:click={() => openProjectModal(selectedProject)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Edit'}>Edit</button>
					<button class="delete-btn" on:click={() => handleDeleteProject(selectedProject)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Delete'}>Delete</button>
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
										<span>Remaining Time</span>
									</div>
									<div class="legend-item">
										<span class="legend-color" style="background: #3ba55d"></span>
										<span>Burned Time</span>
									</div>
									<div class="legend-item">
										<span class="legend-line"></span>
										<span>Ideal</span>
									</div>
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
	<div
		class="modal-overlay"
		role="button"
		tabindex="0"
		on:click={closeProjectModal}
		on:keydown={(event) => {
			const tag = (event.target as HTMLElement).tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				closeProjectModal();
			}
		}}
	>
		<div
			class="modal"
			role="button"
			tabindex="0"
			on:click|stopPropagation
			on:keydown|stopPropagation={(event) => {
				const tag = (event.target as HTMLElement).tagName;
				if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
				}
			}}
		>
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
					<span class="form-group-label">Color</span>
					<div class="color-picker">
						{#each colorOptions as color}
							<button
								type="button"
								class="color-option"
								class:selected={projectColor === color}
								style="background-color: {color}"
								aria-label={`Select project color ${color}`}
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

				<!-- Signature checkbox -->
				<div class="form-group checkbox-group">
					<label class="checkbox-label">
						<input type="checkbox" bind:checked={projectWillSign} />
						<span>Sign this project with my username</span>
					</label>
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
	<div
		class="modal-overlay"
		role="button"
		tabindex="0"
		on:click={closeSprintModal}
		on:keydown={(event) => {
			const tag = (event.target as HTMLElement).tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				closeSprintModal();
			}
		}}
	>
		<div
			class="modal"
			role="button"
			tabindex="0"
			on:click|stopPropagation
			on:keydown|stopPropagation={(event) => {
				const tag = (event.target as HTMLElement).tagName;
				if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
				}
			}}
		>
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

				<!-- Signature checkbox -->
				<div class="form-group checkbox-group">
					<label class="checkbox-label">
						<input type="checkbox" bind:checked={sprintWillSign} />
						<span>Sign this sprint with my username</span>
					</label>
				</div>

				<div class="form-actions">
					{#if editingSprint}
						<button type="button" class="delete-btn" on:click={() => handleDeleteSprint(editingSprint)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Delete'}>Delete</button>
					{/if}
					<div style="flex: 1;"></div>
					<button type="button" class="cancel-btn" on:click={closeSprintModal}>Cancel</button>
					<button type="submit" class="submit-btn">{editingSprint ? 'Save Changes' : 'Create Sprint'}</button>
				</div>
			</form>
		</div>
	</div>
{/if}

