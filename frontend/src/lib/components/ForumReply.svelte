<script lang="ts">
	import type { ForumPost } from '$lib/forumStore';
	import { findAuthor, formatForumTime } from '$lib/forumStore';
	import ObjectShareMenu from './ObjectShareMenu.svelte';
	import { slugify } from '$lib/objectRefRegistry';

	export let reply: ForumPost;
	export let isSolution = false;
	export let onVote: (direction: 'up' | 'down') => void;
	export let onMarkSolution: () => void;
	export let channelId: string;

	$: author = findAuthor(reply.author_user_id);
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
	<div class="forum-reply-body">{reply.body}</div>
	<div class="forum-reply-actions">
		<button class="forum-action-btn" on:click={() => onVote('up')}>&#9650; {reply.votes_up}</button>
		<button class="forum-action-btn" on:click={() => onVote('down')}>&#9660; {reply.votes_down}</button>
		{#if !isSolution}
			<button class="forum-action-btn solution" on:click={onMarkSolution}>&#10003; Mark solution</button>
		{/if}
		<ObjectShareMenu record={shareRecord} />
	</div>
</div>
