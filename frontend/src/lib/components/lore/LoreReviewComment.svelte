<script lang="ts">
	interface Props {
		comment: {
			id: string;
			author_id: string;
			content: string;
			file_path: string;
			line_number: number;
			resolved: boolean;
		};
		onResolve: () => void;
		onReply: () => void;
	}

	let { comment, onResolve, onReply }: Props = $props();
</script>

<div class="review-comment {comment.resolved ? 'resolved' : ''}">
	<div class="comment-line-ref">
		📍 {comment.file_path}:{comment.line_number}
	</div>
	<div class="comment-body">
		<span class="comment-author">@{comment.author_id}</span>
		<p class="comment-text">{comment.content}</p>
	</div>
	<div class="comment-actions">
		{#if !comment.resolved}
			<button class="comment-action" onclick={onResolve}>✓ Resolve</button>
		{:else}
			<button class="comment-action" onclick={onResolve}>↻ Unresolve</button>
		{/if}
		<button class="comment-action" onclick={onReply}>↩ Reply</button>
	</div>
</div>

<style>
	.review-comment {
		padding: var(--space-2);
		border-left: 3px solid color-mix(in srgb, var(--accent-primary) 30%, transparent);
		background: var(--surface-raised);
		border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
		margin: var(--space-1) 0;
	}

	.review-comment.resolved {
		opacity: 0.6;
		border-left-color: var(--text-muted);
	}

	.comment-line-ref {
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		color: var(--text-muted);
		margin-bottom: var(--space-1);
	}

	.comment-body {
		margin-bottom: var(--space-1);
	}

	.comment-author {
		font-weight: 600;
		color: var(--accent-primary);
		font-size: var(--font-size-xs);
	}

	.comment-text {
		margin: var(--space-1) 0 0;
		color: var(--text-secondary);
		font-size: var(--font-size-sm);
		line-height: 1.5;
	}

	.comment-actions {
		display: flex;
		gap: var(--space-2);
	}

	.comment-action {
		background: transparent;
		border: none;
		color: var(--text-muted);
		font-size: var(--font-size-xs);
		cursor: pointer;
		padding: 2px 4px;
		border-radius: var(--radius-sm);
		transition: all var(--duration-fast);
	}

	.comment-action:hover {
		color: var(--text-heading);
		background: var(--surface-sunken);
	}
</style>