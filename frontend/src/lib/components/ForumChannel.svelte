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
		renameForumCategory,
		findAuthor,
		formatForumTime,
		getDefaultCategories,
		categorizeThread,
		tagClass,
		extractForumAttachments,
		resolveForumFileUrl,
		stripForumImageMarkdown,
		formatForumFileSize,
		type ForumPost,
	} from '$lib/forumStore';
	import SurfaceHeader from './SurfaceHeader.svelte';
	import ForumPostRow from './ForumPostRow.svelte';
	import ForumReply from './ForumReply.svelte';
	import ForumComposer from './ForumComposer.svelte';
	import { initObjectRefRegistry, registerObjectRef, slugify } from '$lib/objectRefRegistry';
	import ObjectShareMenu from './ObjectShareMenu.svelte';
	import { peekPendingNav, takePendingNav } from '$lib/pendingNav';

	export let channelId: string | undefined = undefined;
	$: effectiveChannel = channelId || $currentChannel;

	$: activeChannel = $channels.find((ch) => ch.id === effectiveChannel) || null;
	$: allThreads = $forumThreadsStore;
	$: postsByThread = $forumPostsByThreadStore;
	$: isLoading = $forumLoadingStore;
	$: error = $forumErrorStore;
	$: selectedThreadId = $forumSelectedThreadIdStore;

	let activeCategory: string | null = null;
	let searchQuery = '';
	let showNewThread = false;
	// Focused-writing surface: right-anchored draft drawer (the calls-panel
	// pattern, kept forum-local — see handleNewThread). The inline composer
	// stays for quick posts via handleQuickPost.
	let showDraftDrawer = false;

	initObjectRefRegistry();

	$: if (allThreads.length > 0 && effectiveChannel) {
		for (const thread of allThreads) {
			registerObjectRef({
				kind: 'forum_post',
				id: thread.post_id,
				slug: slugify(thread.title),
				title: thread.title,
				channelId: effectiveChannel,
				subtitle: findAuthor(thread.author_user_id)?.username || undefined,
				updatedAt: thread.created_at_micros > 1e12 ? Math.floor(thread.created_at_micros / 1000) : thread.created_at_micros,
			});
		}
	}

	$: categories = (() => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const cat of [...getDefaultCategories(), ...customCategories]) {
			if (!seen.has(cat)) {
				seen.add(cat);
				out.push(cat);
			}
		}
		for (const t of allThreads) {
			const cat = categorizeThread(t);
			if (!seen.has(cat)) {
				seen.add(cat);
				out.push(cat);
			}
		}
		return out;
	})();

	let customCategories: string[] = [];
	let addCategoryMode = false;
	let newCategoryName = '';
	let editingCategory: string | null = null;
	let editingCategoryValue = '';

	function customCategoriesKey(channelId: string): string {
		return `wabi-forum-custom-categories:${channelId}`;
	}

	function loadCustomCategories(channelId: string): string[] {
		try {
			const raw = localStorage.getItem(customCategoriesKey(channelId));
			if (!raw) return [];
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed)
				? parsed.filter((c): c is string => typeof c === 'string')
				: [];
		} catch {
			return [];
		}
	}

	function saveCustomCategories() {
		if (!effectiveChannel) return;
		try {
			localStorage.setItem(
				customCategoriesKey(effectiveChannel),
				JSON.stringify(customCategories)
			);
		} catch {
			// storage unavailable
		}
	}

	function startCategoryRename(cat: string) {
		editingCategory = cat;
		editingCategoryValue = cat;
	}

	function cancelCategoryRename() {
		editingCategory = null;
		editingCategoryValue = '';
	}

	async function commitCategoryRename() {
		const from = editingCategory;
		const to = editingCategoryValue.trim();
		cancelCategoryRename();
		if (!from || !to || to === from) return;
		if (customCategories.includes(from)) {
			customCategories = customCategories.map((c) => (c === from ? to : c));
			saveCustomCategories();
		}
		if (activeCategory === from) activeCategory = to;
		if (effectiveChannel) await renameForumCategory(effectiveChannel, from, to);
	}

	function commitAddCategory() {
		const name = newCategoryName.trim();
		addCategoryMode = false;
		newCategoryName = '';
		if (!name) return;
		if (!customCategories.includes(name)) {
			customCategories = [...customCategories, name];
			saveCustomCategories();
		}
	}
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
	$: starterAttachments = threadStarter
		? (threadStarter.attachments ?? extractForumAttachments(threadStarter.body))
		: [];
	$: starterText = threadStarter ? stripForumImageMarkdown(threadStarter.body) : '';
	$: hasSolution = threadReplies.some((r) => r.is_solution);
	$: canCurrentUserPost = Boolean($currentUser?.dbUserId);

	$: threadStarterAuthor = threadStarter ? findAuthor(threadStarter.author_user_id) : undefined;

	function selectThread(thread: ForumPost) {
		forumSelectedThreadIdStore.set(thread.post_id);
		if (effectiveChannel) {
			loadPosts(effectiveChannel, thread.thread_id);
		}
	}

	$: if (effectiveChannel) {
		customCategories = loadCustomCategories(effectiveChannel);
		loadThreads(effectiveChannel);
		// The draft drawer is scoped to the active forum channel.
		showDraftDrawer = false;
	}

	// C2: deep-link handoff after threads load — peek first, take only on hit
	$: if (effectiveChannel && allThreads.length > 0) {
		const pending = peekPendingNav();
		if (
			pending?.kind === 'forum_post' &&
			(!pending.channelId || pending.channelId === effectiveChannel)
		) {
			const hit =
				allThreads.find((t) => t.post_id === pending.postId) ||
				allThreads.find((t) => t.thread_id === pending.postId);
			if (hit) {
				takePendingNav('forum_post', effectiveChannel);
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
		showDraftDrawer = true;
	}

	function handleQuickPost() {
		showNewThread = true;
	}

	function handleCloseDraftDrawer() {
		showDraftDrawer = false;
	}

	function handleCancelNewThread() {
		showNewThread = false;
	}

	async function handleCreateNewThread(body: string, title?: string, category?: string) {
		if (!effectiveChannel) return;
		const post = await createThread(effectiveChannel, body, title, undefined, category || undefined);
		if (post) {
			showNewThread = false;
			showDraftDrawer = false;
			if (category) activeCategory = category;
			selectThread(post);
		}
	}

	async function handleReply(body: string) {
		if (!effectiveChannel || !selectedThreadId) return;
		await createPost(effectiveChannel, selectedThreadId, body);
	}

	async function handleVote(post: ForumPost, direction: 'up' | 'down') {
		if (!effectiveChannel) return;
		await votePost(effectiveChannel, post.thread_id, post.post_id, direction);
	}

	async function handleMarkSolution(post: ForumPost) {
		if (!effectiveChannel) return;
		await markSolution(effectiveChannel, post.thread_id, post.post_id);
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

	<div class="forum-body">
		{#if isLoading}
			<div class="forum-loading">
				<div class="forum-loading-spinner"></div>
				<span>Loading forum...</span>
			</div>
		{:else if error}
			<div class="forum-error">
				<span>{error}</span>
				<button on:click={() => effectiveChannel && loadThreads(effectiveChannel)}>Retry</button>
			</div>
		{:else}
			<div class="forum-category-pane">
				<div class="forum-category-header">
					<span>Categories</span>
					<div class="forum-category-header-actions">
						{#if canCurrentUserPost}
							<button
								class="forum-add-category-btn"
								on:click={() => (addCategoryMode = true)}
								title="Add category"
							>+</button>
						{/if}
					</div>
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
						<div class="forum-category-row">
							{#if editingCategory === cat}
								<input
									class="forum-category-rename-input"
									bind:value={editingCategoryValue}
									placeholder="New name..."
									on:click={(e) => e.stopPropagation()}
									on:keydown={(e) => {
										if (e.key === 'Enter') commitCategoryRename();
										if (e.key === 'Escape') cancelCategoryRename();
									}}
								/>
								<button class="forum-category-rename-btn" on:click={commitCategoryRename} title="Save">&#10003;</button>
								<button class="forum-category-rename-btn" on:click={cancelCategoryRename} title="Cancel">&#10005;</button>
							{:else}
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
								{#if canCurrentUserPost}
									<button
										class="forum-category-edit-btn"
										title="Rename category"
										on:click={() => startCategoryRename(cat)}
									>&#9998;</button>
								{/if}
							{/if}
						</div>
					{/each}
					{#if addCategoryMode}
						<div class="forum-category-row">
							<input
								class="forum-category-rename-input"
								bind:value={newCategoryName}
								placeholder="Category name..."
								on:click={(e) => e.stopPropagation()}
								on:keydown={(e) => {
									if (e.key === 'Enter') commitAddCategory();
									if (e.key === 'Escape') {
										addCategoryMode = false;
										newCategoryName = '';
									}
								}}
							/>
							<button class="forum-category-rename-btn" on:click={commitAddCategory} title="Add">&#10003;</button>
							<button
								class="forum-category-rename-btn"
								on:click={() => {
									addCategoryMode = false;
									newCategoryName = '';
								}}
								title="Cancel"
							>&#10005;</button>
						</div>
					{/if}
				</div>
			</div>

			<div class="forum-post-list">
				<div class="forum-post-list-header">
					<span>{activeCategory || 'All'} Threads <span class="forum-post-list-header-count">{categorizedThreads.length}</span></span>
					{#if canCurrentUserPost}
						<div class="forum-post-list-header-actions">
							<button class="forum-quick-post-btn" on:click={handleQuickPost} title="Quick post inline">Quick</button>
							<button class="forum-new-thread-btn" on:click={handleNewThread} title="New thread (focused writing panel)">+</button>
						</div>
					{/if}
				</div>
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
							channelId={effectiveChannel}
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
						categoryOptions={categories}
						channelId={effectiveChannel}
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
								<div class="forum-post-detail-body">{starterText}</div>
								{#if starterAttachments.length > 0}
									<div class="forum-files-gallery" class:has-more={starterAttachments.length > 4}>
										{#each starterAttachments.slice(0, 4) as attachment, index}
											<div class="forum-gallery-file-item" class:last-item={index === 3 && starterAttachments.length > 4}>
												<a href={resolveForumFileUrl(attachment.url)} target="_blank" rel="noopener noreferrer" title={attachment.name}>
													<img
														src={resolveForumFileUrl(attachment.url)}
														alt={attachment.name}
														class="forum-gallery-file-image"
														loading="lazy"
														decoding="async"
													/>
												</a>
												{#if index === 3 && starterAttachments.length > 4}
													<div class="forum-more-overlay">
														<span class="forum-more-count">+{starterAttachments.length - 4}</span>
													</div>
												{/if}
											</div>
										{/each}
									</div>
									{#if starterAttachments.length > 4}
										<div class="forum-file-card-list">
											{#each starterAttachments.slice(4) as attachment}
												<a class="forum-file-card" href={resolveForumFileUrl(attachment.url)} target="_blank" rel="noopener noreferrer">
													<span class="forum-file-card-icon" aria-hidden="true">&#128196;</span>
													<span class="forum-file-card-name">{attachment.name}</span>
													{#if attachment.size}<span class="forum-file-card-size">{formatForumFileSize(attachment.size)}</span>{/if}
												</a>
											{/each}
										</div>
									{/if}
								{/if}
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
											channelId: effectiveChannel,
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
										channelId={effectiveChannel}
									/>
								{/each}
							</div>
						{/if}
					</div>

					<ForumComposer
						placeholder="Write a reply... Ctrl+Enter to post"
						channelId={effectiveChannel}
						onSubmit={handleReply}
					/>
				{/if}
			</div>
		{/if}
	</div>

	{#if showDraftDrawer}
		<div
			class="forum-draft-backdrop"
			on:click={handleCloseDraftDrawer}
			role="presentation"
		></div>
		<div
			class="forum-draft-drawer"
			role="dialog"
			aria-modal="false"
			tabindex="-1"
			aria-label="New thread draft"
			on:keydown={(e) => { if (e.key === 'Escape') handleCloseDraftDrawer(); }}
		>
			<div class="forum-draft-drawer-header">
				<div class="forum-draft-drawer-titles">
					<span class="forum-draft-drawer-kicker">Focused writing</span>
					<h2 class="forum-draft-drawer-title">New thread</h2>
					<span class="forum-draft-drawer-channel">in {activeChannel?.name || 'Forum'}</span>
				</div>
				<button
					class="forum-draft-drawer-close"
					on:click={handleCloseDraftDrawer}
					title="Close draft"
					aria-label="Close draft"
				>&#10005;</button>
			</div>
			<div class="forum-draft-drawer-body">
				{#key effectiveChannel}
					<ForumComposer
						showTitle={true}
						categoryOptions={categories}
						channelId={effectiveChannel}
						placeholder="Write your post... Use **bold** `code` @mentions"
						onSubmit={handleCreateNewThread}
						onCancel={handleCloseDraftDrawer}
					/>
				{/key}
			</div>
		</div>
	{/if}
</div>
