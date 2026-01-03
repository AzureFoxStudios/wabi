<script lang="ts">
	import { get } from 'svelte/store';
	import { currentUser } from '$lib/socket';
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

	// Drag and drop state
	let draggingTodo: Todo | null = null;
	let dragOverColumn: TodoStatus | null = null;

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

	// Filter state
	let filterProject: string | null = null;
	let filterPriority: Todo['priority'] | null = null;
	let showColumnSettings = false;

	// Reactive todos grouped by column - this ensures UI updates when todos change
	$: todosByColumn = $todos.reduce((acc, todo) => {
		if (!acc[todo.status]) acc[todo.status] = [];
		// Apply filters
		if (filterProject && todo.projectId !== filterProject) return acc;
		if (filterPriority && todo.priority !== filterPriority) return acc;
		acc[todo.status].push(todo);
		return acc;
	}, {} as Record<TodoStatus, Todo[]>);

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
	function handleDragStart(todo: Todo) {
		draggingTodo = todo;
	}

	function handleDragEnd() {
		draggingTodo = null;
		dragOverColumn = null;
	}

	function handleDragOver(e: DragEvent, status: TodoStatus) {
		e.preventDefault();
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

	function handleDrop(status: TodoStatus) {
		if (draggingTodo && draggingTodo.status !== status) {
			updateTodo(draggingTodo.id, {
				status,
				completedAt: status === 'done' ? Date.now() : undefined
			});
		}
		draggingTodo = null;
		dragOverColumn = null;
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
		showAddModal = true;
	}

	function closeModal() {
		showAddModal = false;
		editingTodo = null;
		resetForm();
	}

	function resetForm() {
		formTitle = '';
		formDescription = '';
		formPriority = 'medium';
		formProjectId = null;
		formDueDate = '';
	}

	function handleSubmit() {
		if (!formTitle.trim()) return;

		const todoData = {
			title: formTitle.trim(),
			description: formDescription.trim() || undefined,
			priority: formPriority,
			projectId: formProjectId || undefined,
			dueDate: formDueDate ? new Date(formDueDate).getTime() : undefined,
			status: targetColumn,
			createdBy: $currentUser?.id || 'unknown'
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

	// Helpers
	function getPriorityColor(priority: Todo['priority']): string {
		switch (priority) {
			case 'urgent': return '#ef4444';
			case 'high': return '#f97316';
			case 'medium': return '#eab308';
			case 'low': return '#22c55e';
			default: return '#64748b';
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

	<!-- Kanban board -->
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
			<div
				class="kanban-column"
				class:drag-over={dragOverColumn === column.id}
				on:dragover={(e) => handleDragOver(e, column.id)}
				on:dragleave={handleDragLeave}
				on:drop={() => handleDrop(column.id)}
			>
				<div class="column-header" style="--col-color: {column.color}">
					<div class="column-title">
						<span class="column-indicator"></span>
						<h2>{column.label}</h2>
						<span class="column-count">{(sortedTodosByColumn[column.id] || []).length}</span>
					</div>
					<button class="add-card-btn" on:click={() => openAddModal(column.id)} title="Add task">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<line x1="12" y1="5" x2="12" y2="19"/>
							<line x1="5" y1="12" x2="19" y2="12"/>
						</svg>
					</button>
				</div>
				<div class="column-cards">
					{#each (sortedTodosByColumn[column.id] || []) as todo (todo.id)}
						<div
							class="kanban-card"
							class:dragging={draggingTodo?.id === todo.id}
							draggable="true"
							on:dragstart={() => handleDragStart(todo)}
							on:dragend={handleDragEnd}
							on:click={() => openEditModal(todo)}
						>
							<div class="card-priority" style="background-color: {getPriorityColor(todo.priority)}"></div>
							<div class="card-content">
								<h3 class="card-title">{todo.title}</h3>
								{#if todo.description}
									<p class="card-description">{todo.description.slice(0, 80)}{todo.description.length > 80 ? '...' : ''}</p>
								{/if}
								<div class="card-meta">
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
			<button class="scroll-hint scroll-hint-right" on:click={scrollRight} title="Scroll right">
				›
			</button>
		{/if}
	</div>
</div>

<!-- Add/Edit Modal -->
{#if showAddModal}
	<div class="modal-overlay" on:click={closeModal}>
		<div class="modal" on:click|stopPropagation>
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
					></textarea>
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

				<div class="form-actions">
					{#if editingTodo}
						<button type="button" class="delete-btn" on:click={() => editingTodo && handleDelete(editingTodo)}>
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
		max-height: 100%;
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
		z-index: 1000;
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
		background: #dc2626;
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
		transform: translateY(-2px);
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
</style>
