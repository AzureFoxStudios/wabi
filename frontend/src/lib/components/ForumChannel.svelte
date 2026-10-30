<script lang="ts">
	import ProfileMedia from './ProfileMedia.svelte';
	import { mediaUrl } from '$lib/mediaUrl';
	import ForumBody from './ForumBody.svelte';
	import { forumAuthors, canManageForumPost } from '$lib/forumIdentity';
	import { onDestroy, tick } from 'svelte';
	import { currentChannel, channels, currentUser } from '$lib/socket';
	import { createForumWorkspace, type ForumPost } from '$lib/forumStore';
	import { inkFor } from '$lib/theme/identity';
	import { confirmAction } from '$lib/confirm';
	import {
		FORUM_SORT_OPTIONS,
		forumErrorCopy,
		forumFilterCategories,
		forumMillis,
		forumRowsShowCategory,
		forumScore,
		forumVersionNote,
		forumVoteLabel,
		sortForumThreads,
		type ForumSort
	} from '$lib/forumView';
	import { forumShareItems } from '$lib/forumMenus';
	import type { MenuEntry } from './context-menu/ContextMenu.svelte';
	import Icon from './ui/Icon.svelte';
	import Menu from './ui/Menu.svelte';
	import Select from './ui/Select.svelte';
	import Notice from './ui/Notice.svelte';
	import Skeleton from './ui/Skeleton.svelte';
	import LoadLine from './ui/LoadLine.svelte';
	import EmptyState from './ui/EmptyState.svelte';
	const forumWorkspace = createForumWorkspace();
	const { forumThreadsStore, forumPostsByThreadStore, forumLoadingStore, forumErrorStore, forumSelectedThreadIdStore, loadThreads, loadPosts, createThread, createPost, votePost, markSolution, renameForumCategory, deleteForumPost, formatForumTime, getDefaultCategories, categorizeThread, extractForumAttachments, resolveForumFileUrl, stripForumImageMarkdown, formatForumFileSize } = forumWorkspace;

	import ForumPostRow from './ForumPostRow.svelte';
	import ForumReply from './ForumReply.svelte';
	import ForumComposer from './ForumComposer.svelte';
	import { initObjectRefRegistry, registerObjectRef, slugify } from '$lib/objectRefRegistry';
	import { pendingNav, takePendingNav } from '$lib/pendingNav';

	export let channelId: string | undefined = undefined;
	export let draftSurface = 'center';
	export let previewPostId: string | undefined = undefined;
	$: effectiveChannel = channelId || $currentChannel;

	$: activeChannel = $channels.find((ch) => ch.id === effectiveChannel) || null;
	$: channelName = activeChannel?.name ? `#${activeChannel.name}` : 'this forum';
	$: allThreads = $forumThreadsStore;
	$: postsByThread = $forumPostsByThreadStore;
	$: isLoading = $forumLoadingStore;
	$: error = $forumErrorStore;
	$: errorCopy = forumErrorCopy(error);
	$: selectedThreadId = $forumSelectedThreadIdStore;
	// In the companion panel the page beside it owns the one primary action (§2.4).
	$: inPanel = draftSurface === 'panel';

	let deletingPostId: string | null = null;
	async function handleDeletePost(post: ForumPost) {
		if (deletingPostId || !canManageForumPost($currentUser, post.author_user_id)) return;
		const reply = !post.is_thread_starter;
		const confirmed = await confirmAction(reply
			? { title: 'Delete this reply?', body: 'It is removed from the thread for everyone.', confirm: 'Delete reply', danger: true }
			: { title: 'Remove this thread?', body: 'It leaves the thread list for everyone. Its replies stay stored.', confirm: 'Remove thread', danger: true });
		if (!confirmed) return;
		deletingPostId = post.post_id;
		try { await deleteForumPost(effectiveChannel, post.thread_id, post.post_id); }
		finally { deletingPostId = null; }
	}

	let activeCategory: string | null = null;
	let sort: ForumSort = 'newest';
	let searchQuery = '';
	let showNewThread = false;
	let replyComposer: ForumComposer | undefined;

	initObjectRefRegistry();

	$: if (allThreads.length > 0 && effectiveChannel) {
		for (const thread of allThreads) {
			registerObjectRef({
				kind: 'forum_post',
				id: thread.post_id,
				slug: slugify(thread.title),
				title: thread.title,
				channelId: effectiveChannel,
				subtitle: $forumAuthors.get(thread.author_user_id)?.username || undefined,
				updatedAt: forumMillis(thread.created_at_micros),
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

	// Categories added here and not yet used by a thread live only in this browser.
	let customCategories: string[] = [];
	let categoryEditor: { mode: 'rename'; from: string } | { mode: 'add' } | null = null;
	let categoryDraft = '';
	let categoryInput: HTMLInputElement | null = null;

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

	async function openCategoryEditor(next: { mode: 'rename'; from: string } | { mode: 'add' }) {
		categoryEditor = next;
		categoryDraft = next.mode === 'rename' ? next.from : '';
		await tick();
		categoryInput?.focus();
		categoryInput?.select();
	}

	function closeCategoryEditor() {
		categoryEditor = null;
		categoryDraft = '';
	}

	async function commitCategoryEditor() {
		const editor = categoryEditor;
		const name = categoryDraft.trim();
		closeCategoryEditor();
		if (!editor || !name) return;
		if (editor.mode === 'add') {
			if (!customCategories.includes(name)) {
				customCategories = [...customCategories, name];
				saveCustomCategories();
			}
			return;
		}
		const from = editor.from;
		if (name === from) return;
		if (customCategories.includes(from)) {
			customCategories = customCategories.map((c) => (c === from ? name : c));
			saveCustomCategories();
		}
		if (activeCategory === from) activeCategory = name;
		if (effectiveChannel) await renameForumCategory(effectiveChannel, from, name);
	}

	$: categorizedThreads = sortForumThreads(allThreads.filter((t) => {
		if (activeCategory && categorizeThread(t) !== activeCategory) return false;
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
	}), sort);
	$: showRowCategory = forumRowsShowCategory(allThreads.map(categorizeThread), Boolean(activeCategory));

	$: categoryCounts = (() => {
		const counts = new Map<string, number>();
		for (const t of allThreads) {
			const cat = categorizeThread(t);
			counts.set(cat, (counts.get(cat) || 0) + 1);
		}
		return counts;
	})();

	// The filter lists what you can find: categories in use, the ones added on this device and the
	// applied one. Unused defaults stay suggestions in the new-thread form.
	$: filterCategories = forumFilterCategories(categories, categoryCounts, customCategories, activeCategory);
	$: categoryItems = [
		{ id: 'all', label: 'All threads', role: 'menuitemradio', checked: !activeCategory, hint: String(allThreads.length), onSelect: () => void chooseCategory(null) },
		...filterCategories.map((cat, index): MenuEntry => ({ id: `category-${index}`, label: cat, keepCase: true, role: 'menuitemradio', checked: activeCategory === cat, hint: String(categoryCounts.get(cat) || 0), onSelect: () => void chooseCategory(cat) })),
		...(canCurrentUserPost
			? [
				{ id: 'manage', type: 'separator' },
				...(activeCategory ? [{ id: 'rename', label: `Rename ${activeCategory}…`, keepCase: true, icon: 'pencil', onSelect: () => void openCategoryEditor({ mode: 'rename', from: activeCategory as string }) }] : []),
				{ id: 'add', label: 'Add a category…', icon: 'plus', onSelect: () => void openCategoryEditor({ mode: 'add' }) },
			]
			: []),
	] as MenuEntry[];

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
	$: starterCategory = threadStarter ? categorizeThread(threadStarter) : '';
	$: starterTags = threadStarter ? threadStarter.tags.filter((tag) => tag !== starterCategory) : [];
	$: starterScore = threadStarter ? forumScore(threadStarter) : 0;
	// The thread's author (or a moderator) picks its solution: the quiet button is not offered to
	// every reader on every reply (forum-wiki#8).
	$: canPickSolution = Boolean(threadStarter && canCurrentUserPost && canManageForumPost($currentUser, threadStarter.author_user_id));

	$: threadStarterAuthor = threadStarter ? $forumAuthors.get(threadStarter.author_user_id) : undefined;
	$: starterName = threadStarterAuthor?.username ?? (threadStarter ? `Member #${threadStarter.author_user_id}` : '');
	$: threadMenuItems = threadStarter
		? forumShareItems(
			{ kind: 'forum_post', id: threadStarter.post_id, slug: slugify(threadStarter.title), title: threadStarter.title, channelId: effectiveChannel, subtitle: threadStarterAuthor?.username },
			canManageForumPost($currentUser, threadStarter.author_user_id)
				? [{ id: 'remove-thread', label: 'Remove thread', icon: 'trash', danger: true, disabled: Boolean(deletingPostId), onSelect: () => void handleDeletePost(threadStarter as ForumPost) }]
				: [],
		)
		: [];

	// Votes cast from this view. The server counts every vote and does not report the viewer's own
	// (ForumPost has no field for it), so a vote shows as pressed only where it was cast here, and
	// the same direction is not sent twice.
	let myVotes: Record<string, 'up' | 'down'> = {};
	let votingIds: Record<string, boolean> = {};

	async function selectThread(thread: ForumPost) {
		if (thread.post_id !== selectedThreadId && replyComposer && !(await replyComposer.confirmDiscard())) return;
		closeCategoryEditor();
		showNewThread = false;
		// A notice belongs to the action that failed; opening another thread starts clean.
		forumErrorStore.set(null);
		forumSelectedThreadIdStore.set(thread.post_id);
		if (effectiveChannel) {
			loadPosts(effectiveChannel, thread.thread_id);
		}
	}

	let loadedChannel: string | undefined;
	$: if (effectiveChannel && effectiveChannel !== loadedChannel) {
		loadedChannel = effectiveChannel;
		customCategories = loadCustomCategories(effectiveChannel);
		loadThreads(effectiveChannel);
		closeCategoryEditor();
		activeCategory = null;
		myVotes = {};
	}

	$: if (draftSurface === 'glance' && previewPostId && allThreads.length) {
		const hit = allThreads.find(thread => thread.post_id === previewPostId || thread.thread_id === previewPostId);
		if (hit && selectedThreadId !== hit.post_id) void tick().then(() => { if (previewPostId === hit.post_id || previewPostId === hit.thread_id) void selectThread(hit); });
	}

	// C2: deep-link handoff after threads load — peek first, take only on hit
	$: if (draftSurface === 'center' && effectiveChannel && allThreads.length > 0) {
		const pending = $pendingNav;
		if (
			pending?.kind === 'forum_post' &&
			(!pending.channelId || pending.channelId === effectiveChannel)
		) {
			const hit =
				allThreads.find((t) => t.post_id === pending.postId) ||
				allThreads.find((t) => t.thread_id === pending.postId);
			if (hit) {
				takePendingNav('forum_post', effectiveChannel);
				// Let the loaded thread list settle before changing the selection.
				// Otherwise legacy reactive ordering can highlight the row while
				// leaving the reading pane on its previous empty state.
				const targetChannel = effectiveChannel;
				void tick().then(() => {
					if (effectiveChannel === targetChannel) void selectThread(hit);
				});
			}
		}
	}

	async function handleNewThread() {
		if (showNewThread || (replyComposer && !(await replyComposer.confirmDiscard()))) return;
		closeCategoryEditor();
		showNewThread = true;
	}

	/** The back crumb: leave the thread (or the new-thread form, whose draft is kept) for the list. */
	async function returnToThreads() {
		if (showNewThread) {
			showNewThread = false;
			forumErrorStore.set(null);
			return;
		}
		if (replyComposer && !(await replyComposer.confirmDiscard())) return;
		forumSelectedThreadIdStore.set(null);
	}

	function handleCancelNewThread() {
		showNewThread = false;
		// The form's own error said what failed; it does not follow the reader back to the list.
		forumErrorStore.set(null);
	}

	async function handleCreateNewThread(body: string, title?: string, category?: string): Promise<boolean> {
		if (!effectiveChannel) return false;
		const submittingChannel = effectiveChannel;
		const post = await createThread(effectiveChannel, body, title, undefined, category || undefined);
		if (post && submittingChannel === effectiveChannel) {
			showNewThread = false;
			if (category) activeCategory = category;
			void selectThread(post);
		}
		return Boolean(post);
	}

	async function handleReply(body: string): Promise<boolean> {
		if (!effectiveChannel || !selectedThreadId) return false;
		return Boolean(await createPost(effectiveChannel, selectedThreadId, body));
	}

	async function handleVote(post: ForumPost, direction: 'up' | 'down') {
		if (!effectiveChannel || votingIds[post.post_id] || myVotes[post.post_id] === direction) return;
		votingIds = { ...votingIds, [post.post_id]: true };
		try {
			const counted = await votePost(effectiveChannel, post.thread_id, post.post_id, direction);
			if (counted) myVotes = { ...myVotes, [post.post_id]: direction };
		} finally {
			const { [post.post_id]: _done, ...rest } = votingIds;
			votingIds = rest;
		}
	}

	async function handleMarkSolution(post: ForumPost) {
		if (!effectiveChannel) return;
		await markSolution(effectiveChannel, post.thread_id, post.post_id);
	}

	async function chooseCategory(cat: string | null) {
		if (cat === activeCategory) return;
		if (replyComposer && !(await replyComposer.confirmDiscard())) return;
		closeCategoryEditor();
		forumSelectedThreadIdStore.set(null);
		activeCategory = cat;
	}

	function clearFilters() {
		void chooseCategory(null);
		searchQuery = '';
	}

	function retryLoad() {
		forumErrorStore.set(null);
		if (effectiveChannel) loadThreads(effectiveChannel);
	}

	function avatarInitial(name: string): string {
		return (name.trim().charAt(0) || '?').toUpperCase();
	}

	function fullDate(micros: number): string {
		try {
			return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(forumMillis(micros)));
		} catch {
			return '';
		}
	}

	onDestroy(() => {
		forumWorkspace.dispose();
	});
</script>

<div
	class="forum-channel"
	class:in-panel={inPanel}
	class:is-reading={Boolean(selectedThread) && !showNewThread}
	class:is-composing={showNewThread}
>
	<div class="forum-toolbar">
		{#if selectedThread || showNewThread}
			<button type="button" class="w-btn w-btn--quiet forum-back" on:click={() => void returnToThreads()}>
				<Icon name="chevLeft" size={16} />
				Threads
			</button>
		{/if}
		<div class="forum-filters">
			<Menu
				class={`w-select forum-category-select${activeCategory ? ' w-select--applied' : ''}`}
				label="Category"
				heading="Category"
				triggerLabel={`Category: ${activeCategory ?? 'All threads'}`}
				items={categoryItems}
			>
				<span class="w-select__label">Category</span>
				<span class="w-select__value">{activeCategory ?? 'All'}</span>
				<Icon name="chevDown" size={16} />
			</Menu>
			<Select class="forum-sort" label="Sort" heading="Sort threads" options={FORUM_SORT_OPTIONS} bind:value={sort} />
			<label class="w-field w-field--chrome forum-search">
				<Icon name="search" size={16} />
				<input type="search" bind:value={searchQuery} placeholder="Search threads" aria-label={`Search threads in ${channelName}`} />
			</label>
		</div>
		{#if canCurrentUserPost && !showNewThread}
			<button
				type="button"
				class="w-btn forum-new"
				class:w-btn--primary={!inPanel}
				class:w-btn--quiet={inPanel}
				on:click={() => void handleNewThread()}
			>
				<Icon name="plus" size={16} />
				<span class="forum-new-label">New thread</span>
			</button>
		{/if}
		<LoadLine class="forum-loadline" active={isLoading} label="Loading threads" />
	</div>

	{#if categoryEditor}
		<form class="forum-category-editor" on:submit|preventDefault={() => void commitCategoryEditor()}>
			<label class="forum-category-editor-label" for="forum-category-editor-{draftSurface}">
				{categoryEditor.mode === 'rename' ? `Rename ${categoryEditor.from}` : 'New category'}
			</label>
			<input
				id="forum-category-editor-{draftSurface}"
				class="w-field w-field--chrome"
				bind:this={categoryInput}
				bind:value={categoryDraft}
				placeholder="Category name"
				on:keydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeCategoryEditor(); } }}
			/>
			<button type="submit" class="w-btn w-btn--sm" disabled={!categoryDraft.trim()}>{categoryEditor.mode === 'rename' ? 'Rename' : 'Add'}</button>
			<button type="button" class="w-btn w-btn--sm w-btn--quiet" on:click={closeCategoryEditor}>Cancel</button>
			<span class="forum-category-editor-hint">
				{categoryEditor.mode === 'rename' ? 'Every thread in this category moves to the new name.' : 'Kept on this device until a thread uses it.'}
			</span>
		</form>
	{/if}

	<div class="forum-body">
		{#if isLoading && allThreads.length === 0}
			<div class="forum-post-list">
				<Skeleton class="forum-skeleton" variant="text" rows={3} label="Loading threads" />
			</div>
			<div class="forum-reading-pane"></div>
		{:else if errorCopy && allThreads.length === 0 && !showNewThread}
			<div class="forum-post-list">
				<div class="forum-notice">
					<Notice title="Could not load threads" text="Check your connection, then try again." error={error} onretry={retryLoad} />
				</div>
			</div>
			<div class="forum-reading-pane"></div>
		{:else}
			<section class="forum-post-list" aria-labelledby="forum-list-head-{draftSurface}">
				<h2 class="forum-list-head" id="forum-list-head-{draftSurface}">
					<span class="w-kicker">{activeCategory ?? 'Threads'}</span>
					<span class="w-count">{categorizedThreads.length}</span>
				</h2>
				{#if errorCopy && !selectedThread && !showNewThread}
					<!-- A failure with no thread open (a category rename) is said beside the list, where it was asked. -->
					<div class="forum-notice">
						<Notice title={errorCopy.title} text={errorCopy.text} error={error} ondismiss={() => forumErrorStore.set(null)} />
					</div>
				{/if}
				{#if allThreads.length === 0}
					<EmptyState
						class="forum-empty"
						icon="forum"
						as="p"
						title={`No threads in ${channelName} yet`}
						text="Longer conversations live here, so they don't scroll away."
					/>
				{:else if categorizedThreads.length === 0}
					<EmptyState class="forum-empty" icon="search" as="p" title="No threads match" text="Try another category, or clear the search." />
					<div class="forum-empty-actions">
						<button type="button" class="w-btn w-btn--sm" on:click={clearFilters}>Clear filters</button>
					</div>
				{:else}
					<ul class="forum-post-rows">
						{#each categorizedThreads as thread (thread.post_id)}
							<li>
								<ForumPostRow
									{thread}
									active={thread.post_id === selectedThreadId}
									showCategory={showRowCategory}
									onClick={() => void selectThread(thread)}
									channelId={effectiveChannel}
								/>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<div class="forum-reading-pane">
				{#if showNewThread}
					<div class="forum-reading-content">
						{#key `${effectiveChannel}:new`}
						<ForumComposer
							{draftSurface}
							showTitle={true}
							categoryOptions={categories}
							initialCategory={activeCategory ?? ''}
							channelId={effectiveChannel}
							placeholder="Say what you would like to talk about. Markdown works here."
							onSubmit={handleCreateNewThread}
							onCancel={handleCancelNewThread}
						/>
						{/key}
					</div>
				{:else if !selectedThread}
					<div class="forum-reading-empty">
						<EmptyState icon="forum" title="Choose a thread" text="Threads open here, beside the list. Replies and votes stay with each thread." />
					</div>
				{:else}
					<div class="forum-reading-content">
						{#if errorCopy}
							<div class="forum-notice forum-notice--inline">
								<Notice title={errorCopy.title} text={errorCopy.text} error={error} ondismiss={() => forumErrorStore.set(null)} />
							</div>
						{/if}
						{#if threadStarter}
							<article class="forum-article" aria-labelledby="forum-article-title-{draftSurface}">
								<header class="forum-article-head">
									<p class="forum-article-kicker">
										<span class="w-kicker">{starterCategory}</span>
										{#each starterTags as tag}<span class="w-tag">{tag}</span>{/each}
										{#if hasSolution}
											<span class="forum-solved"><Icon name="checkCircle" size={14} />Solved</span>
										{/if}
									</p>
									<h1 class="forum-article-title" id="forum-article-title-{draftSurface}">{threadStarter.title}</h1>
									<p class="forum-byline" style={$inkFor(threadStarterAuthor?.color || threadStarterAuthor?.roleColor)}>
										<span class="forum-av forum-av--24" aria-hidden="true">
											{#if threadStarterAuthor?.profilePicture}<ProfileMedia src={mediaUrl(threadStarterAuthor.profilePicture)} alt="" />{:else}{avatarInitial(starterName)}{/if}
										</span>
										<span class="forum-byline-name" title={threadStarterAuthor ? undefined : 'This author is not in the server member directory.'}>{starterName}</span>
										<span class="forum-byline-sep" aria-hidden="true">·</span>
										<time class="forum-byline-time" datetime={new Date(forumMillis(threadStarter.created_at_micros)).toISOString()} title={fullDate(threadStarter.created_at_micros)}>{formatForumTime(threadStarter.created_at_micros)}</time>
										<span class="forum-byline-sep" aria-hidden="true">·</span>
										<span class="forum-byline-version">{forumVersionNote(threadStarter, formatForumTime)}</span>
									</p>
								</header>
								<div class="forum-article-body"><ForumBody text={starterText} /></div>
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
													<Icon name="file" size={18} />
													<span class="forum-file-card-name">{attachment.name}</span>
													{#if attachment.size}<span class="forum-file-card-size">{formatForumFileSize(attachment.size)}</span>{/if}
												</a>
											{/each}
										</div>
									{/if}
								{/if}
								<div class="forum-actions">
									<div class="forum-vote" role="group" aria-label="Votes on this thread">
										<button
											type="button"
											class="forum-vote-btn"
											aria-pressed={myVotes[threadStarter.post_id] === 'up'}
											aria-label={forumVoteLabel('up', starterScore)}
											disabled={!canCurrentUserPost || Boolean(votingIds[threadStarter.post_id])}
											on:click={() => threadStarter && void handleVote(threadStarter, 'up')}
										><Icon name="chevUp" size={16} /></button>
										<span class="forum-vote-score" aria-hidden="true">{starterScore}</span>
										<button
											type="button"
											class="forum-vote-btn"
											aria-pressed={myVotes[threadStarter.post_id] === 'down'}
											aria-label={forumVoteLabel('down', starterScore)}
											disabled={!canCurrentUserPost || Boolean(votingIds[threadStarter.post_id])}
											on:click={() => threadStarter && void handleVote(threadStarter, 'down')}
										><Icon name="chevDown" size={16} /></button>
									</div>
									<Menu class="w-ibtn forum-more" label="Thread actions" triggerLabel="Thread actions" align="end" items={threadMenuItems}>
										<Icon name="more" />
									</Menu>
								</div>
							</article>
						{/if}

						{#if threadReplies.length > 0}
							<section class="forum-replies" aria-labelledby="forum-replies-head-{draftSurface}">
								<h2 class="forum-replies-head" id="forum-replies-head-{draftSurface}">
									<span class="w-kicker">{threadReplies.length} {threadReplies.length === 1 ? 'reply' : 'replies'}</span>
								</h2>
								{#each threadReplies as reply (reply.post_id)}
									<ForumReply
										{reply}
										isSolution={reply.is_solution}
										myVote={myVotes[reply.post_id]}
										voting={Boolean(votingIds[reply.post_id])}
										canVote={canCurrentUserPost}
										canMarkSolution={canPickSolution}
										onVote={(direction) => void handleVote(reply, direction)}
										onMarkSolution={() => handleMarkSolution(reply)}
										onDelete={() => void handleDeletePost(reply)}
										deleting={deletingPostId === reply.post_id}
										channelId={effectiveChannel}
									/>
								{/each}
							</section>
						{/if}
					</div>

					{#if canCurrentUserPost}
						{#key `${effectiveChannel}:${selectedThreadId}`}
						<ForumComposer
							{draftSurface}
							draftKey={`reply:${selectedThreadId}`}
							bind:this={replyComposer}
							replyTo={starterName}
							placeholder="Write a reply"
							channelId={effectiveChannel}
							onSubmit={handleReply}
						/>
						{/key}
					{/if}
				{/if}
			</div>
		{/if}
	</div>
</div>
