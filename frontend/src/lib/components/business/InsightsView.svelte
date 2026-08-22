<script lang="ts">
	import { todos, projects, overdueTodos } from '$lib/business/store';
	import GanttChart from './GanttChart.svelte';
	import PlannerAvatar from './PlannerAvatar.svelte';
	import {
		plannerUserById,
		getPlannerUserName,
		getPlannerUserColor,
		parseAssigneeId
	} from '$lib/business/plannerUsers';
	import { channelNameById, pipableChannels } from '$lib/business/plannerScopes';
	import type { TodoStatus } from '$lib/business/types';

	/**
	 * Insights — read-only aggregation over existing planner data.
	 * No new data entry surfaces here by design (anti-bureaucracy): this tab
	 * answers "how are things doing?" across ALL projects at a glance.
	 */

	const STATUS_META: Array<{ id: TodoStatus; label: string; color: string }> = [
		{ id: 'ideas', label: 'Ideas', color: '#a855f7' },
		{ id: 'todo', label: 'To Do', color: '#64748b' },
		{ id: 'in_progress', label: 'In Progress', color: '#3b82f6' },
		{ id: 'done', label: 'Done', color: '#10b981' }
	];

	$: statusCounts = STATUS_META.map((meta) => ({
		...meta,
		count: $todos.filter((t) => t.status === meta.id).length
	}));
	$: openTasks = $todos.filter((t) => t.status !== 'done' && t.status !== 'archived' && t.status !== 'scrapped');

	// Workload per assignee — open tasks only, sorted heaviest first.
	$: workload = (() => {
		const byUser = new Map<number, { total: number; urgent: number; overdue: number }>();
		for (const t of openTasks) {
			const id = parseAssigneeId(t.assignedTo);
			if (!id) continue;
			const entry = byUser.get(id) || { total: 0, urgent: 0, overdue: 0 };
			entry.total += 1;
			if (t.priority === 'urgent') entry.urgent += 1;
			if (t.dueDate && t.dueDate < Date.now()) entry.overdue += 1;
			byUser.set(id, entry);
		}
		return [...byUser.entries()]
			.map(([id, v]) => ({ id, name: getPlannerUserName($plannerUserById, id), ...v }))
			.sort((a, b) => b.total - a.total)
			.slice(0, 8);
	})();
	$: maxWorkload = Math.max(1, ...workload.map((w) => w.total));

	$: unassignedCount = openTasks.filter((t) => !parseAssigneeId(t.assignedTo)).length;
	$: pipedProjects = $projects.filter((p) => p.channelId);
	// Channel list for name resolution (pipableChannels keeps the socket store subscribed).
	$: channelList = $pipableChannels;
	function channelsNameFor(id: string | undefined): string {
		return id ? channelNameById(channelList, id) : '?';
	}
</script>

