<script lang="ts">
	/**
	 * The project at a glance: where the work is (the pipeline), what to pick up next, what needs a person,
	 * and what moved lately. Everything is derived from the shared cards (status, priority, due date, updated time);
	 * nothing here is stored separately, so it is always as true as the board.
	 */
	type MapTask = {
		taskId: string; title: string; status: string; priority: string;
		dueDateMillis: number | null; assigneeUserId: number | null; updatedAtMicros: number; isArchived: boolean;
	};
	let { tasks, nameOf, onOpen, now = Date.now() }: {
		tasks: MapTask[]; nameOf: (id: number | undefined) => string; onOpen: (taskId: string) => void; now?: number;
	} = $props();

	const STAGES = [
		{ id: 'ideas', label: 'Ideas' },
		{ id: 'todo', label: 'To do' },
		{ id: 'in_progress', label: 'In progress' },
		{ id: 'done', label: 'Done' }
	] as const;
	const LABEL: Record<string, string> = { ideas: 'Ideas', todo: 'To do', in_progress: 'In progress', done: 'Done', scrapped: 'Scrapped' };
	const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

	const live = $derived(tasks.filter((task) => !task.isArchived && task.status !== 'scrapped'));
	const counts = $derived(Object.fromEntries(STAGES.map((stage) => [stage.id, live.filter((task) => task.status === stage.id).length])) as Record<string, number>);
	const total = $derived(live.length);
	// "You are here": the furthest stage that still has open work.
	const here = $derived(
		(['in_progress', 'todo', 'ideas'] as const).find((id) => counts[id] > 0) ?? (total ? 'done' : null)
	);

	// The line runs to the stage the work has reached.
	const reached = $derived(Math.max(0, STAGES.findIndex((stage) => stage.id === here)) / (STAGES.length - 1));

	const next = $derived(
		[...live.filter((task) => task.status === 'in_progress' || task.status === 'todo')].sort((a, b) =>
			(a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1)
			|| (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
			|| (a.dueDateMillis ?? Infinity) - (b.dueDateMillis ?? Infinity)
		)[0] ?? null
	);
	const attention = $derived(
		live.filter((task) => task.status !== 'done' && ((task.dueDateMillis != null && task.dueDateMillis < now) || task.priority === 'urgent'))
			.sort((a, b) => (a.dueDateMillis ?? Infinity) - (b.dueDateMillis ?? Infinity)).slice(0, 4)
	);
	const recent = $derived([...live].sort((a, b) => b.updatedAtMicros - a.updatedAtMicros).slice(0, 4));

	function when(micros: number): string {
		const date = new Date(micros / 1000);
		const sameDay = new Date(now).toDateString() === date.toDateString();
		return sameDay ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}
	function due(millis: number): string {
		return new Date(millis).toLocaleDateString([], { month: 'short', day: 'numeric' });
	}
</script>

{#if total > 0}
<section class="project-map" aria-label="Project map">
	<ol class="pipeline" style:--reached={reached}>
		{#each STAGES as stage (stage.id)}
			<li class="stage" class:here={here === stage.id} class:complete={stage.id === 'done' ? counts.done === total : false} aria-current={here === stage.id ? 'step' : undefined}>
				{#if here === stage.id}<span class="you-are-here">You are here</span>{/if}
				<span class="node" aria-hidden="true"></span>
				<span class="stage-label">{stage.label}</span>
				<span class="stage-count">{counts[stage.id]}</span>
			</li>
		{/each}
	</ol>
	<div class="map-cards">
		<div class="map-card">
			<p class="kicker">Next step</p>
			{#if next}
				<button type="button" class="map-link" onclick={() => onOpen(next.taskId)}>{next.title}</button>
				<p class="meta">{LABEL[next.status]}{#if next.assigneeUserId != null} · {nameOf(next.assigneeUserId)}{/if}{#if next.dueDateMillis != null} · due {due(next.dueDateMillis)}{/if}</p>
			{:else}<p class="meta">Nothing queued. Add a card to start.</p>{/if}
		</div>
		<div class="map-card" class:alert={attention.length > 0}>
			<p class="kicker">Needs attention</p>
			{#each attention as task (task.taskId)}
				<button type="button" class="map-row" onclick={() => onOpen(task.taskId)}><span>{task.title}</span><span class="mono">{task.dueDateMillis != null && task.dueDateMillis < now ? `overdue · ${due(task.dueDateMillis)}` : 'urgent'}</span></button>
			{:else}<p class="meta">Nothing overdue or urgent.</p>{/each}
		</div>
		<div class="map-card">
			<p class="kicker">Changed recently</p>
			{#each recent as task (task.taskId)}
				<button type="button" class="map-row" onclick={() => onOpen(task.taskId)}><span>{task.title} <em>→ {LABEL[task.status] ?? task.status}</em></span><span class="mono">{when(task.updatedAtMicros)}</span></button>
			{/each}
		</div>
	</div>
</section>
{/if}

<style>
	.project-map { display: grid; gap: 1.1rem; padding: 1rem clamp(1rem, 3vw, 2.25rem) .25rem; color: var(--w-text); }
	.pipeline { list-style: none; margin: 0; padding: 1.4rem 0 0; display: grid; grid-template-columns: repeat(4, 1fr); position: relative; }
	.pipeline::before { content: ''; position: absolute; left: 12.5%; right: 12.5%; top: calc(1.4rem + 7px); height: 1px; background: var(--w-line-strong); }
	.pipeline::after { content: ''; position: absolute; left: 12.5%; top: calc(1.4rem + 6px); height: 3px; width: calc(75% * var(--reached, 0)); background: var(--w-sig); }
	.stage { position: relative; display: grid; justify-items: center; gap: .15rem; text-align: center; }
	.node { width: 15px; height: 15px; border: 2px solid var(--w-line-strong); border-radius: 50%; background: var(--w-bg); z-index: 1; }
	.stage.here .node { border-color: var(--w-sig); background: var(--w-sig); box-shadow: 0 0 0 4px var(--w-accent-soft); }
	.stage.complete .node { border-color: var(--w-online); background: var(--w-online); }
	.you-are-here { position: absolute; top: -1.35rem; font: 600 .62rem var(--w-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--w-sig); }
	.stage-label { margin-top: .35rem; font: 600 .95rem var(--w-serif); }
	.stage-count { font: 600 .8rem var(--w-mono); color: var(--w-mute); font-variant-numeric: tabular-nums; }
	.map-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 0; border: var(--w-bw, 1px) solid var(--w-line); border-radius: calc(8px * var(--w-rs, 1)); overflow: hidden; }
	.map-card { padding: .8rem 1rem; border-right: var(--w-bw, 1px) solid var(--w-line); display: grid; align-content: start; gap: .3rem; min-width: 0; }
	.map-card:last-child { border-right: 0; }
	.map-card.alert { box-shadow: inset 3px 0 0 var(--w-danger); }
	.kicker { margin: 0; font: 600 .64rem var(--w-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--w-mute); }
	.meta { margin: 0; color: var(--w-mute); font-size: .8rem; }
	.map-link { all: unset; cursor: pointer; font: 600 1.1rem/1.3 var(--w-serif); color: var(--w-text); overflow-wrap: anywhere; }
	.map-link:hover, .map-row:hover > span:first-child { color: var(--w-accent); }
	.map-row { all: unset; cursor: pointer; display: flex; justify-content: space-between; gap: .75rem; padding: .2rem 0; font-size: .85rem; border-bottom: var(--w-bw, 1px) solid var(--w-line); }
	.map-row:last-child { border-bottom: 0; }
	.map-row em { font-style: normal; color: var(--w-mute); }
	.mono { font: 500 .72rem var(--w-mono); color: var(--w-mute); white-space: nowrap; align-self: center; }
	:is(.map-link, .map-row):focus-visible { outline: 2px solid var(--w-accent); outline-offset: 2px; }
	@media (max-width: 640px) { .map-card { border-right: 0; border-bottom: var(--w-bw, 1px) solid var(--w-line); } .map-card:last-child { border-bottom: 0; } }
</style>
