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

	// Props
	export let isReadOnly = false;

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
	let formHasTimeEstimate = false;
	let formEstimatedHours = '1';
	let willSign = false;

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
		formHasTimeEstimate = false;
		formEstimatedHours = '1';
		willSign = false;
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
		formHasTimeEstimate = typeof todo.estimatedMinutes === 'number' && todo.estimatedMinutes > 0;
		formEstimatedHours = formHasTimeEstimate ? (todo.estimatedMinutes! / 60).toString() : '1';
		willSign = !!todo.signedBy;
		showAddModal = true;
	}

	function closeModal() {
		showAddModal = false;
		resetForm();
	}

	function handleSubmit() {
		if (!formTitle.trim()) return;
		const parsedHours = Number.parseFloat(formEstimatedHours);
		const estimatedMinutes = formHasTimeEstimate && Number.isFinite(parsedHours) && parsedHours > 0
			? Math.max(1, Math.round(parsedHours * 60))
			: undefined;

		const todoData = {
			title: formTitle.trim(),
			description: formDescription.trim() || undefined,
			priority: formPriority,
			status: formStatus,
			estimatedMinutes,
			dueDate: formDueDate ? new Date(formDueDate).getTime() : undefined,
			projectId: formProjectId || undefined,
			tags: formTags ? formTags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
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

	function handleDelete(id: string) {
		if (confirm('Are you sure you want to delete this task?')) {
			deleteTodo(id);
		}
	}

	function handleStatusChange(todo: Todo, newStatus: Todo['status']) {
		if (newStatus === 'done') {
			completeTodo(todo.id);
		} else {
			updateTodo(todo.id, { status: newStatus, completedAt: undefined });
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric'
		});
	}

	function formatEstimateHours(minutes: number | undefined): string {
		if (!minutes || minutes <= 0) return '';
		return `${(minutes / 60).toFixed(1)}h`;
	}

	function isOverdue(todo: Todo): boolean {
		return todo.dueDate !== undefined && todo.dueDate < Date.now() && todo.status !== 'done';
	}

	function getPriorityColor(priority: string): string {
		// Updated to use CSS variable values for consistency with theme system
		switch (priority) {
			case 'urgent': return 'var(--priority-urgent)';
			case 'high': return 'var(--priority-high)';
			case 'medium': return 'var(--priority-medium)';
			case 'low': return 'var(--priority-low)';
			default: return '#6b7280'; // gray for unknown
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
	let suppressCardClick = false;

	function handleDragStart(e: DragEvent, todo: Todo) {
		if (isReadOnly) return;
		draggedTodo = todo;
		suppressCardClick = true;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', todo.id);
		}
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = 'move';
		}
	}

	function handleDrop(e: DragEvent, status: Todo['status']) {
		e.preventDefault();
		e.stopPropagation();
		if (isReadOnly) return;
		if (draggedTodo && draggedTodo.status !== status) {
			handleStatusChange(draggedTodo, status);
		}
		draggedTodo = null;
		setTimeout(() => {
			suppressCardClick = false;
		}, 0);
	}

	function handleCardClick(todo: Todo) {
		if (suppressCardClick) return;
		openEditModal(todo);
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
				<svg class="settings-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m3.08 3.08l4.24 4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m3.08-3.08l4.24-4.24M19.78 19.78l-4.24-4.24m-3.08-3.08l-4.24-4.24M19.78 4.22l-4.24 4.24m-3.08 3.08l-4.24-4.24"></path></svg>
				Columns
			</button>
			<button class="archive-btn" on:click={handleArchiveOld} title="Archive old completed tasks">
				📦 Archive Old
			</button>
			<button class="add-btn" on:click={openAddModal} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Add new task'}>
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
				<!-- svelte-ignore a11y_no_static_element_interactions: kanban columns act as drag-and-drop targets -->
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
							<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions: kanban cards are draggable pointer-first surfaces -->
							<div
								class="todo-card"
								class:overdue={isOverdue(todo)}
								draggable="true"
								on:dragstart={(e) => handleDragStart(e, todo)}
								on:dragend={() => {
									draggedTodo = null;
									setTimeout(() => {
										suppressCardClick = false;
									}, 0);
								}}
								on:click={() => handleCardClick(todo)}
							>
								<div class="card-header">
									<span class="priority-badge" style="background-color: {getPriorityColor(todo.priority)}">
										{todo.priority}
									</span>
									<div class="card-actions">
										<button class="icon-btn" on:click={() => openEditModal(todo)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Edit'}>✏️</button>
										<button class="icon-btn" on:click={() => handleDelete(todo.id)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Delete'}>🗑️</button>
									</div>
								</div>
								<h4 class="card-title">{todo.title}</h4>
								{#if todo.description}
									<p class="card-desc">{todo.description}</p>
								{/if}
								<div class="card-footer">
									{#if todo.estimatedMinutes}
										<span class="time-estimate">{formatEstimateHours(todo.estimatedMinutes)}</span>
									{/if}
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
									{#if todo.signedBy}
										<span class="signature" title="Signed by {todo.signedBy}">
											✍️ {todo.signedBy}
										</span>
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
						<th>Est.</th>
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
									on:change={(e) => handleStatusChange(todo, (e.target as HTMLSelectElement).value as Todo['status'])}
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
								{#if todo.estimatedMinutes}
									<span class="time-estimate">{formatEstimateHours(todo.estimatedMinutes)}</span>
								{:else}
									-
								{/if}
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
									<button class="icon-btn" on:click={() => openEditModal(todo)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Edit'}>✏️</button>
									<button class="icon-btn" on:click={() => handleDelete(todo.id)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Delete'}>🗑️</button>
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
			on:keydown|stopPropagation={(event) => {
				const tag = (event.target as HTMLElement).tagName;
				if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
				}
			}}
		>
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

				<div class="form-group">
					<label for="tags">Tags (comma separated)</label>
					<input
						id="tags"
						type="text"
						bind:value={formTags}
						placeholder="e.g., bug, feature, urgent"
					/>
				</div>

				<!-- Signature checkbox -->
				<div class="form-group checkbox-group">
					<label class="checkbox-label">
						<input type="checkbox" bind:checked={willSign} />
						<span>Sign this task with my username</span>
					</label>
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

