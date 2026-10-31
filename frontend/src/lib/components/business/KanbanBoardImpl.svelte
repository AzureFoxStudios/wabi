<script lang="ts">
	/**
	 * My Planner board (design contract §7.27, §8.6).
	 *
	 * - Tools row (52px, no band): kit selects Project / Priority / Assignee with the applied
	 *   state, then the mono summary ("10 tasks · 4 due this week · 1 overdue · 1 event"), each a
	 *   real filter shown only when non-zero, and a quiet "Columns" menu at the end.
	 * - Lanes hug their cards and scroll inside the board, with an alpha-mask fade at the edge
	 *   that has more to show. Drag-to-scroll on the board's empty space and wheel panning stay.
	 * - Cards and their keyboard moves live in KanbanBoardColumns; the dialog is KanbanTaskModal.
	 */
	import { onMount, tick } from 'svelte';
	import { plannerActor as currentUser } from '$lib/business/personalWorkspace';
	import { plannerUserById, ensurePlannerDirectory } from '$lib/business/plannerUsers';
	import {
		todos,
		projects,
		visibleKanbanColumns,
		kanbanColumns,
		updateTodo,
		addTodo,
		deleteTodo,
		toggleColumnVisibility,
		upcomingEvents,
		type Todo
	} from '$lib/business';
	import type { TodoStatus, KanbanColumn } from '$lib/business/types';
	import {
		NO_FILTERS,
		boardSummary,
		completedAtFor,
		dateInputValue,
		dueDateForSave,
		laneLabel,
		plural,
		spansSeveralProjects,
		tasksByLane,
		type BoardFilters,
		type SummaryFilter
	} from '$lib/business/plannerBoard';
	import { confirmAction } from '$lib/confirm';
	import { _ } from '$lib/i18n';
	import Select, { type SelectOption } from '$lib/components/ui/Select.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import KanbanBoardColumns from './KanbanBoardColumns.svelte';
	import KanbanColumnManagement from './KanbanColumnManagement.svelte';
	import KanbanTaskModal, { type TaskField } from './KanbanTaskModal.svelte';

	interface RegisteredUser {
		user_id: number;
		username: string;
		profile_picture?: string;
		color: string;
	}
	/** Kept for older hosts (KanbanBoard.svelte); the board no longer offsets for a side panel. */
	export let showTaskPanel: boolean = false;
	export let taskPanelWidth: number = 380;
	export let isReadOnly: boolean = false;
	export let embedded: boolean = false;
	export let addSignal: number = 0;
	/** The "1 event" summary opens the Calendar (My Planner passes its view switch). */
	export let onOpenCalendar: (() => void) | null = null;
	$: void showTaskPanel, void taskPanelWidth;

	let draggingTodo: Todo | null = null;
	let dragOverColumn: TodoStatus | null = null;
	let suppressCardClick = false;
	let showAddModal = false;
	let editingTodo: Todo | null = null;
	let initialField: TaskField = 'title';
	let targetColumn: TodoStatus = 'todo';
	let formTitle = '';
	let formDescription = '';
	let formPriority: Todo['priority'] = 'medium';
	let formProjectId: string | null = null;
	let formDueDate = '';
	let formAssigneeId: number | null = null;
	let formHasTimeEstimate = false;
	let formEstimatedHours = '1';
	/** Draft sign-offs for the open task dialog (multi-sign). */
	let draftSignatures: Todo['signatures'] = [];
	/** Legacy signer name of the item being edited (read-only display). */
	let legacySignedBy: string | undefined = undefined;
	/** Draft project file links for the open task dialog. */
	let draftLoreRefs: Todo['loreRefs'] = [];
	let registeredUsers: RegisteredUser[] = [];
	let filteredUsers: RegisteredUser[] = [];
	let userSearchQuery = '';
	let showUserDropdown = false;
	let managingColumns = false;
	let newColumnName = '';
	let newColumnColor = '#3b82f6';
	let lastAddSignal = 0;
	/** Where focus goes back to when the dialog closes (the card or control that opened it). */
	let dialogOpener: HTMLElement | null = null;

	// Filters (strings for the kit selects; '' means "all").
	let projectValue = '';
	let priorityValue = '';
	let assigneeValue = '';
	let summaryFilter: SummaryFilter = 'all';

	// Host "New ▾ → task" trigger
	$: if (addSignal > lastAddSignal) {
		lastAddSignal = addSignal;
		openAddModal('todo');
	}

	onMount(() => {
		// Shared one-shot directory fetch (also used by calendar/TaskPanel).
		ensurePlannerDirectory();
		void tick().then(updateScrollHints);
		const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => updateScrollHints());
		if (observer && kanbanBoard) observer.observe(kanbanBoard);
		return () => observer?.disconnect();
	});

	// Mirror the shared directory into the assignee picker's legacy shape.
	$: registeredUsers = $plannerUserById.size > 0 ? [...$plannerUserById.values()] : registeredUsers;
	$: if (!userSearchQuery.trim()) filteredUsers = registeredUsers;
	// O(1) assignee lookup for cards — shared store, no per-mount fetch.
	$: userById = $plannerUserById;

	$: selectFilters = {
		project: projectValue || null,
		priority: (priorityValue || null) as BoardFilters['priority'],
		assignee: assigneeValue || null,
		summary: 'all'
	} satisfies BoardFilters;
	$: laneIds = $visibleKanbanColumns.map((column) => column.id);
	// The counts are taken over the selects only, so each one says what its filter would show.
	$: summary = boardSummary($todos, laneIds, selectFilters);
	$: eventCount = $upcomingEvents.length;
	// A summary filter whose count fell to zero would hide every card behind a vanished button.
	$: activeSummary = (summaryFilter === 'week' && summary.dueThisWeek === 0) || (summaryFilter === 'overdue' && summary.overdue === 0) ? 'all' : summaryFilter;
	$: filters = { ...selectFilters, summary: activeSummary } satisfies BoardFilters;
	$: sortedTodosByColumn = tasksByLane($todos, filters) as Record<TodoStatus, Todo[]>;
	$: showProjects = spansSeveralProjects($todos.filter((todo) => laneIds.includes(todo.status)));

	$: projectOptions = [
		{ value: '', label: 'All' },
		...$projects.map((project) => ({ value: project.id, label: project.name }))
	] satisfies SelectOption[];
	const priorityOptions: SelectOption[] = [
		{ value: '', label: 'Any' },
		{ value: 'urgent', label: 'Urgent' },
		{ value: 'high', label: 'High' },
		{ value: 'medium', label: 'Medium' },
		{ value: 'low', label: 'Low' }
	];
	$: assigneeOptions = [
		{ value: '', label: 'Anyone' },
		{ value: 'none', label: 'Unassigned' },
		...[...new Set($todos.map((todo) => todo.assignedTo).filter((id): id is string => Boolean(id)))]
			.map((id) => ({ value: id, label: userById.get(Number(id))?.username ?? `Member ${id}` }))
			.sort((a, b) => a.label.localeCompare(b.label))
	] satisfies SelectOption[];

	function toggleSummary(next: SummaryFilter): void {
		summaryFilter = activeSummary === next ? 'all' : next;
	}

	// ── Columns menu: lane switches + Edit columns… ──
	$: columnItems = [
		{ id: 'lanes', type: 'kicker', label: 'Show lanes' },
		...$kanbanColumns.map((column) => ({
			id: `lane-${column.id}`,
			label: laneLabel(column),
			role: 'menuitemcheckbox' as const,
			checked: column.visible,
			keepCase: true,
			disabled: column.visible && $visibleKanbanColumns.length <= 1,
			onSelect: () => toggleColumnVisibility(column.id)
		})),
		{ id: 'sep', type: 'separator', label: '' },
		{ id: 'edit-columns', label: $_('planner.edit_columns'), icon: 'sliders', disabled: isReadOnly, onSelect: openColumnEditor }
	] satisfies MenuEntry[];

	async function openColumnEditor(): Promise<void> {
		managingColumns = true;
		await tick();
		document.querySelector<HTMLElement>('.planner .column-management input')?.focus();
	}

	// ── board scrolling: wheel panning, drag-to-scroll on empty space, edge fades ──
	let kanbanBoard: HTMLElement;
	let isPanning = false;
	let panStartX = 0;
	let panStartScrollLeft = 0;
	let showLeftScroll = false;
	let showRightScroll = false;

	function handleBoardMouseDown(e: MouseEvent) {
		if (!kanbanBoard || e.button !== 0) return;
		if ((e.target as HTMLElement).closest('button, a, input, select, textarea, .kanban-card, [role="menu"]')) return;
		isPanning = true;
		panStartX = e.clientX;
		panStartScrollLeft = kanbanBoard.scrollLeft;
	}

	function handleBoardMouseMove(e: MouseEvent) {
		if (!isPanning || !kanbanBoard) return;
		kanbanBoard.scrollLeft = panStartScrollLeft - (e.clientX - panStartX);
		updateScrollHints();
	}

	function handleBoardMouseUp() {
		isPanning = false;
	}

	/** True when the wheel should scroll a lane's own card list instead of panning the board. */
	function laneTakesWheel(target: EventTarget | null, deltaY: number): boolean {
		const list = (target as HTMLElement | null)?.closest?.('.column-cards') as HTMLElement | null;
		if (!list || list.scrollHeight <= list.clientHeight + 1) return false;
		return deltaY < 0 ? list.scrollTop > 0 : list.scrollTop + list.clientHeight < list.scrollHeight - 1;
	}

	function handleBoardWheel(e: WheelEvent) {
		if (!kanbanBoard) return;
		const canScrollX = kanbanBoard.scrollWidth > kanbanBoard.clientWidth + 2;
		if (!canScrollX) return;
		// Lanes are a horizontal row: a vertical wheel pans the board, unless the pointer is over a
		// lane that can still scroll its own cards that way.
		const mostlyVertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
		if (e.shiftKey || (mostlyVertical && !laneTakesWheel(e.target, e.deltaY))) {
			e.preventDefault();
			kanbanBoard.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
			updateScrollHints();
		} else if (Math.abs(e.deltaX) > 0) {
			requestAnimationFrame(updateScrollHints);
		}
	}

	function updateScrollHints() {
		if (!kanbanBoard) return;
		showLeftScroll = kanbanBoard.scrollLeft > 1;
		showRightScroll = kanbanBoard.scrollLeft < kanbanBoard.scrollWidth - kanbanBoard.clientWidth - 1;
	}

	// ── moves: drag and drop, and the keyboard moves from the cards ──
	function handleDragStart(e: DragEvent, todo: Todo) {
		if (isReadOnly) return;
		draggingTodo = todo;
		suppressCardClick = true;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', todo.id);
		}
	}

	function handleDragEnd() {
		draggingTodo = null;
		dragOverColumn = null;
		setTimeout(() => {
			suppressCardClick = false;
		}, 0);
	}

	function handleDragOver(e: DragEvent, status: TodoStatus) {
		if (!draggingTodo) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dragOverColumn = status;
	}

	function handleDragLeave(e?: DragEvent) {
		// Moving between a lane's own children fires dragleave on the lane; only a real exit clears it.
		const lane = e?.currentTarget as HTMLElement | undefined;
		const next = e?.relatedTarget as Node | null | undefined;
		if (lane && next && lane.contains(next)) return;
		dragOverColumn = null;
	}

	function moveTodo(todo: Todo, status: TodoStatus): void {
		if (isReadOnly || todo.status === status) return;
		updateTodo(todo.id, { status, completedAt: completedAtFor(status, todo.completedAt) });
	}

	function handleDrop(e: DragEvent, status: TodoStatus) {
		e.preventDefault();
		e.stopPropagation();
		if (!isReadOnly && draggingTodo) moveTodo(draggingTodo, status);
		draggingTodo = null;
		dragOverColumn = null;
	}

	function handleCardClick(todo: Todo) {
		if (suppressCardClick) return;
		openEditModal(todo);
	}

	function rememberOpener(): void {
		dialogOpener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
	}

	function openAddModal(column: TodoStatus) {
		if (isReadOnly) return;
		rememberOpener();
		editingTodo = null;
		initialField = 'title';
		targetColumn = column;
		resetForm();
		showAddModal = true;
	}

	function openEditModal(todo: Todo, field: TaskField = 'title') {
		rememberOpener();
		editingTodo = todo;
		initialField = field;
		targetColumn = todo.status;
		formTitle = todo.title;
		formDescription = todo.description || '';
		formPriority = todo.priority;
		formProjectId = todo.projectId || null;
		formDueDate = dateInputValue(todo.dueDate);
		formAssigneeId = todo.assignedTo ? parseInt(String(todo.assignedTo), 10) : null;
		formHasTimeEstimate = typeof todo.estimatedMinutes === 'number' && todo.estimatedMinutes > 0;
		formEstimatedHours = formHasTimeEstimate ? (todo.estimatedMinutes! / 60).toString() : '1';
		draftSignatures = todo.signatures ? [...todo.signatures] : [];
		legacySignedBy = todo.signatures?.length ? undefined : todo.signedBy;
		draftLoreRefs = todo.loreRefs ? [...todo.loreRefs] : [];
		showAddModal = true;
	}

	function closeModal() {
		const opener = dialogOpener;
		showAddModal = false;
		editingTodo = null;
		resetForm();
		dialogOpener = null;
		// BaseModal returns focus to its opener; a card that re-rendered is found again by id.
		if (opener && !opener.isConnected) {
			void tick().then(() => document.getElementById(opener.id)?.focus());
		}
	}

	function filterUsers(query: string) {
		userSearchQuery = query;
		if (!query.trim()) {
			filteredUsers = registeredUsers;
		} else {
			const lowerQuery = query.toLowerCase();
			filteredUsers = registeredUsers.filter((u) => u.username.toLowerCase().includes(lowerQuery));
		}
	}

	function selectUser(user: RegisteredUser) {
		formAssigneeId = user.user_id;
		showUserDropdown = false;
		userSearchQuery = '';
		filteredUsers = registeredUsers;
	}

	function clearAssignee() {
		formAssigneeId = null;
		userSearchQuery = '';
		filteredUsers = registeredUsers;
	}

	function getAssigneeName(userId: number | undefined): string {
		if (!userId) return '';
		return userById.get(userId)?.username || '';
	}
	function getAssigneeColor(userId: number | undefined): string {
		if (!userId) return '';
		return userById.get(userId)?.color || '';
	}
	function getAssigneeAvatarUrl(userId: number | undefined): string | undefined {
		if (!userId) return undefined;
		return userById.get(userId)?.profile_picture || undefined;
	}

	function resetForm() {
		formTitle = '';
		formDescription = '';
		formPriority = 'medium';
		formProjectId = null;
		formDueDate = '';
		formAssigneeId = null;
		userSearchQuery = '';
		filteredUsers = registeredUsers;
		formHasTimeEstimate = false;
		formEstimatedHours = '1';
		draftSignatures = [];
		legacySignedBy = undefined;
		draftLoreRefs = [];
	}

	function handleSubmit() {
		if (!formTitle.trim() || isReadOnly) return;
		const parsedHours = Number.parseFloat(formEstimatedHours);
		const estimatedMinutes = formHasTimeEstimate && Number.isFinite(parsedHours) && parsedHours > 0
			? Math.max(1, Math.round(parsedHours * 60))
			: undefined;
		const completedAt = completedAtFor(targetColumn, editingTodo?.completedAt);

		const todoData = {
			title: formTitle.trim(),
			description: formDescription.trim() || undefined,
			priority: formPriority,
			estimatedMinutes,
			projectId: formProjectId || undefined,
			dueDate: dueDateForSave(formDueDate, editingTodo?.dueDate),
			status: targetColumn,
			completedAt,
			assignedTo: formAssigneeId?.toString(),
			createdBy: $currentUser?.dbUserId ? String($currentUser.dbUserId) : ($currentUser?.id || 'unknown'),
			signatures: draftSignatures && draftSignatures.length > 0 ? [...draftSignatures] : undefined,
			loreRefs: draftLoreRefs && draftLoreRefs.length > 0 ? [...draftLoreRefs] : undefined,
			// Legacy single-signer mirror (first signer's name) for older clients.
			signedBy: draftSignatures && draftSignatures.length > 0 ? draftSignatures[0].name : undefined
		};

		if (editingTodo) {
			updateTodo(editingTodo.id, todoData);
		} else {
			addTodo(todoData);
		}

		closeModal();
	}

	async function handleDelete(todo: Todo) {
		const confirmed = await confirmAction({
			title: 'Delete this task?',
			body: `“${todo.title}” will be removed from your Planner.`,
			confirm: 'Delete task',
			danger: true
		});
		if (!confirmed) return;
		deleteTodo(todo.id);
		closeModal();
	}

	function addNewColumn() {
		if (!newColumnName.trim()) return;
		const newColumnId = newColumnName.toLowerCase().replace(/\s+/g, '_') as TodoStatus;
		if ($kanbanColumns.some((column) => column.id === newColumnId)) return;
		const newColumn: KanbanColumn = {
			id: newColumnId,
			label: newColumnName.trim(),
			color: newColumnColor,
			visible: true
		};
		kanbanColumns.update((cols) => [...cols, newColumn]);
		newColumnName = '';
		newColumnColor = '#3b82f6';
	}

	async function deleteColumn(columnId: TodoStatus) {
		const column = $kanbanColumns.find((col) => col.id === columnId);
		const confirmed = await confirmAction({
			title: `Delete the ${column ? laneLabel(column) : columnId} column?`,
			body: 'Tasks in it are kept; show the lane again from Edit columns.',
			confirm: 'Delete column',
			danger: true
		});
		if (confirmed) kanbanColumns.update((cols) => cols.filter((col) => col.id !== columnId));
	}

	function hideColumn(columnId: TodoStatus) {
		if ($visibleKanbanColumns.length <= 1) return;
		toggleColumnVisibility(columnId);
	}

	function getPriorityColor(priority: Todo['priority']): string {
		return priority === 'urgent' ? 'var(--w-danger)' : priority === 'high' ? 'var(--w-warn)' : 'var(--w-faint)';
	}

	function getProjectName(projectId: string | undefined): string {
		if (!projectId) return '';
		return $projects.find((p) => p.id === projectId)?.name || '';
	}

	function getProjectColor(projectId: string | undefined): string {
		if (!projectId) return '';
		return $projects.find((p) => p.id === projectId)?.color || '';
	}

	function formatEstimateHours(minutes: number | undefined): string {
		if (!minutes || minutes <= 0) return '';
		const hours = minutes / 60;
		return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
	}
