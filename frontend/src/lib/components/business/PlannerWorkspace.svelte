<script lang="ts">
	import '$lib/components/business/PlannerWorkspace.css';
	import { openPlannerSurface } from '$lib/plannerWorkspace';
	import { layoutStore } from '$lib/layoutStore';

	import Calendar from '$lib/components/business/Calendar.svelte';
	import KanbanBoard from '$lib/components/business/KanbanBoard.svelte';
	import DiaryView from '$lib/components/business/DiaryView.svelte';
	import ProjectsView from '$lib/components/business/ProjectsView.svelte';
	import TaskPanel from '$lib/components/business/TaskPanel.svelte';

	type ViewKey = 'calendar' | 'board' | 'journal' | 'projects';
	type Variant = 'full' | 'compact' | 'detached';

	export let variant: Variant = 'full';

	let activeView: ViewKey = 'calendar';
	let showTaskPanel = false;

	function setActiveView(view: ViewKey): void {
		activeView = view;
	}

	function toggleTaskPanel(): void {
		showTaskPanel = !showTaskPanel;
		layoutStore.rightPanelView.set(showTaskPanel ? 'tasks' : 'none');
	}

	function handleNew(): void {
		if (activeView === 'calendar') {
			activeView = 'calendar';
		}
	}
</script>

<div class="planner-surface" class:variant-full={variant === 'full'} class:variant-compact={variant === 'compact'} class:variant-detached={variant === 'detached'}>
	<!-- Header -->
	<div class="planner-header">
		<div class="planner-title">
			<span>Planner</span>
			<span class="planner-badge">LOCAL</span>
		</div>

		<div class="planner-tabs">
			<button class="planner-tab" class:active={activeView === 'calendar'} on:click={() => setActiveView('calendar')}>
				Calendar
			</button>
			<button class="planner-tab" class:active={activeView === 'board'} on:click={() => setActiveView('board')}>
				Board
			</button>
			<button class="planner-tab" class:active={activeView === 'journal'} on:click={() => setActiveView('journal')}>
				Journal
			</button>
			<button class="planner-tab" class:active={activeView === 'projects'} on:click={() => setActiveView('projects')}>
				Projects
			</button>
		</div>

		<div class="planner-spacer" />

		<button class="planner-primary-btn" on:click={handleNew}> New </button>

		<button class="planner-icon-btn" title="Toggle task panel" on:click={toggleTaskPanel}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
				<line x1="9" y1="3" x2="9" y2="21" />
			</svg>
		</button>
	</div>

	<!-- Stats -->
	<div class="planner-stats">
		<div class="planner-stat">Overdue <strong>0</strong></div>
		<div class="planner-stat">Today <strong>0</strong></div>
		<div class="planner-stat">This week <strong>0</strong></div>
		<div class="planner-stat">Upcoming <strong>0</strong></div>
	</div>

	<!-- Body -->
	<div class="planner-body">
		{#if activeView === 'calendar'}
			<div class="planner-view active">
				<Calendar />
			</div>
		{:else if activeView === 'board'}
			<div class="planner-view active">
				<KanbanBoard />
			</div>
		{:else if activeView === 'journal'}
			<div class="planner-view active">
				<DiaryView />
			</div>
		{:else if activeView === 'projects'}
			<div class="planner-view active">
				<ProjectsView />
			</div>
		{/if}
	</div>
</div>
