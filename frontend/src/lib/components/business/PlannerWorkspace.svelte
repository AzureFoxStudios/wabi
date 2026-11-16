<!--
	My Planner's account frame: storage notices (where the problem is, inside the visible area,
	§7.16) above the Planner itself. The save state lives in row A ("Changes not yet saved" /
	"Saved 09:41"), not in a strip here, and the locality is said once there.
-->
<script lang="ts">
	import { _ } from '$lib/i18n';
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

<section class="planner-account" aria-label={$_('planner.label')}>
	{#if $plannerStorage.error}
		<div class="planner-notices">
			{#if $plannerStorage.loaded}
				<Notice title={$_('planner.cannot_save_title')} text={$_('planner.cannot_save_text')}>
					{#snippet actions()}
						<button type="button" class="w-btn w-btn--sm" onclick={() => run(flushBusinessStorage, $_('planner.save_failed_again'))}>{$_('planner.retry_save')}</button>
						<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={() => run(exportDraft, $_('planner.export_failed'))}>{$_('planner.export_draft')}</button>
						<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={() => run(keepDraftAndReload, $_('planner.load_saved_failed'))}>{$_('planner.download_and_load')}</button>
					{/snippet}
				</Notice>
			{:else}
				<Notice title={$_('planner.not_opened_title')} text={$_('planner.not_opened_text')} onretry={reloadFromStorage} />
			{/if}
		</div>
	{/if}
	{#if $plannerStorage.legacy}
		<div class="planner-notices">
			<Notice tone="info" title={$_('planner.legacy_title')} text={$_('planner.legacy_text')}>
				{#snippet actions()}
					<button type="button" class="w-btn w-btn--sm" onclick={() => run(downloadLegacyPlanner, $_('planner.older_failed'))}>{$_('planner.download_older')}</button>
				{/snippet}
			</Notice>
		</div>
	{/if}
	{#if $plannerStorage.recoveryCount > 0}
		<div class="planner-notices">
			<Notice tone="warn" title={$_('planner.recovery_title')} text={$_('planner.recovery_text')}>
				{#snippet actions()}
					<button type="button" class="w-btn w-btn--sm" onclick={() => run(downloadPlannerRecovery, $_('planner.recovery_failed'))}>{$_('planner.download_recovery')}</button>
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
			<LoadLine label={$_('planner.opening')} />
			<Skeleton rows={4} label={$_('planner.opening')} />
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
