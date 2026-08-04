<script lang="ts">
	import { onDestroy } from 'svelte';
	import { currentChannel, channels, currentUser } from '$lib/socket';
	import {
		forumThreadsStore,
		forumPostsByThreadStore,
		forumLoadingStore,
		forumErrorStore,
		forumSelectedThreadIdStore,
		loadThreads,
		loadPosts,
		createThread,
		createPost,
		votePost,
		markSolution,
		findAuthor,
		formatForumTime,
		getDefaultCategories,
		categorizeThread,
		tagClass,
		type ForumPost,
	} from '$lib/forumStore';
	import SurfaceHeader from './SurfaceHeader.svelte';
	import SurfaceToolbar from './SurfaceToolbar.svelte';
	import ForumPostRow from './ForumPostRow.svelte';
	import ForumReply from './ForumReply.svelte';
	import ForumComposer from './ForumComposer.svelte';
	import { initObjectRefRegistry, registerObjectRef, slugify } from '$lib/objectRefRegistry';
	import ObjectShareMenu from './ObjectShareMenu.svelte';
	import { peekPendingNav, takePendingNav } from '$lib/pendingNav';

	$: activeChannel = $channels.find((ch) => ch.id === $currentChannel) || null;
	$: allThreads = $forumThreadsStore;
	$: postsByThread = $forumPostsByThreadStore;
	$: isLoading = $forumLoadingStore;
	$: error = $forumErrorStore;
	$: selectedThreadId = $forumSelectedThreadIdStore;

	let activeCategory: string | null = null;
	let searchQuery = '';
	let showNewThread = false;

	initObjectRefRegistry();

	$: if (allThreads.length > 0 && $currentChannel) {
		for (const thread of allThreads) {
			registerObjectRef({
				kind: 'forum_post',
				id: thread.post_id,
				slug: slugify(thread.title),
				title: thread.title,
				channelId: $currentChannel,
				subtitle: findAuthor(thread.author_user_id)?.username || undefined,
				updatedAt: thread.created_at_micros > 1e12 ? Math.floor(thread.created_at_micros / 1000) : thread.created_at_micros,
			});
		}
	}

	$: categories = getDefaultCategories();
	$: categorizedThreads = allThreads.filter((t) => {
		if (activeCategory && activeCategory !== 'all' && categorizeThread(t) !== activeCategory) return false;
		if (searchQuery) {
			const q = searchQuery.toLowerCase();
			if (
				!t.title.toLowerCase().includes(q) &&
				!t.body.toLowerCase().includes(q) &&
				!t.tags.some((tag) => tag.toLowerCase().includes(q))
			)
				return false;
		}
		return true;
	});

	$: categoryCounts = new Map<string, number>();
	$: {
		const counts = new Map<string, number>();
		for (const t of allThreads) {
			const cat = categorizeThread(t);
			counts.set(cat, (counts.get(cat) || 0) + 1);
		}
		categoryCounts = counts;
	}

	$: selectedThread = allThreads.find((t) => t.post_id === selectedThreadId) || null;
	$: selectedPosts = selectedThreadId ? (postsByThread.get(selectedThreadId) || []) : [];
	$: threadStarter = selectedPosts.find((p) => p.is_thread_starter) || selectedThread;
	$: threadReplies = selectedPosts.filter((p) => !p.is_thread_starter && p.post_id !== threadStarter?.post_id);
	$: hasSolution = threadReplies.some((r) => r.is_solution);
	$: canCurrentUserPost = Boolean($currentUser?.dbUserId);

	$: threadStarterAuthor = threadStarter ? findAuthor(threadStarter.author_user_id) : undefined;

	function selectThread(thread: ForumPost) {
		forumSelectedThreadIdStore.set(thread.post_id);
		if ($currentChannel) {
			loadPosts($currentChannel, thread.thread_id);
		}
	}

	$: if ($currentChannel) {
		loadThreads($currentChannel);
	}

	// C2: deep-link handoff after threads load — peek first, take only on hit
	$: if ($currentChannel && allThreads.length > 0) {
		const pending = peekPendingNav();
		if (
			pending?.kind === 'forum_post' &&
			(!pending.channelId || pending.channelId === $currentChannel)
		) {
			const hit =
				allThreads.find((t) => t.post_id === pending.postId) ||
				allThreads.find((t) => t.thread_id === pending.postId);
			if (hit) {
				takePendingNav('forum_post', $currentChannel);
				selectThread(hit);
			}
		}
	}

	function handleSearch(q: string) {
		searchQuery = q;
	}

	function handlePill(key: string) {
		activeCategory = key === 'all' ? null : key;
	}

	function handleNewThread() {
		showNewThread = true;
	}

	function handleCancelNewThread() {
		showNewThread = false;
	}

	async function handleCreateNewThread(body: string, title?: string) {
		if (!$currentChannel) return;
		const post = await createThread($currentChannel, body, title);
		if (post) {
			showNewThread = false;
			selectThread(post);
		}
	}

	async function handleReply(body: string) {
		if (!$currentChannel || !selectedThreadId) return;
		await createPost($currentChannel, selectedThreadId, body);
	}

	async function handleVote(post: ForumPost, direction: 'up' | 'down') {
		if (!$currentChannel) return;
		await votePost($currentChannel, post.thread_id, post.post_id, direction);
	}

	async function handleMarkSolution(post: ForumPost) {
		if (!$currentChannel) return;
		await markSolution($currentChannel, post.thread_id, post.post_id);
	}

	function handleFilterByCategory(cat: string) {
		activeCategory = activeCategory === cat ? null : cat;
	}

	onDestroy(() => {
		forumSelectedThreadIdStore.set(null);
	});
</script>

