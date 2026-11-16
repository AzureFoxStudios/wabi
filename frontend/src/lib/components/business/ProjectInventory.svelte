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
	import { _ } from '$lib/i18n';
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
			<h2 class="pj-inventory__title" id={`${uid}-title`}>{$_('project_detail.projects_crumb')}</h2>
			<p class="pj-inventory__lede">{$_('pj.lede')}</p>
		</div>
		{#if searchable}
			<label class="pj-search">
				<span class="visually-hidden">{$_('pj.find')}</span>
				<Icon name="search" size={16} />
				<input class="w-field w-field--chrome" type="search" bind:value={search} placeholder={$_('pj.find')} />
			</label>
		{/if}
	</header>

	{#if results.length === 0}
		{#if search.trim()}
			<EmptyState icon="search" as="h3" title={$_('pj.no_match')} text={$_('pj.no_match_text')} class="pj-empty" />
		{:else}
			<EmptyState
				icon="layers"
				as="h3"
				title={$_('pj.none')}
				text={$_('pj.none_text')}
				action={isReadOnly ? undefined : $_('pj.create_first')}
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
						<p class="pj-card__desc">{project.description || $_('pj.no_desc')}</p>
						<div class="pj-card__meta">
							<span class="pj-progress">
								<span class="pj-bar" aria-hidden="true"><span class="pj-bar__fill" style:width={`${Math.round(summary.ratio * 100)}%`}></span></span>
								<span>{progressWords(summary)}</span>
							</span>
							{#if summary.nextDue?.dueDate}
								<span class:is-overdue={isPastDue(summary.nextDue.dueDate, now)} title={$_('pj.next_due_title', { values: { title: summary.nextDue.title } })}>
									{$_('pj.next_due', { values: { date: dateWords(summary.nextDue.dueDate, now) } })}
								</span>
							{:else if project.targetEndDate}
								<span>{$_('project_detail.target_date', { values: { date: dateWords(project.targetEndDate, now) } })}</span>
							{/if}
							{#if summary.subprojects}
								<span>{$_(summary.subprojects === 1 ? 'pj.sub_one' : 'pj.sub_other', { values: { count: summary.subprojects } })}</span>
							{/if}
						</div>
					</article>
				</li>
			{/each}
		</ul>
	{/if}
</section>
