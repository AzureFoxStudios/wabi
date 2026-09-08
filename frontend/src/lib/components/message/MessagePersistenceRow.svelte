<script lang="ts">
	let {
		persistenceState,
		persistenceError
	}: {
		persistenceState: 'failed' | 'retrying';
		persistenceError?: string;
	} = $props();
</script>

{#if persistenceState === 'failed' || persistenceState === 'retrying'}
	<div
		class="message-persistence-row"
		role="status"
		aria-live="polite"
		aria-atomic="true"
	>
		Earlier save status is unconfirmed.
		{#if persistenceError?.trim()}{persistenceError}{/if}
		Check this conversation’s history before sending again.
	</div>
{/if}

<style>
	.message-persistence-row {
		display: block;
		min-width: 0;
		max-width: 100%;
		margin-block: var(--space-1, 4px);
		padding-inline-start: var(--space-2, 8px);
		border-inline-start: 2px solid var(--text-warning);
		color: var(--text-secondary);
		font-size: var(--text-sm, 0.8125rem);
		line-height: 1.45;
		white-space: normal;
		overflow-wrap: anywhere;
		text-wrap: pretty;
	}
</style>
