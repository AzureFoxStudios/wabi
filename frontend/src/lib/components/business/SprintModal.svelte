<script lang="ts">
	import { _ } from '$lib/i18n';
	import type { Sprint, ItemSignature } from '$lib/business/types';
	import SignatureRow from './SignatureRow.svelte';

	export let editingSprint: Sprint | null = null;
	export let sprintName = '';
	export let sprintStartDate = '';
	export let sprintEndDate = '';
	export let sprintGoals = '';
	/** Draft sign-offs (two-way bound with the host form). */
	export let sprintDraftSignatures: ItemSignature[] = [];
	/** Legacy read-only signer shown when the sprint predates multi-sign. */
	export let sprintLegacySignedBy: string | undefined = undefined;
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
			<h2>{editingSprint ? $_('sprint_modal.edit_sprint') : $_('sprint_modal.new_sprint')}</h2>
			<button class="close-btn" on:click={onClose}>&times;</button>
		</div>
		<form on:submit|preventDefault={onSubmit}>
			<div class="form-group">
				<label for="sprintName">{$_('sprint_modal.name_required')}</label>
				<input id="sprintName" type="text" bind:value={sprintName} placeholder={$_('sprint_modal.name_placeholder')} required />
			</div>

			<div class="form-row">
				<div class="form-group">
					<label for="sprintStart">{$_('sprint_modal.start_date')}</label>
					<input id="sprintStart" type="date" bind:value={sprintStartDate} required />
				</div>
				<div class="form-group">
					<label for="sprintEnd">{$_('sprint_modal.end_date')}</label>
					<input id="sprintEnd" type="date" bind:value={sprintEndDate} required />
				</div>
			</div>

			<div class="form-group">
				<label for="sprintGoals">{$_('sprint_modal.goals')}</label>
				<textarea id="sprintGoals" bind:value={sprintGoals} rows="3" placeholder={$_('sprint_modal.goals_placeholder')}></textarea>
			</div>

			<div class="form-group">
				<SignatureRow bind:draftSignatures={sprintDraftSignatures} legacySignedBy={sprintLegacySignedBy} label={$_('sprint_modal.names_attached')} />
			</div>

			<div class="form-actions">
				{#if editingSprint}
					<button type="button" class="delete-btn" on:click={() => onDeleteSprint(editingSprint)} disabled={isReadOnly} title={isReadOnly ? $_('sprint_modal.read_only_mode') : $_('admin.actions.delete')}>{$_('admin.actions.delete')}</button>
				{/if}
				<div style="flex: 1;"></div>
				<button type="button" class="cancel-btn" on:click={onClose}>{$_('common.cancel')}</button>
				<button type="submit" class="submit-btn">{editingSprint ? $_('sprint_modal.save_changes') : $_('sprint_modal.create_sprint')}</button>
			</div>
		</form>
	</div>
</div>
