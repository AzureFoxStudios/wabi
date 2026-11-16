<script lang="ts">
	import { _ } from '$lib/i18n';
	/**
	 * The project at a glance: where the work is (the pipeline), what to pick up next, what needs a person,
	 * and what moved lately. Everything is derived from the shared cards (status, priority, due date, updated time);
	 * nothing here is stored separately, so it is always as true as the board.
	 */
	type MapTask = {
		taskId: string; title: string; status: string; priority: string;
		dueDateMillis: number | null; assigneeUserId: number | null; updatedAtMicros: number; isArchived: boolean;
		revision?: number; blockedReason?: string | null;
		decision?: { question: string; fallback: string; deadlineMillis: number | null } | null;
	};
	let { tasks, history = [], nameOf, onOpen, now = Date.now() }: {
		tasks: MapTask[]; history?: MapTask[]; nameOf: (id: number | undefined) => string; onOpen: (taskId: string) => void; now?: number;
	} = $props();

	const STAGES = [
		{ id: 'ideas', label: $_('project_map.ideas') },
		{ id: 'todo', label: $_('project_map.to_do') },
		{ id: 'in_progress', label: $_('project_map.in_progress') },
		{ id: 'done', label: $_('project_map.done') }
	] as const;
	const LABEL: Record<string, string> = { ideas: $_('project_map.ideas'), todo: $_('project_map.to_do'), in_progress: $_('project_map.in_progress'), done: $_('project_map.done'), scrapped: $_('project_map.scrapped') };
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
	const calls = $derived(
		live.filter((task) => task.status !== 'done' && task.decision)
			.sort((a, b) => (a.decision!.deadlineMillis ?? Infinity) - (b.decision!.deadlineMillis ?? Infinity)).slice(0, 3)
	);
	const attention = $derived(
		live.filter((task) => task.status !== 'done' && !task.decision && (task.blockedReason || (task.dueDateMillis != null && task.dueDateMillis < now) || task.priority === 'urgent'))
			.sort((a, b) => (a.dueDateMillis ?? Infinity) - (b.dueDateMillis ?? Infinity)).slice(0, 4)
	);
	// What actually changed, read from consecutive saved revisions of each card (not just "last touched").
	type Change = { taskId: string; title: string; text: string; at: number };
	const changes = $derived.by((): Change[] => {
		const byTask = new Map<string, MapTask[]>();
		for (const row of history) byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row]);
		const out: Change[] = [];
		for (const rows of byTask.values()) {
			rows.sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0));
			rows.forEach((row, index) => {
				const prev = rows[index - 1];
				const push = (text: string) => out.push({ taskId: row.taskId, title: row.title, text, at: row.updatedAtMicros });
				if (!prev) { push($_('project_map.added_to', { values: { status: LABEL[row.status] ?? row.status } })); return; }
				if (prev.status !== row.status) push(`${LABEL[prev.status] ?? prev.status} → ${LABEL[row.status] ?? row.status}`);
				if (!prev.blockedReason && row.blockedReason) push($_('project_map.blocked'));
				if (prev.blockedReason && !row.blockedReason) push($_('project_map.unblocked'));
				if (!prev.decision && row.decision) push($_('project_map.needs_decision'));
				if (prev.decision && !row.decision) push($_('project_map.decision_settled'));
				if (prev.assigneeUserId !== row.assigneeUserId && row.assigneeUserId != null) push($_('project_map.picked_up', { values: { name: nameOf(row.assigneeUserId) } }));
			});
		}
		return out.sort((a, b) => b.at - a.at).slice(0, 5);
	});
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
<section class="project-map" aria-label={$_('project_map.aria_label')}>
	<ol class="pipeline" style:--reached={reached}>
		{#each STAGES as stage (stage.id)}
			<li class="stage" class:here={here === stage.id} class:complete={stage.id === 'done' ? counts.done === total : false} aria-current={here === stage.id ? 'step' : undefined}>
				{#if here === stage.id}<span class="you-are-here">{$_('project_map.you_are_here')}</span>{/if}
				<span class="node" aria-hidden="true"></span>
				<span class="stage-label">{stage.label}</span>
				<span class="stage-count">{counts[stage.id]}</span>
			</li>
		{/each}
	</ol>
	<div class="map-cards">
		<div class="map-card">
			<p class="kicker">{$_('project_map.next_step')}</p>
			{#if next}
				<button type="button" class="map-link" onclick={() => onOpen(next.taskId)}>{next.title}</button>
				<p class="meta">{LABEL[next.status]}{#if next.assigneeUserId != null} · {nameOf(next.assigneeUserId)}{/if}{#if next.dueDateMillis != null} · {$_('project_map.due', { values: { date: due(next.dueDateMillis) } })}{/if}</p>
			{:else}<p class="meta">{$_('project_map.nothing_queued')}</p>{/if}
		</div>
		{#if calls.length}
			<div class="map-card call">
				<p class="kicker">{$_('project_map.needs_call')}</p>
				{#each calls as task (task.taskId)}
					<button type="button" class="map-decision" onclick={() => onOpen(task.taskId)}>
						<strong>{task.decision!.question}</strong>
						<span class="meta">{task.title}{#if task.decision!.deadlineMillis != null} · {$_('project_map.answer_by', { values: { date: due(task.decision!.deadlineMillis) } })}{/if}</span>
						{#if task.decision!.fallback}<span class="meta">{$_('project_map.no_reply', { values: { fallback: task.decision!.fallback } })}</span>{/if}
					</button>
				{/each}
			</div>
		{/if}
		<div class="map-card" class:alert={attention.length > 0}>
			<p class="kicker">{$_('project_map.needs_attention')}</p>
			{#each attention as task (task.taskId)}
				<button type="button" class="map-row" onclick={() => onOpen(task.taskId)}><span>{task.title}{#if task.blockedReason} <em>· {task.blockedReason}</em>{/if}</span><span class="mono">{task.blockedReason ? $_('project_map.blocked') : task.dueDateMillis != null && task.dueDateMillis < now ? $_('project_map.overdue', { values: { date: due(task.dueDateMillis) } }) : $_('project_map.urgent')}</span></button>
			{:else}<p class="meta">{$_('project_map.nothing_attention')}</p>{/each}
		</div>
		<div class="map-card">
			<p class="kicker">{$_('project_map.changed_recently')}</p>
			{#if changes.length}
				{#each changes as change, index (change.taskId + change.at + index)}
					<button type="button" class="map-row" onclick={() => onOpen(change.taskId)}><span>{change.title} <em>{change.text}</em></span><span class="mono">{when(change.at)}</span></button>
				{/each}
			{:else}
				{#each recent as task (task.taskId)}
					<button type="button" class="map-row" onclick={() => onOpen(task.taskId)}><span>{task.title} <em>→ {LABEL[task.status] ?? task.status}</em></span><span class="mono">{when(task.updatedAtMicros)}</span></button>
				{/each}
			{/if}
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
	.map-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: .75rem; }
	.map-card { padding: .8rem 1rem; border: var(--w-bw, 1px) solid var(--w-line); border-radius: calc(8px * var(--w-rs, 1)); display: grid; align-content: start; gap: .3rem; min-width: 0; }
	.map-card.call { box-shadow: inset 3px 0 0 var(--w-sig); }
	.map-decision { all: unset; cursor: pointer; display: grid; gap: .15rem; padding: .25rem 0; border-bottom: var(--w-bw, 1px) solid var(--w-line); }
	.map-decision:last-child { border-bottom: 0; }
	.map-decision strong { font: 600 1.05rem/1.3 var(--w-serif); }
	.map-decision:hover strong { color: var(--w-accent); }
	.map-card.alert { box-shadow: inset 3px 0 0 var(--w-danger); }
	.kicker { margin: 0; font: 600 .64rem var(--w-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--w-mute); }
	.meta { margin: 0; color: var(--w-mute); font-size: .8rem; }
	.map-link { all: unset; cursor: pointer; font: 600 1.1rem/1.3 var(--w-serif); color: var(--w-text); overflow-wrap: anywhere; }
	.map-link:hover, .map-row:hover > span:first-child { color: var(--w-accent); }
	.map-row { all: unset; cursor: pointer; display: flex; justify-content: space-between; gap: .75rem; padding: .2rem 0; font-size: .85rem; border-bottom: var(--w-bw, 1px) solid var(--w-line); }
	.map-row:last-child { border-bottom: 0; }
	.map-row em { font-style: normal; color: var(--w-mute); }
	.mono { font: 500 .72rem var(--w-mono); color: var(--w-mute); white-space: nowrap; align-self: center; }
	:is(.map-link, .map-row, .map-decision):focus-visible { outline: 2px solid var(--w-accent); outline-offset: 2px; }
</style>
