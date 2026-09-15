<script lang="ts">
	import { onMount } from 'svelte';
	import PlannerWorkspaceContent from './PlannerWorkspaceContent.svelte';
	import { plannerStorage, reloadFromStorage, flushBusinessStorage, downloadLegacyPlanner,
		downloadPlannerRecovery, keepDraftAndReload, capturePlannerSession, downloadPlannerData } from '$lib/business/deviceStorage';
	import { showToast } from '$lib/toast';
	export let variant: 'full' | 'compact' | 'detached' = 'full';
	onMount(reloadFromStorage);
	async function run(action: () => unknown) {
		try { await action(); } catch (error) { showToast(error instanceof Error ? error.message : 'Planner action failed.', 'error'); }
	}
	function exportDraft() {
		const captured = capturePlannerSession();
		downloadPlannerData({ ...captured.session.data, version: '1.0', sourceScope: captured.session.scope }, 'wabi-planner-draft');
	}
</script>

<section class="planner-account" aria-label="Planner">
	{#if $plannerStorage.error}
		<div class="storage-notice" role="alert">
			<p>{$plannerStorage.error}</p>
			{#if $plannerStorage.loaded}
				<button on:click={() => run(exportDraft)}>Export draft</button>
				<button on:click={() => run(flushBusinessStorage)}>Retry save</button>
				<button on:click={() => run(keepDraftAndReload)}>Download draft and load saved version</button>
			{:else}
				<button on:click={reloadFromStorage}>Retry storage</button>
			{/if}
		</div>
	{/if}
	{#if $plannerStorage.legacy}
		<details class="storage-notice">
			<summary>Older Planner data is available to recover</summary>
			<p>Older Planner data has no account owner. Download the original, then import it into the account it belongs to. The original stays intact.</p>
			<button on:click={() => run(downloadLegacyPlanner)}>Download older data</button>
		</details>
	{/if}
	{#if $plannerStorage.recoveryCount > 0}
		<div class="storage-notice">
			<p>Drafts from competing edits are available for this account.</p>
			<button on:click={() => run(downloadPlannerRecovery)}>Download recovery copies</button>
		</div>
	{/if}
	{#if $plannerStorage.loaded}
		<p class="save-state" role="status">{$plannerStorage.dirty ? 'Changes not yet saved' : 'Saved on this device for this account'}</p>
		{#key $plannerStorage.epoch}
			<PlannerWorkspaceContent {variant} />
		{/key}
	{:else if !$plannerStorage.error}
		<p class="save-state" role="status">Opening your Planner…</p>
	{/if}
</section>

<style>
	.planner-account { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; }
	.storage-notice { padding: 0.75rem 1rem; background: var(--surface-raised); color: var(--text-primary); border-bottom: 1px solid var(--border-default); }
	.storage-notice p { margin: 0 0 0.5rem; }
	.storage-notice button { margin: 0.25rem 0.5rem 0.25rem 0; padding: 0.4rem 0.7rem; border-radius: var(--radius-md); background: var(--surface-base); color: var(--text-primary); border: 1px solid var(--border-default); }
	.save-state { margin: 0; padding: 0.35rem 1rem; color: var(--text-secondary); font-size: 0.75rem; }
</style>
