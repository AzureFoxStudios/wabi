<!--
	My Planner — Projects inventory (design contract §8.6, §4.5). The projects as cards on
	--w-lift in a `repeat(auto-fill, minmax(280px, 1fr))` grid: a colour dot (the project's
	colour is user data: a dot only) and the serif name, two lines of description, a 64×2
	progress bar with "3/10 done", and the next due date. A status word appears only when the
	project is not simply active. The whole card opens the project: a stretched button inside
	an <article>, so the heading and text are never inside a button. The search field shows
	once there are enough projects to look through. "New project" is the masthead's New.
-->
<script lang="ts">
	import { projects, todos } from '$lib/business/store';
	import type { Project } from '$lib/business/types';
	import { dateWords } from '$lib/business/plannerBoard';
	import { SEARCH_FROM, inventoryProjects, isPastDue, progressWords, projectStatus, projectSummary } from '$lib/business/plannerProjects';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';

	let { onSelect, onCreate, isReadOnly = false }: { onSelect: (project: Project) => void; onCreate: () => void; isReadOnly?: boolean } = $props();

	const uid = $props.id();
	let search = $state('');
	const results = $derived(inventoryProjects($projects, search));
	const searchable = $derived($projects.length >= SEARCH_FROM || search.trim() !== '');
	const now = Date.now();
</script>

<section class="pj-inventory" aria-labelledby={`${uid}-title`}>
	<header class="pj-inventory__head">
		<div class="pj-inventory__intro">
			<h2 class="pj-inventory__title" id={`${uid}-title`}>Projects</h2>
			<p class="pj-inventory__lede">Plan a convention, a collection or a larger goal, and keep the smaller pieces together.</p>
		</div>
		{#if searchable}
			<label class="pj-search">
				<span class="visually-hidden">Find a project</span>
				<Icon name="search" size={16} />
				<input class="w-field w-field--chrome" type="search" bind:value={search} placeholder="Find a project" />
			</label>
		{/if}
	</header>

	{#if results.length === 0}
		{#if search.trim()}
			<EmptyState icon="search" as="h3" title="No matching projects" text="Try another name or a word from the description." class="pj-empty" />
		{:else}
			<EmptyState
				icon="layers"
				as="h3"
				title="No projects yet"
				text="Start with a convention, a collection or a goal. Add sub-projects as the plan grows."
				action={isReadOnly ? undefined : 'Create your first project'}
				onaction={onCreate}
				class="pj-empty"
			/>
		{/if}
	{:else}
		<ul class="pj-grid">
			{#each results as project (project.id)}
				{@const summary = projectSummary($projects, $todos, project.id)}
				{@const status = projectStatus(project.status)}
				<li>
					<article class="pj-card" aria-labelledby={`${uid}-${project.id}`}>
						<div class="pj-card__top">
							<span class="pj-dot" style:--project={project.color} aria-hidden="true"></span>
							<h3 class="pj-card__name" id={`${uid}-${project.id}`}>
								<button type="button" class="pj-card__hit" onclick={() => onSelect(project)}>{project.name}</button>
							</h3>
							{#if !status.quiet}
								<span class="w-tag pj-card__status"><span class="w-dot w-dot--{status.tone}" aria-hidden="true"></span>{status.word}</span>
							{/if}
						</div>
						<p class="pj-card__desc">{project.description || 'No description yet.'}</p>
						<div class="pj-card__meta">
							<span class="pj-progress">
								<span class="pj-bar" aria-hidden="true"><span class="pj-bar__fill" style:width={`${Math.round(summary.ratio * 100)}%`}></span></span>
								<span>{progressWords(summary)}</span>
							</span>
							{#if summary.nextDue?.dueDate}
								<span class:is-overdue={isPastDue(summary.nextDue.dueDate, now)} title={`Next due: ${summary.nextDue.title}`}>
									Next due {dateWords(summary.nextDue.dueDate, now)}
								</span>
							{:else if project.targetEndDate}
								<span>Target {dateWords(project.targetEndDate, now)}</span>
							{/if}
							{#if summary.subprojects}
								<span>{summary.subprojects} {summary.subprojects === 1 ? 'sub-project' : 'sub-projects'}</span>
							{/if}
						</div>
					</article>
				</li>
			{/each}
		</ul>
	{/if}
</section>
