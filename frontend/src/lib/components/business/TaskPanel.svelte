<script lang="ts">
	import { get } from 'svelte/store';
	import { todos, projects, addTodo, updateTodo, deleteTodo, type Todo } from '$lib/business';
	import { onMount } from 'svelte';

	interface RegisteredUser {
		user_id: number;
		username: string;
		profile_picture?: string;
		color: string;
	}

	let newTaskTitle = '';
	let newTaskDescription = '';
	let newTaskPriority: Todo['priority'] = 'medium';
	let newTaskProject: string | null = null;
	let newTaskAssignee: number | null = null;
	let registeredUsers: RegisteredUser[] = [];
	let filteredUsers: RegisteredUser[] = [];
	let showUserDropdown = false;
	let userSearchQuery = '';
	let showAddForm = false;

	// Edit mode state
	let editingTaskId: string | null = null;
	let editingTaskTitle = '';
	let editingTaskDescription = '';
	let editingTaskPriority: Todo['priority'] = 'medium';
	let editingTaskProject: string | null = null;
	let editingTaskAssignee: number | null = null;

	// Filter options
	type FilterType = 'all' | 'today' | 'overdue' | 'upcoming';
	let activeFilter: FilterType = 'all';

	onMount(async () => {
		try {
			const response = await fetch('/api/users');
			if (response.ok) {
				const data = await response.json();
				console.log('[TaskPanel] Fetched users:', data);
				registeredUsers = data;
				filteredUsers = registeredUsers;
			} else {
				console.error('[TaskPanel] Failed to fetch users:', response.status);
			}
		} catch (error) {
			console.error('[TaskPanel] Failed to fetch users:', error);
		}
	});

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
		newTaskAssignee = user.user_id;
		showUserDropdown = false;
		userSearchQuery = '';
	}

	function getAssigneeName(userId: number | undefined): string {
		if (!userId) return '';
		const user = registeredUsers.find(u => u.user_id === userId);
		return user?.username || '';
	}

	function openEditMode(todo: Todo) {
		editingTaskId = todo.id;
		editingTaskTitle = todo.title;
		editingTaskDescription = todo.description || '';
		editingTaskPriority = todo.priority;
		editingTaskProject = todo.projectId || null;
		editingTaskAssignee = todo.assignedTo ? parseInt(String(todo.assignedTo), 10) : null;
	}

	function closeEditMode() {
		editingTaskId = null;
		editingTaskTitle = '';
		editingTaskDescription = '';
		editingTaskPriority = 'medium';
		editingTaskProject = null;
		editingTaskAssignee = null;
	}

	function saveEditedTask() {
		if (!editingTaskId || !editingTaskTitle.trim()) return;
		const todo = $todos.find(t => t.id === editingTaskId);
		if (!todo) return;

		updateTodo(editingTaskId, {
			title: editingTaskTitle.trim(),
			description: editingTaskDescription.trim() || undefined,
			priority: editingTaskPriority,
			projectId: editingTaskProject || undefined,
			assignedTo: editingTaskAssignee?.toString()
		});

		closeEditMode();
	}

	function deleteEditingTask() {
		if (!editingTaskId) return;
		if (confirm('Delete this task?')) {
			deleteTodo(editingTaskId);
			closeEditMode();
		}
	}

	$: filteredTodos = $todos.filter(todo => {
		if (todo.status === 'done' || todo.status === 'archived') return false;

		const now = new Date();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
		const weekFromNow = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

		switch (activeFilter) {
			case 'today':
				return todo.dueDate && todo.dueDate >= today.getTime() && todo.dueDate < tomorrow.getTime();
			case 'overdue':
				return todo.dueDate && todo.dueDate < today.getTime();
			case 'upcoming':
				return todo.dueDate && todo.dueDate >= today.getTime() && todo.dueDate < weekFromNow.getTime();
			default:
				return true;
		}
	}).sort((a, b) => {
		// Sort by priority then due date
		const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
		if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
			return priorityOrder[a.priority] - priorityOrder[b.priority];
		}
		if (a.dueDate && b.dueDate) return a.dueDate - b.dueDate;
		if (a.dueDate) return -1;
		if (b.dueDate) return 1;
		return 0;
	});

	function handleAddTask() {
		if (!newTaskTitle.trim()) return;

		addTodo({
			title: newTaskTitle.trim(),
			description: newTaskDescription.trim() || undefined,
			priority: newTaskPriority,
			projectId: newTaskProject,
			assignedTo: newTaskAssignee?.toString(),
			status: 'todo'
		});

		newTaskTitle = '';
		newTaskDescription = '';
		newTaskPriority = 'medium';
		newTaskProject = null;
		newTaskAssignee = null;
		showAddForm = false;
	}

	function toggleTaskStatus(todo: Todo) {
		const newStatus = todo.status === 'done' ? 'todo' : 'done';
		updateTodo(todo.id, { status: newStatus });
	}

	function getProjectName(projectId: string | null | undefined): string {
		if (!projectId) return '';
		const project = get(projects).find(p => p.id === projectId);
		return project?.name || '';
	}

	function getPriorityClass(priority: Todo['priority']): string {
		return `priority-${priority}`;
	}

	function formatDueDate(timestamp: number | null | undefined): string {
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

	function isOverdue(timestamp: number | null | undefined): boolean {
		if (!timestamp) return false;
		const now = new Date();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		return timestamp < today.getTime();
	}
</script>

<div class="task-panel-container">
	<div class="panel-header">
		<h2>Tasks</h2>
		<button class="add-btn" on:click={() => showAddForm = !showAddForm} title="Add Task">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<line x1="12" y1="5" x2="12" y2="19"/>
				<line x1="5" y1="12" x2="19" y2="12"/>
			</svg>
		</button>
	</div>

	<!-- Filter Tabs -->
	<div class="filter-tabs">
		<button
			class="filter-tab"
			class:active={activeFilter === 'all'}
			on:click={() => activeFilter = 'all'}
		>All</button>
		<button
			class="filter-tab"
			class:active={activeFilter === 'today'}
			on:click={() => activeFilter = 'today'}
		>Today</button>
		<button
			class="filter-tab"
			class:active={activeFilter === 'overdue'}
			on:click={() => activeFilter = 'overdue'}
		>Overdue</button>
		<button
			class="filter-tab"
			class:active={activeFilter === 'upcoming'}
			on:click={() => activeFilter = 'upcoming'}
		>Week</button>
	</div>

	<!-- Quick Add Form -->
	{#if showAddForm}
		<form class="quick-add-form" on:submit|preventDefault={handleAddTask}>
			<input
				type="text"
				bind:value={newTaskTitle}
				placeholder="What needs to be done?"
				class="task-input"
				autofocus
			/>
			<textarea
				bind:value={newTaskDescription}
				placeholder="Add details..."
				class="description-input"
				rows="2"
			></textarea>
			<div class="form-row">
				<select bind:value={newTaskPriority} class="priority-select">
					<option value="low">Low</option>
					<option value="medium">Medium</option>
					<option value="high">High</option>
					<option value="urgent">Urgent</option>
				</select>
				<select bind:value={newTaskProject} class="project-select">
					<option value={null}>No Project</option>
					{#each $projects as project}
						<option value={project.id}>{project.name}</option>
					{/each}
				</select>
			</div>
			<div class="assignee-field">
				{#if newTaskAssignee}
					<div class="assignee-chip">
						<span class="assignee-dot" style="background-color: {registeredUsers.find(u => u.user_id === newTaskAssignee)?.color || '#888'}"></span>
						<span>{getAssigneeName(newTaskAssignee)}</span>
						<button type="button" class="chip-remove" on:click={() => newTaskAssignee = null} title="Clear assignee">×</button>
					</div>
				{:else}
					<input
						type="text"
						placeholder="Assign to user..."
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
									on:click={() => {
										newTaskAssignee = user.user_id;
										showUserDropdown = false;
										userSearchQuery = '';
									}}
								>
									<span class="assignee-item-dot" style="background-color: {user.color}"></span>
									<span>{user.username}</span>
								</button>
							{/each}
						</div>
					{/if}
				{/if}
			</div>
			<div class="form-actions">
				<button type="button" class="cancel-btn" on:click={() => showAddForm = false}>Cancel</button>
				<button type="submit" class="submit-btn">Add Task</button>
			</div>
		</form>
	{/if}

	<!-- Task List -->
	<div class="task-list">
		{#if filteredTodos.length === 0}
			<div class="empty-state">
				<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
					<path d="M9 11l3 3L22 4"/>
					<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
				</svg>
				<p>No tasks {activeFilter !== 'all' ? `for ${activeFilter}` : ''}</p>
			</div>
		{:else}
			{#each filteredTodos as todo (todo.id)}
				{#if editingTaskId === todo.id}
					<!-- Edit Mode -->
					<form class="edit-task-form" on:submit|preventDefault={saveEditedTask}>
						<div class="form-header">
							<h3>Edit Task</h3>
							<button type="button" class="close-btn" on:click={closeEditMode}>×</button>
						</div>
						<input
							type="text"
							bind:value={editingTaskTitle}
							placeholder="Task title"
							class="task-input"
							required
						/>
						<textarea
							bind:value={editingTaskDescription}
							placeholder="Add details..."
							class="description-input"
							rows="2"
						></textarea>
						<div class="form-row">
							<select bind:value={editingTaskPriority} class="priority-select">
								<option value="low">Low</option>
								<option value="medium">Medium</option>
								<option value="high">High</option>
								<option value="urgent">Urgent</option>
							</select>
							<select bind:value={editingTaskProject} class="project-select">
								<option value={null}>No Project</option>
								{#each $projects as project}
									<option value={project.id}>{project.name}</option>
								{/each}
							</select>
						</div>
						<div class="assignee-field">
							{#if editingTaskAssignee}
								<div class="assignee-chip">
									<span class="assignee-dot" style="background-color: {registeredUsers.find(u => u.user_id === editingTaskAssignee)?.color || '#888'}"></span>
									<span>{getAssigneeName(editingTaskAssignee)}</span>
									<button type="button" class="chip-remove" on:click={() => editingTaskAssignee = null} title="Clear assignee">×</button>
								</div>
							{:else}
								<input
									type="text"
									placeholder="Assign to user..."
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
												on:click={() => {
													editingTaskAssignee = user.user_id;
													showUserDropdown = false;
													userSearchQuery = '';
												}}
											>
												<span class="assignee-item-dot" style="background-color: {user.color}"></span>
												<span>{user.username}</span>
											</button>
										{/each}
									</div>
								{/if}
							{/if}
						</div>
						<div class="form-actions">
							<button type="button" class="delete-btn" on:click={deleteEditingTask}>Delete</button>
							<button type="button" class="cancel-btn" on:click={closeEditMode}>Cancel</button>
							<button type="submit" class="submit-btn">Save</button>
						</div>
					</form>
				{:else}
					<!-- View Mode -->
					<div class="task-item {getPriorityClass(todo.priority)}">
						<button
							class="checkbox"
							class:checked={todo.status === 'done'}
							on:click={() => toggleTaskStatus(todo)}
						>
							{#if todo.status === 'done'}
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
									<polyline points="20 6 9 17 4 12"/>
								</svg>
							{/if}
						</button>
						<div class="task-content">
							<span class="task-title" class:completed={todo.status === 'done'}>{todo.title}</span>
							<div class="task-meta">
								{#if todo.assignedTo}
									<span class="assignee-tag">
										(o{getAssigneeName(parseInt(String(todo.assignedTo), 10))})
									</span>
								{/if}
								{#if todo.projectId}
									<span class="project-tag">{getProjectName(todo.projectId)}</span>
								{/if}
								{#if todo.dueDate}
									<span class="due-date" class:overdue={isOverdue(todo.dueDate)}>
										{formatDueDate(todo.dueDate)}
									</span>
								{/if}
							</div>
						</div>
						<button class="edit-btn" on:click={() => openEditMode(todo)} title="Edit task">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
								<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
							</svg>
						</button>
						<div class="priority-indicator"></div>
					</div>
				{/if}
			{/each}
		{/if}
	</div>
</div>

<style>
	.task-panel-container {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 1rem;
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1rem;
	}

	.panel-header h2 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--biz-text-primary, #f1f5f9);
	}

	.add-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		background: var(--biz-accent, #f59e0b);
		border: none;
		border-radius: 8px;
		color: white;
		cursor: pointer;
		transition: all 0.2s;
	}

	.add-btn:hover {
		background: var(--biz-accent-hover, #d97706);
		transform: scale(1.05);
	}

	/* Filter Tabs */
	.filter-tabs {
		display: flex;
		gap: 0.25rem;
		margin-bottom: 1rem;
		padding: 0.25rem;
		background: var(--biz-bg-tertiary, #243044);
		border-radius: 8px;
	}

	.filter-tab {
		flex: 1;
		padding: 0.5rem 0.75rem;
		background: transparent;
		border: none;
		border-radius: 6px;
		color: var(--biz-text-secondary, #94a3b8);
		font-size: 0.8rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	.filter-tab:hover {
		color: var(--biz-text-primary, #f1f5f9);
	}

	.filter-tab.active {
		background: var(--biz-bg-secondary, #1a2332);
		color: var(--biz-accent, #f59e0b);
	}

	/* Quick Add Form */
	.quick-add-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		background: var(--biz-bg-tertiary, #243044);
		border-radius: 10px;
		margin-bottom: 1rem;
	}

	.task-input {
		padding: 0.75rem;
		background: var(--biz-bg-primary, #0f1419);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.9rem;
	}

	.task-input:focus {
		outline: none;
		border-color: var(--biz-accent, #f59e0b);
	}

	.form-row {
		display: flex;
		gap: 0.5rem;
	}

	.priority-select,
	.project-select {
		flex: 1;
		padding: 0.5rem;
		background: var(--biz-bg-primary, #0f1419);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 6px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.85rem;
	}

	.form-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
	}

	.cancel-btn {
		padding: 0.5rem 1rem;
		background: transparent;
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 6px;
		color: var(--biz-text-secondary, #94a3b8);
		font-size: 0.85rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.cancel-btn:hover {
		background: var(--biz-bg-hover, #2a3a4d);
		color: var(--biz-text-primary, #f1f5f9);
	}

	.submit-btn {
		padding: 0.5rem 1rem;
		background: var(--biz-accent, #f59e0b);
		border: none;
		border-radius: 6px;
		color: white;
		font-size: 0.85rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	.submit-btn:hover {
		background: var(--biz-accent-hover, #d97706);
	}

	/* Task List */
	.task-list {
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 3rem 1rem;
		color: var(--biz-text-muted, #64748b);
		text-align: center;
	}

	.empty-state svg {
		margin-bottom: 1rem;
		opacity: 0.5;
	}

	.empty-state p {
		margin: 0;
		font-size: 0.9rem;
	}

	/* Task Item */
	.task-item {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem;
		background: var(--biz-bg-tertiary, #243044);
		border-radius: 8px;
		border-left: 3px solid var(--priority-color, var(--biz-border));
		transition: all 0.2s;
	}

	.task-item:hover {
		background: var(--biz-bg-hover, #2a3a4d);
	}

	.edit-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		background: transparent;
		border: none;
		color: var(--biz-text-secondary, #94a3b8);
		cursor: pointer;
		transition: all 0.2s;
		flex-shrink: 0;
		padding: 0;
	}

	.edit-btn:hover {
		color: var(--biz-accent, #f59e0b);
	}

	.edit-task-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		background: var(--biz-bg-tertiary, #243044);
		border-radius: 8px;
		margin-bottom: 0.5rem;
		border: 1px solid var(--biz-accent, #f59e0b);
	}

	.form-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.5rem;
	}

	.form-header h3 {
		margin: 0;
		font-size: 0.9rem;
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

	.form-actions {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
		margin-top: 0.5rem;
	}

	.delete-btn {
		padding: 0.4rem 0.8rem;
		background: var(--biz-danger, #ef4444);
		border: none;
		border-radius: 6px;
		color: white;
		font-size: 0.8rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
		margin-right: auto;
	}

	.delete-btn:hover {
		background: var(--biz-danger-hover, #dc2626);
	}

	.cancel-btn,
	.submit-btn {
		padding: 0.4rem 0.8rem;
		border: none;
		border-radius: 6px;
		font-size: 0.8rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	.cancel-btn {
		background: transparent;
		border: 1px solid var(--biz-border, #2d3a4d);
		color: var(--biz-text-secondary, #94a3b8);
	}

	.cancel-btn:hover {
		background: var(--biz-bg-hover, #2a3a4d);
		color: var(--biz-text-primary, #f1f5f9);
	}

	.submit-btn {
		background: var(--biz-accent, #f59e0b);
		color: white;
	}

	.submit-btn:hover {
		background: var(--biz-accent-hover, #d97706);
	}

	.task-item.priority-urgent { --priority-color: #ef4444; }
	.task-item.priority-high { --priority-color: #f97316; }
	.task-item.priority-medium { --priority-color: #eab308; }
	.task-item.priority-low { --priority-color: #22c55e; }

	.checkbox {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		background: transparent;
		border: 2px solid var(--biz-border-light, #3d4a5d);
		border-radius: 4px;
		color: white;
		cursor: pointer;
		transition: all 0.2s;
		flex-shrink: 0;
		margin-top: 2px;
	}

	.checkbox:hover {
		border-color: var(--biz-accent, #f59e0b);
	}

	.checkbox.checked {
		background: var(--biz-success, #10b981);
		border-color: var(--biz-success, #10b981);
	}

	.task-content {
		flex: 1;
		min-width: 0;
	}

	.task-assignee-badge {
		font-size: 0.7rem;
		color: var(--biz-accent, #f59e0b);
		font-weight: 600;
		margin-bottom: 0.2rem;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		display: block;
	}

	.task-title {
		display: block;
		font-size: 0.9rem;
		color: var(--biz-text-primary, #f1f5f9);
		line-height: 1.4;
		word-break: break-word;
	}

	.task-title.completed {
		text-decoration: line-through;
		color: var(--biz-text-muted, #64748b);
	}

	.task-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.35rem;
	}

	.project-tag {
		font-size: 0.7rem;
		padding: 0.15rem 0.5rem;
		background: var(--biz-info-soft, rgba(59, 130, 246, 0.15));
		color: var(--biz-info, #3b82f6);
		border-radius: 4px;
	}

	.due-date {
		font-size: 0.7rem;
		color: var(--biz-text-muted, #64748b);
	}

	.due-date.overdue {
		color: var(--biz-danger, #ef4444);
		font-weight: 500;
	}

	.priority-indicator {
		display: none;
	}

	.description-input {
		width: 100%;
		padding: 0.75rem;
		background: var(--biz-bg-primary, #0f1419);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 8px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.9rem;
		font-family: inherit;
		resize: vertical;
		min-height: 50px;
	}

	.description-input:focus {
		outline: none;
		border-color: var(--biz-accent, #f59e0b);
	}

	.assignee-field {
		position: relative;
	}

	.assignee-input {
		width: 100%;
		padding: 0.5rem;
		background: var(--biz-bg-primary, #0f1419);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 6px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.85rem;
		font-family: inherit;
	}

	.assignee-input:focus {
		outline: none;
		border-color: var(--biz-accent, #f59e0b);
	}

	.assignee-dropdown {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		background: var(--biz-bg-secondary, #1a2332);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-top: none;
		border-radius: 0 0 6px 6px;
		max-height: 150px;
		overflow-y: auto;
		z-index: 50;
		margin-top: -1px;
	}

	.assignee-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.5rem 0.75rem;
		background: transparent;
		border: none;
		color: var(--biz-text-primary, #f1f5f9);
		cursor: pointer;
		text-align: left;
		font-size: 0.85rem;
		transition: all 0.2s;
	}

	.assignee-item:hover {
		background: var(--biz-bg-tertiary, #243044);
	}

	.assignee-item-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.assignee-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.4rem 0.6rem;
		background: var(--biz-bg-tertiary, #243044);
		border: 1px solid var(--biz-border, #2d3a4d);
		border-radius: 16px;
		color: var(--biz-text-primary, #f1f5f9);
		font-size: 0.8rem;
		white-space: nowrap;
		margin-bottom: 0.5rem;
	}

	.assignee-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.chip-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		background: transparent;
		border: none;
		color: var(--biz-text-secondary, #94a3b8);
		cursor: pointer;
		font-size: 1rem;
		padding: 0;
		transition: all 0.2s;
		margin-left: 0.2rem;
	}

	.chip-remove:hover {
		color: var(--biz-text-primary, #f1f5f9);
	}

	.assignee-tag {
		font-size: 0.7rem;
		padding: 0.15rem 0.5rem;
		background: var(--biz-info-soft, rgba(59, 130, 246, 0.15));
		color: var(--biz-info, #3b82f6);
		border-radius: 4px;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		white-space: nowrap;
	}

	/* Mobile styles */
	@media (max-width: 768px) {
		.task-panel-container {
			padding: 0.75rem;
		}

		.panel-header h2 {
			font-size: 1rem;
		}

		.filter-tabs {
			margin-bottom: 0.75rem;
		}

		.filter-tab {
			padding: 0.4rem 0.5rem;
			font-size: 0.75rem;
		}

		.task-item {
			padding: 0.6rem;
			gap: 0.5rem;
		}

		.task-title {
			font-size: 0.85rem;
		}

		.task-list {
			/* Hide scrollbar on mobile */
			-ms-overflow-style: none;
			scrollbar-width: none;
		}

		.task-list::-webkit-scrollbar {
			display: none;
		}
	}
</style>
