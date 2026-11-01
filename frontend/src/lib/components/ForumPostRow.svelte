<script lang="ts">
	import { forumAuthors } from '$lib/forumIdentity';
	import type { ForumPost } from '$lib/forumStore';
	import { formatForumTime, categorizeThread, extractForumAttachments, resolveForumFileUrl, stripForumImageMarkdown } from '$lib/forumStore';
	import { wikiCardExcerpt } from '$lib/forumPreview';
	import { forumPoints, forumScore } from '$lib/forumView';
	import { forumShareItems } from '$lib/forumMenus';
	import { slugify } from '$lib/objectRefRegistry';
	import Icon from './ui/Icon.svelte';
	import Menu from './ui/Menu.svelte';

	export let thread: ForumPost;
	export let active = false;
	/** Show the category on the row: only when the list mixes categories (forumRowsShowCategory). */
	export let showCategory = false;
	export let onClick: () => void;
	export let channelId: string;

	$: author = $forumAuthors.get(thread.author_user_id);
	$: authorName = author?.username ?? `Member #${thread.author_user_id}`;
	$: category = categorizeThread(thread);
	$: excerpt = wikiCardExcerpt(stripForumImageMarkdown(thread.body));
	$: attachments = thread.attachments ?? extractForumAttachments(thread.body);
	$: previewImages = attachments.slice(0, 3);
	$: points = forumPoints(forumScore(thread));
	$: menuItems = forumShareItems({
		kind: 'forum_post',
		id: thread.post_id,
		slug: slugify(thread.title),
		title: thread.title,
		channelId,
		subtitle: author?.username,
	});
</script>

<!-- The row is one button (Enter opens the thread); its ⋯ sits beside it, never inside it. -->
<div class="forum-post-row" class:active>
	<button type="button" class="forum-post-row-open" aria-current={active ? 'true' : undefined} on:click={onClick}>
		{#if showCategory || thread.is_solution}
			<span class="forum-post-row-kicker">
				{#if showCategory}<span class="w-kicker">{category}</span>{/if}
				{#if thread.is_solution}<span class="forum-solved"><Icon name="checkCircle" size={14} />Solved</span>{/if}
			</span>
		{/if}
		<span class="forum-post-row-title">{thread.title}</span>
		{#if excerpt}<span class="forum-post-row-excerpt">{excerpt}</span>{/if}
		{#if previewImages.length > 0}
			<span class="forum-post-row-images" aria-hidden="true">
				{#each previewImages as attachment}
					<span class="forum-post-row-thumb"><img src={resolveForumFileUrl(attachment.url)} alt="" loading="lazy" decoding="async" /></span>
				{/each}
				{#if attachments.length > previewImages.length}
					<span class="forum-post-row-more-count">+{attachments.length - previewImages.length}</span>
				{/if}
			</span>
		{/if}
		<span class="forum-post-row-meta">
			<span class="forum-post-row-author" title={author ? undefined : 'This author is not in the server member directory.'}>{authorName}</span>
			<span aria-hidden="true">·</span>
			<span>{formatForumTime(thread.created_at_micros)}</span>
			<span aria-hidden="true">·</span>
			<span>{points}</span>
			{#if attachments.length > 0}<span class="sr-only">, {attachments.length} {attachments.length === 1 ? 'image' : 'images'}</span>{/if}
		</span>
	</button>
	<div class="forum-post-row-tools">
		<Menu class="w-ibtn forum-more" label="Thread actions" triggerLabel={`Actions for ${thread.title}`} align="end" items={menuItems}>
			<Icon name="more" />
		</Menu>
	</div>
</div>
