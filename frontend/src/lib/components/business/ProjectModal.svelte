<script lang="ts">
	import { projects } from '$lib/business/store';
	import { pipableChannels } from '$lib/business/plannerScopes';
	import type { Project, ItemSignature } from '$lib/business/types';
	import SignatureRow from './SignatureRow.svelte';

	export let editingProject: Project | null = null;
	export let projectName = '';
	export let projectDescription = '';
	export let projectColor = '#5865f2';
	export let projectStartDate = '';
	export let projectTargetDate = '';
	export let projectParentId = '';
	/** Optional channel link — "pipe" this plan to a channel. */
	export let projectChannelId = '';
	/** Draft sign-offs (two-way bound with the host form). */
	export let projectDraftSignatures: ItemSignature[] = [];
	/** Legacy read-only signer shown when the project predates multi-sign. */
	export let projectLegacySignedBy: string | undefined = undefined;
	export let colorOptions: string[] = [];
	export let onClose: () => void = () => {};
	export let onSubmit: () => void = () => {};
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
			<h2>{editingProject ? 'Edit Project' : 'New Project'}</h2>
			<button class="close-btn" on:click={onClose}>&times;</button>
		</div>
		<form on:submit|preventDefault={onSubmit}>
			<div class="form-group">
				<label for="projectName">Name *</label>
				<input id="projectName" type="text" bind:value={projectName} required />
			</div>

			<div class="form-group">
				<label for="projectDesc">Description</label>
				<textarea id="projectDesc" bind:value={projectDescription} rows="2"></textarea>
			</div>

			<div class="form-group">
				<label for="projectParent">Parent Project</label>
				<select id="projectParent" bind:value={projectParentId}>
					<option value="">No parent (root project)</option>
					{#each $projects.filter(p => p.id !== editingProject?.id) as project}
						<option value={project.id}>{project.name}</option>
					{/each}
				</select>
			</div>

			<div class="form-group">
				<label for="projectChannel">Pipe to channel (optional)</label>
				<select id="projectChannel" bind:value={projectChannelId}>
					<option value="">Personal (this device only)</option>
					{#each $pipableChannels as channel (channel.id)}
						<option value={channel.id}>#{channel.name}</option>
					{/each}
				</select>
			</div>

			<div class="form-group">
				<span class="form-group-label">Color</span>
				<div class="color-picker">
					{#each colorOptions as color}
						<button
							type="button"
							class="color-option"
							class:selected={projectColor === color}
							style="background-color: {color}"
							aria-label={`Select project color ${color}`}
							on:click={() => projectColor = color}
						></button>
					{/each}
				</div>
			</div>

			<div class="form-row">
				<div class="form-group">
					<label for="startDate">Start Date</label>
					<input id="startDate" type="date" bind:value={projectStartDate} />
				</div>
				<div class="form-group">
					<label for="targetDate">Target End Date</label>
					<input id="targetDate" type="date" bind:value={projectTargetDate} />
				</div>
			</div>

			<div class="form-group">
				<SignatureRow bind:draftSignatures={projectDraftSignatures} legacySignedBy={projectLegacySignedBy} label="Sign-off" />
			</div>

			<div class="form-actions">
				<button type="button" class="cancel-btn" on:click={onClose}>Cancel</button>
				<button type="submit" class="submit-btn">
					{editingProject ? 'Save Changes' : 'Create Project'}
				</button>
			</div>
		</form>
	</div>
</div>
