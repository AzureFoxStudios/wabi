<script lang="ts">
	import { kanbanColumns, projects } from '$lib/business/store';
	import type { Todo, TodoStatus } from '$lib/business/types';

	export let editingTodo: Todo | null = null;
	export let formTitle = '';
	export let formDescription = '';
	export let formPriority: Todo['priority'] = 'medium';
	export let formStatus: TodoStatus = 'todo';
	export let formDueDate = '';
	export let formProjectId = '';
	export let formTags = '';
	export let formHasTimeEstimate = false;
	export let formEstimatedHours = '1';
	export let willSign = false;
	export let handleSubmit: () => void;
	export let closeModal: () => void;
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
		role="button"
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
			<h2>{editingTodo ? 'Edit Task' : 'Add New Task'}</h2>
			<button class="close-btn" on:click={closeModal}>&times;</button>
		</div>
		<form on:submit|preventDefault={handleSubmit}>
			<div class="form-group">
				<label for="title">Title *</label>
				<input id="title" type="text" bind:value={formTitle} placeholder="What needs to be done?" required />
			</div>

			<div class="form-group">
				<label for="description">Description</label>
				<textarea id="description" bind:value={formDescription} placeholder="Add more details..." rows="3"></textarea>
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
					<input id="estimatedHours" type="number" min="0.25" step="0.25" bind:value={formEstimatedHours} />
				</div>
			{/if}

			<div class="form-group">
				<label for="tags">Tags (comma separated)</label>
				<input id="tags" type="text" bind:value={formTags} placeholder="e.g., bug, feature, urgent" />
			</div>

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
