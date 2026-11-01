<!--
	A project's overview (design contract §8.6): how far along it is (a contained progress bar and
	the words), the next deadlines and the work in progress as hairline lists (rules, not boxes),
	then the sub-projects as the same lift cards the inventory uses.
-->
<script lang="ts">
	import { projects, todos } from '$lib/business/store';
	import { projectTasks } from '$lib/business/projectHierarchy';
	import { plannerUserById } from '$lib/business/plannerUsers';
	import { dueLabel } from '$lib/business/plannerBoard';
	import { progressWords, projectStatus, projectSummary } from '$lib/business/plannerProjects';
	import type { Project } from '$lib/business/types';

	let { project, onSelectProject = () => {} }: { project: Project; onSelectProject?: (project: Project) => void } = $props();

	const uid = $props.id();
	const tasks = $derived(projectTasks($projects, $todos, project.id));
	const completed = $derived(tasks.filter((task) => task.status === 'done').length);
	const children = $derived($projects.filter((child) => child.parentId === project.id));
	const upcoming = $derived(tasks.filter((task) => task.status !== 'done' && task.dueDate).sort((a, b) => a.dueDate! - b.dueDate!));
	const working = $derived(tasks.filter((task) => task.status === 'in_progress'));
	const ratio = $derived(tasks.length ? completed / tasks.length : 0);

	/** The assignee's name, or nothing: an unassigned row says nothing rather than repeat it. */
	function assignee(id: string | undefined): string {
		if (!id) return '';
		const user = $plannerUserById.get(Number.parseInt(id, 10));
		return user?.username ?? 'Assigned';
	}
</script>

<section class="pj-overview" aria-label="Project overview">
	<div class="pj-summary">
		<p class="pj-summary__words">
			{tasks.length ? `${completed} of ${tasks.length} tasks done` : 'No tasks yet'}
		</p>
		{#if tasks.length}
			<span class="pj-bar pj-bar--wide" role="progressbar" aria-label="Tasks done" aria-valuemin={0} aria-valuemax={tasks.length} aria-valuenow={completed}>
				<span class="pj-bar__fill" style:width={`${Math.round(ratio * 100)}%`}></span>
			</span>
		{/if}
		<p class="pj-summary__note">Counts this project and its sub-projects; archived and parked tasks are left out.</p>
	</div>

	{#if tasks.length}
		<div class="pj-lists">
			<section class="pj-list" aria-labelledby={`${uid}-due`}>
				<h3 class="pj-list__title" id={`${uid}-due`}>Next deadlines</h3>
				{#each upcoming.slice(0, 5) as task (task.id)}
					{@const due = dueLabel(task)}
					<div class="pj-list__row">
						<span class="pj-list__name">{task.title}</span>
						{#if due}<span class="pj-list__fact" class:is-overdue={due.tone === 'overdue'} title={due.title}>{due.text}</span>{/if}
					</div>
				{:else}
					<p class="pj-list__none">No deadlines yet. Add a due date to a task when the timing matters.</p>
				{/each}
			</section>
			<section class="pj-list" aria-labelledby={`${uid}-wip`}>
				<h3 class="pj-list__title" id={`${uid}-wip`}>In progress</h3>
				{#each working.slice(0, 5) as task (task.id)}
					{@const who = assignee(task.assignedTo)}
					<div class="pj-list__row">
						<span class="pj-list__name">{task.title}</span>
						{#if who}<span class="pj-list__fact">{who}</span>{/if}
					</div>
				{:else}
					<p class="pj-list__none">Nothing in progress. Move a task to In progress on the Board when you start it.</p>
				{/each}
			</section>
		</div>
	{/if}

	<section class="pj-children" aria-labelledby={`${uid}-subs`}>
		<h3 class="pj-list__title" id={`${uid}-subs`}>Sub-projects{#if children.length}{' '}<span class="pj-list__count">{children.length}</span>{/if}</h3>
		{#if children.length}
			<ul class="pj-grid pj-grid--sub">
				{#each children as child (child.id)}
					{@const summary = projectSummary($projects, $todos, child.id)}
					{@const status = projectStatus(child.status)}
					<li>
						<article class="pj-card" aria-labelledby={`${uid}-c-${child.id}`}>
							<div class="pj-card__top">
								<span class="pj-dot" style:--project={child.color} aria-hidden="true"></span>
								<h4 class="pj-card__name" id={`${uid}-c-${child.id}`}>
									<button type="button" class="pj-card__hit" onclick={() => onSelectProject(child)}>{child.name}</button>
								</h4>
								{#if !status.quiet}
									<span class="w-tag pj-card__status"><span class="w-dot w-dot--{status.tone}" aria-hidden="true"></span>{status.word}</span>
								{/if}
							</div>
							<p class="pj-card__desc">{child.description || 'No description yet.'}</p>
							<div class="pj-card__meta">
								<span class="pj-progress">
									<span class="pj-bar" aria-hidden="true"><span class="pj-bar__fill" style:width={`${Math.round(summary.ratio * 100)}%`}></span></span>
									<span>{progressWords(summary)}</span>
								</span>
							</div>
						</article>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="pj-list__none">Split a larger goal into smaller projects: a convention, a poster series, one finished piece.</p>
		{/if}
	</section>
</section>
