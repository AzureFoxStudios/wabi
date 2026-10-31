<!--
	My Planner's account frame: storage notices (where the problem is, inside the visible area,
	§7.16) above the Planner itself. The save state lives in row A ("Changes not yet saved" /
	"Saved 09:41"), not in a strip here, and the locality is said once there.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import PlannerWorkspaceContent from './PlannerWorkspaceContent.svelte';
	import Notice from '$lib/components/ui/Notice.svelte';
	import LoadLine from '$lib/components/ui/LoadLine.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import { plannerStorage, reloadFromStorage, flushBusinessStorage, downloadLegacyPlanner,
		downloadPlannerRecovery, keepDraftAndReload, capturePlannerSession, downloadPlannerData } from '$lib/business/deviceStorage';
	import { showToast } from '$lib/toast';

	let { variant = 'full' }: { variant?: 'full' | 'compact' | 'detached' } = $props();

	onMount(reloadFromStorage);

	/** Runs a storage action; a failure is said in a plain sentence (the cause goes to the console). */
	async function run(action: () => unknown, failure: string) {
		try {
			await action();
		} catch (error) {
			console.error('Planner storage action failed', error);
			showToast(failure, 'error');
		}
	}

	function exportDraft() {
		const captured = capturePlannerSession();
		downloadPlannerData({ ...captured.session.data, version: '1.0', sourceScope: captured.session.scope }, 'wabi-planner-draft');
	}

	// The storage layer's own message can be a raw error: log it, say the cause plainly.
	$effect(() => {
		if ($plannerStorage.error) console.error('Planner storage:', $plannerStorage.error);
	});
</script>

<section class="planner-account" aria-label="My Planner">
	{#if $plannerStorage.error}
		<div class="planner-notices">
			{#if $plannerStorage.loaded}
				<Notice title="Changes could not be saved on this device" text="Your draft stays open here. Export it, or retry saving.">
					{#snippet actions()}
						<button type="button" class="w-btn w-btn--sm" onclick={() => run(flushBusinessStorage, 'Saving failed again. Your draft is still open.')}>Retry save</button>
						<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={() => run(exportDraft, 'Could not export the draft. It is still open here.')}>Export draft</button>
						<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={() => run(keepDraftAndReload, 'Could not load the saved version. Your draft is still open.')}>Download draft and load saved version</button>
					{/snippet}
				</Notice>
			{:else}
				<Notice title="Your Planner could not be opened" text="Nothing was changed. Sign in, or retry opening it." onretry={reloadFromStorage} />
			{/if}
		</div>
	{/if}
	{#if $plannerStorage.legacy}
		<div class="planner-notices">
			<Notice tone="info" title="Older Planner data is available to recover" text="It has no account owner. Download the original, then import it into the account it belongs to. The original stays intact.">
				{#snippet actions()}
					<button type="button" class="w-btn w-btn--sm" onclick={() => run(downloadLegacyPlanner, 'Could not download the older data. It is unchanged.')}>Download older data</button>
				{/snippet}
			</Notice>
		</div>
	{/if}
	{#if $plannerStorage.recoveryCount > 0}
		<div class="planner-notices">
			<Notice tone="warn" title="Drafts from competing edits are available" text="They were kept when two windows changed this Planner at once.">
				{#snippet actions()}
					<button type="button" class="w-btn w-btn--sm" onclick={() => run(downloadPlannerRecovery, 'Could not download the recovery copies. They are unchanged.')}>Download recovery copies</button>
				{/snippet}
			</Notice>
		</div>
	{/if}
	{#if $plannerStorage.loaded}
		{#key $plannerStorage.epoch}
			<PlannerWorkspaceContent {variant} />
		{/key}
	{:else if !$plannerStorage.error}
		<div class="planner-opening">
			<LoadLine label="Opening your Planner" />
			<Skeleton rows={4} label="Opening your Planner" />
		</div>
	{/if}
</section>

<style>
	.planner-account {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		min-width: 0;
		background: var(--w-bg);
		color: var(--w-text);
	}
	.planner-notices {
		flex: none;
		padding: 12px var(--w-gutter, 32px) 0;
	}
	.planner-opening {
		position: relative;
		padding: 24px var(--w-gutter, 32px);
	}
</style>
