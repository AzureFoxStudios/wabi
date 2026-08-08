<script lang="ts">
	interface Props {
		commits: Array<{
			date: string;
			count: number;
			author_id?: string;
		}>;
	}

	let { commits }: Props = $props();

	let maxCount = $derived(Math.max(...commits.map(c => c.count), 1));

	let heatmap = $derived(() => {
		const weeks: number[][] = [];
		let currentWeek: number[] = [];

		for (let i = 0; i < 365; i++) {
			const commit = commits[i] || { count: 0 };
			currentWeek.push(commit.count);
			if (currentWeek.length === 7 || i === 364) {
				weeks.push(currentWeek);
				currentWeek = [];
			}
		}

		return weeks;
	});

	function intensity(count: number): number {
		if (count === 0) return 0;
		return Math.min(count / maxCount, 1);
	}
</script>

<div class="push-calendar">
	<div class="calendar-header">
		<span class="calendar-title">Contribution Activity</span>
		<span class="calendar-total">{commits.reduce((sum, c) => sum + c.count, 0)} commits</span>
	</div>

	<div class="heatmap-grid">
		{#each heatmap() as week}
			<div class="heatmap-week">
				{#each week as day}
					<div
						class="heatmap-cell"
						style="background: hsl(250, 60%, {5 + intensity(day) * 40}%)"
						title="{day} commits"
					></div>
				{/each}
			</div>
		{/each}
	</div>

	<div class="calendar-legend">
		<span>Less</span>
		<div class="legend-cell legend-0"></div>
		<div class="legend-cell legend-1"></div>
		<div class="legend-cell legend-2"></div>
		<div class="legend-cell legend-3"></div>
		<div class="legend-cell legend-4"></div>
		<span>More</span>
	</div>
</div>

<style>
	.push-calendar {
		padding: var(--space-2);
	}

	.calendar-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: var(--space-2);
	}

	.calendar-title {
		font-weight: 600;
		color: var(--text-heading);
		font-size: var(--font-size-sm);
	}

	.calendar-total {
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.heatmap-grid {
		display: flex;
		gap: 2px;
		overflow-x: auto;
		padding-bottom: var(--space-1);
	}

	.heatmap-week {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.heatmap-cell {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		transition: transform var(--duration-fast);
	}

	.heatmap-cell:hover {
		transform: scale(1.5);
	}

	.calendar-legend {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-1);
		margin-top: var(--space-1);
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.legend-cell {
		width: 10px;
		height: 10px;
		border-radius: 2px;
	}

	.legend-0 { background: hsl(250, 60%, 5%); }
	.legend-1 { background: hsl(250, 60%, 15%); }
	.legend-2 { background: hsl(250, 60%, 25%); }
	.legend-3 { background: hsl(250, 60%, 35%); }
	.legend-4 { background: hsl(250, 60%, 45%); }
</style>