<div class="forum-channel">
	<SurfaceHeader
		title={activeChannel?.name || 'Forum'}
	/>

	<SurfaceToolbar
		searchPlaceholder="Search threads..."
		pills={[
			{ key: 'all', label: 'All', active: !activeCategory },
			...categories.map((cat) => ({
				key: cat,
				label: cat,
				active: activeCategory === cat,
			})),
		]}
		onSearch={handleSearch}
		onPill={handlePill}
	/>

	<div class="forum-body">
		{#if isLoading}
			<div class="forum-loading">
				<div class="forum-loading-spinner"></div>
				<span>Loading forum...</span>
			</div>
		{:else if error}
			<div class="forum-error">
				<span>{error}</span>
				<button on:click={() => $currentChannel && loadThreads($currentChannel)}>Retry</button>
			</div>
		{:else}
			<div class="forum-category-pane">
				<div class="forum-category-header">
					<span>Categories</span>
					{#if canCurrentUserPost}
						<button class="forum-new-thread-btn" on:click={handleNewThread} title="New Thread">+</button>
					{/if}
				</div>
				<div class="forum-category-list">
					<button
						class="forum-category-item"
						class:active={!activeCategory}
						on:click={() => handleFilterByCategory('all')}
					>
						<span class="forum-category-dot" style="background: var(--accent-primary);"></span>
						All
						<span class="forum-category-count">{allThreads.length}</span>
					</button>
					{#each categories as cat}
						<button
							class="forum-category-item"
							class:active={activeCategory === cat}
							on:click={() => handleFilterByCategory(cat)}
						>
							<span
								class="forum-category-dot"
								style="background: {cat === 'Bug'
									? 'var(--color-danger)'
									: cat === 'Feature'
										? 'var(--color-success)'
										: 'var(--accent-primary)'};"
							></span>
							{cat}
							<span class="forum-category-count">{categoryCounts.get(cat) || 0}</span>
						</button>
					{/each}
				</div>
			</div>

			<div class="forum-post-list">
				{#if categorizedThreads.length === 0}
					<div class="forum-empty">
						<span>No threads found</span>
					</div>
				{:else}
					{#each categorizedThreads as thread (thread.post_id)}
						<ForumPostRow
							{thread}
							active={thread.post_id === selectedThreadId}
							onClick={() => selectThread(thread)}
							channelId={$currentChannel}
						/>
					{/each}
				{/if}
			</div>

			<div class="forum-reading-pane">
				{#if showNewThread}
					<div class="forum-reading-content">
						<div class="forum-post-detail">
							<h2 class="forum-post-detail-title">New Thread</h2>
						</div>
					</div>
					<ForumComposer
						showTitle={true}
						placeholder="Write your post... Use **bold** `code` @mentions"
						onSubmit={handleCreateNewThread}
						onCancel={handleCancelNewThread}
					/>
				{:else if !selectedThread}
					<div class="forum-reading-empty">
						<div class="forum-reading-empty-icon">
							<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
								<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
							</svg>
						</div>
						<span>Select a thread to read</span>
					</div>
				{:else}
					<div class="forum-reading-content">
						{#if threadStarter}
							<div class="forum-post-detail">
								<div class="forum-post-detail-tags">
									{#each threadStarter.tags as tag}
										<span class="forum-tag {tagClass(tag)}">{tag}</span>
									{/each}
									{#if hasSolution}
										<span class="forum-solved-badge">&#10003; Solved</span>
									{/if}
								</div>
								<h1 class="forum-post-detail-title">{threadStarter.title}</h1>
								<div class="forum-post-detail-meta">
									{#if threadStarterAuthor}
										<div
											class="forum-post-detail-avatar"
											style="background: {threadStarterAuthor.color || threadStarterAuthor.roleColor || 'var(--accent-primary)'};"
										>
											{threadStarterAuthor.username.charAt(0).toUpperCase()}
										</div>
										<span class="forum-post-detail-author">{threadStarterAuthor.username}</span>
									{:else}
										<div class="forum-post-detail-avatar" style="background: var(--accent-primary);">?</div>
										<span class="forum-post-detail-author">User #{threadStarter.author_user_id}</span>
									{/if}
									<span>·</span>
									<span>{formatForumTime(threadStarter.created_at_micros)}</span>
									<span>·</span>
									<span>&#128065; {threadStarter.votes_up + threadStarter.votes_down} views</span>
								</div>
								<div class="forum-post-detail-body">{threadStarter.body}</div>
								<div class="forum-post-detail-actions">
									<button
										class="forum-action-btn"
										on:click={() => handleVote(threadStarter, 'up')}
									>
										&#9650; {threadStarter.votes_up}
									</button>
									<button
										class="forum-action-btn"
										on:click={() => handleVote(threadStarter, 'down')}
									>
										&#9660; {threadStarter.votes_down}
									</button>
									<ObjectShareMenu
										record={{
											kind: 'forum_post',
											id: threadStarter.post_id,
											slug: slugify(threadStarter.title),
											title: threadStarter.title,
											channelId: $currentChannel,
											subtitle: threadStarterAuthor?.username,
										}}
									/>
								</div>
							</div>
						{/if}

						{#if threadReplies.length > 0}
							<div class="forum-replies-section">
								<div class="forum-replies-header">{threadReplies.length} Replies</div>
								{#each threadReplies as reply (reply.post_id)}
									<ForumReply
										{reply}
										isSolution={reply.is_solution}
										onVote={(direction) => handleVote(reply, direction)}
										onMarkSolution={() => handleMarkSolution(reply)}
										channelId={$currentChannel}
									/>
								{/each}
							</div>
						{/if}
					</div>

					<ForumComposer
						placeholder="Write a reply... Ctrl+Enter to post"
						onSubmit={handleReply}
					/>
				{/if}
			</div>
		{/if}
	</div>
</div>
