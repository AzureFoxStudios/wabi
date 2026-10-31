<script lang="ts">
	/**
	 * My Planner (design contract §7.23, §8.6). Two bands only: StageBar row A describes the
	 * Planner (title, one locality tag, the save state, the view segment, split "New task ▾" and
	 * ⋯) and each view brings its own tools row. No save strip, no second title band, no stat
	 * pills: the board's summary filters carry those counts as real filters.
	 *
	 * - Only the center-stage instance describes row A (`variant="full"` while My Planner is the
	 *   active workspace). Without a StageBar (the personal workspace route) the same row renders
	 *   inline as the Planner's own masthead.
	 * - Truth labels (§9.3): "Only you · this device", or "Synced to server" when the backend
	 *   actually syncs; the save state is "Changes not yet saved" / "Saved 09:41" (role=status).
	 * - The New split creates the right item for the active view; its menu offers the other three.
	 *   `requestPlannerNew()` (lib/business/plannerBoard.ts) starts one from elsewhere.
	 */
	import '$lib/components/business/PlannerWorkspace.css';
	import { onDestroy, onMount, tick } from 'svelte';
	import { browser } from '$app/environment';
	import { _ } from '$lib/i18n';
	import { reloadFromStorage } from '$lib/business/store';
	import { getBusinessDataSnapshot, applyBusinessDataSnapshot } from '$lib/business/snapshot';
	import { parsePlannerBackup, mergePlannerBackup } from '$lib/business/backup';
	import { capturePlannerSession, flushBusinessStorage, downloadPlannerData, plannerStorage } from '$lib/business/deviceStorage';
	import { businessSyncAvailable } from '$lib/business/sync';
	import { showToast } from '$lib/toast';
	import { isMobile } from '$lib/layoutStoreStates';
	import { activeWorkspaceView } from '$lib/workspaceNavigationState';
	import { setStageHeader, clearStageHeader, type StageHeaderAction } from '$lib/stageHeader';
	import { plannerNewRequest, plannerViewFrom, takePlannerNewRequest, type PlannerView } from '$lib/business/plannerBoard';
	import { tasksPanelShown, togglePlannerTasksPanel } from '$lib/business/plannerTasksPanel';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';

	import Calendar from '$lib/components/business/Calendar.svelte';
	import KanbanBoardImpl from '$lib/components/business/KanbanBoardImpl.svelte';
	import DiaryView from '$lib/components/business/DiaryView.svelte';
	import ProjectsView from '$lib/components/business/ProjectsView.svelte';
	import PlannerStageHeader from '$lib/components/business/PlannerStageHeader.svelte';

	type Variant = 'full' | 'compact' | 'detached';

	export let variant: Variant = 'full';

	const ACTIVE_VIEW_KEY = 'planner.activeView';
	const HEADER_OWNER = 'planner';
	const PANEL_ID = 'planner-view-panel';

	const VIEWS: { value: PlannerView; label: string }[] = [
		{ value: 'calendar', label: 'Calendar' },
		{ value: 'board', label: 'Board' },
		{ value: 'journal', label: 'Journal' },
		{ value: 'projects', label: 'Projects' }
	];

	/** What New makes in each view: the visible words and the tooltip. */
	const NEW_WORDS: Record<PlannerView, { label: string; hint: string }> = {
		calendar: { label: 'New event', hint: 'Add a calendar event' },
		board: { label: 'New task', hint: 'Add a task to the board' },
		journal: { label: 'New entry', hint: "Write today's journal entry" },
		projects: { label: 'New project', hint: 'Create a project' }
	};

	let activeView: PlannerView = 'calendar';
	let addSignal = 0;
	let importFileInput: HTMLInputElement;
	let moreAnchor: HTMLElement | null = null;
	let moreOpen = false;
	let mounted = false;

	onMount(() => {
		reloadFromStorage();
		let deepLink: string | null = null;
		let saved: string | null = null;
		try {
			deepLink = browser ? sessionStorage.getItem('plannerDeepLinkView') : null;
			if (deepLink) sessionStorage.removeItem('plannerDeepLinkView');
			// Views are device-local by design: restore the last one used here.
			saved = browser ? localStorage.getItem(ACTIVE_VIEW_KEY) : null;
		} catch {
			// Storage blocked: the Planner opens on Calendar.
		}
		activeView = plannerViewFrom(deepLink) ?? plannerViewFrom(saved) ?? 'calendar';
		mounted = true;
		// A New request from elsewhere (the palette) waits until the Planner is here to take it.
		const stopRequests = plannerNewRequest.subscribe((request) => {
			if (!request) return;
			const taken = takePlannerNewRequest(request.seq);
			if (taken) triggerNew(taken.view);
		});
		return stopRequests;
	});

	onDestroy(() => clearStageHeader(HEADER_OWNER));

	function persistActiveView(view: PlannerView): void {
		try {
			if (browser) localStorage.setItem(ACTIVE_VIEW_KEY, view);
		} catch {
			// Storage blocked: the view still switches for this visit.
		}
	}

	function setActiveView(view: PlannerView): void {
		// A create request belongs to its current view, never to a later tab visit.
		if (activeView !== view) addSignal = 0;
		activeView = view;
		persistActiveView(view);
		// On the phone the view switch lives in two places (the strip under the bar for Calendar,
		// Journal and Projects; the board's tools-row menu for Board), so the control that was just
		// used can unmount with its own action. Focus then moves to the new view's control instead
		// of falling to <body>; elsewhere the control stays and keeps focus.
		void tick().then(() => {
			const active = document.activeElement;
			if (!active || active === document.body || !active.isConnected) focusViewControl(view);
		});
	}

	/**
	 * Focus the control that names `view`: its tab, or where the tabs are folded (a narrow stage:
	 * the view menu; the phone board: the view menu in its tools row) that menu, else the view
	 * panel itself, never a hidden element.
	 */
	function focusViewControl(view: PlannerView): void {
		const shown = (element: HTMLElement | null): element is HTMLElement => Boolean(element && element.getClientRects().length > 0);
		const candidates = [
			document.getElementById(`${PANEL_ID}-tab-${view}`),
			...document.querySelectorAll<HTMLElement>('.psh-viewmenu'),
			document.getElementById(PANEL_ID)
		];
		candidates.find(shown)?.focus();
	}

	/** Increments the child-visible signal so the active view opens its "new" form. */
	function triggerNew(view: PlannerView): void {
		if (activeView !== view) addSignal = 0;
		activeView = view;
		persistActiveView(view);
		addSignal += 1;
	}

	// ── Save state and locality (row A) ──
	let savedAt: number | null = null;
	let wasDirty = false;
	$: {
		const { dirty, error } = $plannerStorage;
		if (wasDirty && !dirty && !error) savedAt = Date.now();
		wasDirty = dirty;
	}
	function clock(at: number): string {
		return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(at));
	}
	$: saveStatus = $plannerStorage.dirty
		? 'Changes not yet saved'
		: savedAt
			? $_('locality.saved_at', { values: { time: clock(savedAt) } })
			: 'Saved';
	$: synced = $businessSyncAvailable === true;
	$: localityLabel = synced ? $_('locality.synced') : $_('locality.only_you_device');
	$: localityTitle = synced
		? 'Your Planner syncs to the server for your account.'
		: 'Your Planner is stored on this device only. Use Export or Import in Planner options to move it to another device.';

	// ── New ▾ ──
	$: newItems = [
		{ id: 'new-event', label: 'Add event', icon: 'calendar', onSelect: () => triggerNew('calendar') },
		{ id: 'new-task', label: 'Add task', icon: 'columns', onSelect: () => triggerNew('board') },
		{ id: 'new-entry', label: 'New journal entry', icon: 'pencil', onSelect: () => triggerNew('journal') },
		{ id: 'new-project', label: 'New project', icon: 'layers', onSelect: () => triggerNew('projects') }
	] satisfies MenuEntry[];

	$: headerProps = {
		title: $_('places.my_planner'),
		scope: localityLabel,
		scopeTitle: localityTitle,
		status: saveStatus,
		views: VIEWS,
		activeView,
		panelId: PANEL_ID,
		onSelectView: setActiveView,
		newLabel: NEW_WORDS[activeView].label,
		newHint: NEW_WORDS[activeView].hint,
		onNew: () => triggerNew(activeView),
		newItems
	};

	// ── ⋯ Planner options ──
	$: moreItems = [
		{ id: 'export', label: 'Export JSON', icon: 'download', hint: 'Download all Planner data', onSelect: handleExport },
		{ id: 'import', label: 'Import JSON…', icon: 'upload', hint: 'Adds items and keeps what you have', onSelect: handleImportClick },
		{ id: 'sep-tasks', type: 'separator', label: '' },
		{
			id: 'tasks-panel',
			label: 'Tasks panel',
			icon: 'sidebarRight',
			role: 'menuitemcheckbox',
			// The Tasks companion on the rail (§7.21), not a private split inside the Planner.
			checked: $tasksPanelShown,
			onSelect: () => togglePlannerTasksPanel()
		}
	] satisfies MenuEntry[];

	const moreAction: StageHeaderAction = {
		id: 'more',
		label: 'Planner options',
		icon: 'more',
		iconOnly: true,
		onSelect: (anchor) => {
			moreAnchor = anchor;
			moreOpen = !moreOpen;
		}
	};
	const headerActions: readonly StageHeaderAction[] = [moreAction];

	// Only the center-stage instance describes row A; it is cleared on destroy (stageHeader.ts).
	$: onStage = variant === 'full' && $activeWorkspaceView === 'planner';
	// The phone board: no strip under the bar, its tools row carries the view menu and New (§8.12).
	$: phoneBoard = onStage && $isMobile && activeView === 'board';
	$: if (mounted && onStage) {
		setStageHeader(HEADER_OWNER, {
			view: 'planner',
			title: $_('places.my_planner'),
			component: PlannerStageHeader,
			props: headerProps,
			actions: headerActions
		});
	}

	// ── Import / Export (device-to-device bridge while server sync is absent) ──
	function handleExport(): void {
		try {
			const captured = capturePlannerSession();
			downloadPlannerData({ ...getBusinessDataSnapshot(), exportedAt: new Date().toISOString(), version: '1.0', sourceScope: captured.session.scope });
		} catch (error) {
			console.error('Planner export failed', error);
			showToast('Could not export your Planner. Your data is unchanged.', 'error');
		}
	}

	/** Plain-sentence import failures (§7.16); the cause itself goes to the console. */
	class ImportProblem extends Error {}

	async function handleImportFile(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		try {
			const captured = capturePlannerSession();
			if (file.size > 20 * 1024 * 1024) throw new ImportProblem('That file is larger than 20 MB, the most an import can take. Nothing was added.');
			let incoming;
			try {
				incoming = parsePlannerBackup(await file.text(), captured.session.scope);
			} catch (error) {
				console.error('Planner import could not read the file', error);
				throw new ImportProblem('That file is not a Planner export Wabi can read. Nothing was added.');
			}
			if (!captured.isCurrent()) throw new ImportProblem('Your Planner account changed. Choose the file again.');
			const result = mergePlannerBackup(getBusinessDataSnapshot(), incoming);
			applyBusinessDataSnapshot(result.data);
			const saved = await flushBusinessStorage();
			if (!captured.isCurrent()) return;
			showToast(
				saved
					? `Added ${result.added} items; kept ${result.skipped} existing items.`
					: 'The import is in your draft but could not be saved. Export the draft or retry saving.',
				saved ? 'info' : 'error'
			);
		} catch (error) {
			if (error instanceof ImportProblem) {
				showToast(error.message, 'error');
				return;
			}
			console.error('Planner import failed', error);
			showToast('Could not import that file. Your Planner is unchanged.', 'error');
		}
	}

	function handleImportClick(): void {
		importFileInput?.click();
	}

	/** The board's "1 event" summary opens the Calendar and moves focus to its control. */
	function openCalendar(): void {
		setActiveView('calendar');
		void tick().then(() => focusViewControl('calendar'));
	}
