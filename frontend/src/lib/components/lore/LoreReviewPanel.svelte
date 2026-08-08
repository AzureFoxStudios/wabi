<script lang="ts">
	interface Props {
		review: {
			id: string;
			title: string;
			source_branch: string;
			target_branch: string;
			status: 'Open' | 'Approved' | 'ChangesRequested' | 'Merged' | 'Closed';
			author_id: string;
			commit_count: number;
			file_change_count: number;
			insertions: number;
			deletions: number;
		};
		onApprove: () => void;
		onRequestChanges: () => void;
		onMerge: () => void;
		onClose: () => void;
	}

	let { review, onApprove, onRequestChanges, onMerge, onClose }: Props = $props();

	let statusColor = $derived(() => {
		switch (review.status) {
			case 'Open': return 'var(--accent-primary)';
			case 'Approved': return 'var(--color-success, #22c55e)';
			case 'ChangesRequested': return 'var(--color-warning, #f59e0b)';
			case 'Merged': return 'var(--color-info, #3b82f6)';
			case 'Closed': return 'var(--text-muted)';
		}
	});
</script>

<div class="review-panel">
	<div class="review-header">
		<div class="review-title-group">
			<span class="review-status" style="background: {statusColor()}">{review.status}</span>
			<h3 class="review-title">{review.title}</h3>
		</div>
		<div class="review-actions">
			{#if review.status === 'Open'}
				<button class="action-btn approve" onclick={onApprove}>Approve</button>
				<button class="action-btn changes" onclick={onRequestChanges}>Request Changes</button>
			{/if}
			{#if review.status === 'Approved'}
				<button class="action-btn merge" onclick={onMerge}>Merge</button>
			{/if}
			{#if review.status !== 'Merged' && review.status !== 'Closed'}
				<button class="action-btn close" onclick={onClose}>Close</button>
			{/if}
		</div>
	</div>

	<div class="review-meta">
		<span class="meta-item">
			<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
			{review.source_branch} → {review.target_branch}
		</span>
		<span class="meta-item">📦 {review.commit_count} commits</span>
		<span class="meta-item">📄 {review.file_change_count} files</span>
		<span class="meta-item diff-stats">
			<span class="insertions">+{review.insertions}</span>
			<span class="deletions">-{review.deletions}</span>
		</span>
	</div>
</div>

<style>
	.review-panel {
		padding: var(--space-2);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
	}

	.review-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--space-2);
		margin-bottom: var(--space-2);
	}

	.review-title-group {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.review-status {
		font-size: var(--font-size-xs);
		padding: 2px 8px;
		border-radius: var(--radius-sm);
		color: white;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.review-title {
		margin: 0;
		font-size: var(--font-size-base);
		color: var(--text-heading);
	}

	.review-actions {
		display: flex;
		gap: var(--space-1);
	}

	.action-btn {
		padding: var(--space-1) var(--space-2);
		border: none;
		border-radius: var(--radius-sm);
		font-size: var(--font-size-xs);
		font-weight: 600;
		cursor: pointer;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.action-btn.approve {
		background: var(--color-success, #22c55e);
		color: white;
	}

	.action-btn.changes {
		background: var(--color-warning, #f59e0b);
		color: white;
	}

	.action-btn.merge {
		background: var(--accent-primary);
		color: white;
	}

	.action-btn.close {
		background: var(--surface-raised);
		color: var(--text-secondary);
	}

	.action-btn:hover {
		filter: brightness(1.1);
	}

	.review-meta {
		display: flex;
		gap: var(--space-3);
		font-size: var(--font-size-xs);
		color: var(--text-muted);
		align-items: center;
	}

	.meta-item {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}

	.diff-stats {
		display: flex;
		gap: var(--space-1);
	}

	.insertions {
		color: var(--color-success, #22c55e);
	}

	.deletions {
		color: var(--color-danger, #ef4444);
	}
</style>