</script>

<div class="kanban-container" class:embedded>
	{#if !embedded}
		<h1 class="kanban-page-title">Board</h1>
	{/if}
	<div class="planner-tools">
		<div class="planner-tools__filters">
			<Select label="Project" options={projectOptions} bind:value={projectValue} applied={projectValue !== ''} heading="Project" />
			<Select label="Priority" options={priorityOptions} bind:value={priorityValue} applied={priorityValue !== ''} heading="Priority" />
			<Select label="Assignee" options={assigneeOptions} bind:value={assigneeValue} applied={assigneeValue !== ''} heading="Assignee" />
		</div>
		{#if summary.tasks > 0 || eventCount > 0}
			<div class="planner-summary" role="group" aria-label="Board summary">
				{#if summary.tasks > 0}
					<button
						type="button"
						class="planner-summary__item"
						aria-pressed={activeSummary === 'all'}
						title="Show every task"
						on:click={() => (summaryFilter = 'all')}
					><b>{summary.tasks}</b> {summary.tasks === 1 ? 'task' : 'tasks'}</button>
				{/if}
				{#if summary.dueThisWeek > 0}
					<span class="planner-summary__sep" aria-hidden="true">·</span>
					<button
						type="button"
						class="planner-summary__item"
						aria-pressed={activeSummary === 'week'}
						title="Show only tasks due in the next 7 days"
						on:click={() => toggleSummary('week')}
					><b>{summary.dueThisWeek}</b> due this week</button>
				{/if}
				{#if summary.overdue > 0}
					<span class="planner-summary__sep" aria-hidden="true">·</span>
					<button
						type="button"
						class="planner-summary__item planner-summary__item--danger"
						aria-pressed={activeSummary === 'overdue'}
						title="Show only overdue tasks"
						on:click={() => toggleSummary('overdue')}
					><b>{summary.overdue}</b> overdue</button>
				{/if}
				{#if eventCount > 0 && onOpenCalendar}
					<span class="planner-summary__sep" aria-hidden="true">·</span>
					<button
						type="button"
						class="planner-summary__item"
						title="Open the Calendar: {plural(eventCount, 'event', 'events')} in the next 7 days"
						on:click={() => onOpenCalendar?.()}
					><b>{eventCount}</b> {eventCount === 1 ? 'event' : 'events'}</button>
				{/if}
			</div>
		{/if}
		<span class="planner-tools__spacer" aria-hidden="true"></span>
		<Menu items={columnItems} label={$_('planner.columns')} class="w-btn w-btn--quiet planner-columns-btn" align="end" heading={$_('planner.columns')}>
			<Icon name="columns" size={16} /><span>{$_('planner.columns')}</span>
		</Menu>
	</div>
	{#if managingColumns}
		<div class="planner-column-editor">
			<KanbanColumnManagement
				bind:managingColumns
				bind:newColumnName
				bind:newColumnColor
				{addNewColumn}
				{deleteColumn}
			/>
		</div>
	{/if}
	<!-- svelte-ignore a11y_no_static_element_interactions: drag-to-scroll on the board's empty space; cards, lanes and the scrollbar keep their own keyboard paths -->
	<div
		class="kanban-board-wrapper"
		bind:this={kanbanBoard}
		class:panning={isPanning}
		class:fade-start={showLeftScroll}
		class:fade-end={showRightScroll}
		on:mousedown={handleBoardMouseDown}
		on:mousemove={handleBoardMouseMove}
		on:mouseup={handleBoardMouseUp}
		on:mouseleave={handleBoardMouseUp}
		on:wheel={handleBoardWheel}
		on:scroll={updateScrollHints}
	>
		<KanbanBoardColumns
			{sortedTodosByColumn}
			{dragOverColumn}
			draggingId={draggingTodo?.id ?? null}
			{isReadOnly}
			{showProjects}
			{getPriorityColor}
			{formatEstimateHours}
			{getAssigneeName}
			{getAssigneeColor}
			{getAssigneeAvatarUrl}
			{getProjectColor}
			{getProjectName}
			{openAddModal}
			{handleDragOver}
			{handleDragLeave}
			{handleDrop}
			{handleDragStart}
			{handleDragEnd}
			{handleCardClick}
			{moveTodo}
			openTaskField={openEditModal}
			onHideColumn={hideColumn}
			onEditColumns={openColumnEditor}
		/>
	</div>
</div>
{#if showAddModal}
	<KanbanTaskModal
		{editingTodo}
		{isReadOnly}
		{initialField}
		{registeredUsers}
		bind:filteredUsers
		bind:showUserDropdown
		bind:formTitle
		bind:formDescription
		bind:formPriority
		bind:formProjectId
		bind:formDueDate
		bind:formAssigneeId
		bind:formHasTimeEstimate
		bind:formEstimatedHours
		bind:draftSignatures
		{legacySignedBy}
		bind:draftLoreRefs
		bind:userSearchQuery
		bind:targetColumn
		{closeModal}
		{handleSubmit}
		{handleDelete}
		{filterUsers}
		{selectUser}
		{clearAssignee}
		{getAssigneeName}
	/>
{/if}
