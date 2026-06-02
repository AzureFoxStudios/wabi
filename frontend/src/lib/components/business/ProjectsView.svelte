<script lang="ts">
	import { currentUser } from '$lib/socket';
	import {
		projects,
		addProject,
		updateProject,
		deleteProject,
		addSprint,
		updateSprint,
		deleteSprint,
		rootProjects
	} from '$lib/business/store';
	import type { Project, Sprint } from '$lib/business/types';
	import { onMount } from 'svelte';
	import ProjectDetail from './ProjectDetail.svelte';
	import ProjectModal from './ProjectModal.svelte';
	import ProjectSidebar from './ProjectSidebar.svelte';
	import SprintModal from './SprintModal.svelte';

	export let isReadOnly = false;

	let selectedProject: Project | null = null;
	let showProjectModal = false;
	let showSprintModal = false;
	let editingProject: Project | null = null;
	let editingSprint: Sprint | null = null;
	let expandedProjects: Set<string> = new Set();

	let projectName = '';
	let projectDescription = '';
	let projectColor = '#5865f2';
	let projectStartDate = '';
	let projectTargetDate = '';
	let projectParentId = '';
	let projectWillSign = false;

	let sprintName = '';
	let sprintStartDate = '';
	let sprintEndDate = '';
	let sprintGoals = '';
	let sprintWillSign = false;

	const colorOptions = [
		'#5865f2', '#3ba55d', '#faa81a', '#ed4245',
		'#9b59b6', '#e91e63', '#00bcd4', '#ff9800'
	];

	onMount(() => {
		const savedProjectId = localStorage.getItem('businessHubSelectedProject');
		if (savedProjectId) {
			const project = $projects.find(p => p.id === savedProjectId);
			if (project) {
				selectedProject = project;
				return;
			}
		}
		if ($rootProjects.length > 0) {
			selectedProject = $rootProjects[0];
		}
	});

	$: if (selectedProject) {
		localStorage.setItem('businessHubSelectedProject', selectedProject.id);
	}

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
</script>

<div class="projects-container">
	<ProjectSidebar
		bind:selectedProject
		bind:expandedProjects
		onOpenProjectModal={openProjectModal}
	/>

	<main class="project-main">
		{#if selectedProject}
			<ProjectDetail
				{selectedProject}
				{isReadOnly}
				onOpenProjectModal={openProjectModal}
				onDeleteProject={handleDeleteProject}
				onOpenSprintModal={openSprintModal}
			/>
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

{#if showProjectModal}
	<ProjectModal
		{editingProject}
		bind:projectName
		bind:projectDescription
		bind:projectColor
		bind:projectStartDate
		bind:projectTargetDate
		bind:projectParentId
		bind:projectWillSign
		{colorOptions}
		onClose={closeProjectModal}
		onSubmit={handleProjectSubmit}
	/>
{/if}

{#if showSprintModal}
	<SprintModal
		{editingSprint}
		bind:sprintName
		bind:sprintStartDate
		bind:sprintEndDate
		bind:sprintGoals
		bind:sprintWillSign
		{isReadOnly}
		onClose={closeSprintModal}
		onSubmit={handleSprintSubmit}
		onDeleteSprint={handleDeleteSprint}
	/>
{/if}
