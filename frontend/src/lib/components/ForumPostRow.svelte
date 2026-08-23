<script lang="ts">
	import type { ForumPost } from '$lib/forumStore';
	import { findAuthor, formatForumTime, categorizeThread, tagClass } from '$lib/forumStore';
	import ObjectShareMenu from './ObjectShareMenu.svelte';
	import RoleBadge from './RoleBadge.svelte';
	import { slugify } from '$lib/objectRefRegistry';

	export let thread: ForumPost;
	export let active = false;
	export let onClick: () => void;
	export let channelId: string;

	$: author = findAuthor(thread.author_user_id);
	$: category = categorizeThread(thread);
	$: shareRecord = {
		kind: 'forum_post' as const,
		id: thread.post_id,
		slug: slugify(thread.title),
		title: thread.title,
		channelId,
		subtitle: author?.username,
	};
</script>

<div
	class="forum-post-row"
	class:active
	on:click={onClick}
	role="button"
	tabindex="0"
	on:keydown={(e) => { if (e.key === 'Enter') onClick(); }}
>
	<div class="forum-post-row-tags">
		{#each thread.tags as tag}
			<span class="forum-tag {tagClass(tag)}">{tag}</span>
		{/each}
		{#if thread.is_solution}
			<span class="forum-solved-badge">&#10003; Solved</span>
		{/if}
	</div>
	<div class="forum-post-row-title">{thread.title}</div>
	<div class="forum-post-row-meta">
		<div class="forum-post-row-author">
			{#if author}
				<div
					class="forum-post-row-avatar"
					style="background: {author.color || author.roleColor || 'var(--accent-primary)'};"
				>
					{author.username.charAt(0).toUpperCase()}
				</div>
				<span>{author.username}</span>
				<RoleBadge user={author} size="sm" />
			{:else}
				<div class="forum-post-row-avatar" style="background: var(--accent-primary);">?</div>
				<span>User #{thread.author_user_id}</span>
			{/if}
		</div>
		<span>·</span>
		<span>{formatForumTime(thread.created_at_micros)}</span>
		<div class="forum-post-row-stats">
			<span>&#128065; {thread.votes_up + thread.votes_down}</span>
			<span>&#128172; 0</span>
			<span>&#9650; {thread.votes_up}</span>
		</div>
	</div>
	<ObjectShareMenu record={shareRecord} />
</div>
