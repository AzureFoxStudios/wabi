<script lang="ts">
	import { get } from 'svelte/store';
	import { currentUser } from '$lib/socket';
	import { getServerUrl } from '$lib/serverUrl';
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

	interface RegisteredUser {
		user_id: number;
		username: string;
		profile_picture?: string;
		color: string;
	}

	// Props to track task panel state
	export let showTaskPanel: boolean = false;
	export let taskPanelWidth: number = 380;
	export let isReadOnly: boolean = false;

	// Drag and drop state
	let draggingTodo: Todo | null = null;
	let dragOverColumn: TodoStatus | null = null;
	let suppressCardClick = false;

	// Modal state
	let showAddModal = false;
	let editingTodo: Todo | null = null;
	let targetColumn: TodoStatus = 'todo';

	// Form state
	let formTitle = '';
	let formDescription = '';
	let formPriority: Todo['priority'] = 'medium';
	let formProjectId: string | null = null;
	let formDueDate = '';
	let formAssigneeId: number | null = null;
	let formHasTimeEstimate = false;
	let formEstimatedHours = '1';
	let willSign = false;

	// User and assignee state
	let registeredUsers: RegisteredUser[] = [];
	let filteredUsers: RegisteredUser[] = [];
	let userSearchQuery = '';
	let showUserDropdown = false;

	// Filter state
	let filterProject: string | null = null;
	let filterPriority: Todo['priority'] | null = null;
	let showColumnSettings = false;

	// Column management state
	let managingColumns = false;
	let newColumnName = '';
	let newColumnColor = '#3b82f6';

	onMount(async () => {
		try {
			const response = await fetch(`${getServerUrl()}/api/users`);
			if (response.ok) {
				const data = await response.json();
				console.log('[KanbanBoard] Fetched users:', data);
				registeredUsers = data;
				filteredUsers = registeredUsers;
			} else {
				console.error('[KanbanBoard] Failed to fetch users:', response.status);
			}
		} catch (error) {
			console.error('[KanbanBoard] Failed to fetch users:', error);
		}
	});

	// Reactive todos grouped by column - this ensures UI updates when todos change and users load
	$: todosByColumn = (() => {
		// Reference registeredUsers to trigger re-render when users load
		void registeredUsers;
		return $todos.reduce((acc, todo) => {
			if (!acc[todo.status]) acc[todo.status] = [];
			// Apply filters
			if (filterProject && todo.projectId !== filterProject) return acc;
			if (filterPriority && todo.priority !== filterPriority) return acc;
			acc[todo.status].push(todo);
			return acc;
		}, {} as Record<TodoStatus, Todo[]>);
	})();

	// Sort todos within each column
	$: sortedTodosByColumn = Object.fromEntries(
		Object.entries(todosByColumn).map(([status, todos]) => [
			status,
			[...todos].sort((a, b) => {
				const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
				if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
					return priorityOrder[a.priority] - priorityOrder[b.priority];
				}
				return (a.dueDate || Infinity) - (b.dueDate || Infinity);
			})
		])
	) as Record<TodoStatus, Todo[]>;

	// Kanban board horizontal scroll/pan state
	let kanbanBoard: HTMLElement;
	let isPanning = false;
	let panStartX = 0;
	let panStartScrollLeft = 0;
	let showLeftScroll = false;
	let showRightScroll = false;

	// Drag handlers
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

	// Kanban board panning
	function handleBoardMouseDown(e: MouseEvent) {
		if (!kanbanBoard) return;
		// Don't pan if clicking on interactive elements
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
		// Shift+Scroll or only horizontal scroll (no vertical content overflow)
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

	// Modal handlers
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
		const user = registeredUsers.find(u => u.user_id === userId);
		return user?.username || '';
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

	// Column management functions
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

	// Helpers
	function getPriorityColor(priority: Todo['priority']): string {
		// Updated to use CSS variable values for consistency with theme system
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
	<!-- Header with filters -->
	<header class="kanban-header">
		<h1>Kanban Board</h1>
		<div class="filters">
			<select bind:value={filterProject} class="filter-select">
				<option value={null}>All Projects</option>
				{#each $projects as project}
					<option value={project.id}>{project.name}</option>
				{/each}
			</select>
			<select bind:value={filterPriority} class="filter-select">
				<option value={null}>All Priorities</option>
				<option value="urgent">Urgent</option>
				<option value="high">High</option>
				<option value="medium">Medium</option>
				<option value="low">Low</option>
			</select>
			<button class="settings-btn" on:click={() => showColumnSettings = !showColumnSettings} title="Column settings">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="3"/>
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
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
	</header>

	<!-- Column settings panel -->
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

	<!-- Column management panel -->
	{#if managingColumns}
		<div class="column-management">
			<div class="management-header">
				<h3>Manage Columns</h3>
				<button class="close-btn" on:click={() => managingColumns = false}>×</button>
			</div>

			<!-- Add new column -->
			<div class="add-column-form">
				<h4>Add New Column</h4>
				<input
					type="text"
					bind:value={newColumnName}
					placeholder="Column name"
					class="column-input"
				/>
				<div class="color-picker">
					<label for="new-column-color">Color:</label>
					<input
						id="new-column-color"
						type="color"
						bind:value={newColumnColor}
						class="color-input"
					/>
					<div class="color-preview" style="background-color: {newColumnColor}"></div>
				</div>
				<button
					class="add-column-btn"
					on:click={addNewColumn}
					disabled={!newColumnName.trim()}
				>
					Add Column
				</button>
			</div>

			<!-- Existing columns -->
			<div class="existing-columns">
				<h4>Existing Columns</h4>
				<div class="columns-list">
					{#each $kanbanColumns as column}
						<div class="column-item">
							<div class="column-info">
								<div class="column-color" style="background-color: {column.color}"></div>
								<span>{column.label}</span>
								<span class="column-id">({column.id})</span>
							</div>
							{#if !['todo', 'done', 'in_progress'].includes(column.id)}
								<button
									class="delete-column-btn"
									on:click={() => deleteColumn(column.id)}
									title="Delete column"
								>
									🗑️
								</button>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	<!-- Kanban board -->
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
		<!-- Scroll hint buttons -->
		{#if showLeftScroll}
			<button class="scroll-hint scroll-hint-left" on:click={scrollLeft} title="Scroll left">
				‹
			</button>
		{/if}

		<div class="kanban-board">
			{#each $visibleKanbanColumns as column (column.id)}
			<!-- svelte-ignore a11y_no_static_element_interactions: kanban columns act as drag-and-drop targets -->
			<div
				class="kanban-column"
				class:drag-over={dragOverColumn === column.id}
				on:dragover={(e) => handleDragOver(e, column.id)}
				on:dragleave={handleDragLeave}
				on:drop={(e) => handleDrop(e, column.id)}
			>
				<div class="column-header" style="--col-color: {column.color}">
					<div class="column-title">
						<span class="column-indicator"></span>
						<h2>{column.label}</h2>
						<span class="column-count">{(sortedTodosByColumn[column.id] || []).length}</span>
					</div>
					<button class="add-card-btn" on:click={() => openAddModal(column.id)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Add task'}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<line x1="12" y1="5" x2="12" y2="19"/>
							<line x1="5" y1="12" x2="19" y2="12"/>
						</svg>
					</button>
				</div>
				<div class="column-cards">
					{#each (sortedTodosByColumn[column.id] || []) as todo (todo.id)}
						<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions: kanban cards are draggable pointer-first surfaces -->
						<div
							class="kanban-card"
							class:dragging={draggingTodo?.id === todo.id}
							draggable="true"
							on:dragstart={(e) => handleDragStart(e, todo)}
							on:dragend={handleDragEnd}
							on:click={() => handleCardClick(todo)}
						>
							<div class="card-priority" style="background-color: {getPriorityColor(todo.priority)}"></div>
							<div class="card-content">
								<h3 class="card-title">{todo.title}</h3>
								{#if todo.description}
									<p class="card-description">{todo.description.slice(0, 80)}{todo.description.length > 80 ? '...' : ''}</p>
								{/if}
								<div class="card-meta">
									{#if todo.estimatedMinutes}
										<span class="card-estimate">{formatEstimateHours(todo.estimatedMinutes)}</span>
									{/if}
									{#if todo.assignedTo}
										<span class="assignee-chip-card">
											<span class="assignee-dot" style="background-color: {registeredUsers.find(u => u.user_id === parseInt(String(todo.assignedTo), 10))?.color || '#888'}"></span>
											<span>{getAssigneeName(parseInt(String(todo.assignedTo), 10))}</span>
										</span>
									{/if}
									{#if todo.projectId}
										<span class="card-project" style="background-color: {getProjectColor(todo.projectId)}20; color: {getProjectColor(todo.projectId)}">
											{getProjectName(todo.projectId)}
										</span>
									{/if}
									{#if todo.dueDate}
										<span class="card-due" class:overdue={isOverdue(todo.dueDate) && todo.status !== 'done'}>
											{formatDueDate(todo.dueDate)}
										</span>
									{/if}
								</div>
							</div>
						</div>
					{/each}
					{#if (sortedTodosByColumn[column.id] || []).length === 0}
						<div class="empty-column">
							<p>No tasks</p>
						</div>
					{/if}
				</div>
			</div>
		{/each}
		</div>

		<!-- Scroll hint button right -->
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

<!-- Add/Edit Modal -->
{#if showAddModal}
	<div
		class="modal-overlay"
		role="button"
		tabindex="0"
		on:click={closeModal}
		on:keydown={(event) => {
			const tag = (event.target as HTMLElement).tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				closeModal();
			}
		}}
	>
		<div
			class="modal"
			role="button"
			tabindex="0"
			on:click|stopPropagation
			on:keydown|stopPropagation={() => {}}
		>
			<div class="modal-header">
				<h2>{editingTodo ? 'Edit Task' : 'Add Task'}</h2>
				<button class="close-btn" on:click={closeModal}>&times;</button>
			</div>
			<form on:submit|preventDefault={handleSubmit}>
				<div class="form-group">
					<label for="title">Title *</label>
					<input
						id="title"
						type="text"
						bind:value={formTitle}
						placeholder="Task title"
						required
					/>
				</div>

				<div class="form-group">
					<label for="description">Description</label>
					<textarea
						id="description"
						bind:value={formDescription}
						placeholder="Add details..."
						rows="3"
						class="description-textarea"
					></textarea>
				</div>

				<div class="form-group">
					<label for="assignee">Assign to</label>
					<div class="assignee-search-wrap">
						{#if formAssigneeId}
							<div class="assignee-chip">
								<span class="assignee-dot" style="background-color: {registeredUsers.find(u => u.user_id === formAssigneeId)?.color || '#888'}"></span>
								<span>{getAssigneeName(formAssigneeId)}</span>
								<button type="button" class="chip-remove" on:click={clearAssignee} title="Clear assignee">×</button>
							</div>
						{:else}
							<input
								type="text"
								id="assignee"
								placeholder="Search user..."
								value={userSearchQuery}
								on:input={(e) => filterUsers(e.currentTarget.value)}
								on:focus={() => showUserDropdown = true}
								on:blur={() => setTimeout(() => showUserDropdown = false, 200)}
								class="assignee-input"
							/>
							{#if showUserDropdown && filteredUsers.length > 0}
								<div class="assignee-dropdown">
									{#each filteredUsers as user (user.user_id)}
										<button
											type="button"
											class="assignee-item"
											on:click={() => selectUser(user)}
										>
											<span class="assignee-item-dot" style="background-color: {user.color}"></span>
											<span>{user.username}</span>
										</button>
									{/each}
								</div>
							{/if}
						{/if}
					</div>
				</div>

				<div class="form-row">
					<div class="form-group">
						<label for="priority">Priority</label>
						<select id="priority" bind:value={formPriority}>
							<option value="low">Low</option>
							<option value="medium">Medium</option>
							<option value="high">High</option>
							<option value="urgent">Urgent</option>
						</select>
					</div>
					<div class="form-group">
						<label for="status">Status</label>
						<select id="status" bind:value={targetColumn}>
							{#each $kanbanColumns as col}
								<option value={col.id}>{col.label}</option>
							{/each}
						</select>
					</div>
				</div>

				<div class="form-row">
					<div class="form-group">
						<label for="project">Project</label>
						<select id="project" bind:value={formProjectId}>
							<option value={null}>No project</option>
							{#each $projects as project}
								<option value={project.id}>{project.name}</option>
							{/each}
						</select>
					</div>
					<div class="form-group">
						<label for="dueDate">Due Date</label>
						<input id="dueDate" type="date" bind:value={formDueDate} />
					</div>
				</div>

				<div class="form-group checkbox-group">
					<label class="checkbox-label">
						<input type="checkbox" bind:checked={formHasTimeEstimate} />
						<span>Track time estimate for burndown</span>
					</label>
				</div>

				{#if formHasTimeEstimate}
					<div class="form-group">
						<label for="estimatedHours">Estimated Time (hours)</label>
						<input
							id="estimatedHours"
							type="number"
							min="0.25"
							step="0.25"
							bind:value={formEstimatedHours}
						/>
					</div>
				{/if}

				<!-- Signature checkbox -->
				<div class="form-group checkbox-group">
					<label class="checkbox-label">
						<input type="checkbox" bind:checked={willSign} />
						<span>Sign this task with my username</span>
					</label>
				</div>

				<div class="form-actions">
					{#if editingTodo}
						<button type="button" class="delete-btn" on:click={() => editingTodo && handleDelete(editingTodo)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Delete'}>
							Delete
						</button>
					{/if}
					<button type="button" class="cancel-btn" on:click={closeModal}>Cancel</button>
					<button type="submit" class="submit-btn">
						{editingTodo ? 'Save Changes' : 'Add Task'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<style>
	.kanban-container {
		height: 100%;
		display: flex;
		flex-direction: column;
	}

	.kanban-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
		flex-wrap: wrap;
		gap: 1rem;
	}

	.kanban-header h1 {
		margin: 0;
		font-size: 1.5rem;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.filters {
		display: flex;
		gap: 0.75rem;
		align-items: center;
	}

	.filter-select {
		padding: 0.5rem 0.75rem;
		background: var(--biz-bg-secondary, #1a2332);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.85rem;
		cursor: pointer;
	}

	.filter-select:focus {
		outline: none;
		border-color: var(--biz-accent, #f59e0b);
	}

	.settings-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		background: var(--biz-bg-secondary, #1a2332);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-secondary, #94a3b8);
		cursor: pointer;
		transition: all 0.2s;
	}

	.settings-btn:hover {
		background: var(--biz-bg-tertiary, #243044);
		color: var(--biz-text-primary, #f1f5f9);
	}

	.column-settings {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.75rem 1rem;
		background: var(--biz-bg-secondary, #1a2332);
		border-radius: 8px;
		margin-bottom: 1rem;
		flex-wrap: wrap;
		border: 1px solid var(--biz-border, #2d3a4d);
	}

	.settings-label {
		font-size: 0.85rem;
		color: var(--biz-text-secondary, #94a3b8);
	}

	.column-toggle {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		cursor: pointer;
	}

	.column-toggle input {
		accent-color: var(--biz-accent, #f59e0b);
	}

	.toggle-label {
		font-size: 0.85rem;
		color: var(--biz-text-primary, #f1f5f9);
		padding-left: 0.35rem;
		border-left: 3px solid var(--col-color);
	}

	.settings-btn.active {
		background: var(--biz-accent, #f59e0b);
		color: white;
	}

	/* Column Management Panel */
	.column-management {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		padding: 1.5rem;
		background: var(--biz-bg-secondary, #1a2332);
		border-radius: 8px;
		margin-bottom: 1rem;
		border: 2px solid var(--biz-accent, #f59e0b);
	}

	.management-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.management-header h3 {
		margin: 0;
		font-size: 1rem;
		color: var(--biz-text-primary, #f1f5f9);
		font-weight: 600;
	}

	.close-btn {
		background: transparent;
		border: none;
		color: var(--biz-text-secondary, #94a3b8);
		font-size: 1.5rem;
		cursor: pointer;
		padding: 0;
		width: 24px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.close-btn:hover {
		color: var(--biz-text-primary, #f1f5f9);
	}

	.add-column-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		background: var(--biz-bg-tertiary, #243044);
		border-radius: 8px;
	}

	.add-column-form h4 {
		margin: 0 0 0.5rem 0;
		font-size: 0.9rem;
		color: var(--biz-text-primary, #f1f5f9);
		font-weight: 600;
	}

	.column-input {
		padding: 0.6rem;
		background: var(--biz-bg-primary, #0f1419);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 6px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.9rem;
	}

	.column-input:focus {
		outline: none;
		border-color: var(--biz-accent, #f59e0b);
	}

	.color-picker {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.color-picker label {
		font-size: 0.85rem;
		color: var(--biz-text-secondary, #94a3b8);
		flex-shrink: 0;
	}

	.color-input {
		width: 50px;
		height: 40px;
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 6px;
		cursor: pointer;
	}

	.color-preview {
		width: 40px;
		height: 40px;
		border-radius: 6px;
		border: 1px solid var(--biz-border, #2d3a4d);
	}

	.add-column-btn {
		padding: 0.6rem 1rem;
		background: var(--biz-accent, #f59e0b);
		border: none;
		border-radius: 6px;
		color: white;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
		margin-top: 0.5rem;
	}

	.add-column-btn:hover:not(:disabled) {
		background: var(--biz-accent-hover, #d97706);
	}

	.add-column-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.existing-columns h4 {
		margin: 0 0 0.75rem 0;
		font-size: 0.9rem;
		color: var(--biz-text-primary, #f1f5f9);
		font-weight: 600;
	}

	.columns-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.column-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.75rem;
		background: var(--biz-bg-primary, #0f1419);
		border-radius: 6px;
		border: 1px solid var(--biz-border, #2d3a4d);
	}

	.column-info {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
	}

	.column-color {
		width: 20px;
		height: 20px;
		border-radius: 4px;
		flex-shrink: 0;
		border: 1px solid var(--biz-border, #2d3a4d);
	}

	.column-id {
		font-size: 0.75rem;
		color: var(--biz-text-muted, #64748b);
		margin-left: auto;
	}

	.delete-column-btn {
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 0.25rem;
		font-size: 1rem;
		transition: all 0.2s;
	}

	.delete-column-btn:hover {
		opacity: 0.7;
	}

	/* Kanban Board Wrapper */
	.kanban-board-wrapper {
		flex: 1;
		position: relative;
		overflow-x: auto;
		overflow-y: hidden;
		scroll-behavior: smooth;
		cursor: grab;
		padding-bottom: 1rem;
	}

	.kanban-board-wrapper:active {
		cursor: grabbing;
	}

	.kanban-board-wrapper.panning {
		scroll-behavior: auto;
	}

	/* Kanban Board */
	.kanban-board {
		display: flex;
		gap: 1rem;
		width: fit-content;
		padding: 0 1rem;
		height: 100%;
	}

	/* Scroll Hint Buttons */
	.scroll-hint {
		position: fixed;
		top: 50%;
		transform: translateY(-50%);
		width: 32px;
		height: 48px;
		background: linear-gradient(90deg, var(--biz-accent, #f59e0b), var(--biz-accent-hover, #d97706));
		border: none;
		border-radius: 4px;
		color: white;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.25rem;
		font-weight: bold;
		z-index: 20;
		transition: all 0.2s;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
		pointer-events: auto;
	}

	.scroll-hint:hover {
		transform: translateY(-50%) scale(1.1);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
	}

	.scroll-hint:active {
		transform: translateY(-50%) scale(0.95);
	}

	.scroll-hint-left {
		left: 12px;
	}

	.scroll-hint-right {
		right: 12px;
	}

	.kanban-column {
		flex: 0 0 280px;
		background: var(--biz-bg-secondary, #1a2332);
		border-radius: 12px;
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		border: 1px solid var(--biz-border, #2d3a4d);
		transition: all 0.2s;
	}

	.kanban-column.drag-over {
		border-color: var(--biz-accent, #f59e0b);
		background: var(--biz-accent-soft, rgba(245, 158, 11, 0.1));
	}

	.column-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--biz-border, #2d3a4d);
	}

	.column-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.column-indicator {
		width: 4px;
		height: 16px;
		background: var(--col-color);
		border-radius: 2px;
	}

	.column-header h2 {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.column-count {
		background: var(--biz-bg-tertiary, #243044);
		padding: 0.15rem 0.5rem;
		border-radius: 10px;
		font-size: 0.75rem;
		color: var(--biz-text-secondary, #94a3b8);
	}

	.add-card-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		background: var(--biz-bg-tertiary, #243044);
		border: none;
		border-radius: 6px;
		color: var(--biz-text-secondary, #94a3b8);
		cursor: pointer;
		transition: all 0.2s;
	}

	.add-card-btn:hover {
		background: var(--biz-accent, #f59e0b);
		color: white;
	}

	.column-cards {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	/* Cards */
	.kanban-card {
		display: flex;
		background: var(--biz-bg-tertiary, #243044);
		border-radius: 8px;
		cursor: grab;
		transition: all 0.2s;
		overflow: hidden;
		flex-shrink: 0;
	}

	.kanban-card:hover {
		background: var(--biz-bg-hover, #2a3a4d);
		transform: translateY(-1px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
	}

	.kanban-card.dragging {
		opacity: 0.5;
		cursor: grabbing;
	}

	.card-priority {
		width: 4px;
		flex-shrink: 0;
	}

	.card-content {
		flex: 1;
		padding: 0.75rem;
		min-width: 0;
	}

	.card-title {
		margin: 0 0 0.35rem 0;
		font-size: 0.9rem;
		font-weight: 500;
		color: var(--biz-text-primary, #f1f5f9);
		word-break: break-word;
	}

	.card-description {
		margin: 0 0 0.5rem 0;
		font-size: 0.8rem;
		color: var(--biz-text-secondary, #94a3b8);
		line-height: 1.4;
	}

	.card-meta {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.card-estimate {
		font-size: 0.7rem;
		padding: 0.15rem 0.5rem;
		border-radius: 4px;
		font-weight: 600;
		color: var(--biz-accent, #f59e0b);
		background: color-mix(in srgb, var(--biz-accent, #f59e0b) 15%, transparent);
	}

	.card-project {
		font-size: 0.7rem;
		padding: 0.15rem 0.5rem;
		border-radius: 4px;
		font-weight: 500;
	}

	.card-due {
		font-size: 0.7rem;
		color: var(--biz-text-muted, #64748b);
	}

	.card-due.overdue {
		color: var(--biz-danger, #ef4444);
		font-weight: 500;
	}

	.empty-column {
		padding: 2rem 1rem;
		text-align: center;
	}

	.empty-column p {
		margin: 0;
		color: var(--biz-text-muted, #64748b);
		font-size: 0.85rem;
	}

	/* Modal */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.8);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: var(--z-overlay);
		backdrop-filter: blur(2px);
		animation: fadeIn 0.2s ease-out;
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.modal {
		background: linear-gradient(135deg, var(--biz-bg-secondary, #1a2332), var(--biz-bg-tertiary, #243044));
		border-radius: 12px;
		width: 100%;
		max-width: 480px;
		max-height: 90vh;
		overflow-y: auto;
		border: 1px solid var(--biz-border, #2d3a4d);
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.05);
		animation: slideIn 0.3s ease-out;
	}

	@keyframes slideIn {
		from {
			transform: scale(0.95) translateY(-20px);
			opacity: 0;
		}
		to {
			transform: scale(1) translateY(0);
			opacity: 1;
		}
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1.5rem 1.5rem 1rem;
		border-bottom: 2px solid var(--biz-border, #2d3a4d);
		background: linear-gradient(90deg, rgba(245, 158, 11, 0.05), transparent);
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--biz-text-primary, #f1f5f9);
		letter-spacing: -0.3px;
	}

	.close-btn {
		background: transparent;
		border: none;
		color: var(--biz-text-secondary, #94a3b8);
		font-size: 1.5rem;
		cursor: pointer;
		line-height: 1;
		transition: all 0.2s;
		padding: 0.25rem;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.close-btn:hover {
		color: var(--biz-text-primary, #f1f5f9);
		background: rgba(255, 255, 255, 0.05);
		border-radius: 4px;
	}

	form {
		padding: 1.5rem;
	}

	.form-group {
		margin-bottom: 1.25rem;
	}

	.form-group label {
		display: block;
		font-size: 0.8rem;
		margin-bottom: 0.5rem;
		color: var(--biz-text-secondary, #94a3b8);
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.3px;
	}

	.form-group input,
	.form-group textarea,
	.form-group select {
		width: 100%;
		padding: 0.75rem;
		background: var(--biz-bg-secondary, #1a2332);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.9rem;
		transition: all 0.2s;
		font-family: inherit;
	}

	.form-group input::placeholder,
	.form-group textarea::placeholder {
		color: var(--biz-text-muted, #64748b);
	}

	.description-textarea {
		resize: vertical;
		min-height: 80px;
	}

	.assignee-search-wrap {
		position: relative;
	}

	.assignee-input {
		width: 100%;
		padding: 0.75rem;
		background: var(--biz-bg-secondary, #1a2332);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.9rem;
		transition: all 0.2s;
		font-family: inherit;
	}

	.assignee-input:focus {
		outline: none;
		border-color: var(--biz-accent, #f59e0b);
		background: rgba(245, 158, 11, 0.05);
		box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.1);
	}

	.assignee-dropdown {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		background: var(--biz-bg-secondary, #1a2332);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-top: none;
		border-radius: 0 0 8px 8px;
		max-height: 180px;
		overflow-y: auto;
		z-index: 50;
		margin-top: -1px;
	}

	.assignee-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.6rem 0.75rem;
		background: transparent;
		border: none;
		color: var(--biz-text-primary, #f1f5f9);
		cursor: pointer;
		text-align: left;
		font-size: 0.9rem;
		transition: all 0.2s;
	}

	.assignee-item:hover {
		background: var(--biz-bg-tertiary, #243044);
	}

	.assignee-item-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.assignee-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: var(--biz-bg-tertiary, #243044);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 20px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.85rem;
		white-space: nowrap;
	}

	.assignee-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.chip-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		background: transparent;
		border: none;
		color: var(--biz-text-secondary, #94a3b8);
		cursor: pointer;
		font-size: 1.2rem;
		padding: 0;
		transition: all 0.2s;
		margin-left: 0.25rem;
	}

	.chip-remove:hover {
		color: var(--biz-text-primary, #f1f5f9);
	}

	.assignee-chip-card {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.15rem 0.5rem;
		background: var(--biz-info-soft, rgba(59, 130, 246, 0.15));
		color: var(--biz-info, #3b82f6);
		border-radius: 4px;
		font-size: 0.7rem;
		white-space: nowrap;
	}

	.form-group input:focus,
	.form-group textarea:focus,
	.form-group select:focus {
		outline: none;
		border-color: var(--biz-accent, #f59e0b);
		background: rgba(245, 158, 11, 0.05);
		box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.1);
	}

	.form-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		margin-top: 2rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--biz-border, #2d3a4d);
	}

	.delete-btn {
		padding: 0.75rem 1.5rem;
		background: var(--biz-danger, #ef4444);
		border: none;
		border-radius: 8px;
		color: white;
		cursor: pointer;
		margin-right: auto;
		transition: all 0.2s;
		font-weight: 500;
		font-size: 0.9rem;
	}

	.delete-btn:hover {
		background: var(--biz-danger-hover, #dc2626);
		box-shadow: 0 4px 12px rgba(220, 38, 38, 0.4);
	}

	.delete-btn:active {
		transform: scale(0.98);
	}

	.cancel-btn {
		padding: 0.75rem 1.5rem;
		background: transparent;
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-secondary, #94a3b8);
		cursor: pointer;
		transition: all 0.2s;
		font-weight: 500;
		font-size: 0.9rem;
	}

	.cancel-btn:hover {
		background: var(--biz-bg-tertiary, #243044);
		color: var(--biz-text-primary, #f1f5f9);
		border-color: var(--biz-border, #2d3a4d);
	}

	.cancel-btn:active {
		transform: scale(0.98);
	}

	.submit-btn {
		padding: 0.75rem 2rem;
		background: linear-gradient(135deg, var(--biz-accent, #f59e0b), var(--biz-accent-hover, #d97706));
		border: none;
		border-radius: 8px;
		color: white;
		cursor: pointer;
		font-weight: 600;
		transition: all 0.2s;
		font-size: 0.9rem;
		box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);
	}

	.submit-btn:hover {
		transform: translateY(-1px);
		box-shadow: 0 6px 20px rgba(245, 158, 11, 0.4);
	}

	.submit-btn:active {
		transform: scale(0.98);
	}

	@media (max-width: 768px) {
		.kanban-header {
			flex-direction: column;
			align-items: stretch;
		}

		.filters {
			flex-wrap: wrap;
		}

		.kanban-column {
			flex: 0 0 260px;
		}

		.form-row {
			grid-template-columns: 1fr;
		}
	}

	.submit-btn:disabled,
	.delete-btn:disabled,
	.add-card-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.delete-btn:disabled:hover,
	.add-card-btn:disabled:hover {
		background: none;
		color: inherit;
	}

	.checkbox-group {
		margin-bottom: 0.75rem;
	}

	.checkbox-label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0;
		cursor: pointer;
		color: var(--biz-text-secondary, #94a3b8);
		font-size: 0.95rem;
	}

	.checkbox-label input[type="checkbox"] {
		cursor: pointer;
	}

</style>
