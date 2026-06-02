<script lang="ts">
	import type { Sprint } from '$lib/business/types';

	export let editingSprint: Sprint | null = null;
	export let sprintName = '';
	export let sprintStartDate = '';
	export let sprintEndDate = '';
	export let sprintGoals = '';
	export let sprintWillSign = false;
	export let isReadOnly = false;
	export let onClose: () => void = () => {};
	export let onSubmit: () => void = () => {};
	export let onDeleteSprint: (sprint: Sprint) => void = () => {};
</script>

<div
	class="modal-overlay"
	role="button"
	tabindex="0"
	on:click={onClose}
	on:keydown={(event) => {
		const tag = (event.target as HTMLElement).tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onClose();
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
			<h2>{editingSprint ? 'Edit Sprint' : 'New Sprint'}</h2>
			<button class="close-btn" on:click={onClose}>&times;</button>
		</div>
		<form on:submit|preventDefault={onSubmit}>
			<div class="form-group">
				<label for="sprintName">Name *</label>
				<input id="sprintName" type="text" bind:value={sprintName} placeholder="Sprint 1" required />
			</div>

			<div class="form-row">
				<div class="form-group">
					<label for="sprintStart">Start Date *</label>
					<input id="sprintStart" type="date" bind:value={sprintStartDate} required />
				</div>
				<div class="form-group">
					<label for="sprintEnd">End Date *</label>
					<input id="sprintEnd" type="date" bind:value={sprintEndDate} required />
				</div>
			</div>

			<div class="form-group">
				<label for="sprintGoals">Goals (one per line)</label>
				<textarea id="sprintGoals" bind:value={sprintGoals} rows="3" placeholder="Complete user auth&#10;Fix critical bugs&#10;Deploy to staging"></textarea>
			</div>

			<div class="form-group checkbox-group">
				<label class="checkbox-label">
					<input type="checkbox" bind:checked={sprintWillSign} />
					<span>Sign this sprint with my username</span>
				</label>
			</div>

			<div class="form-actions">
				{#if editingSprint}
					<button type="button" class="delete-btn" on:click={() => onDeleteSprint(editingSprint)} disabled={isReadOnly} title={isReadOnly ? 'Read-only mode' : 'Delete'}>Delete</button>
				{/if}
				<div style="flex: 1;"></div>
				<button type="button" class="cancel-btn" on:click={onClose}>Cancel</button>
				<button type="submit" class="submit-btn">{editingSprint ? 'Save Changes' : 'Create Sprint'}</button>
			</div>
		</form>
	</div>
</div>
