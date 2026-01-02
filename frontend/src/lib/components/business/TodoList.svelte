<script lang="ts">
	import { currentUser } from '$lib/socket';
	import {
		todos,
		todosByStatus,
		projects,
		addTodo,
		updateTodo,
		deleteTodo,
		completeTodo,
		todoFilters,
		kanbanColumns,
		visibleKanbanColumns,
		toggleColumnVisibility,
		archiveOldCompletedTasks
	} from '$lib/business/store';
	import type { Todo, TodoStatus, KanbanColumn } from '$lib/business/types';

	let showAddModal = false;
	let showColumnSettings = false;
	let editingTodo: Todo | null = null;
	let viewMode: 'list' | 'kanban' = 'kanban';

	// Form state
	let formTitle = '';
	let formDescription = '';
	let formPriority: Todo['priority'] = 'medium';
	let formStatus: TodoStatus = 'todo';
	let formDueDate = '';
	let formProjectId = '';
	let formTags = '';

	// Filter state
	let filterStatus: TodoStatus | '' = '';
	let filterPriority: Todo['priority'] | '' = '';
	let filterProject = '';

	function resetForm() {
		formTitle = '';
		formDescription = '';
		formPriority = 'medium';
		formStatus = 'todo';
		formDueDate = '';
		formProjectId = '';
		formTags = '';
		editingTodo = null;
	}

	function openAddModal() {
		resetForm();
		showAddModal = true;
	}

	function openEditModal(todo: Todo) {
		editingTodo = todo;
		formTitle = todo.title;
		formDescription = todo.description || '';
		formPriority = todo.priority;
		formStatus = todo.status;
		formDueDate = todo.dueDate ? new Date(todo.dueDate).toISOString().split('T')[0] : '';
		formProjectId = todo.projectId || '';
		formTags = todo.tags?.join(', ') || '';
		showAddModal = true;
	}

	function closeModal() {
		showAddModal = false;
		resetForm();
	}

	function handleSubmit() {
		if (!formTitle.trim()) return;

		const todoData = {
			title: formTitle.trim(),
			description: formDescription.trim() || undefined,
			priority: formPriority,
			status: formStatus,
			dueDate: formDueDate ? new Date(formDueDate).getTime() : undefined,
			projectId: formProjectId || undefined,
			tags: formTags ? formTags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
			createdBy: $currentUser?.id || 'unknown'
		};

		if (editingTodo) {
			updateTodo(editingTodo.id, todoData);
		} else {
			addTodo(todoData);
		}

		closeModal();
	}

	function handleDelete(id: string) {
		if (confirm('Are you sure you want to delete this task?')) {
			deleteTodo(id);
		}
	}

	function handleStatusChange(todo: Todo, newStatus: Todo['status']) {
		if (newStatus === 'done') {
			completeTodo(todo.id);
		} else {
			updateTodo(todo.id, { status: newStatus });
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric'
		});
	}

	function isOverdue(todo: Todo): boolean {
		return todo.dueDate !== undefined && todo.dueDate < Date.now() && todo.status !== 'done';
	}

	function getPriorityColor(priority: string): string {
		switch (priority) {
			case 'urgent': return '#ef4444';
			case 'high': return '#f97316';
			case 'medium': return '#eab308';
			case 'low': return '#22c55e';
			default: return '#6b7280';
		}
	}

	function getStatusLabel(status: TodoStatus): string {
		const column = $kanbanColumns.find(c => c.id === status);
		return column?.label || status;
	}

	function getColumnColor(status: TodoStatus): string {
		const column = $kanbanColumns.find(c => c.id === status);
		return column?.color || '#64748b';
	}

	function handleArchiveOld() {
		const count = archiveOldCompletedTasks(30);
		if (count > 0) {
			alert(`Archived ${count} task(s) completed more than 30 days ago.`);
		} else {
			alert('No tasks to archive.');
		}
	}

	// Filter todos (exclude archived from main views unless specifically filtered)
	$: filteredTodos = $todos.filter(todo => {
		// Hide archived unless specifically filtering for archived
		if (todo.status === 'archived' && filterStatus !== 'archived') return false;
		if (filterStatus && todo.status !== filterStatus) return false;
		if (filterPriority && todo.priority !== filterPriority) return false;
		if (filterProject && todo.projectId !== filterProject) return false;
		return true;
	});

	// Group filtered todos by status for kanban view
	$: kanbanTodos = {
		ideas: filteredTodos.filter(t => t.status === 'ideas'),
		todo: filteredTodos.filter(t => t.status === 'todo'),
		in_progress: filteredTodos.filter(t => t.status === 'in_progress'),
		done: filteredTodos.filter(t => t.status === 'done'),
		scrapped: filteredTodos.filter(t => t.status === 'scrapped'),
		archived: filteredTodos.filter(t => t.status === 'archived')
	} as Record<TodoStatus, Todo[]>;

	// Drag and drop
	let draggedTodo: Todo | null = null;

	function handleDragStart(todo: Todo) {
		draggedTodo = todo;
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
	}

	function handleDrop(e: DragEvent, status: Todo['status']) {
		e.preventDefault();
		if (draggedTodo && draggedTodo.status !== status) {
			handleStatusChange(draggedTodo, status);
		}
		draggedTodo = null;
	}
