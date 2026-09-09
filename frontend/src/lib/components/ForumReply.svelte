<script lang="ts">
	import type { ForumPost } from '$lib/forumStore';
	import { findAuthor, formatForumTime, extractForumAttachments, resolveForumFileUrl, stripForumImageMarkdown, formatForumFileSize } from '$lib/forumStore';
	import ObjectShareMenu from './ObjectShareMenu.svelte';
	import { slugify } from '$lib/objectRefRegistry';

	export let reply: ForumPost;
	export let isSolution = false;
	export let onVote: (direction: 'up' | 'down') => void;
	export let onMarkSolution: () => void;
	export let channelId: string;

	$: author = findAuthor(reply.author_user_id);
	$: attachments = reply.attachments ?? extractForumAttachments(reply.body);
	$: textBody = stripForumImageMarkdown(reply.body);
	$: shareRecord = {
		kind: 'forum_post' as const,
		id: reply.post_id,
		slug: slugify(reply.title),
		title: reply.title,
		channelId,
		subtitle: author?.username,
	};
</script>

<div class="forum-reply {isSolution ? 'reply-solution' : ''}">
	{#if isSolution}
		<div class="forum-reply-solution-badge">&#10003; Solution</div>
	{/if}
	<div class="forum-reply-meta">
		{#if author}
			<div
				class="forum-reply-avatar"
				style="background: {author.color || author.roleColor || 'var(--accent-primary)'};"
			>
				{author.username.charAt(0).toUpperCase()}
			</div>
			<span class="forum-reply-author">{author.username}</span>
		{:else}
			<div class="forum-reply-avatar" style="background: var(--accent-primary);">?</div>
			<span class="forum-reply-author">User #{reply.author_user_id}</span>
		{/if}
		<span>·</span>
		<span>{formatForumTime(reply.created_at_micros)}</span>
	</div>
	<div class="forum-reply-body">{textBody}</div>
	{#if attachments.length > 0}
		<div class="forum-files-gallery" class:has-more={attachments.length > 4}>
			{#each attachments.slice(0, 4) as attachment, index}
				<div class="forum-gallery-file-item" class:last-item={index === 3 && attachments.length > 4}>
					<a href={resolveForumFileUrl(attachment.url)} target="_blank" rel="noopener noreferrer" title={attachment.name}>
						<img
							src={resolveForumFileUrl(attachment.url)}
							alt={attachment.name}
							class="forum-gallery-file-image"
							loading="lazy"
							decoding="async"
						/>
					</a>
					{#if index === 3 && attachments.length > 4}
						<div class="forum-more-overlay">
							<span class="forum-more-count">+{attachments.length - 4}</span>
						</div>
					{/if}
				</div>
			{/each}
		</div>
		{#if attachments.length > 4}
			<div class="forum-file-card-list">
				{#each attachments.slice(4) as attachment}
					<a class="forum-file-card" href={resolveForumFileUrl(attachment.url)} target="_blank" rel="noopener noreferrer">
						<span class="forum-file-card-icon" aria-hidden="true">&#128196;</span>
						<span class="forum-file-card-name">{attachment.name}</span>
						{#if attachment.size}<span class="forum-file-card-size">{formatForumFileSize(attachment.size)}</span>{/if}
					</a>
				{/each}
			</div>
		{/if}
	{/if}
	<div class="forum-reply-actions">
		<button class="forum-action-btn" on:click={() => onVote('up')}>&#9650; {reply.votes_up}</button>
		<button class="forum-action-btn" on:click={() => onVote('down')}>&#9660; {reply.votes_down}</button>
		{#if !isSolution}
			<button class="forum-action-btn solution" on:click={onMarkSolution}>&#10003; Mark solution</button>
		{/if}
		<ObjectShareMenu record={shareRecord} />
	</div>
</div>
