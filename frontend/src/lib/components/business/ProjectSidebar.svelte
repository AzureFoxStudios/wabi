<script lang="ts">
	/**
	 * The project tree beside a project page (design contract §8.6, §7.11): projects and their
	 * sub-projects (three levels) as 32px rows on the selection grammar (raise fill, sig dot),
	 * chevron disclosures with aria-expanded, the project colour as a dot (user data), and a
	 * quiet "Add sub-project" that shows on hover and focus. No text glyphs (▼ ▶ +).
	 *
	 * Svelte 4 (`export let`) — matches the business tree.
	 */
	import { projects, rootProjects } from '$lib/business/store';
	import type { Project } from '$lib/business/types';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';

	export let selectedProject: Project | null = null;
	export let expandedProjects: Set<string> = new Set();
	export let onOpenProjectModal: (project?: Project, parentId?: string) => void = () => {};

	function getSubProjects(parentId: string, all: Project[]): Project[] {
		return all.filter((p) => p.parentId === parentId);
	}

	function toggleExpanded(projectId: string) {
		if (expandedProjects.has(projectId)) expandedProjects.delete(projectId);
		else expandedProjects.add(projectId);
		expandedProjects = expandedProjects;
	}
</script>

{#snippet row(project: Project, depth: number, children: Project[])}
	{@const open = expandedProjects.has(project.id)}
	<div class="pj-tree__row" class:is-selected={selectedProject?.id === project.id} style:--depth={depth}>
		{#if children.length > 0 && depth < 2}
			<button
				type="button"
				class="pj-tree__toggle"
				aria-expanded={open}
				aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`}
				on:click|stopPropagation={() => toggleExpanded(project.id)}
			>
				<Icon name={open ? 'chevDown' : 'chevRight'} size={14} />
			</button>
		{:else}
			<span class="pj-tree__toggle" aria-hidden="true"></span>
		{/if}
		<button
			type="button"
			class="pj-tree__item"
			aria-current={selectedProject?.id === project.id ? 'page' : undefined}
			on:click={() => (selectedProject = project)}
		>
			<span class="pj-dot" style:--project={project.color} aria-hidden="true"></span>
			<span class="pj-tree__name">{project.name}</span>
		</button>
		{#if depth < 2}
			<Tooltip text={`Add a sub-project to ${project.name}`}>
				<button type="button" class="w-ibtn w-ibtn--sm pj-tree__add" aria-label={`Add a sub-project to ${project.name}`} on:click|stopPropagation={() => onOpenProjectModal(undefined, project.id)}>
					<Icon name="plus" size={14} />
				</button>
			</Tooltip>
		{/if}
	</div>
	{#if open && children.length > 0 && depth < 2}
		<ul class="pj-tree__list">
			{#each children as child (child.id)}
				<li>{@render row(child, depth + 1, getSubProjects(child.id, $projects))}</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<aside class="pj-tree" aria-label="Project tree">
	<div class="pj-tree__head">
		<h3 class="pj-tree__title">All projects</h3>
		<Tooltip text="New project">
			<button type="button" class="w-ibtn w-ibtn--sm" aria-label="New project" on:click={() => onOpenProjectModal()}><Icon name="plus" size={16} /></button>
		</Tooltip>
	</div>
	{#if $projects.length === 0}
		<p class="pj-tree__empty">No projects yet.</p>
	{:else}
		<ul class="pj-tree__list">
			{#each $rootProjects as project (project.id)}
				<li>{@render row(project, 0, getSubProjects(project.id, $projects))}</li>
			{/each}
		</ul>
	{/if}
</aside>
