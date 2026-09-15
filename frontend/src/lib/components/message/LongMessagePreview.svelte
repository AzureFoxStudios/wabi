<script lang="ts">
	import type { Message } from '$lib/socket';
	import { openReaderDocument } from '$lib/readerWorkspace';
	import { createLongMessageExcerpt, getLongMessageStats } from './longMessagePreview';

	export let message: Message;
	export let text: string;
	export let contextLabel = '';
	export let spoiler = false;

	$: excerpt = createLongMessageExcerpt(text);
	$: stats = getLongMessageStats(text);
	$: readerTitle = contextLabel
		? `Message from ${message.user} · ${contextLabel}`
		: `Message from ${message.user}`;

	function openInReader(): void {
		openReaderDocument(readerTitle, text, 'markdown', 'chat', undefined, String(message.id));
	}
</script>

<article class="long-message-preview" aria-label="Long message preview">
	<div class="long-message-header">
		<div class="long-message-heading">
			<span class="long-message-icon" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
					<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
				</svg>
			</span>
			<div>
				<div class="long-message-kicker">{spoiler ? 'Long spoiler message' : 'Long message'}</div>
				<div class="long-message-title">Open in Reader for the full post</div>
			</div>
		</div>
		<span class="long-message-reader-label">Reader</span>
	</div>

	<div class="long-message-meta" aria-label="Message length">
		<span>{stats.characterCount.toLocaleString()} chars</span>
		<span aria-hidden="true">·</span>
		<span>{stats.wordCount.toLocaleString()} words</span>
		<span aria-hidden="true">·</span>
		<span>~{stats.readMinutes} min read</span>
	</div>

	{#if spoiler}
		<p class="long-message-spoiler-copy">
			Preview hidden because this message is marked as a spoiler. Opening Reader reveals the full message.
		</p>
	{:else}
		<p class="long-message-excerpt">{excerpt}</p>
	{/if}

	<div class="long-message-actions">
		<button type="button" class="long-message-open" on:click|stopPropagation={openInReader}>
			<span>{spoiler ? 'Reveal in Reader' : 'Open in Reader'}</span>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="m9 18 6-6-6-6" />
			</svg>
		</button>
		<span class="long-message-hint">Full markdown, comfortable width, reading progress</span>
	</div>
</article>

<style>
	.long-message-preview {
		width: min(100%, 46rem);
		box-sizing: border-box;
		margin-top: 0.2rem;
		padding: 0.8rem 0.9rem;
		border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.12));
		border-radius: var(--radius-md, 10px);
		background: var(--surface-elevated, rgba(255, 255, 255, 0.045));
		box-shadow: 0 1px 0 rgba(0, 0, 0, 0.08);
	}

	.long-message-header,
	.long-message-heading,
	.long-message-meta,
	.long-message-actions,
	.long-message-open {
		display: flex;
		align-items: center;
	}

	.long-message-header {
		justify-content: space-between;
		gap: 0.75rem;
	}

	.long-message-heading {
		gap: 0.6rem;
		min-width: 0;
	}

	.long-message-icon {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		flex: 0 0 auto;
		border-radius: var(--radius-sm, 7px);
		background: var(--accent-soft, rgba(110, 180, 170, 0.14));
		color: var(--accent, currentColor);
	}

	.long-message-icon svg {
		width: 1rem;
		height: 1rem;
	}

	.long-message-kicker {
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.045em;
		text-transform: uppercase;
		color: var(--text-muted, rgba(255, 255, 255, 0.58));
	}

	.long-message-title {
		margin-top: 0.08rem;
		font-size: 0.92rem;
		font-weight: 650;
		color: var(--text-heading, inherit);
	}

	.long-message-reader-label {
		flex: 0 0 auto;
		padding: 0.2rem 0.45rem;
		border-radius: 999px;
		background: var(--accent-soft, rgba(110, 180, 170, 0.12));
		font-size: 0.7rem;
		font-weight: 650;
		color: var(--text-muted, inherit);
	}

	.long-message-meta {
		gap: 0.35rem;
		margin-top: 0.65rem;
		font-size: 0.72rem;
		color: var(--text-muted, rgba(255, 255, 255, 0.56));
		font-variant-numeric: tabular-nums;
	}

	.long-message-excerpt,
	.long-message-spoiler-copy {
		margin: 0.65rem 0 0;
		line-height: 1.42;
		font-size: 0.88rem;
		color: var(--text-primary, inherit);
	}

	.long-message-excerpt {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		mask-image: linear-gradient(to bottom, #000 78%, transparent 100%);
	}

	.long-message-spoiler-copy {
		padding: 0.65rem 0.7rem;
		border-radius: var(--radius-sm, 7px);
		background: rgba(0, 0, 0, 0.16);
		color: var(--text-muted, inherit);
	}

	.long-message-actions {
		gap: 0.65rem;
		margin-top: 0.7rem;
		flex-wrap: wrap;
	}

	.long-message-open {
		gap: 0.35rem;
		min-height: 2rem;
		padding: 0.38rem 0.65rem;
		border: 1px solid var(--accent-border, rgba(110, 180, 170, 0.35));
		border-radius: var(--radius-sm, 7px);
		background: var(--accent-soft, rgba(110, 180, 170, 0.12));
		color: var(--text-heading, inherit);
		font: inherit;
		font-size: 0.8rem;
		font-weight: 650;
		cursor: pointer;
	}

	.long-message-open:hover {
		background: var(--accent-soft-hover, rgba(110, 180, 170, 0.2));
	}

	.long-message-open:focus-visible {
		outline: 2px solid var(--accent, currentColor);
		outline-offset: 2px;
	}

	.long-message-open svg {
		width: 0.85rem;
		height: 0.85rem;
	}

	.long-message-hint {
		font-size: 0.72rem;
		color: var(--text-muted, rgba(255, 255, 255, 0.5));
	}

	@media (max-width: 640px) {
		.long-message-preview {
			padding: 0.7rem 0.75rem;
		}

		.long-message-reader-label,
		.long-message-hint {
			display: none;
		}
	}
</style>
