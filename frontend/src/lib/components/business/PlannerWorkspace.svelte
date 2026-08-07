<script lang="ts">
	import '$lib/components/business/PlannerWorkspace.css';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { reloadFromStorage, todos, calendarEvents, overdueTodos, todaysTodos, upcomingEvents } from '$lib/business/store';

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
	let taskPanelWidth = 340;
	let newMenuOpen = false;
	let addSignal = 0;

	onMount(() => {
		reloadFromStorage();
		const deepLinkView = browser ? sessionStorage.getItem('plannerDeepLinkView') : null;
		if (deepLinkView === 'calendar' || deepLinkView === 'board' || deepLinkView === 'journal' || deepLinkView === 'projects') {
			activeView = deepLinkView;
			sessionStorage.removeItem('plannerDeepLinkView');
		}
		const savedWidth = browser ? Number(localStorage.getItem('plannerTaskPanelWidth')) : 0;
		if (Number.isFinite(savedWidth) && savedWidth >= 260) {
			taskPanelWidth = savedWidth;
		}
	});

	$: todayStart = (() => {
		const d = new Date();
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	})();

	$: weekTasks = $todos.filter((t) => {
		if (!t.dueDate) return false;
		if (t.status === 'done' || t.status === 'archived' || t.status === 'scrapped') return false;
		return t.dueDate >= todayStart && t.dueDate < todayStart + 7 * 24 * 60 * 60 * 1000;
	}).length;

	$: hasStats = $overdueTodos.length > 0 || $todaysTodos.length > 0 || weekTasks > 0 || $upcomingEvents.length > 0;

	function setActiveView(view: ViewKey): void {
		activeView = view;
		newMenuOpen = false;
	}

	function toggleTaskPanel(): void {
		showTaskPanel = !showTaskPanel;
	}

	/** Increments the child-visible signal so the active view opens its "new" modal. */
	function triggerNew(view: ViewKey): void {
		activeView = view;
		newMenuOpen = false;
		addSignal += 1;
	}

	function handleNew(): void {
		triggerNew(activeView);
	}

	// Task panel drag-resize (width kept between sessions)
	let resizingPanel = false;
	function startPanelResize(event: MouseEvent): void {
		event.preventDefault();
		resizingPanel = true;
		const onMove = (ev: MouseEvent) => {
			if (!resizingPanel) return;
			const width = Math.min(Math.max(window.innerWidth - ev.clientX - 32, 260), 460);
			taskPanelWidth = width;
		};
		const onUp = () => {
			resizingPanel = false;
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
			if (browser) localStorage.setItem('plannerTaskPanelWidth', String(taskPanelWidth));
		};
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	}
</script>

<div
	class="planner-surface"
	class:variant-full={variant === 'full'}
	class:variant-compact={variant === 'compact'}
	class:variant-detached={variant === 'detached'}
