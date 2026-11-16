<script lang="ts">
	import { _ } from '$lib/i18n';
	import { kanbanColumns, projects } from '$lib/business/store';
	import type { Todo, TodoStatus } from '$lib/business/types';
	import SignatureRow from './SignatureRow.svelte';

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
	export let draftSignatures: import('$lib/business/types').ItemSignature[] = [];
	export let legacySignedBy: string | undefined = undefined;
	export let handleSubmit: () => void;
	export let closeModal: () => void;
</script>

<div
	class="modal-overlay todo-task-modal"
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
			<h2>{editingTodo ? $_('ttm.edit_task') : $_('ttm.add_task_new')}</h2>
			<button class="close-btn" on:click={closeModal}>&times;</button>
		</div>
		<form on:submit|preventDefault={handleSubmit}>
			<div class="form-group">
				<label for="title">{$_('reader_doc.title_label')} *</label>
				<input id="title" type="text" bind:value={formTitle} placeholder={$_('ttm.title_ph')} required />
			</div>

			<div class="form-group">
				<label for="description">{$_('donation_config.description')}</label>
				<textarea id="description" bind:value={formDescription} placeholder={$_('ttm.desc_ph')} rows="3"></textarea>
			</div>

			<div class="form-row">
				<div class="form-group">
					<label for="priority">{$_('kan.kick_priority')}</label>
					<select id="priority" bind:value={formPriority}>
						<option value="low">{$_('kan.pri_low')}</option>
						<option value="medium">{$_('kan.pri_medium')}</option>
						<option value="high">{$_('kan.pri_high')}</option>
						<option value="urgent">{$_('kan.pri_urgent')}</option>
					</select>
				</div>

				<div class="form-group">
					<label for="status">{$_('project_schedule.th_status')}</label>
					<select id="status" bind:value={formStatus}>
						{#each $kanbanColumns as column}
							<option value={column.id}>{column.label}</option>
						{/each}
					</select>
				</div>
			</div>

			<div class="form-row">
				<div class="form-group">
					<label for="dueDate">{$_('ttm.due_date')}</label>
					<input id="dueDate" type="date" bind:value={formDueDate} />
				</div>

				{#if $projects.length > 0}
					<div class="form-group">
						<label for="project">{$_('places.project')}</label>
						<select id="project" bind:value={formProjectId}>
							<option value="">{$_('ttm.no_project')}</option>
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
					<span>{$_('ttm.track_estimate')}</span>
				</label>
			</div>

			{#if formHasTimeEstimate}
				<div class="form-group">
					<label for="estimatedHours">{$_('ttm.est_hours')}</label>
					<input id="estimatedHours" type="number" min="0.25" step="0.25" bind:value={formEstimatedHours} />
				</div>
			{/if}

			<div class="form-group">
				<label for="tags">{$_('ttm.tags')}</label>
				<input id="tags" type="text" bind:value={formTags} placeholder={$_('ttm.tags_ph')} />
			</div>

			<div class="form-group">
				<SignatureRow bind:draftSignatures {legacySignedBy} label={$_('project_modal.names_attached')} />
			</div>

			<div class="form-actions">
				<button type="button" class="cancel-btn" on:click={closeModal}>{$_('common.cancel')}</button>
				<button type="submit" class="submit-btn">
					{editingTodo ? $_('project_modal.save_changes') : $_('ttm.add_task')}
				</button>
			</div>
		</form>
	</div>
</div>
