<script lang="ts">
	import { kanbanColumns, projects } from '$lib/business';
	import type { Todo, TodoStatus, ItemSignature } from '$lib/business/types';
	import SignatureRow from './SignatureRow.svelte';

	interface RegisteredUser {
		user_id: number;
		username: string;
		profile_picture?: string;
		color: string;
	}

	export let editingTodo: Todo | null = null;
	export let isReadOnly = false;
	export let registeredUsers: RegisteredUser[] = [];
	export let filteredUsers: RegisteredUser[] = [];
	export let showUserDropdown = false;
	export let formTitle = '';
	export let formDescription = '';
	export let formPriority: Todo['priority'] = 'medium';
	export let formProjectId: string | null = null;
	export let formDueDate = '';
	export let formAssigneeId: number | null = null;
	export let formHasTimeEstimate = false;
	export let formEstimatedHours = '1';
	/** Draft sign-offs (two-way bound with the host form). */
	export let draftSignatures: ItemSignature[] = [];
	/** Legacy read-only signer shown when the item predates multi-sign. */
	export let legacySignedBy: string | undefined = undefined;
	export let userSearchQuery = '';
	export let targetColumn: TodoStatus = 'todo';
	export let closeModal: () => void;
	export let handleSubmit: () => void;
	export let handleDelete: (todo: Todo) => void;
	export let filterUsers: (query: string) => void;
	export let selectUser: (user: RegisteredUser) => void;
	export let clearAssignee: () => void;
	export let getAssigneeName: (userId: number | undefined) => string;
</script>

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
		role="dialog"
		aria-modal="true"
		aria-label={editingTodo ? 'Edit task' : 'Add task'}
		tabindex="-1"
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
			<h2>{editingTodo ? 'Edit Task' : 'Add Task'}</h2>
			<button class="close-btn" on:click={closeModal}>&times;</button>
		</div>
		<form on:submit|preventDefault={handleSubmit}>
			<div class="form-group">
				<label for="title">Title *</label>
				<input id="title" type="text" bind:value={formTitle} placeholder="Task title" required />
			</div>

			<div class="form-group">
				<label for="description">Description</label>
				<textarea id="description" bind:value={formDescription} placeholder="Add more details..." rows="3"></textarea>
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
							id="assignee"
							type="text"
							bind:value={userSearchQuery}
							on:input={(e) => filterUsers((e.target as HTMLInputElement).value)}
							on:focus={() => showUserDropdown = true}
							placeholder="Search users..."
							autocomplete="off"
						/>
						{#if showUserDropdown && filteredUsers.length > 0}
							<div class="assignee-dropdown">
								{#each filteredUsers as user (user.user_id)}
									<button type="button" class="assignee-option" on:click={() => selectUser(user)}>
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
					<input id="estimatedHours" type="number" min="0.25" step="0.25" bind:value={formEstimatedHours} />
				</div>
			{/if}

			<div class="form-group">
				<SignatureRow bind:draftSignatures {legacySignedBy} label="Sign-off" />
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
