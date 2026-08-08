<script lang="ts">
	import { get } from 'svelte/store';
	import { currentUser } from '$lib/socket';
	import { getLocalMockUsers, isLocalMockApiMode } from '$lib/localMockApi';
	import { getServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';
	import { onMount } from 'svelte';
	import {
		todos,
		projects,
		visibleKanbanColumns,
		kanbanColumns,
		updateTodo,
		addTodo,
		deleteTodo,
		toggleColumnVisibility,
		type Todo
	} from '$lib/business';
	import type { TodoStatus, KanbanColumn } from '$lib/business/types';
	import KanbanBoardColumns from './KanbanBoardColumns.svelte';
	import KanbanColumnManagement from './KanbanColumnManagement.svelte';
	import KanbanTaskModal from './KanbanTaskModal.svelte';

	interface RegisteredUser {
		user_id: number;
		username: string;
		profile_picture?: string;
		color: string;
	}
	export let showTaskPanel: boolean = false;
	export let taskPanelWidth: number = 380;
	export let isReadOnly: boolean = false;
	export let embedded: boolean = false;
	export let addSignal: number = 0;
	let draggingTodo: Todo | null = null;
	let dragOverColumn: TodoStatus | null = null;
	let suppressCardClick = false;
	let showAddModal = false;
	let editingTodo: Todo | null = null;
	let targetColumn: TodoStatus = 'todo';
	let formTitle = '';
	let formDescription = '';
	let formPriority: Todo['priority'] = 'medium';
	let formProjectId: string | null = null;
	let formDueDate = '';
	let formAssigneeId: number | null = null;
	let formHasTimeEstimate = false;
	let formEstimatedHours = '1';
	let willSign = false;
	let registeredUsers: RegisteredUser[] = [];
	let filteredUsers: RegisteredUser[] = [];
	let userSearchQuery = '';
	let showUserDropdown = false;
	let filterProject: string | null = null;
	let filterPriority: Todo['priority'] | null = null;
	let showColumnSettings = false;
	let managingColumns = false;
	let newColumnName = '';
	let newColumnColor = '#3b82f6';
	let lastAddSignal = 0;

	// Host "New ▾ → task" trigger
	$: if (addSignal > lastAddSignal) {
		lastAddSignal = addSignal;
		openAddModal('todo');
	}

	onMount(async () => {
		if (isLocalMockApiMode()) {
			registeredUsers = getLocalMockUsers();
			filteredUsers = registeredUsers;
			return;
		}

		try {
			const authToken = getAuthToken();
			const response = await fetch(`${getServerUrl()}/api/users`, {
				headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
			});
			if (response.ok) {
				const data = await response.json();
				const rows = Array.isArray(data)
					? data
					: Array.isArray(data?.users)
						? data.users
						: [];
				registeredUsers = rows.map((u: any) => ({
					user_id: u.user_id ?? u.userId ?? u.id ?? 0,
					username: u.username ?? u.name ?? 'user',
					profile_picture: u.profile_picture ?? u.profilePicture,
					color: u.color ?? '#6366f1'
				}));
				filteredUsers = registeredUsers;
			} else {
				console.error('[KanbanBoard] Failed to fetch users:', response.status);
			}
		} catch (error) {
			console.error('[KanbanBoard] Failed to fetch users:', error);
		}
	});
	$: todosByColumn = (() => {
		return $todos.reduce((acc, todo) => {
			if (!acc[todo.status]) acc[todo.status] = [];
			if (filterProject && todo.projectId !== filterProject) return acc;
			if (filterPriority && todo.priority !== filterPriority) return acc;
			acc[todo.status].push(todo);
			return acc;
		}, {} as Record<TodoStatus, Todo[]>);
	})();
	$: sortedTodosByColumn = Object.fromEntries(
		Object.entries(todosByColumn).map(([status, colTodos]) => [
			status,
			[...colTodos].sort((a, b) => {
				const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
				if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
					return priorityOrder[a.priority] - priorityOrder[b.priority];
				}
				return (a.dueDate || Infinity) - (b.dueDate || Infinity);
			})
		])
	) as Record<TodoStatus, Todo[]>;
	// O(1) assignee lookup for cards (avoid find() per card)
	$: userById = new Map(registeredUsers.map((u) => [u.user_id, u]));
	let kanbanBoard: HTMLElement;
	let isPanning = false;
	let panStartX = 0;
	let panStartScrollLeft = 0;
	let showLeftScroll = false;
	let showRightScroll = false;
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
		e.preventDefault();
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = 'move';
		}
		dragOverColumn = status;
	}

	function handleDragLeave() {
		dragOverColumn = null;
	}
	function handleBoardMouseDown(e: MouseEvent) {
		if (!kanbanBoard) return;
		if ((e.target as HTMLElement).closest('button, input, select, .kanban-card')) return;

		isPanning = true;
		panStartX = e.clientX;
		panStartScrollLeft = kanbanBoard.scrollLeft;
		kanbanBoard.style.cursor = 'grabbing';
		kanbanBoard.style.userSelect = 'none';
	}

	function handleBoardMouseMove(e: MouseEvent) {
		if (!isPanning || !kanbanBoard) return;
		const delta = e.clientX - panStartX;
		kanbanBoard.scrollLeft = panStartScrollLeft - delta;
		updateScrollHints();
	}

	function handleBoardMouseUp() {
		isPanning = false;
		if (kanbanBoard) {
			kanbanBoard.style.cursor = 'grab';
			kanbanBoard.style.userSelect = 'auto';
		}
	}

	function handleBoardWheel(e: WheelEvent) {
		if (!e.shiftKey && kanbanBoard && kanbanBoard.scrollHeight <= kanbanBoard.clientHeight) {
			return; // Allow normal vertical scroll if needed
		}

		if (e.shiftKey || (kanbanBoard && kanbanBoard.scrollHeight <= kanbanBoard.clientHeight)) {
			e.preventDefault();
			if (kanbanBoard) {
				kanbanBoard.scrollLeft += e.deltaY; // Use deltaY for horizontal scroll
				updateScrollHints();
			}
		}
	}

	function updateScrollHints() {
		if (!kanbanBoard) return;
		showLeftScroll = kanbanBoard.scrollLeft > 0;
		showRightScroll =
			kanbanBoard.scrollLeft < kanbanBoard.scrollWidth - kanbanBoard.clientWidth - 10;
	}

	function scrollLeft() {
		if (kanbanBoard) {
			kanbanBoard.scrollBy({ left: -300, behavior: 'smooth' });
			setTimeout(updateScrollHints, 400);
		}
	}

	function scrollRight() {
		if (kanbanBoard) {
			kanbanBoard.scrollBy({ left: 300, behavior: 'smooth' });
			setTimeout(updateScrollHints, 400);
		}
	}

	function handleDrop(e: DragEvent, status: TodoStatus) {
		e.preventDefault();
		e.stopPropagation();
		if (isReadOnly) return;

		if (draggingTodo && draggingTodo.status !== status) {
			updateTodo(draggingTodo.id, {
				status,
				completedAt: status === 'done' ? Date.now() : undefined
			});
		}
		draggingTodo = null;
		dragOverColumn = null;
	}

	function handleCardClick(todo: Todo) {
		if (suppressCardClick) return;
		openEditModal(todo);
	}
	function openAddModal(column: TodoStatus) {
		targetColumn = column;
		resetForm();
		showAddModal = true;
	}

	function openEditModal(todo: Todo) {
		editingTodo = todo;
		targetColumn = todo.status;
		formTitle = todo.title;
		formDescription = todo.description || '';
		formPriority = todo.priority;
		formProjectId = todo.projectId || null;
		formDueDate = todo.dueDate ? new Date(todo.dueDate).toISOString().split('T')[0] : '';
		formAssigneeId = todo.assignedTo ? parseInt(String(todo.assignedTo), 10) : null;
		formHasTimeEstimate = typeof todo.estimatedMinutes === 'number' && todo.estimatedMinutes > 0;
		formEstimatedHours = formHasTimeEstimate ? (todo.estimatedMinutes! / 60).toString() : '1';
		willSign = !!todo.signedBy;
		showAddModal = true;
	}

	function closeModal() {
		showAddModal = false;
		editingTodo = null;
		resetForm();
	}

	function filterUsers(query: string) {
		userSearchQuery = query;
		if (!query.trim()) {
			filteredUsers = registeredUsers;
		} else {
			const lowerQuery = query.toLowerCase();
			filteredUsers = registeredUsers.filter(u =>
				u.username.toLowerCase().includes(lowerQuery)
			);
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
		if (!userId) return '#888';
		return userById.get(userId)?.color || '#888';
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
		willSign = false;
	}

	function handleSubmit() {
		if (!formTitle.trim()) return;
		const parsedHours = Number.parseFloat(formEstimatedHours);
		const estimatedMinutes = formHasTimeEstimate && Number.isFinite(parsedHours) && parsedHours > 0
			? Math.max(1, Math.round(parsedHours * 60))
			: undefined;
		const completedAt = targetColumn === 'done'
			? (editingTodo?.completedAt || Date.now())
			: undefined;

		const todoData = {
			title: formTitle.trim(),
			description: formDescription.trim() || undefined,
			priority: formPriority,
			estimatedMinutes,
			projectId: formProjectId || undefined,
			dueDate: formDueDate ? new Date(formDueDate).getTime() : undefined,
			status: targetColumn,
			completedAt,
			assignedTo: formAssigneeId?.toString(),
			createdBy: $currentUser?.dbUserId ? String($currentUser.dbUserId) : ($currentUser?.id || 'unknown'),
			signedBy: willSign ? ($currentUser?.username || 'Guest') : undefined,
			visibility: willSign ? ('public' as const) : ('private' as const)
		};

		if (editingTodo) {
			updateTodo(editingTodo.id, todoData);
		} else {
			addTodo(todoData);
		}

		closeModal();
	}

	function handleDelete(todo: Todo) {
		if (confirm(`Delete "${todo.title}"?`)) {
			deleteTodo(todo.id);
			closeModal();
		}
	}
	function addNewColumn() {
		if (!newColumnName.trim()) return;

		const newColumnId = newColumnName.toLowerCase().replace(/\s+/g, '_') as TodoStatus;
		const newColumn: KanbanColumn = {
			id: newColumnId,
			label: newColumnName,
			color: newColumnColor,
			visible: true
		};

		kanbanColumns.update(cols => [...cols, newColumn]);
		newColumnName = '';
		newColumnColor = '#3b82f6';
	}

	function deleteColumn(columnId: TodoStatus) {
		if (confirm(`Delete column "${columnId}"? Tasks in this column won't be deleted.`)) {
			kanbanColumns.update(cols => cols.filter(col => col.id !== columnId));
		}
	}
	function getPriorityColor(priority: Todo['priority']): string {
		switch (priority) {
			case 'urgent': return 'var(--priority-urgent)';
			case 'high': return 'var(--priority-high)';
			case 'medium': return 'var(--priority-medium)';
			case 'low': return 'var(--priority-low)';
			default: return 'var(--biz-text-muted, #64748b)';
		}
	}

	function getProjectName(projectId: string | undefined): string {
		if (!projectId) return '';
		const project = get(projects).find(p => p.id === projectId);
		return project?.name || '';
	}

	function getProjectColor(projectId: string | undefined): string {
		if (!projectId) return '#64748b';
		const project = get(projects).find(p => p.id === projectId);
		return project?.color || '#64748b';
	}

	function formatDueDate(timestamp: number | undefined): string {
		if (!timestamp) return '';
		const date = new Date(timestamp);
		const now = new Date();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

		if (timestamp < today.getTime()) return 'Overdue';
		if (timestamp < tomorrow.getTime()) return 'Today';

		const diffDays = Math.ceil((timestamp - today.getTime()) / (24 * 60 * 60 * 1000));
		if (diffDays <= 7) return `${diffDays}d`;

		return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	function formatEstimateHours(minutes: number | undefined): string {
		if (!minutes || minutes <= 0) return '';
		return `${(minutes / 60).toFixed(1)}h`;
	}

	function isOverdue(timestamp: number | undefined): boolean {
		if (!timestamp) return false;
		const now = new Date();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		return timestamp < today.getTime();
	}
</script>

<div class="kanban-container">
	<header class="kanban-header" class:embedded={embedded}>
		{#if !embedded}
			<h1>Kanban Board</h1>
		{/if}
		<div class="filters">
			<select bind:value={filterProject} class="filter-select" aria-label="Filter by project">
				<option value={null}>All Projects</option>
				{#each $projects as project}
					<option value={project.id}>{project.name}</option>
				{/each}
			</select>
			<select bind:value={filterPriority} class="filter-select" aria-label="Filter by priority">
				<option value={null}>All Priorities</option>
				<option value="urgent">Urgent</option>
				<option value="high">High</option>
				<option value="medium">Medium</option>
				<option value="low">Low</option>
			</select>
			<button class="settings-btn" on:click={() => showColumnSettings = !showColumnSettings} title="Show / hide columns">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="3"/>
					<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
				</svg>
			</button>
			<button
				class="settings-btn"
				class:active={managingColumns}
				on:click={() => managingColumns = !managingColumns}
				title="Manage columns"
			>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M12 5v14M5 12h14"/>
				</svg>
			</button>
		</div>
		{#if embedded}
			<button class="kanban-add-btn" on:click={() => openAddModal('todo')} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Add a task'}>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
					<line x1="12" y1="5" x2="12" y2="19"/>
					<line x1="5" y1="12" x2="19" y2="12"/>
				</svg>
				<span>Add Task</span>
			</button>
		{/if}
	</header>
	{#if showColumnSettings}
		<div class="column-settings">
			<span class="settings-label">Show columns:</span>
			{#each $kanbanColumns as column}
				<label class="column-toggle">
					<input
						type="checkbox"
						checked={column.visible}
						on:change={() => toggleColumnVisibility(column.id)}
					/>
					<span class="toggle-label" style="--col-color: {column.color}">{column.label}</span>
				</label>
			{/each}
		</div>
	{/if}
	{#if managingColumns}
		<KanbanColumnManagement
			bind:managingColumns
			bind:newColumnName
			bind:newColumnColor
			{addNewColumn}
			{deleteColumn}
		/>
	{/if}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions: this is a pointer-first drag-scroll board surface -->
	<div
		class="kanban-board-wrapper"
		bind:this={kanbanBoard}
		class:panning={isPanning}
		on:mousedown={handleBoardMouseDown}
		on:mousemove={handleBoardMouseMove}
		on:mouseup={handleBoardMouseUp}
		on:mouseleave={handleBoardMouseUp}
		on:wheel={handleBoardWheel}
		role="region"
		aria-label="Kanban board - drag to scroll"
	>
		{#if showLeftScroll}
			<button class="scroll-hint scroll-hint-left" on:click={scrollLeft} title="Scroll left">
				‹
			</button>
		{/if}

		<KanbanBoardColumns
			{sortedTodosByColumn}
			{dragOverColumn}
			{isReadOnly}
			{getPriorityColor}
			{formatEstimateHours}
			{getAssigneeName}
			{getAssigneeColor}
			{getProjectColor}
			{getProjectName}
			{formatDueDate}
			{isOverdue}
			{openAddModal}
			{handleDragOver}
			{handleDragLeave}
			{handleDrop}
			{handleDragStart}
			{handleDragEnd}
			{handleCardClick}
		/>
		{#if showRightScroll}
			<button
			class="scroll-hint scroll-hint-right"
			style:right={showTaskPanel ? `${taskPanelWidth + 12}px` : '12px'}
			on:click={scrollRight}
			title="Scroll right"
		>
				›
			</button>
		{/if}
	</div>
</div>
{#if showAddModal}
	<KanbanTaskModal
		{editingTodo}
		{isReadOnly}
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
		bind:willSign
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