<div class="insights-view">
	<div class="insights-grid">
		<!-- Status summary -->
		<section class="insight-card status-card">
			<h3>Task status</h3>
			<div class="status-chips">
				{#each statusCounts as s}
					<span class="status-chip" style="--chip-color: {s.color}">
						<span class="status-dot"></span>
						<span class="status-label">{s.label}</span>
						<strong>{s.count}</strong>
					</span>
				{/each}
			</div>
			{#if $overdueTodos.length > 0}
				<p class="overdue-note"><strong>{$overdueTodos.length}</strong> overdue task{$overdueTodos.length === 1 ? '' : 's'} need attention</p>
			{:else}
				<p class="ok-note">Nothing overdue</p>
			{/if}
		</section>

		<!-- Workload -->
		<section class="insight-card workload-card">
			<h3>Open workload</h3>
			{#if workload.length === 0}
				<p class="empty-line">No assigned open tasks{unassignedCount > 0 ? ` (${unassignedCount} unassigned)` : ''}</p>
			{:else}
				<ul class="workload-list">
					{#each workload as w (w.id)}
						<li class="workload-row">
							<PlannerAvatar
								name={w.name}
								color={getPlannerUserColor($plannerUserById, w.id)}
								size="sm"
							/>
							<span class="workload-name">{w.name}</span>
							<span class="workload-bar-track">
								<span
									class="workload-bar-fill"
									class:has-overdue={w.overdue > 0}
									style="width: {(w.total / maxWorkload) * 100}%"
								></span>
							</span>
							<span class="workload-count" class:pinned={w.overdue > 0}>
								{w.total}{#if w.overdue > 0}<em class="overdue-mark">{w.overdue}!</em>{/if}
							</span>
						</li>
					{/each}
				</ul>
				{#if unassignedCount > 0}
					<p class="muted-line">{unassignedCount} unassigned open task{unassignedCount === 1 ? '' : 's'}</p>
				{/if}
			{/if}
		</section>

		<!-- Piped plans -->
		<section class="insight-card piped-card">
			<h3>Piped plans</h3>
			{#if pipedProjects.length === 0}
				<p class="empty-line">All projects are personal. Edit a project to pipe it to a channel and share its plan.</p>
			{:else}
				<ul class="piped-list">
					{#each pipedProjects as p (p.id)}
						<li class="piped-row">
							<span class="piped-swatch" style="background: {p.color}"></span>
							<span class="piped-name">{p.name}</span>
							<span class="piped-hash">#{channelsNameFor(p.channelId)}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- Cross-project timeline -->
		<section class="insight-card gantt-card">
			<h3>Timeline — all projects</h3>
			<GanttChart selectedProjectId={null} />
		</section>
	</div>
</div>

<style>
	.insights-view {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 16px;
		background: var(--planner-bg, var(--surface-base, #24243e));
	}
	.insights-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(280px, 1fr));
		gap: 14px;
		max-width: 1200px;
		margin: 0 auto;
	}
	@media (max-width: 900px) {
		.insights-grid {
			grid-template-columns: 1fr;
		}
	}
	.insight-card {
		grid-column: span 1;
		padding: 14px 16px;
		border-radius: var(--planner-radius-lg, 12px);
		background: color-mix(in srgb, var(--surface-raised, #302b63) 82%, transparent);
		border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
	}
	.gantt-card {
		grid-column: 1 / -1;
	}
	.insight-card h3 {
		margin: 0 0 10px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-muted, #9999ff);
	}

	/* Status chips */
	.status-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.status-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 11px;
		border-radius: 999px;
		font-size: 12px;
		color: var(--text-heading, #e0e0ff);
		background: color-mix(in srgb, var(--chip-color) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--chip-color) 32%, transparent);
	}
	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--chip-color);
	}
	.overdue-note {
		margin: 10px 0 0;
		font-size: 12px;
		color: var(--color-danger, #ef4444);
	}
	.ok-note,
	.muted-line {
		margin: 10px 0 0;
		font-size: 12px;
		color: var(--text-muted, #9999ff);
	}
	.empty-line {
		margin: 4px 0 0;
		font-size: 13px;
		color: var(--text-muted, #9999ff);
		line-height: 1.5;
	}

	/* Workload rows */
	.workload-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.workload-row {
		display: grid;
		grid-template-columns: auto minmax(80px, 130px) 1fr auto;
		align-items: center;
		gap: 9px;
	}
	.workload-name {
		font-size: 13px;
		color: var(--text-heading, #e0e0ff);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.workload-bar-track {
		height: 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-hover, #302b63) 90%, transparent);
		overflow: hidden;
	}
	.workload-bar-fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--accent-primary-color, #6366f1);
		transition: width 200ms ease;
	}
	.workload-bar-fill.has-overdue {
		background: linear-gradient(90deg, var(--accent-primary-color, #6366f1), var(--color-danger, #ef4444));
	}
	.workload-count {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-secondary, #b3b3ff);
		min-width: 26px;
		text-align: right;
	}
	.overdue-mark {
		font-style: normal;
		color: var(--color-danger, #ef4444);
		margin-left: 3px;
	}

	/* Piped list */
	.piped-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 7px;
	}
	.piped-row {
		display: flex;
		align-items: center;
		gap: 9px;
		font-size: 13px;
	}
	.piped-swatch {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		flex-shrink: 0;
	}
	.piped-name {
		color: var(--text-heading, #e0e0ff);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.piped-hash {
		margin-left: auto;
		font-family: var(--font-mono, monospace);
		font-size: 11px;
		color: var(--text-muted, #9999ff);
	}
</style>
