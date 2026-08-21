<script lang="ts">
	import { visibleKanbanColumns } from '$lib/business';
	import type { Todo, TodoStatus } from '$lib/business/types';

	export let sortedTodosByColumn: Record<TodoStatus, Todo[]>;
	export let dragOverColumn: TodoStatus | null = null;
	export let isReadOnly = false;
	export let getPriorityColor: (priority: Todo['priority']) => string;
	export let formatEstimateHours: (minutes: number | undefined) => string;
	export let getAssigneeName: (userId: number | undefined) => string;
	export let getAssigneeColor: (userId: number | undefined) => string = () => '#888';
	export let getProjectColor: (projectId: string | undefined) => string;
	export let getProjectName: (projectId: string | undefined) => string;
	export let formatDueDate: (timestamp: number | undefined) => string;
	export let isOverdue: (timestamp: number | undefined) => boolean;
	export let openAddModal: (column: TodoStatus) => void;
	export let handleDragOver: (event: DragEvent, status: TodoStatus) => void;
	export let handleDragLeave: () => void;
	export let handleDrop: (event: DragEvent, status: TodoStatus) => void;
	export let handleDragStart: (event: DragEvent, todo: Todo) => void;
	export let handleDragEnd: () => void;
	export let handleCardClick: (todo: Todo) => void;
</script>

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
						draggable={!isReadOnly}
						on:dragstart={(e) => handleDragStart(e, todo)}
						on:dragend={handleDragEnd}
						on:click={() => handleCardClick(todo)}
					>
						<div class="card-priority" style="background-color: {getPriorityColor(todo.priority)}"></div>
						<div class="card-content">
							<div class="card-title-row">
								<h3 class="card-title">{todo.title}</h3>
								<span class="card-edit-hint" aria-hidden="true">
									<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
										<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
										<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
									</svg>
								</span>
							</div>
							{#if todo.description}
								<p class="card-description">{todo.description.slice(0, 80)}{todo.description.length > 80 ? '...' : ''}</p>
							{/if}
							<div class="card-meta">
								{#if todo.estimatedMinutes}
									<span class="card-estimate">{formatEstimateHours(todo.estimatedMinutes)}</span>
								{/if}
								{#if todo.assignedTo}
									<span class="assignee-chip-card">
										<span class="assignee-dot" style="background-color: {getAssigneeColor(parseInt(String(todo.assignedTo), 10))}"></span>
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
								{#if (todo.signatures?.length ?? 0) > 0 || todo.signedBy}
									<span
										class="card-signed"
										title={todo.signatures?.length
											? `Signed off by ${todo.signatures.map((s) => s.name).join(', ')}`
											: `Signed by ${todo.signedBy}`}
									>
										<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
											<path d="M12 20h9" />
											<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
										</svg>
										{todo.signatures?.length ?? 1}
									</span>
								{/if}
							</div>
						</div>
					</div>
				{/each}
				{#if (sortedTodosByColumn[column.id] || []).length === 0}
					<button type="button" class="empty-column" on:click={() => openAddModal(column.id)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Add a task'}>
						<span class="empty-column-plus" aria-hidden="true">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
								<line x1="12" y1="5" x2="12" y2="19"/>
								<line x1="5" y1="12" x2="19" y2="12"/>
							</svg>
						</span>
						<span>Add a task</span>
						<span class="empty-column-hint">or drop one here</span>
					</button>
				{/if}
			</div>
		</div>
	{/each}
</div>
