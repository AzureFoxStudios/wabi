<script lang="ts">
	import { get } from 'svelte/store';
	import { currentUser } from '$lib/socket';
	import { todos, projects, addTodo, updateTodo, deleteTodo, type Todo } from '$lib/business';
	import { getLocalMockUsers, isLocalMockApiMode } from '$lib/localMockApi';
	import { getServerUrl } from '$lib/serverUrl';
	import { getAuthToken } from '$lib/authSession';

	export let onClose: (() => void) | undefined = undefined;
	import { onMount, tick } from 'svelte';

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
	let newTaskHasTimeEstimate = false;
	let newTaskEstimatedHours = '1';
	let registeredUsers: RegisteredUser[] = [];
	let filteredUsers: RegisteredUser[] = [];
	let showUserDropdown = false;
	let userSearchQuery = '';
	let showAddForm = false;
	let quickAddTitleInput: HTMLInputElement | null = null;

	$: if (showAddForm) {
		void tick().then(() => quickAddTitleInput?.focus());
	}

	// Edit mode state
	let editingTaskId: string | null = null;
	let editingTaskTitle = '';
	let editingTaskDescription = '';
	let editingTaskPriority: Todo['priority'] = 'medium';
	let editingTaskProject: string | null = null;
	let editingTaskAssignee: number | null = null;
	let editingTaskHasTimeEstimate = false;
	let editingTaskEstimatedHours = '1';

	// Filter options
	type FilterType = 'all' | 'today' | 'overdue' | 'upcoming';
	/**
	 * Initial filter — lets host surfaces (Planner stat pills) open the panel
	 * pre-focused on Overdue/Today/etc. Only read on mount.
	 */
	export let initialFilter: FilterType = 'all';
	let activeFilter: FilterType = initialFilter;

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
				console.log('[TaskPanel] Fetched users:', data);
				registeredUsers = Array.isArray(data) ? data : [];
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
		editingTaskHasTimeEstimate =
			typeof todo.estimatedMinutes === 'number' && todo.estimatedMinutes > 0;
		editingTaskEstimatedHours = editingTaskHasTimeEstimate
			? (todo.estimatedMinutes! / 60).toString()
			: '1';
	}

	function closeEditMode() {
		editingTaskId = null;
		editingTaskTitle = '';
		editingTaskDescription = '';
		editingTaskPriority = 'medium';
		editingTaskProject = null;
		editingTaskAssignee = null;
		editingTaskHasTimeEstimate = false;
		editingTaskEstimatedHours = '1';
	}

	function saveEditedTask() {
		if (!editingTaskId || !editingTaskTitle.trim()) return;
		const todo = $todos.find(t => t.id === editingTaskId);
		if (!todo) return;

		updateTodo(editingTaskId, {
			title: editingTaskTitle.trim(),
			description: editingTaskDescription.trim() || undefined,
			priority: editingTaskPriority,
			estimatedMinutes:
				editingTaskHasTimeEstimate &&
				Number.isFinite(Number.parseFloat(editingTaskEstimatedHours)) &&
				Number.parseFloat(editingTaskEstimatedHours) > 0
					? Math.max(1, Math.round(Number.parseFloat(editingTaskEstimatedHours) * 60))
					: undefined,
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
			estimatedMinutes:
				newTaskHasTimeEstimate &&
				Number.isFinite(Number.parseFloat(newTaskEstimatedHours)) &&
				Number.parseFloat(newTaskEstimatedHours) > 0
					? Math.max(1, Math.round(Number.parseFloat(newTaskEstimatedHours) * 60))
					: undefined,
			projectId: newTaskProject,
			assignedTo: newTaskAssignee?.toString(),
			status: 'todo',
			createdBy: $currentUser?.id || 'unknown'
		});

		newTaskTitle = '';
		newTaskDescription = '';
		newTaskPriority = 'medium';
		newTaskProject = null;
		newTaskAssignee = null;
		newTaskHasTimeEstimate = false;
		newTaskEstimatedHours = '1';
		showAddForm = false;
	}

	function toggleTaskStatus(todo: Todo) {
		const newStatus = todo.status === 'done' ? 'todo' : 'done';
		updateTodo(todo.id, {
			status: newStatus,
			completedAt: newStatus === 'done' ? Date.now() : undefined
		});
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

	function formatEstimateHours(minutes: number | undefined): string {
		if (!minutes || minutes <= 0) return '';
		return `${(minutes / 60).toFixed(1)}h`;
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
		<div class="header-buttons">
			<button class="add-btn" on:click={() => showAddForm = !showAddForm} title="Add Task">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<line x1="12" y1="5" x2="12" y2="19"/>
					<line x1="5" y1="12" x2="19" y2="12"/>
				</svg>
			</button>
			{#if onClose}
				<button class="close-panel-btn" on:click={onClose} title="Close task panel">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<line x1="18" y1="6" x2="6" y2="18"/>
						<line x1="6" y1="6" x2="18" y2="18"/>
					</svg>
				</button>
			{/if}
		</div>
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
				bind:this={quickAddTitleInput}
				type="text"
				bind:value={newTaskTitle}
				placeholder="What needs to be done?"
				class="task-input"
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
			<label class="time-toggle">
				<input type="checkbox" bind:checked={newTaskHasTimeEstimate} />
				<span>Track time estimate for burndown</span>
			</label>
			{#if newTaskHasTimeEstimate}
				<input
					type="number"
					min="0.25"
					step="0.25"
					bind:value={newTaskEstimatedHours}
					class="task-input"
					placeholder="Estimated hours"
				/>
			{/if}
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
						<label class="time-toggle">
							<input type="checkbox" bind:checked={editingTaskHasTimeEstimate} />
							<span>Track time estimate for burndown</span>
						</label>
						{#if editingTaskHasTimeEstimate}
							<input
								type="number"
								min="0.25"
								step="0.25"
								bind:value={editingTaskEstimatedHours}
								class="task-input"
								placeholder="Estimated hours"
							/>
						{/if}
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
								{#if todo.estimatedMinutes}
									<span class="estimate-tag">{formatEstimateHours(todo.estimatedMinutes)}</span>
								{/if}
								{#if todo.assignedTo}
									<span class="assignee-tag">
										<span class="assignee-dot" style="background-color: {registeredUsers.find(u => u.user_id === parseInt(String(todo.assignedTo), 10))?.color || '#888'}"></span>
										<span>{getAssigneeName(parseInt(String(todo.assignedTo), 10))}</span>
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