>
	<!-- Chrome -->
	<header class="planner-header">
		<div class="planner-title">
			<span>Planner</span>
			<span class="planner-locality" title="Planner data is stored on this device only">On this device</span>
		</div>

		<div class="planner-tabs" role="tablist" aria-label="Planner views">
			<button class="planner-tab" class:active={activeView === 'calendar'} role="tab" aria-selected={activeView === 'calendar'} on:click={() => setActiveView('calendar')}>
				Calendar
			</button>
			<button class="planner-tab" class:active={activeView === 'board'} role="tab" aria-selected={activeView === 'board'} on:click={() => setActiveView('board')}>
				Board
			</button>
			<button class="planner-tab" class:active={activeView === 'journal'} role="tab" aria-selected={activeView === 'journal'} on:click={() => setActiveView('journal')}>
				Journal
			</button>
			<button class="planner-tab" class:active={activeView === 'projects'} role="tab" aria-selected={activeView === 'projects'} on:click={() => setActiveView('projects')}>
				Projects
			</button>
		</div>

		<div class="planner-spacer"></div>

		<div class="planner-actions">
			{#if newMenuOpen}
				<button class="planner-new-backdrop" aria-label="Close new menu" on:click={() => (newMenuOpen = false)}></button>
			{/if}
			<div class="planner-new-wrap">
				<div class="planner-new-split" class:open={newMenuOpen}>
					<button
						type="button"
						class="planner-new-btn planner-new-primary"
						on:click={handleNew}
						title="Create for current view"
					>
						<span class="planner-new-icon" aria-hidden="true">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
								<line x1="12" y1="5" x2="12" y2="19"/>
								<line x1="5" y1="12" x2="19" y2="12"/>
							</svg>
						</span>
						<span>New</span>
					</button>
					<button
						type="button"
						class="planner-new-btn planner-new-caret"
						on:click={() => (newMenuOpen = !newMenuOpen)}
						aria-haspopup="menu"
						aria-expanded={newMenuOpen}
						aria-label="Choose what to create"
						title="Choose what to create"
					>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<polyline points="6 9 12 15 18 9"/>
						</svg>
					</button>
				</div>
				{#if newMenuOpen}
					<div class="planner-new-menu" role="menu" aria-label="Create new">
						<button role="menuitem" class:active={activeView === 'calendar'} on:click={() => triggerNew('calendar')}>
							<span class="menu-dot" style="background-color: var(--planner-accent)"></span>
							<span class="menu-label">Add event</span>
							<span class="menu-hint">Calendar</span>
						</button>
						<button role="menuitem" class:active={activeView === 'board'} on:click={() => triggerNew('board')}>
							<span class="menu-dot" style="background-color: var(--planner-accent)"></span>
							<span class="menu-label">Add task</span>
							<span class="menu-hint">Board</span>
						</button>
						<button role="menuitem" class:active={activeView === 'journal'} on:click={() => triggerNew('journal')}>
							<span class="menu-dot" style="background-color: var(--planner-accent)"></span>
							<span class="menu-label">New journal entry</span>
							<span class="menu-hint">Journal</span>
						</button>
						<button role="menuitem" class:active={activeView === 'projects'} on:click={() => triggerNew('projects')}>
							<span class="menu-dot" style="background-color: var(--planner-accent)"></span>
							<span class="menu-label">New project</span>
							<span class="menu-hint">Projects</span>
						</button>
					</div>
				{/if}
			</div>

			<button class="planner-tasks-btn" class:active={showTaskPanel} on:click={toggleTaskPanel} aria-pressed={showTaskPanel} title={showTaskPanel ? 'Hide tasks panel' : 'Show tasks panel'}>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
					<line x1="9" y1="3" x2="9" y2="21"/>
				</svg>
				<span>Tasks</span>
			</button>
		</div>
	</header>

	<!-- Honest stats: only render when something is non-zero -->
	{#if hasStats}
		<div class="planner-stats" aria-label="Planner summary">
			{#if $overdueTodos.length > 0}
				<span class="planner-stat pill-danger"><span class="stat-label">Overdue</span><strong>{$overdueTodos.length}</strong></span>
			{/if}
			{#if $todaysTodos.length > 0}
				<span class="planner-stat pill-warning"><span class="stat-label">Today</span><strong>{$todaysTodos.length}</strong></span>
			{/if}
			{#if weekTasks > 0}
				<span class="planner-stat"><span class="stat-label">This week</span><strong>{weekTasks}</strong></span>
			{/if}
			{#if $upcomingEvents.length > 0}
				<span class="planner-stat"><span class="stat-label">Events</span><strong>{$upcomingEvents.length}</strong></span>
			{/if}
		</div>
	{/if}

	<!-- Body: active view + optional in-surface task split -->
	<div class="planner-body">
		<div class="planner-main">
			{#if activeView === 'calendar'}
				<div class="planner-view active"><Calendar embedded addSignal={addSignal} /></div>
			{:else if activeView === 'board'}
				<div class="planner-view active"><KanbanBoard embedded addSignal={addSignal} /></div>
			{:else if activeView === 'journal'}
				<div class="planner-view active"><DiaryView embedded addSignal={addSignal} /></div>
			{:else if activeView === 'projects'}
				<div class="planner-view active"><ProjectsView embedded addSignal={addSignal} /></div>
			{/if}
		</div>

		{#if showTaskPanel}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions: drag-resize handle (mouse-only, matches main app's panel resizers) -->
			<div
				class="planner-task-resizer"
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize tasks panel"
				on:mousedown={startPanelResize}
				title="Resize tasks panel"
			></div>
			<aside class="planner-task-panel" style:width="{taskPanelWidth}px" aria-label="Tasks panel">
				<TaskPanel onClose={() => (showTaskPanel = false)} />
			</aside>
		{/if}
	</div>
</div>
