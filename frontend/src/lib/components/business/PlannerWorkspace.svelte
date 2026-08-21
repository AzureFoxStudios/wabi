<script lang="ts">
	import '$lib/components/business/PlannerWorkspace.css';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import {
		reloadFromStorage,
		todos,
		overdueTodos,
		todaysTodos,
		upcomingEvents
	} from '$lib/business/store';
	import {
		getBusinessDataSnapshot,
		applyBusinessDataSnapshot
	} from '$lib/business/snapshot';
	import { sanitizeBusinessData } from '$lib/business/validation';
	import { businessSyncAvailable } from '$lib/business/sync';
	import { showToast } from '$lib/toast';

	import Calendar from '$lib/components/business/Calendar.svelte';
	import KanbanBoard from '$lib/components/business/KanbanBoard.svelte';
	import DiaryView from '$lib/components/business/DiaryView.svelte';
	import ProjectsView from '$lib/components/business/ProjectsView.svelte';
	import TaskPanel from '$lib/components/business/TaskPanel.svelte';

	type ViewKey = 'calendar' | 'board' | 'journal' | 'projects';
	type Variant = 'full' | 'compact' | 'detached';
	type TaskPanelFilter = 'all' | 'today' | 'overdue' | 'upcoming';
	/** What a stat pill click should do. */
	type StatAction = TaskPanelFilter | 'calendar';

	export let variant: Variant = 'full';

	const ACTIVE_VIEW_KEY = 'planner.activeView';

	let activeView: ViewKey = 'calendar';
	let showTaskPanel = false;
	let taskPanelFilter: TaskPanelFilter = 'all';
	/** Bump to force the task panel to re-mount with a fresh initial filter. */
	let taskPanelEpoch = 0;
	let taskPanelWidth = 340;
	let newMenuOpen = false;
	let overflowMenuOpen = false;
	let addSignal = 0;
	let importFileInput: HTMLInputElement;

	onMount(() => {
		reloadFromStorage();
		const deepLinkView = browser ? sessionStorage.getItem('plannerDeepLinkView') : null;
		if (
			deepLinkView === 'calendar' ||
			deepLinkView === 'board' ||
			deepLinkView === 'journal' ||
			deepLinkView === 'projects'
		) {
			activeView = deepLinkView;
			sessionStorage.removeItem('plannerDeepLinkView');
		} else if (browser) {
			// Views are device-local by design — restore the last one used here.
			const saved = localStorage.getItem(ACTIVE_VIEW_KEY);
			if (saved === 'calendar' || saved === 'board' || saved === 'journal' || saved === 'projects') {
				activeView = saved;
			}
		}
		const savedWidth = browser ? Number(localStorage.getItem('plannerTaskPanelWidth')) : 0;
		if (Number.isFinite(savedWidth) && savedWidth >= 260) {
			taskPanelWidth = savedWidth;
		}
	});

	function persistActiveView(view: ViewKey): void {
		if (browser) localStorage.setItem(ACTIVE_VIEW_KEY, view);
	}

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

	$: hasStats =
		$overdueTodos.length > 0 || $todaysTodos.length > 0 || weekTasks > 0 || $upcomingEvents.length > 0;

	/** Primary New label follows the active view so the control is never a mystery. */
	$: newPrimaryLabel =
		activeView === 'calendar'
			? 'Event'
			: activeView === 'board'
				? 'Task'
				: activeView === 'journal'
					? 'Entry'
					: 'Project';

	$: newPrimaryTitle =
		activeView === 'calendar'
			? 'Add calendar event'
			: activeView === 'board'
				? 'Add board task'
				: activeView === 'journal'
					? 'New journal entry for today'
					: 'Create project';

	/** Truthful locality line: server sync only when the backend actually has routes. */
	$: localityLabel =
		$businessSyncAvailable === true ? 'Synced to server' : 'On this device';
	$: localityTitle =
		$businessSyncAvailable === true
			? 'Planner data syncs to the server for your account'
			: 'Planner data is stored on this device only. Use Export / Import in the ⋯ menu to move it between devices.';

	function setActiveView(view: ViewKey): void {
		activeView = view;
		newMenuOpen = false;
		persistActiveView(view);
	}

	function toggleTaskPanel(): void {
		showTaskPanel = !showTaskPanel;
	}

	/**
	 * Stats pills are controls, not decoration: Overdue/Today/Week open the
	 * Tasks panel pre-filtered; Events jumps to the Calendar.
	 */
	function openStat(filter: TaskPanelFilter | 'calendar'): void {
		if (filter === 'upcoming' || filter === 'calendar') {
			setActiveView('calendar');
			return;
		}
		taskPanelFilter = filter;
		taskPanelEpoch += 1;
		showTaskPanel = true;
	}

	/** Increments the child-visible signal so the active view opens its "new" modal. */
	function triggerNew(view: ViewKey): void {
		activeView = view;
		newMenuOpen = false;
		persistActiveView(view);
		addSignal += 1;
	}

	function handleNew(): void {
		triggerNew(activeView);
	}

	// ── Import / Export (device-to-device bridge while server sync is absent) ──
	function handleExport(): void {
		overflowMenuOpen = false;
		try {
			const data = {
				...getBusinessDataSnapshot(),
				exportedAt: new Date().toISOString(),
				version: '1.0'
			};
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `wabi-planner-export-${new Date().toISOString().split('T')[0]}.json`;
			a.click();
			URL.revokeObjectURL(url);
			showToast('Planner data exported', 'info');
		} catch (e) {
			console.error('[Planner] Export failed:', e);
			showToast('Export failed', 'error');
		}
	}

	function handleImportFile(event: Event): void {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = (e) => {
			try {
				const data = JSON.parse(e.target?.result as string);
				applyBusinessDataSnapshot(sanitizeBusinessData(data));
				showToast('Planner data imported', 'info');
			} catch (error) {
				console.error('[Planner] Import failed:', error);
				showToast('Import failed — check the file format', 'error');
			}
		};
		reader.readAsText(file);
		input.value = '';
	}

	function handleImportClick(): void {
		overflowMenuOpen = false;
		importFileInput?.click();
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

<svelte:window
	on:keydown={(e) => {
		if (e.key === 'Escape') {
			if (newMenuOpen) newMenuOpen = false;
			if (overflowMenuOpen) overflowMenuOpen = false;
		}
	}}
/>

<div
	class="planner-surface"
	class:variant-full={variant === 'full'}
	class:variant-compact={variant === 'compact'}
	class:variant-detached={variant === 'detached'}
>
	<header class="planner-header">
		<div class="planner-title">
			<span>Planner</span>
			<span class="planner-locality" class:locality-synced={$businessSyncAvailable === true} title={localityTitle}>{localityLabel}</span>
		</div>

		<div class="planner-tabs" role="tablist" aria-label="Planner views">
			<button
				type="button"
				class="planner-tab"
				class:active={activeView === 'calendar'}
				role="tab"
				aria-selected={activeView === 'calendar'}
				on:click={() => setActiveView('calendar')}>Calendar</button
			>
			<button
				type="button"
				class="planner-tab"
				class:active={activeView === 'board'}
				role="tab"
				aria-selected={activeView === 'board'}
				on:click={() => setActiveView('board')}>Board</button
			>
			<button
				type="button"
				class="planner-tab"
				class:active={activeView === 'journal'}
				role="tab"
				aria-selected={activeView === 'journal'}
				on:click={() => setActiveView('journal')}>Journal</button
			>
			<button
				type="button"
				class="planner-tab"
				class:active={activeView === 'projects'}
				role="tab"
				aria-selected={activeView === 'projects'}
				on:click={() => setActiveView('projects')}>Projects</button
			>
		</div>

		<div class="planner-spacer"></div>

		<div class="planner-actions">
			{#if newMenuOpen || overflowMenuOpen}
				<button type="button" class="planner-new-backdrop" aria-label="Close menus" on:click={() => { newMenuOpen = false; overflowMenuOpen = false; }}
				></button>
			{/if}
			<div class="planner-new-wrap">
				<div class="planner-new-split" class:open={newMenuOpen}>
					<button
						type="button"
						class="planner-new-btn planner-new-primary"
						on:click={() => {
							newMenuOpen = false;
							handleNew();
						}}
						title={newPrimaryTitle}
						aria-label={newPrimaryTitle}
					>
						<span class="planner-new-icon" aria-hidden="true">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
								<line x1="12" y1="5" x2="12" y2="19" />
								<line x1="5" y1="12" x2="19" y2="12" />
							</svg>
						</span>
						<span>New {newPrimaryLabel}</span>
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
						<svg
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.4"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<polyline points="6 9 12 15 18 9" />
						</svg>
					</button>
				</div>
				{#if newMenuOpen}
					<div class="planner-new-menu" role="menu" aria-label="Create new">
						<button type="button" role="menuitem" class:active={activeView === 'calendar'} on:click={() => triggerNew('calendar')}>
							<span class="menu-dot menu-dot-calendar" aria-hidden="true"></span>
							<span class="menu-label">Add event</span>
							<span class="menu-hint">Calendar</span>
						</button>
						<button type="button" role="menuitem" class:active={activeView === 'board'} on:click={() => triggerNew('board')}>
							<span class="menu-dot menu-dot-board" aria-hidden="true"></span>
							<span class="menu-label">Add task</span>
							<span class="menu-hint">Board</span>
						</button>
						<button type="button" role="menuitem" class:active={activeView === 'journal'} on:click={() => triggerNew('journal')}>
							<span class="menu-dot menu-dot-journal" aria-hidden="true"></span>
							<span class="menu-label">New journal entry</span>
							<span class="menu-hint">Journal</span>
						</button>
						<button type="button" role="menuitem" class:active={activeView === 'projects'} on:click={() => triggerNew('projects')}>
							<span class="menu-dot menu-dot-projects" aria-hidden="true"></span>
							<span class="menu-label">New project</span>
							<span class="menu-hint">Projects</span>
						</button>
					</div>
				{/if}
			</div>

			<div class="planner-overflow-wrap">
				<button
					type="button"
					class="planner-overflow-btn"
					on:click={() => (overflowMenuOpen = !overflowMenuOpen)}
					aria-haspopup="menu"
					aria-expanded={overflowMenuOpen}
					aria-label="Planner options"
					title="Import / Export / sync status"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<circle cx="5" cy="12" r="1.8" />
						<circle cx="12" cy="12" r="1.8" />
						<circle cx="19" cy="12" r="1.8" />
					</svg>
				</button>
				{#if overflowMenuOpen}
					<div class="planner-overflow-menu" role="menu" aria-label="Planner options">
						<div class="overflow-status" role="note">
							<span class="status-dot" class:synced={$businessSyncAvailable === true}></span>
							<span>{$businessSyncAvailable === true ? 'Server sync available' : 'Stored on this device — export to move data'}</span>
						</div>
						<button type="button" role="menuitem" on:click={handleExport}>
							<span class="menu-label">Export JSON</span>
							<span class="menu-hint">Download all planner data</span>
						</button>
						<button type="button" role="menuitem" on:click={handleImportClick}>
							<span class="menu-label">Import JSON</span>
							<span class="menu-hint">Replace with an exported file</span>
						</button>
					</div>
				{/if}
			</div>

			<button
				type="button"
				class="planner-tasks-btn"
				class:active={showTaskPanel}
				on:click={toggleTaskPanel}
				aria-pressed={showTaskPanel}
				title={showTaskPanel ? 'Hide tasks panel' : 'Show tasks panel'}
			>
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
					<line x1="9" y1="3" x2="9" y2="21" />
				</svg>
				<span>Tasks</span>
			</button>

			<input
				bind:this={importFileInput}
				type="file"
				accept="application/json,.json"
				style="display: none"
				aria-hidden="true"
				tabindex="-1"
				on:change={handleImportFile}
			/>
		</div>
	</header>

	{#if hasStats}
		<div class="planner-stats" aria-label="Planner summary">
			{#if $overdueTodos.length > 0}
				<button type="button" class="planner-stat pill-danger" on:click={() => openStat('overdue')} title="Show overdue tasks">
					<span class="stat-label">Overdue</span><strong>{$overdueTodos.length}</strong>
				</button>
			{/if}
			{#if $todaysTodos.length > 0}
				<button type="button" class="planner-stat pill-warning" on:click={() => openStat('today')} title="Show today's tasks">
					<span class="stat-label">Today</span><strong>{$todaysTodos.length}</strong>
				</button>
			{/if}
			{#if weekTasks > 0}
				<button type="button" class="planner-stat" on:click={() => openStat('upcoming')} title="Show this week's tasks">
					<span class="stat-label">This week</span><strong>{weekTasks}</strong>
				</button>
			{/if}
			{#if $upcomingEvents.length > 0}
				<button type="button" class="planner-stat" on:click={() => openStat('calendar')} title="Go to calendar">
					<span class="stat-label">Events</span><strong>{$upcomingEvents.length}</strong>
				</button>
			{/if}
		</div>
	{/if}

	<div class="planner-body">
		<div class="planner-main">
			{#if activeView === 'calendar'}
				<div class="planner-view active view-calendar">
					<Calendar embedded addSignal={addSignal} />
				</div>
			{:else if activeView === 'board'}
				<div class="planner-view active view-board">
					<KanbanBoard embedded addSignal={addSignal} />
				</div>
			{:else if activeView === 'journal'}
				<div class="planner-view active view-journal">
					<DiaryView embedded addSignal={addSignal} />
				</div>
			{:else if activeView === 'projects'}
				<div class="planner-view active view-projects">
					<ProjectsView embedded addSignal={addSignal} />
				</div>
			{/if}
		</div>

		{#if showTaskPanel}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions: drag-resize handle (mouse-only) -->
			<div
				class="planner-task-resizer"
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize tasks panel"
				on:mousedown={startPanelResize}
				title="Resize tasks panel"
			></div>
			<aside class="planner-task-panel" style:width="{taskPanelWidth}px" aria-label="Tasks panel">
				{#key taskPanelEpoch}
					<TaskPanel onClose={() => (showTaskPanel = false)} initialFilter={taskPanelFilter} />
				{/key}
			</aside>
		{/if}
	</div>
</div>
