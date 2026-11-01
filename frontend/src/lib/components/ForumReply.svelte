<script lang="ts">
	import ProfileMedia from './ProfileMedia.svelte';
	import { mediaUrl } from '$lib/mediaUrl';
	import ForumBody from './ForumBody.svelte';
	import { forumAuthors, canManageForumPost } from '$lib/forumIdentity';
	import { currentUser } from '$lib/presenceIdentity';
	import type { ForumPost } from '$lib/forumStore';
	import { formatForumTime, extractForumAttachments, resolveForumFileUrl, stripForumImageMarkdown, formatForumFileSize } from '$lib/forumStore';
	import { forumMillis, forumScore, forumVersionNote, forumVoteLabel, forumVoteState } from '$lib/forumView';
	import { forumShareItems } from '$lib/forumMenus';
	import { inkFor } from '$lib/theme/identity';
	import { slugify } from '$lib/objectRefRegistry';
	import Icon from './ui/Icon.svelte';
	import Menu from './ui/Menu.svelte';
	import Notice from './ui/Notice.svelte';

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
	/** Offered to the thread's author on other people's replies, and to moderators (forumCanMarkSolution). */
	export let canMarkSolution = true;
	/** The solution request for this reply is running. */
	export let marking = false;
	/** A failure of an action on this reply, said under its actions (§7.16). */
	export let notice: { title: string; text: string; error: string } | null = null;
	export let onDismissNotice: (actions: HTMLElement | null) => void = () => {};
	export let draftSurface = 'center';

	let actionsEl: HTMLElement | null = null;
	$: up = forumVoteState('up', myVote, voting);
	$: down = forumVoteState('down', myVote, voting);
	$: noteId = `forum-vote-note-${draftSurface}-${reply.post_id}`;

	/** The notice lands in view: the reading pane scrolls only if it would fall outside. */
	function reveal(node: HTMLElement) {
		node.scrollIntoView?.({ block: 'nearest' });
	}

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
		<div class="forum-actions" bind:this={actionsEl}>
			<div class="forum-vote" role="group" aria-label={`Votes on ${authorName}'s reply`} aria-busy={voting}>
				<button
					type="button"
					class="forum-vote-btn"
					aria-pressed={up.pressed}
					aria-label={forumVoteLabel('up', score)}
					aria-disabled={up.locked ? 'true' : undefined}
					aria-describedby={myVote ? noteId : undefined}
					disabled={!canVote}
					on:click={() => onVote('up')}
				><Icon name="chevUp" size={16} /></button>
				<span class="forum-vote-score" aria-hidden="true">{score}</span>
				<button
					type="button"
					class="forum-vote-btn"
					aria-pressed={down.pressed}
					aria-label={forumVoteLabel('down', score)}
					aria-disabled={down.locked ? 'true' : undefined}
					aria-describedby={myVote ? noteId : undefined}
					disabled={!canVote}
					on:click={() => onVote('down')}
				><Icon name="chevDown" size={16} /></button>
				{#if myVote}<span id={noteId} hidden>Your vote is counted. A vote cannot be changed or taken back.</span>{/if}
			</div>
			{#if canMarkSolution && !isSolution}
				<button type="button" class="w-btn w-btn--quiet forum-mark-solution" aria-busy={marking} aria-disabled={marking ? 'true' : undefined} on:click={() => { if (!marking) onMarkSolution(); }}>
					<Icon name="check" size={14} />
					Mark as solution
				</button>
			{/if}
			<Menu class="w-ibtn forum-more" label="Reply actions" triggerLabel={`Actions for ${authorName}'s reply`} align="end" items={menuItems}>
				<Icon name="more" />
			</Menu>
		</div>
		{#if notice}
			<div class="forum-post-notice" use:reveal>
				<Notice title={notice.title} text={notice.text} error={notice.error} ondismiss={() => onDismissNotice(actionsEl)} />
			</div>
		{/if}
	</div>
</article>
