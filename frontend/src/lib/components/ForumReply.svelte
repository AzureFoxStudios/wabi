<script lang="ts">
	import ProfileMedia from './ProfileMedia.svelte';
	import { mediaUrl } from '$lib/mediaUrl';
	import ForumBody from './ForumBody.svelte';
	import { forumAuthors, canManageForumPost } from '$lib/forumIdentity';
	import { currentUser } from '$lib/presenceIdentity';
	import type { ForumPost } from '$lib/forumStore';
	import { formatForumTime, extractForumAttachments, resolveForumFileUrl, stripForumImageMarkdown, formatForumFileSize } from '$lib/forumStore';
	import { forumMillis, forumScore, forumVersionNote, forumVoteLabel } from '$lib/forumView';
	import { forumShareItems } from '$lib/forumMenus';
	import { inkFor } from '$lib/theme/identity';
	import { slugify } from '$lib/objectRefRegistry';
	import Icon from './ui/Icon.svelte';
	import Menu from './ui/Menu.svelte';

	export let reply: ForumPost;
	export let isSolution = false;
	export let onVote: (direction: 'up' | 'down') => void;
	export let onMarkSolution: () => void;
	export let channelId: string;
	export let onDelete: () => void = () => {};
	export let deleting = false;
	/** The vote cast on this reply from this view, if any (the server does not report it). */
	export let myVote: 'up' | 'down' | undefined = undefined;
	export let voting = false;
	export let canVote = true;
	export let canMarkSolution = true;

	$: author = $forumAuthors.get(reply.author_user_id);
	$: authorName = author?.username ?? `Member #${reply.author_user_id}`;
	$: attachments = reply.attachments ?? extractForumAttachments(reply.body);
	$: textBody = stripForumImageMarkdown(reply.body);
	$: score = forumScore(reply);
	$: menuItems = forumShareItems(
		{
			kind: 'forum_post' as const,
			id: reply.post_id,
			slug: slugify(reply.title),
			title: reply.title,
			channelId,
			subtitle: author?.username,
		},
		canManageForumPost($currentUser, reply.author_user_id)
			? [{ id: 'delete-reply', label: 'Delete reply', icon: 'trash', danger: true, disabled: deleting, onSelect: onDelete }]
			: [],
	);
	$: edited = forumVersionNote(reply, formatForumTime);
</script>

<article class="forum-reply" class:is-solution={isSolution} aria-label={`Reply from ${authorName}`}>
	<span class="forum-av forum-av--28" style={$inkFor(author?.color || author?.roleColor)} aria-hidden="true">
		{#if author?.profilePicture}<ProfileMedia src={mediaUrl(author.profilePicture)} alt="" />{:else}{(authorName.trim().charAt(0) || '?').toUpperCase()}{/if}
	</span>
	<div class="forum-reply-main">
		<p class="forum-reply-meta">
			<span class="forum-reply-author" style={$inkFor(author?.color || author?.roleColor)} title={author ? undefined : 'This author is not in the server member directory.'}>{authorName}</span>
			<time class="forum-reply-time" datetime={new Date(forumMillis(reply.created_at_micros)).toISOString()}>{formatForumTime(reply.created_at_micros)}</time>
			{#if reply.edited_at_micros}<span class="forum-reply-edited">{edited}</span>{/if}
			{#if isSolution}<span class="forum-solved"><Icon name="checkCircle" size={14} />Solved</span>{/if}
		</p>
		<div class="forum-reply-body"><ForumBody text={textBody} /></div>
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
							<Icon name="file" size={18} />
							<span class="forum-file-card-name">{attachment.name}</span>
							{#if attachment.size}<span class="forum-file-card-size">{formatForumFileSize(attachment.size)}</span>{/if}
						</a>
					{/each}
				</div>
			{/if}
		{/if}
		<div class="forum-actions">
			<div class="forum-vote" role="group" aria-label={`Votes on ${authorName}'s reply`}>
				<button
					type="button"
					class="forum-vote-btn"
					aria-pressed={myVote === 'up'}
					aria-label={forumVoteLabel('up', score)}
					disabled={!canVote || voting}
					on:click={() => onVote('up')}
				><Icon name="chevUp" size={16} /></button>
				<span class="forum-vote-score" aria-hidden="true">{score}</span>
				<button
					type="button"
					class="forum-vote-btn"
					aria-pressed={myVote === 'down'}
					aria-label={forumVoteLabel('down', score)}
					disabled={!canVote || voting}
					on:click={() => onVote('down')}
				><Icon name="chevDown" size={16} /></button>
			</div>
			{#if canMarkSolution && !isSolution}
				<button type="button" class="w-btn w-btn--quiet w-btn--sm forum-mark-solution" on:click={onMarkSolution}>
					<Icon name="check" size={14} />
					Mark as solution
				</button>
			{/if}
			<Menu class="w-ibtn w-ibtn--sm forum-more" label="Reply actions" triggerLabel={`Actions for ${authorName}'s reply`} align="end" items={menuItems}>
				<Icon name="more" />
			</Menu>
		</div>
	</div>
</article>