</script>

<div class="todo-container">
	<header class="todo-header">
		<div class="header-left">
			<h1>Tasks</h1>
			<div class="view-toggle">
				<button class:active={viewMode === 'kanban'} on:click={() => viewMode = 'kanban'}>
					Kanban
				</button>
				<button class:active={viewMode === 'list'} on:click={() => viewMode = 'list'}>
					List
				</button>
			</div>
		</div>
		<div class="header-right">
			<button class="settings-btn" on:click={() => showColumnSettings = !showColumnSettings} title="Column Settings">
				⚙️ Columns
			</button>
			<button class="archive-btn" on:click={handleArchiveOld} title="Archive old completed tasks">
				📦 Archive Old
			</button>
			<button class="add-btn" on:click={openAddModal}>
				+ Add Task
			</button>
		</div>
	</header>

	<!-- Column Settings Panel -->
	{#if showColumnSettings}
		<div class="column-settings">
			<h3>Visible Columns</h3>
			<div class="column-toggles">
				{#each $kanbanColumns as column}
					<label class="column-toggle">
						<input
							type="checkbox"
							checked={column.visible}
							on:change={() => toggleColumnVisibility(column.id)}
						/>
						<span class="toggle-color" style="background-color: {column.color}"></span>
						{column.label}
					</label>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Filters -->
	<div class="filters">
		<select bind:value={filterStatus}>
			<option value="">All Status</option>
			{#each $kanbanColumns as column}
				<option value={column.id}>{column.label}</option>
			{/each}
		</select>

		<select bind:value={filterPriority}>
			<option value="">All Priority</option>
			<option value="urgent">Urgent</option>
			<option value="high">High</option>
			<option value="medium">Medium</option>
			<option value="low">Low</option>
		</select>

		{#if $projects.length > 0}
			<select bind:value={filterProject}>
				<option value="">All Projects</option>
				{#each $projects as project}
					<option value={project.id}>{project.name}</option>
				{/each}
			</select>
		{/if}
	</div>

	{#if viewMode === 'kanban'}
		<!-- Kanban View -->
		<div class="kanban-board" style="grid-template-columns: repeat({$visibleKanbanColumns.length}, 1fr);">
			{#each $visibleKanbanColumns as column (column.id)}
				<div
					class="kanban-column"
					on:dragover={handleDragOver}
					on:drop={(e) => handleDrop(e, column.id)}
				>
					<div class="column-header" style="border-top: 3px solid {column.color};">
						<h3 style="color: {column.color};">{column.label}</h3>
						<span class="count">{kanbanTodos[column.id]?.length || 0}</span>
					</div>
					<div class="column-content">
						{#each kanbanTodos[column.id] || [] as todo (todo.id)}
							<div
								class="todo-card"
								class:overdue={isOverdue(todo)}
								draggable="true"
								on:dragstart={() => handleDragStart(todo)}
							>
								<div class="card-header">
									<span class="priority-badge" style="background-color: {getPriorityColor(todo.priority)}">
										{todo.priority}
									</span>
									<div class="card-actions">
										<button class="icon-btn" on:click={() => openEditModal(todo)} title="Edit">✏️</button>
										<button class="icon-btn" on:click={() => handleDelete(todo.id)} title="Delete">🗑️</button>
									</div>
								</div>
								<h4 class="card-title">{todo.title}</h4>
								{#if todo.description}
									<p class="card-desc">{todo.description}</p>
								{/if}
								<div class="card-footer">
									{#if todo.dueDate}
										<span class="due-date" class:overdue={isOverdue(todo)}>
											📅 {formatDate(todo.dueDate)}
										</span>
									{/if}
									{#if todo.tags?.length}
										<div class="tags">
											{#each todo.tags.slice(0, 2) as tag}
												<span class="tag">{tag}</span>
											{/each}
										</div>
									{/if}
								</div>
							</div>
						{/each}
						{#if (kanbanTodos[column.id]?.length || 0) === 0}
							<div class="empty-column">No tasks</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<!-- List View -->
		<div class="list-view">
			<table class="todo-table">
				<thead>
					<tr>
						<th>Status</th>
						<th>Title</th>
						<th>Priority</th>
						<th>Due Date</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each filteredTodos as todo (todo.id)}
						<tr class:overdue={isOverdue(todo)} class:done={todo.status === 'done'}>
							<td>
								<select
									value={todo.status}
									on:change={(e) => handleStatusChange(todo, e.target.value)}
									class="status-select"
								>
									{#each $kanbanColumns as column}
										<option value={column.id}>{column.label}</option>
									{/each}
								</select>
							</td>
							<td class="title-cell">
								<span class="todo-title" class:completed={todo.status === 'done'}>{todo.title}</span>
								{#if todo.description}
									<span class="todo-desc">{todo.description}</span>
								{/if}
							</td>
							<td>
								<span class="priority-badge small" style="background-color: {getPriorityColor(todo.priority)}">
									{todo.priority}
								</span>
							</td>
							<td>
								{#if todo.dueDate}
									<span class:overdue={isOverdue(todo)}>{formatDate(todo.dueDate)}</span>
								{:else}
									-
								{/if}
							</td>
							<td>
								<div class="table-actions">
									<button class="icon-btn" on:click={() => openEditModal(todo)} title="Edit">✏️</button>
									<button class="icon-btn" on:click={() => handleDelete(todo.id)} title="Delete">🗑️</button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if filteredTodos.length === 0}
				<div class="empty-state">
					<p>No tasks found</p>
					<button class="add-btn" on:click={openAddModal}>+ Add your first task</button>
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- Add/Edit Modal -->
{#if showAddModal}
	<div class="modal-overlay" on:click={closeModal}>
		<div class="modal" on:click|stopPropagation>
			<div class="modal-header">
				<h2>{editingTodo ? 'Edit Task' : 'Add New Task'}</h2>
				<button class="close-btn" on:click={closeModal}>&times;</button>
			</div>
			<form on:submit|preventDefault={handleSubmit}>
				<div class="form-group">
					<label for="title">Title *</label>
					<input
						id="title"
						type="text"
						bind:value={formTitle}
						placeholder="What needs to be done?"
						required
					/>
				</div>

				<div class="form-group">
					<label for="description">Description</label>
					<textarea
						id="description"
						bind:value={formDescription}
						placeholder="Add more details..."
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
						<select id="status" bind:value={formStatus}>
							{#each $kanbanColumns as column}
								<option value={column.id}>{column.label}</option>
							{/each}
						</select>
					</div>
				</div>

				<div class="form-row">
					<div class="form-group">
						<label for="dueDate">Due Date</label>
						<input id="dueDate" type="date" bind:value={formDueDate} />
					</div>

					{#if $projects.length > 0}
						<div class="form-group">
							<label for="project">Project</label>
							<select id="project" bind:value={formProjectId}>
								<option value="">No Project</option>
								{#each $projects as project}
									<option value={project.id}>{project.name}</option>
								{/each}
							</select>
						</div>
					{/if}
				</div>

				<div class="form-group">
					<label for="tags">Tags (comma separated)</label>
					<input
						id="tags"
						type="text"
						bind:value={formTags}
						placeholder="e.g., bug, feature, urgent"
					/>
				</div>

				<div class="form-actions">
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
	.todo-container {
		height: 100%;
		display: flex;
		flex-direction: column;
	}

	.todo-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 1.5rem;
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.settings-btn,
	.archive-btn {
		padding: 0.5rem 0.8rem;
		background: var(--bg-secondary, #16213e);
		border: 1px solid var(--border-color, #2a2a4a);
		color: var(--text-secondary, #aaa);
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.85rem;
		transition: all 0.2s;
	}

	.settings-btn:hover,
	.archive-btn:hover {
		background: var(--bg-tertiary, #1f2937);
		color: var(--text-primary, #eee);
	}

	/* Column Settings Panel */
	.column-settings {
		background: var(--bg-secondary, #16213e);
		border-radius: 8px;
		padding: 1rem;
		margin-bottom: 1rem;
		border: 1px solid var(--border-color, #2a2a4a);
	}

	.column-settings h3 {
		margin: 0 0 0.75rem 0;
		font-size: 0.9rem;
		color: var(--text-secondary, #aaa);
	}

	.column-toggles {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	.column-toggle {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.75rem;
		background: var(--bg-tertiary, #1f2937);
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.85rem;
		transition: all 0.2s;
	}

	.column-toggle:hover {
		background: var(--bg-hover, #2a2a4a);
	}

	.column-toggle input {
		cursor: pointer;
	}

	.toggle-color {
		width: 12px;
		height: 12px;
		border-radius: 3px;
	}

	.todo-header h1 {
		margin: 0;
		font-size: 1.5rem;
	}

	.view-toggle {
		display: flex;
		background: var(--bg-secondary, #16213e);
		border-radius: 8px;
		padding: 4px;
	}

	.view-toggle button {
		padding: 0.4rem 0.8rem;
		border: none;
		background: transparent;
		color: var(--text-secondary, #888);
		cursor: pointer;
		border-radius: 6px;
		font-size: 0.85rem;
		transition: all 0.2s;
	}

	.view-toggle button.active {
		background: var(--accent, #5865f2);
		color: white;
	}

	.add-btn {
		padding: 0.6rem 1.2rem;
		background: var(--accent, #5865f2);
		color: white;
		border: none;
		border-radius: 8px;
		cursor: pointer;
		font-weight: 500;
		transition: all 0.2s;
	}

	.add-btn:hover {
		background: #4752c4;
	}

	/* Filters */
	.filters {
		display: flex;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.filters select {
		padding: 0.5rem 0.75rem;
		background: var(--bg-secondary, #16213e);
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 6px;
		color: var(--text-primary, #eee);
		font-size: 0.85rem;
	}

	/* Kanban Board */
	.kanban-board {
		display: grid;
		gap: 1rem;
		flex: 1;
		overflow-x: auto;
		min-width: 0;
	}

	.kanban-column {
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		display: flex;
		flex-direction: column;
		min-height: 400px;
	}

	.column-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem;
		border-bottom: 1px solid var(--border-color, #2a2a4a);
	}

	.column-header h3 {
		margin: 0;
		font-size: 0.9rem;
		font-weight: 600;
	}

	.count {
		background: var(--bg-tertiary, #1f2937);
		padding: 0.2rem 0.5rem;
		border-radius: 10px;
		font-size: 0.75rem;
	}

	.column-content {
		flex: 1;
		padding: 0.75rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.todo-card {
		background: var(--bg-tertiary, #1f2937);
		border-radius: 8px;
		padding: 0.75rem;
		cursor: grab;
		transition: all 0.2s;
		border: 1px solid transparent;
	}

	.todo-card:hover {
		border-color: var(--accent, #5865f2);
	}

	.todo-card.overdue {
		border-left: 3px solid #ef4444;
	}

	.card-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.5rem;
	}

	.priority-badge {
		font-size: 0.65rem;
		padding: 0.15rem 0.4rem;
		border-radius: 4px;
		color: white;
		text-transform: uppercase;
		font-weight: 600;
	}

	.priority-badge.small {
		font-size: 0.6rem;
	}

	.card-actions {
		display: flex;
		gap: 0.25rem;
		opacity: 0;
		transition: opacity 0.2s;
	}

	.todo-card:hover .card-actions {
		opacity: 1;
	}

	.icon-btn {
		background: transparent;
		border: none;
		cursor: pointer;
		font-size: 0.8rem;
		padding: 0.2rem;
		border-radius: 4px;
		transition: background 0.2s;
	}

	.icon-btn:hover {
		background: var(--bg-secondary, #16213e);
	}

	.card-title {
		margin: 0 0 0.25rem 0;
		font-size: 0.9rem;
		font-weight: 500;
	}

	.card-desc {
		margin: 0;
		font-size: 0.8rem;
		color: var(--text-secondary, #888);
		overflow: hidden;
		text-overflow: ellipsis;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.card-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 0.5rem;
		flex-wrap: wrap;
		gap: 0.25rem;
	}

	.due-date {
		font-size: 0.75rem;
		color: var(--text-secondary, #888);
	}

	.due-date.overdue {
		color: #ef4444;
	}

	.tags {
		display: flex;
		gap: 0.25rem;
	}

	.tag {
		font-size: 0.65rem;
		padding: 0.1rem 0.35rem;
		background: var(--bg-secondary, #16213e);
		border-radius: 4px;
		color: var(--text-secondary, #888);
	}

	.empty-column {
		text-align: center;
		color: var(--text-secondary, #888);
		font-size: 0.85rem;
		padding: 2rem 0;
	}

	/* List View */
	.list-view {
		flex: 1;
		overflow: auto;
	}

	.todo-table {
		width: 100%;
		border-collapse: collapse;
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		overflow: hidden;
	}

	.todo-table th,
	.todo-table td {
		padding: 0.75rem 1rem;
		text-align: left;
		border-bottom: 1px solid var(--border-color, #2a2a4a);
	}

	.todo-table th {
		background: var(--bg-tertiary, #1f2937);
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		color: var(--text-secondary, #888);
	}

	.todo-table tr.overdue td {
		background: rgba(239, 68, 68, 0.1);
	}

	.todo-table tr.done .todo-title {
		text-decoration: line-through;
		color: var(--text-secondary, #888);
	}

	.title-cell {
		display: flex;
		flex-direction: column;
	}

	.todo-title {
		font-weight: 500;
	}

	.todo-desc {
		font-size: 0.8rem;
		color: var(--text-secondary, #888);
	}

	.status-select {
		padding: 0.35rem 0.5rem;
		background: var(--bg-tertiary, #1f2937);
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 4px;
		color: var(--text-primary, #eee);
		font-size: 0.8rem;
	}

	.table-actions {
		display: flex;
		gap: 0.25rem;
	}

	.empty-state {
		text-align: center;
		padding: 3rem;
		color: var(--text-secondary, #888);
	}

	/* Modal */
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.modal {
		background: var(--bg-secondary, #16213e);
		border-radius: 12px;
		width: 100%;
		max-width: 500px;
		max-height: 90vh;
		overflow-y: auto;
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--border-color, #2a2a4a);
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.1rem;
	}

	.close-btn {
		background: transparent;
		border: none;
		color: var(--text-secondary, #888);
		font-size: 1.5rem;
		cursor: pointer;
		line-height: 1;
	}

	form {
		padding: 1.25rem;
	}

	.form-group {
		margin-bottom: 1rem;
	}

	.form-group label {
		display: block;
		font-size: 0.85rem;
		margin-bottom: 0.35rem;
		color: var(--text-secondary, #aaa);
	}

	.form-group input,
	.form-group textarea,
	.form-group select {
		width: 100%;
		padding: 0.6rem 0.75rem;
		background: var(--bg-tertiary, #1f2937);
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 6px;
		color: var(--text-primary, #eee);
		font-size: 0.9rem;
	}

	.form-group input:focus,
	.form-group textarea:focus,
	.form-group select:focus {
		outline: none;
		border-color: var(--accent, #5865f2);
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
		margin-top: 1.5rem;
	}

	.cancel-btn {
		padding: 0.6rem 1rem;
		background: transparent;
		border: 1px solid var(--border-color, #2a2a4a);
		border-radius: 6px;
		color: var(--text-secondary, #aaa);
		cursor: pointer;
		transition: all 0.2s;
	}

	.cancel-btn:hover {
		background: var(--bg-tertiary, #1f2937);
	}

	.submit-btn {
		padding: 0.6rem 1.25rem;
		background: var(--accent, #5865f2);
		border: none;
		border-radius: 6px;
		color: white;
		cursor: pointer;
		font-weight: 500;
		transition: all 0.2s;
	}

	.submit-btn:hover {
		background: #4752c4;
	}

	@media (max-width: 1200px) {
		.kanban-board {
			grid-template-columns: repeat(3, 1fr) !important;
		}
	}

	@media (max-width: 900px) {
		.kanban-board {
			grid-template-columns: repeat(2, 1fr) !important;
		}

		.header-right {
			flex-wrap: wrap;
		}
	}

	@media (max-width: 600px) {
		.kanban-board {
			grid-template-columns: 1fr !important;
		}

		.form-row {
			grid-template-columns: 1fr;
		}

		.todo-header {
			flex-direction: column;
			gap: 1rem;
			align-items: stretch;
		}

		.header-left,
		.header-right {
			justify-content: center;
		}
	}
</style>
