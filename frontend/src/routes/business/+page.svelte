<script lang="ts">
	import { get } from 'svelte/store';
	import '$lib/business/theme.css';
	import { todos, projects, calendarEvents, diaryEntries, sprints, kanbanColumns, todaysTodos, overdueTodos } from '$lib/business/store';
	import Calendar from '$lib/components/business/Calendar.svelte';
	import DiaryView from '$lib/components/business/DiaryView.svelte';
	import ProjectsView from '$lib/components/business/ProjectsView.svelte';
	import KanbanBoard from '$lib/components/business/KanbanBoard.svelte';
	import TaskPanel from '$lib/components/business/TaskPanel.svelte';

	type MainView = 'calendar' | 'journal' | 'projects' | 'kanban';
	let activeView: MainView = 'calendar';
	let showTaskPanel = true;
	let taskPanelWidth = 380;

	// Quick stats for header
	$: totalTasks = $todos.length;
	$: completedTasks = $todos.filter(t => t.status === 'done').length;
	$: overdueCount = $overdueTodos.length;
	$: todayCount = $todaysTodos.length;
	$: upcomingEvents = $calendarEvents.filter(e => {
		const now = Date.now();
		const weekFromNow = now + 7 * 24 * 60 * 60 * 1000;
		return e.startDate >= now && e.startDate <= weekFromNow;
	}).length;

	function exportData() {
		const data = {
			todos: get(todos),
			calendarEvents: get(calendarEvents),
			diaryEntries: get(diaryEntries),
			projects: get(projects),
			sprints: get(sprints),
			kanbanColumns: get(kanbanColumns)
		};
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `business-hub-export-${new Date().toISOString().split('T')[0]}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<div class="dashboard">
	<!-- Top Header Bar -->
	<header class="dashboard-header">
		<div class="header-left">
			<a href="/" class="back-btn" title="Back to Chat">
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M19 12H5M12 19l-7-7 7-7"/>
				</svg>
			</a>
			<h1>Business Hub</h1>
		</div>

		<nav class="header-nav">
			<button
				class="nav-tab"
				class:active={activeView === 'calendar'}
				on:click={() => activeView = 'calendar'}
			>
				<span class="tab-icon">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
						<line x1="16" y1="2" x2="16" y2="6"/>
						<line x1="8" y1="2" x2="8" y2="6"/>
						<line x1="3" y1="10" x2="21" y2="10"/>
					</svg>
				</span>
				Calendar
			</button>
			<button
				class="nav-tab"
				class:active={activeView === 'journal'}
				on:click={() => activeView = 'journal'}
			>
				<span class="tab-icon">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
						<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
					</svg>
				</span>
				Journal
			</button>
			<button
				class="nav-tab"
				class:active={activeView === 'projects'}
				on:click={() => activeView = 'projects'}
			>
				<span class="tab-icon">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
					</svg>
				</span>
				Projects
			</button>
			<button
				class="nav-tab"
				class:active={activeView === 'kanban'}
				on:click={() => activeView = 'kanban'}
			>
				<span class="tab-icon">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<rect x="3" y="3" width="5" height="18" rx="1"/>
						<rect x="10" y="3" width="5" height="12" rx="1"/>
						<rect x="17" y="3" width="5" height="8" rx="1"/>
					</svg>
				</span>
				Kanban
			</button>
		</nav>

		<div class="header-right">
			<!-- Quick Stats -->
			<div class="quick-stats">
				{#if overdueCount > 0}
					<div class="stat-badge danger" title="Overdue tasks">
						<span class="stat-num">{overdueCount}</span>
						<span class="stat-label">overdue</span>
					</div>
				{/if}
				{#if todayCount > 0}
					<div class="stat-badge warning" title="Due today">
						<span class="stat-num">{todayCount}</span>
						<span class="stat-label">today</span>
					</div>
				{/if}
				<div class="stat-badge" title="Tasks completed">
					<span class="stat-num">{completedTasks}/{totalTasks}</span>
					<span class="stat-label">done</span>
				</div>
			</div>

			<!-- Export Button -->
			<button
				class="panel-toggle"
				on:click={exportData}
				title="Export All Business Data"
			>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
				</svg>
			</button>

			<!-- Task Panel Toggle -->
			<button
				class="panel-toggle"
				class:active={showTaskPanel}
				on:click={() => showTaskPanel = !showTaskPanel}
				title={showTaskPanel ? 'Hide Tasks' : 'Show Tasks'}
			>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M9 11l3 3L22 4"/>
					<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
				</svg>
				Tasks
			</button>
		</div>
	</header>

	<!-- Main Content Area -->
	<div class="dashboard-body">
		<main class="main-content" class:panel-open={showTaskPanel}>
			{#if activeView === 'calendar'}
				<Calendar />
			{:else if activeView === 'journal'}
				<DiaryView />
			{:else if activeView === 'projects'}
				<ProjectsView />
			{:else if activeView === 'kanban'}
				<KanbanBoard />
			{/if}
		</main>

		<!-- Right Task Panel -->
		{#if showTaskPanel}
			<aside class="task-panel" style="width: {taskPanelWidth}px">
				<TaskPanel />
			</aside>
		{/if}
	</div>
</div>

<style>
	.dashboard {
		display: flex;
		flex-direction: column;
		height: 100vh;
		background: var(--biz-bg-primary, #0f1419);
		color: var(--biz-text-primary, #f1f5f9);
	}

	/* Header */
	.dashboard-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 1.5rem;
		height: 60px;
		background: var(--biz-bg-secondary, #1a2332);
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
		flex-shrink: 0;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.back-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		background: var(--biz-bg-tertiary, #243044);
		border-radius: 8px;
		color: var(--biz-text-secondary, #94a3b8);
		text-decoration: none;
		transition: all 0.2s;
	}

	.back-btn:hover {
		background: var(--biz-accent, #f59e0b);
		color: white;
	}

	.dashboard-header h1 {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
		background: var(--biz-gradient-accent, linear-gradient(135deg, #f59e0b 0%, #d97706 100%));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	/* Navigation Tabs */
	.header-nav {
		display: flex;
		gap: 0.5rem;
	}

	.nav-tab {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem 1rem;
		background: transparent;
		border: none;
		border-radius: 8px;
		color: var(--biz-text-secondary, #94a3b8);
		font-size: 0.9rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	.nav-tab:hover {
		background: var(--biz-bg-tertiary, #243044);
		color: var(--biz-text-primary, #f1f5f9);
	}

	.nav-tab.active {
		background: var(--biz-accent-soft, rgba(245, 158, 11, 0.15));
		color: var(--biz-accent, #f59e0b);
	}

	.tab-icon {
		display: flex;
		align-items: center;
	}

	/* Header Right */
	.header-right {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.quick-stats {
		display: flex;
		gap: 0.75rem;
	}

	.stat-badge {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 0.35rem 0.75rem;
		background: var(--biz-bg-tertiary, #243044);
		border-radius: 8px;
		min-width: 50px;
	}

	.stat-badge.danger {
		background: var(--biz-danger-soft, rgba(239, 68, 68, 0.15));
		color: var(--biz-danger, #ef4444);
	}

	.stat-badge.warning {
		background: var(--biz-warning-soft, rgba(245, 158, 11, 0.15));
		color: var(--biz-warning, #f59e0b);
	}

	.stat-num {
		font-size: 0.95rem;
		font-weight: 700;
	}

	.stat-label {
		font-size: 0.65rem;
		text-transform: uppercase;
		opacity: 0.7;
	}

	.panel-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem 1rem;
		background: var(--biz-bg-tertiary, #243044);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-secondary, #94a3b8);
		font-size: 0.9rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.panel-toggle:hover {
		background: var(--biz-bg-hover, #2a3a4d);
		color: var(--biz-text-primary, #f1f5f9);
	}

	.panel-toggle.active {
		background: var(--biz-accent, #f59e0b);
		border-color: var(--biz-accent, #f59e0b);
		color: white;
	}

	/* Body */
	.dashboard-body {
		display: flex;
		flex: 1;
		overflow: hidden;
	}

	.main-content {
		flex: 1;
		overflow-y: auto;
		padding: 1.5rem;
		transition: margin-right 0.3s ease;
	}

	/* Task Panel */
	.task-panel {
		background: var(--biz-bg-secondary, #1a2332);
		border-left: 1px solid var(--biz-border, #2d3a4d);
		overflow-y: auto;
		flex-shrink: 0;
	}

	@media (max-width: 1024px) {
		.quick-stats {
			display: none;
		}

		.task-panel {
			position: fixed;
			right: 0;
			top: 60px;
			bottom: 0;
			z-index: 100;
			box-shadow: var(--biz-shadow-lg);
		}
	}

	@media (max-width: 768px) {
		.dashboard-header {
			padding: 0 1rem;
		}

		.header-nav {
			position: fixed;
			bottom: 0;
			left: 0;
			right: 0;
			background: var(--biz-bg-secondary, #1a2332);
			border-top: 1px solid var(--biz-border, #2d3a4d);
			padding: 0.5rem;
			justify-content: space-around;
			z-index: 100;
		}

		.nav-tab {
			flex-direction: column;
			padding: 0.5rem;
			font-size: 0.75rem;
			gap: 0.25rem;
		}

		.dashboard-body {
			padding-bottom: 70px;
		}
	}
</style>
