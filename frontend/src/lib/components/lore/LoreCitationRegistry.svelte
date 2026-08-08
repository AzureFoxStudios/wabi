<script lang="ts">
	import LoreCitationChip from './LoreCitationChip.svelte';

	interface Props {
		citations: Array<{
			id: string;
			file_path: string;
			start_line: number;
			end_line: number;
			mode: 'Pinned' | 'Tracking';
			branch?: string;
			revision?: string;
			label?: string;
			drift?: 'Current' | 'Drifted' | 'Missing';
		}>;
		onCitationClick: (id: string) => void;
		onPin: (id: string) => void;
		onUpdate: (id: string) => void;
	}

	let { citations, onCitationClick, onPin, onUpdate }: Props = $props();

	let driftCount = $derived(citations.filter(c => c.drift === 'Drifted').length);
</script>

<div class="citation-registry">
	<div class="registry-header">
		<span class="registry-title">Code Citations</span>
		<span class="registry-count">{citations.length}</span>
		{#if driftCount > 0}
			<span class="drift-badge">{driftCount} drifted</span>
		{/if}
	</div>

	{#if citations.length === 0}
		<div class="registry-empty">No code citations yet. Use ^c/ in chat to create one.</div>
	{:else}
		<div class="citation-list">
			{#each citations as citation (citation.id)}
				<LoreCitationChip
					citation={citation}
					drift={citation.drift}
					onClick={() => onCitationClick(citation.id)}
					onPin={() => onPin(citation.id)}
					onUpdate={() => onUpdate(citation.id)}
				/>
			{/each}
		</div>
	{/if}
</div>

<style>
	.citation-registry {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.registry-header {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding-bottom: var(--space-1);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
	}

	.registry-title {
		font-weight: 600;
		color: var(--text-heading);
		font-size: var(--font-size-sm);
	}

	.registry-count {
		font-size: var(--font-size-xs);
		color: var(--text-muted);
		background: var(--surface-raised);
		padding: 2px 8px;
		border-radius: var(--radius-full);
	}

	.drift-badge {
		font-size: var(--font-size-xs);
		color: var(--color-warning, #f59e0b);
		background: color-mix(in srgb, var(--color-warning, #f59e0b) 15%, transparent);
		padding: 2px 8px;
		border-radius: var(--radius-full);
		margin-left: auto;
	}

	.registry-empty {
		color: var(--text-muted);
		font-size: var(--font-size-sm);
		text-align: center;
		padding: var(--space-3);
	}

	.citation-list {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}
</style>