</script>

<div
	class="planner planner-surface"
	class:planner--inline={!onStage}
	class:variant-full={variant === 'full'}
	class:variant-compact={variant === 'compact'}
	class:variant-detached={variant === 'detached'}
>
	{#if !onStage}
		<!-- No StageBar here (the personal workspace route): the Planner draws its own masthead. -->
		<header class="planner-masthead">
			<PlannerStageHeader part="inline" {...headerProps} />
			<Menu items={moreItems} label="Planner options" triggerLabel="Planner options" class="w-ibtn" align="end" heading={$_('places.my_planner')} subheading={localityTitle}>
				<Icon name="more" />
			</Menu>
		</header>
	{:else if !phoneBoard && $isMobile}
		<!-- The phone bar keeps only the title; the views and New sit in one row under it. The
		     board has no strip: its one tools row carries the view menu and New (§8.12). -->
		<div class="planner-phone-strip">
			<PlannerStageHeader part="tabs" {...headerProps} />
		</div>
	{/if}

	<div class="planner-body">
		<!-- The phone board has no tab strip (its tools row carries the view menu): the panel is
		     then named by its view instead of by a tab that is not there. -->
		<div
			class="planner-main"
			id={PANEL_ID}
			role="tabpanel"
			aria-labelledby={phoneBoard ? undefined : `${PANEL_ID}-tab-${activeView}`}
			aria-label={phoneBoard ? VIEWS.find((view) => view.value === activeView)?.label : undefined}
			tabindex="-1"
		>
			{#if activeView === 'calendar'}
				<div class="planner-view active view-calendar">
					<Calendar embedded {addSignal} />
				</div>
			{:else if activeView === 'board'}
				<div class="planner-view active view-board">
					<KanbanBoardImpl embedded {addSignal} onOpenCalendar={openCalendar}>
						<svelte:fragment slot="lead">
							{#if onStage && $isMobile}<PlannerStageHeader part="views" {...headerProps} />{/if}
						</svelte:fragment>
						<svelte:fragment slot="trail">
							{#if onStage && $isMobile}<PlannerStageHeader part="new" {...headerProps} />{/if}
						</svelte:fragment>
					</KanbanBoardImpl>
				</div>
			{:else if activeView === 'journal'}
				<div class="planner-view active view-journal">
					<DiaryView embedded {addSignal} />
				</div>
			{:else if activeView === 'projects'}
				<div class="planner-view active view-projects">
					<ProjectsView embedded {addSignal} />
				</div>
			{/if}
		</div>
	</div>

	<input
		bind:this={importFileInput}
		type="file"
		accept="application/json,.json"
		class="planner-import-input"
		aria-hidden="true"
		tabindex="-1"
		on:change={handleImportFile}
	/>
</div>

<!-- Anchored to the masthead ⋯ only: without an anchor Menu would draw its own unnamed trigger. The
     phone bar shows the tag only as its dot and no save state, so there ⋯ says both in words (§7.23:
     the words stay available). -->
{#if onStage && moreAnchor}
	<Menu items={moreItems} label="Planner options" anchor={moreAnchor} bind:open={moreOpen} align="end" heading={$_('places.my_planner')} subheading={$isMobile ? `${localityLabel}. ${localityTitle} ${saveStatus}.` : localityTitle} />
{/if}
