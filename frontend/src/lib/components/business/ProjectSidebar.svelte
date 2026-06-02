<script lang="ts">
	import { projects, rootProjects, todos } from '$lib/business/store';
	import type { Project } from '$lib/business/types';

	export let selectedProject: Project | null = null;
	export let expandedProjects: Set<string> = new Set();
	export let onOpenProjectModal: (project?: Project, parentId?: string) => void = () => {};

	function getSubProjects(parentId: string): Project[] {
		return $projects.filter(p => p.parentId === parentId);
	}

	function toggleExpanded(projectId: string) {
		if (expandedProjects.has(projectId)) {
			expandedProjects.delete(projectId);
		} else {
			expandedProjects.add(projectId);
		}
		expandedProjects = expandedProjects;
	}

	function getProjectProgress(projectId: string): number {
		const projectTodos = $todos.filter(t => t.projectId === projectId);
		if (projectTodos.length === 0) return 0;
		const completed = projectTodos.filter(t => t.status === 'done').length;
		return Math.round((completed / projectTodos.length) * 100);
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

<aside class="projects-sidebar">
	<div class="sidebar-header">
		<h2>Projects</h2>
		<button class="add-project-btn" on:click={() => onOpenProjectModal()}>+</button>
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
						<button class="add-sub-btn" on:click|stopPropagation={() => onOpenProjectModal(undefined, project.id)} title="Add sub-project">+</button>
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
										<button class="add-sub-btn" on:click|stopPropagation={() => onOpenProjectModal(undefined, subProject.id)} title="Add sub-project">+</button>
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
