<script lang="ts">
	/**
	 * A wiki channel (design contract §8.7): the page tree beside one reading column.
	 *
	 * - The tree column (clamp(220px, 22%, 280px)) holds the wiki's chrome: the PAGES kicker,
	 *   the one "New page" action, the page search and the tree. There is no separate toolbar row.
	 * - A page reads on one 720px column: a 44px breadcrumb row (with Edit, Fullscreen and the
	 *   page's ⋯), the serif title, the meta line, a hairline, then the one prose style (.w-prose).
	 *   Title, meta and prose share one left edge.
	 * - ON THIS PAGE (.w-outline) sits in the right margin when the reading pane has room for it
	 *   (a stage of about 1100px and up), under the page tree when the tree is a column, and as a
	 *   collapsed disclosure under the meta otherwise (phones, the companion panel).
	 * - Editing and new pages use the writing surface (WritingEditor: the reading face, hanging
	 *   heading markers, the selection bubble) on the same column, with Insert, Write | Preview,
	 *   Cancel and the one primary in the breadcrumb row.
	 * - Drafts belong to their surface (wikiDrafts + draftSurface), so the center stage and the
	 *   companion panel keep independent drafts; the send/settle logic is unchanged.
	 */
	import ProfileMedia from './ProfileMedia.svelte';
	import { mediaUrl } from '$lib/mediaUrl';
	import { onDestroy, tick } from 'svelte';
	import { _ } from '$lib/i18n';
	import { inkFor } from '$lib/theme/identity';
	import { wikiDrafts, type WikiDraft } from '$lib/wikiDraftState';
	import { captureGroupAccess, groupMembership } from '$lib/groupAccess';
	import { onAuthSessionCleared } from '$lib/authSession';
	import { currentChannel } from '$lib/socket';
	import { createWikiWorkspace, type WikiPage, type WikiRevision } from '$lib/wikiStore';
	import { uploadFileResumable } from './chat/uploadResumable';
	import WikiPageTree from './WikiPageTree.svelte';
	import WikiRevisionDrawer from './WikiRevisionDrawer.svelte';
	import WritingEditor from './WritingEditor.svelte';
	import Icon from './ui/Icon.svelte';
	import Menu from './ui/Menu.svelte';
	import Notice from './ui/Notice.svelte';
	import Skeleton from './ui/Skeleton.svelte';
	import LoadLine from './ui/LoadLine.svelte';
	import EmptyState from './ui/EmptyState.svelte';
	import Tooltip from './ui/Tooltip.svelte';
	import type { MenuEntry } from './context-menu/ContextMenu.svelte';
	import { initObjectRefRegistry, registerObjectRef, slugify } from '$lib/objectRefRegistry';
	import { parseMessage } from '$lib/markdown';
	import UserPopout from './UserPopout.svelte';
	import { users as presenceUsers, currentUser as presenceCurrentUser } from '$lib/presenceIdentity';
	import type { User } from '$lib/socket-types';
	import { forumAuthors } from '$lib/forumIdentity';
	import { forumShareItems } from '$lib/forumMenus';
	import { pendingNav, completePendingNavAfterRender, peekPendingNav, clearPendingNav } from '$lib/pendingNav';
	import { confirmAction } from '$lib/confirm';
	import { formatWikiCitationMarkdown, getWikiBreadcrumbs, getWikiCitation } from '$lib/wikiHelpers';
	import {
		buildWikiOutline,
		currentSectionIndex,
		flattenOutline,
		hangsMarkers,
		headingAnchorIds,
		outlinePlace,
		paneHasMargin,
		shouldOpenOnlyPage,
		showsOutline,
		treeColumnShown,
		wikiVersionNote,
		type OutlineEntry,
		type OutlineHeading
	} from '$lib/wikiReading';
	import { INSERT_KINDS, type InsertKind } from '$lib/editor/writingMarkdown';

	const wikiWorkspace = createWikiWorkspace();
	// Names what goes here (§7.3); the Insert menu and the bubble carry the how.
	const WRITING_PLACEHOLDER = 'Write the page…';
	const { wikiPagesStore, wikiRevisionsStore, wikiLoadingStore, wikiErrorStore, loadWiki, loadRevisions, createWikiPage, updateWikiPage, formatWikiTime } = wikiWorkspace;

	export let channelId: string | undefined = undefined;
	export let draftSurface = 'center';
	export let previewPageId: string | undefined = undefined;
	$: effectiveChannel = channelId || $currentChannel;
	// Load first. A `$:` statement runs at most once per update, so a store alias such as
	// `isLoading = $wikiLoadingStore` that ran before loadWiki() set the store in the same update
	// would keep the old value until the store changed again: the wiki then showed "No pages
	// yet" for as long as the first request was pending. Svelte orders `$:` statements by source
	// order after their dependencies, so these stay above every alias of the wiki's stores.
	$: if (effectiveChannel && effectiveChannel !== loadedChannelId) {
		loadedChannelId = effectiveChannel;
		openDraft(effectiveChannel);
		loadWiki(effectiveChannel);
	}
	$: if (!effectiveChannel) {
		if (loadedChannelId) { draftOwner?.save(snapshot()); retireDraft(); }
		loadedChannelId = null;
		wikiSearchQuery = '';
	}
	$: inPanel = draftSurface === 'panel';
	$: canWrite = draftSurface !== 'glance';

	$: allPages = $wikiPagesStore;
	$: isLoading = $wikiLoadingStore;
	$: error = $wikiErrorStore;

	let readingPane: HTMLDivElement;
	let expandedReading = false;
	async function toggleReading() {
		try {
			if (document.fullscreenElement === readingPane) await document.exitFullscreen();
			else await readingPane.requestFullscreen();
		} catch {
			copyError = 'Fullscreen is not available in this window.';
		}
	}

	let selectedPageId: string | null = null;
	let loadedPageKey = '';
	let creatingPage = false;
	let createError = '';
	let showHistory = false;
	let editMode = false;
	let viewRevision: WikiRevision | null = null;
	let editTitle = '';
	let editBody = '';
	let showNewPage = false;
	let newPageTitle = '';
	let newPageBody = '';
	let newPageParentId: string | null = null;
	let wikiSearchQuery = '';
	let loadedChannelId: string | null = null;
	let copyError = '';
	let previewing = false;
	let editSavedTitle = '';
	let editSavedBody = '';
	let imageInput: HTMLInputElement | null = null;
	let imageUploading = false;
	let saveState: 'idle' | 'dirty' | 'saving' | 'saved' | 'failed' = 'idle';
	let saveProblem = '';
	let showTreeOnMobile = true;
	let writer: WritingEditor | null = null;

	// Layout: measured, so the outline has exactly one place (wikiReading.outlinePlace).
	let wikiWidth = 0;
	let paneWidth = 0;
	let proseEl: HTMLDivElement | null = null;
	let startTitleEl: HTMLHeadingElement | null = null;
	let outlineHeadings: OutlineHeading[] = [];
	let currentOutlineId: string | null = null;
	let outlineOpen = false;
	let onlyPageDecidedFor = '';

	let draftOwner: ReturnType<typeof wikiDrafts.open> | undefined;
	let stopDraftEvents: (() => void) | undefined;
	let draftChannel = '';
	let mounted = true;
	let editorEpoch = 0;
	function snapshot(): WikiDraft {
		return { selectedPageId, editMode, editTitle, editBody, editSavedTitle, editSavedBody,
			showNewPage, newPageTitle, newPageBody, newPageParentId };
	}
	function restoreDraft(draft?: WikiDraft) {
		editorEpoch += 1;
		imageUploading = false;
		selectedPageId = draft?.selectedPageId ?? null;
		loadedPageKey = selectedPageId ? `${draftChannel}/${selectedPageId}` : '';
		editMode = draft?.editMode ?? false;
		editTitle = draft?.editTitle ?? '';
		editBody = draft?.editBody ?? '';
		editSavedTitle = draft?.editSavedTitle ?? '';
		editSavedBody = draft?.editSavedBody ?? '';
		showNewPage = draft?.showNewPage ?? false;
		newPageTitle = draft?.newPageTitle ?? '';
		newPageBody = draft?.newPageBody ?? '';
		newPageParentId = draft?.newPageParentId ?? null;
		showTreeOnMobile = !selectedPageId && !showNewPage;
		showHistory = false;
		viewRevision = null;
		createError = '';
		saveState = 'idle';
		saveProblem = '';
		previewing = false;
	}
	function openDraft(channel: string) {
		if (mounted) draftOwner?.save(snapshot());
		stopDraftEvents?.();
		draftChannel = channel;
		draftOwner = wikiDrafts.open(channel, captureGroupAccess(channel), draftSurface);
		if (draftOwner.current() && draftSurface !== 'glance') restoreDraft(draftOwner.read());
		else restoreDraft();
		const owner = draftOwner;
		const applyPending = (pending: boolean) => {
			creatingPage = pending && showNewPage;
			if (pending && !showNewPage) saveState = 'saving';
			else if (saveState === 'saving') saveState = 'idle';
		};
		applyPending(owner.isSending());
		stopDraftEvents = owner.onSendState((pending, update) => {
			if (!mounted || !owner.current()) return;
			if (update) {
				restoreDraft(update(snapshot()));
				owner.save(snapshot());
				void loadWiki(draftChannel);
			}
			applyPending(pending);
		});
	}
	function retireDraft() {
		if (draftOwner?.current()) draftOwner.save(snapshot());
		loadedChannelId = null;
		stopDraftEvents?.();
		draftOwner = undefined;
		restoreDraft();
		creatingPage = false;
	}
	const stopAuth = onAuthSessionCleared(retireDraft);
	const stopContext = groupMembership.onContextChanged(retireDraft);
	const stopRevocation = groupMembership.onRevoked(({ channelId }) => {
		if (channelId === draftChannel) retireDraft();
	});

	initObjectRefRegistry();

	$: if (allPages.length > 0 && effectiveChannel) {
		for (const page of allPages) {
			registerObjectRef({
				kind: 'wiki_page',
				id: page.pageId,
				slug: page.slug || slugify(page.title),
				title: page.title,
				channelId: effectiveChannel,
				subtitle: $forumAuthors.get(page.authorUserId)?.username || undefined,
				updatedAt: page.updatedAtMicros > 1e12 ? Math.floor(page.updatedAtMicros / 1000) : page.updatedAtMicros,
			});
		}
	}

	$: selectedPage = allPages.find((p) => p.pageId === selectedPageId) || null;
	$: breadcrumbs = selectedPage ? getWikiBreadcrumbs(allPages, selectedPage.pageId) : [];
	$: ancestorCrumbs = breadcrumbs.slice(0, -1);
	$: newPageParent = newPageParentId ? allPages.find((p) => p.pageId === newPageParentId) || null : null;
	$: newPageCrumbs = newPageParent ? getWikiBreadcrumbs(allPages, newPageParent.pageId) : [];

	$: if (selectedPage && effectiveChannel && loadedPageKey !== `${effectiveChannel}/${selectedPage.pageId}`) {
		loadedPageKey = `${effectiveChannel}/${selectedPage.pageId}`;
		loadRevisions(effectiveChannel, selectedPage.pageId);
		showHistory = false;
		editMode = false;
		viewRevision = null;
	}
	// After the statement above that reloads the revisions (see the note at the load statement).
	$: allRevisions = $wikiRevisionsStore;

	$: if (draftSurface === 'glance' && previewPageId && loadedChannelId === effectiveChannel && allPages.length) {
		const hit = allPages.find(page => page.pageId === previewPageId);
		if (hit && selectedPageId !== hit.pageId) void tick().then(() => { if (mounted && previewPageId === hit.pageId) selectPage(hit); });
	}

	// C2: deep-link handoff after pages load — peek first, take only on hit
	$: if (draftSurface === 'center' && effectiveChannel && loadedChannelId === effectiveChannel && allPages.length > 0) {
		const pending = $pendingNav;
		if (
			pending?.kind === 'wiki_page' &&
			(!pending.channelId || pending.channelId === effectiveChannel)
		) {
			const hit = allPages.find((p) => p.pageId === pending.pageId);
			if (hit) {
				const channel = effectiveChannel, owner = draftOwner;
				// Wait until the initial derived reader state has finished updating. Over unsaved
				// writing the page opens once the person confirms; the link is then used up.
				void completePendingNavAfterRender(pending, tick,
					() => mounted && effectiveChannel === channel && owner === draftOwner && !!owner?.current(),
					() => !draftOwner?.isSending() && afterDiscard(
						() => { openPage(hit); if (peekPendingNav() === pending) clearPendingNav(); },
						// Declining the discard also declines the link: it must not open later on its
						// own once the writing is saved and the pages reload.
						() => { if (peekPendingNav() === pending) clearPendingNav(); }));
			}
		}
	}

	// A wiki with exactly one page opens it (once per load of this wiki here); the "Wiki"
	// crumb still leads back to the overview, which then stays.
	$: if (effectiveChannel && loadedChannelId === effectiveChannel && !isLoading && allPages.length > 0 && onlyPageDecidedFor !== effectiveChannel
		&& allPages.every((page) => !page.channelId || page.channelId === effectiveChannel)) {
		const live = allPages.filter((page) => !page.isDeleted);
		const open = shouldOpenOnlyPage({ pageCount: live.length, selectedPageId, composing: showNewPage || editMode, alreadyDecided: false })
			&& !(draftSurface === 'glance' && previewPageId) && !($pendingNav?.kind === 'wiki_page');
		onlyPageDecidedFor = effectiveChannel;
		if (open) void tick().then(() => { if (mounted && selectedPageId === null && !showNewPage) selectPage(live[0]); });
	}

	$: revisionsForDrawer = showHistory ? allRevisions : [];

	$: displayTitle = viewRevision ? viewRevision.title : (selectedPage?.title || '');
	$: displayBody = viewRevision ? viewRevision.body : (selectedPage?.body || '');
	$: displayAuthor = selectedPage ? $forumAuthors.get(selectedPage.authorUserId) : undefined;
	$: displayTime = selectedPage ? formatWikiTime(selectedPage.updatedAtMicros) : '';
	$: displayRevisionCount = allRevisions.length;
	$: authorName = displayAuthor?.username || (selectedPage ? `User #${selectedPage.authorUserId}` : '');

	/** The unsaved writing a move would drop: an edited page, a new page with words, or none. */
	function writingAtRisk(): 'edit' | 'new' | null {
		if (editIsDirty) return 'edit';
		if (showNewPage && (newPageTitle.trim() || newPageBody.trim())) return 'new';
		return null;
	}

	/**
	 * Runs `leave` now when no unsaved writing would be lost; otherwise after the person confirms
	 * in the confirm dialog (§7.13), not a native browser prompt. Returns whether it ran now. An
	 * answer that comes back after the wiki, the draft owner or the editor changed does nothing.
	 * `onDecline` runs when the person keeps their writing.
	 */
	function afterDiscard(leave: () => void, onDecline?: () => void): boolean {
		const risk = writingAtRisk();
		if (!risk) {
			leave();
			return true;
		}
		const owner = draftOwner;
		const epoch = editorEpoch;
		void confirmAction(risk === 'edit'
			? { title: 'Discard your changes to this page?', body: 'The page keeps its last saved version.', confirm: 'Discard changes', danger: true }
			: { title: 'Discard this new page?', body: 'Its title and text have not been saved anywhere.', confirm: 'Discard page', danger: true }
		).then((discard) => {
			if (!discard) {
				onDecline?.();
				return;
			}
			if (!mounted || owner !== draftOwner || epoch !== editorEpoch || draftOwner?.isSending()) return;
			leave();
		});
		return false;
	}

	function closeNewPage() {
		showNewPage = false; newPageTitle = ''; newPageBody = ''; newPageParentId = null; createError = '';
	}

	function openPage(page: WikiPage) {
		editorEpoch += 1; imageUploading = false;
		if (showNewPage) closeNewPage();
		selectedPageId = page.pageId;
		showTreeOnMobile = false;
		editMode = false;
		showHistory = false;
		viewRevision = null;
		previewing = false;
		outlineOpen = false;
	}

	function selectPage(page: WikiPage): boolean {
		if (draftOwner?.isSending()) return false;
		return afterDiscard(() => openPage(page));
	}

	function goToOverview() {
		if (draftOwner?.isSending()) return;
		afterDiscard(() => {
			editorEpoch += 1; imageUploading = false;
			if (showNewPage) closeNewPage();
			editMode = false;
			selectedPageId = null;
			showHistory = false;
			viewRevision = null;
			previewing = false;
			// The overview has no breadcrumb row and so no Pages toggle: where the tree stacks
			// (phones, narrow stages, the panel) it shows again, with New page and the search.
			showTreeOnMobile = true;
			// The crumb that was pressed is gone with the breadcrumb row, so keyboard and screen
			// reader focus moves to the overview's heading instead of falling to <body>.
			void tick().then(() => { if (mounted) startTitleEl?.focus(); });
		});
	}

	function handleEdit() {
		if (!selectedPage || draftOwner?.isSending()) return;
		editorEpoch += 1; imageUploading = false;
		editTitle = selectedPage.title;
		editBody = selectedPage.body;
		editSavedTitle = editTitle;
		editSavedBody = editBody;
		previewing = false;
		editMode = true;
		viewRevision = null;
		showHistory = false;
		saveProblem = '';
	}

	function handleCancelEdit() {
		if (draftOwner?.isSending()) return;
		afterDiscard(() => {
			editorEpoch += 1; imageUploading = false;
			editMode = false;
			previewing = false;
			saveState = 'idle';
			saveProblem = '';
		});
	}

	/** Back to Write (the editor mounts and makes its view in an effect), then run `action`. */
	async function inWriteMode(action: () => void) {
		if (previewing) {
			previewing = false;
			await tick();
			await new Promise((resolve) => requestAnimationFrame(resolve));
		}
		action();
	}

	function insertBlock(kind: InsertKind) {
		void inWriteMode(() => writer?.insert(kind));
	}

	async function handleImage(file: File) {
		if (!effectiveChannel || !file.type.startsWith('image/')) return;
		const owner = draftOwner;
		const epoch = editorEpoch;
		const isCurrent = () => mounted && owner === draftOwner && !!owner?.current() && epoch === editorEpoch;
		imageUploading = true;
		try {
			const uploaded = await uploadFileResumable(file, effectiveChannel, () => {}, false, undefined, isCurrent);
			if (!isCurrent()) return;
			const markdown = `![${file.name.replace(/\.[^.]+$/, '')}](${uploaded.fileUrl})`;
			await inWriteMode(() => writer?.insertText(markdown));
		} catch (err) {
			if (isCurrent()) {
				console.warn('[wiki] image upload failed', err);
				copyError = 'The image could not be uploaded. Your page is unchanged.';
			}
		} finally {
			if (isCurrent()) {
				imageUploading = false;
				if (imageInput) imageInput.value = '';
			}
		}
	}

	async function handleSaveEdit() {
		if (!effectiveChannel || !selectedPage || saveState === 'saving') return;
		if (!editTitle.trim()) {
			saveState = 'failed';
			saveProblem = 'Give the page a title to save it.';
			return;
		}
		saveProblem = '';
		const owner = draftOwner;
		if (owner === draftOwner) owner?.save(snapshot());
		const transaction = owner?.beginSend();
		if (!transaction) return;
		const savingChannel = effectiveChannel;
		const savingPage = selectedPage.pageId;
		const title = editTitle;
		const body = editBody;
		saveState = 'saving';
		const result = await updateWikiPage(effectiveChannel, selectedPage.pageId, {
			expectedUpdatedAtMicros: selectedPage.updatedAtMicros,
			title,
			body,
		});
		if (mounted && owner === draftOwner) owner?.save(snapshot());
		if (result) transaction.settle(draft => ({ ...draft,
			editSavedTitle: title, editSavedBody: body,
			editMode: draft.editTitle !== title || draft.editBody !== body
		}));
		transaction.finish();
		if (!mounted || !owner?.current() || effectiveChannel !== savingChannel || selectedPageId !== savingPage) return;
		previewing = false;
		saveState = result ? 'saved' : 'failed';
		if (result) void loadWiki(effectiveChannel);
	}

	function handleHistory() {
		if (draftOwner?.isSending()) return;
		afterDiscard(() => {
			showHistory = !showHistory;
			if (showHistory && effectiveChannel && selectedPage) void loadRevisions(effectiveChannel, selectedPage.pageId);
			editMode = false;
		});
	}

	function handleCloseHistory() {
		showHistory = false;
		viewRevision = null;
	}

	function handleSelectRevision(revision: WikiRevision) {
		viewRevision = revision;
	}

	async function handleRestoreRevision(revision: WikiRevision) {
		if (!effectiveChannel || !selectedPage) return;
		const owner = draftOwner;
		const restoringPage = selectedPage.pageId;
		const result = await updateWikiPage(effectiveChannel, selectedPage.pageId, {
			expectedUpdatedAtMicros: selectedPage.updatedAtMicros,
			title: revision.title,
			body: revision.body,
		});
		if (result && mounted && owner === draftOwner && owner?.current() && selectedPageId === restoringPage) {
			viewRevision = null;
		}
	}

	function handleDismissRevision() {
		viewRevision = null;
	}

	async function copyWikiCitation() {
		if (!selectedPage || !effectiveChannel) return;
		const citation = getWikiCitation(window.location.origin, effectiveChannel, selectedPage);
		try {
			await navigator.clipboard.writeText(formatWikiCitationMarkdown(citation));
			copyError = '';
		} catch {
			copyError = 'The page citation could not be copied.';
		}
	}

	function startNewPage(parentId: string | null) {
		editorEpoch += 1; imageUploading = false;
		editMode = false;
		createError = '';
		newPageTitle = '';
		newPageBody = '';
		newPageParentId = parentId;
		previewing = false;
		showNewPage = true;
		showTreeOnMobile = false;
	}

	function handleOpenNewPage() {
		if (draftOwner?.isSending() || showNewPage) return;
		afterDiscard(() => startNewPage(null));
	}

	function handleNewChild(parent: WikiPage | null) {
		if (draftOwner?.isSending()) return;
		if (!parent) { handleOpenNewPage(); return; }
		afterDiscard(() => startNewPage(parent.pageId));
	}

	function handleCancelNewPage() {
		if (creatingPage) return;
		afterDiscard(() => {
			editorEpoch += 1; imageUploading = false;
			closeNewPage();
			previewing = false;
			if (!selectedPageId) showTreeOnMobile = true;
		});
	}

	async function handleCreateNewPage() {
		if (!effectiveChannel || !newPageTitle.trim() || creatingPage) return;
		const owner = draftOwner;
		if (owner === draftOwner) owner?.save(snapshot());
		const transaction = owner?.beginSend();
		if (!transaction) return;
		creatingPage = true;
		createError = '';
		const creatingChannel = effectiveChannel;
		const result = await createWikiPage(effectiveChannel, {
			title: newPageTitle.trim(),
			body: newPageBody,
			parentPageId: newPageParentId || undefined,
		});
		if (mounted && owner === draftOwner) owner?.save(snapshot());
		if (result) transaction.settle(draft => ({ ...draft, showNewPage: false,
			newPageTitle: '', newPageBody: '', newPageParentId: null, selectedPageId: result.pageId }));
		transaction.finish();
		if (!mounted || !owner?.current() || effectiveChannel !== creatingChannel) return;
		creatingPage = false;
		if (!result) createError = 'Page could not be created. Your draft is still here.';
		if (result) void loadWiki(effectiveChannel);
	}

	$: shareRecord = selectedPage ? {
		kind: 'wiki_page' as const,
		id: selectedPage.pageId,
		slug: selectedPage.slug || slugify(selectedPage.title),
		title: selectedPage.title,
		channelId: effectiveChannel || '',
		subtitle: $forumAuthors.get(selectedPage.authorUserId)?.username || undefined,
		updatedAt: selectedPage.updatedAtMicros > 1e12 ? Math.floor(selectedPage.updatedAtMicros / 1000) : selectedPage.updatedAtMicros,
	} : null;

	// The page's ⋯: its own actions first, then the share actions every object offers.
	$: pageMenuItems = shareRecord ? [
		{ id: 'history', label: 'Revision history', icon: 'history', onSelect: handleHistory },
		{ id: 'citation', label: 'Copy page citation', icon: 'quote', onSelect: () => void copyWikiCitation() },
		{ id: 'reload', label: 'Reload pages', icon: 'refresh', disabled: isLoading || saveState === 'saving', onSelect: () => { if (effectiveChannel) void loadWiki(effectiveChannel); } },
		{ id: 'share-sep', type: 'separator' },
		...forumShareItems(shareRecord)
	] satisfies MenuEntry[] : [];

	$: insertItems = [
		...INSERT_KINDS.map(({ kind, label, icon }) => ({ id: `insert-${kind}`, label, icon, onSelect: () => insertBlock(kind) })),
		{ id: 'insert-sep', type: 'separator' },
		{ id: 'insert-image', label: imageUploading ? 'Uploading image…' : 'Image…', icon: 'image', disabled: imageUploading, onSelect: () => imageInput?.click() }
	] satisfies MenuEntry[];

	// [[Page title]] and [[Page title|label]] link wiki pages to each other. Unknown titles stay visible as
	// "missing" links so a typo or an unwritten page is obvious instead of silently plain text.
	function wikiLinkTarget(raw: string): WikiPage | undefined {
		const key = raw.trim().toLocaleLowerCase();
		return allPages.find((page) => page.title.trim().toLocaleLowerCase() === key || page.slug === key || slugify(page.title) === slugify(raw));
	}
	// [[Title]] and [[Title|label]] become anchors AFTER markdown parsing: parseMessage treats a
	// "#wikipage-…" destination as a channel reference and breaks the surrounding link.
	function escapeWikiText(value: string): string {
		return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}
	function renderWikiBody(markdown: string): string {
		const links: string[] = [];
		// Code stays literal: only prose outside fences and inline code gets wiki links.
		const stage = (prose: string) => prose.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_match, title: string, label?: string) => {
			const target = wikiLinkTarget(title);
			const text = escapeWikiText((label || title).trim());
			links.push(target
				? `<a href="#wikipage-${escapeWikiText(String(target.pageId))}" class="wiki-link">${text}</a>`
				: `<a href="#wikipage-missing" class="wiki-link wiki-link-missing" title="No page with this title yet">${text}</a>`);
			return `wabiwikilinkx${links.length - 1}x`;
		});
		const staged = markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, index) => (index % 2 === 1 ? part : stage(part))).join('');
		return parseMessage(staged, [], { allowTables: true }).replace(/wabiwikilinkx(\d+)x/g, (_m, i: string) => links[Number(i)] ?? '');
	}
	let mentionedUser = null as User | null;
	let mentionAnchor = null as HTMLElement | null;
	let mentionOpen = false;
	function openMention(token: HTMLElement): boolean {
		const name = token.textContent?.replace(/^@/, '').trim().toLowerCase();
		if (!name) return false;
		const known = [...$forumAuthors.values(), ...$presenceUsers] as User[];
		const user = known.find((item) => item.username?.toLowerCase() === name || item.handle?.toLowerCase() === name);
		if (!user) return false;
		mentionedUser = user; mentionAnchor = token; mentionOpen = true;
		return true;
	}
	function handleBodyClick(event: MouseEvent) {
		const mention = (event.target as HTMLElement | null)?.closest?.('.mention-token:not([data-ref-kind])') as HTMLElement | null;
		if (mention && openMention(mention)) { event.preventDefault(); return; }
		const anchor = (event.target as HTMLElement | null)?.closest?.('a[href^="#wikipage-"]') as HTMLAnchorElement | null;
		if (!anchor) return;
		event.preventDefault();
		const id = anchor.getAttribute('href')!.slice('#wikipage-'.length);
		const page = allPages.find((candidate) => candidate.pageId === id);
		if (page) selectPage(page);
	}
	/** Pages that link here with [[this title]]. */
	$: backlinks = selectedPage
		? allPages.filter((page) => page.pageId !== selectedPage!.pageId && new RegExp('\\[\\[\\s*' + selectedPage!.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(\\||\\]\\])', 'i').test(page.body))
		: [];
	$: renderedBody = displayBody ? renderWikiBody(displayBody) : '';
	$: editIsDirty = editMode && (editTitle !== editSavedTitle || editBody !== editSavedBody);
	$: if (editMode && editIsDirty && (saveState === 'idle' || saveState === 'saved')) saveState = 'dirty';
	$: if (editMode && !editIsDirty && saveState === 'dirty') saveState = 'idle';
	$: newPageDirty = showNewPage && Boolean(newPageTitle.trim() || newPageBody.trim());
	$: editStatus = saveState === 'saving' ? 'Saving…'
		: saveState === 'failed' ? (saveProblem || 'Save failed — your draft is still here')
		: editIsDirty ? 'Unsaved changes'
		: saveState === 'saved' ? 'Saved'
		: 'No changes yet';
	$: newPageStatus = creatingPage ? 'Creating…' : createError || (newPageDirty ? 'Unsaved draft' : 'New draft');

	// ---- ON THIS PAGE: headings come from the rendered page, so the outline always matches it ----
	$: sideShown = treeColumnShown(wikiWidth, inPanel);
	$: outline = buildWikiOutline(outlineHeadings);
	$: outlineEntries = flattenOutline(outline);
	$: outlineAt = outlinePlace(paneWidth, sideShown);
	// A pane with room keeps the margin column in every mode (reading with or without an outline,
	// Edit, New page, the overview), so the column and the breadcrumbs share one left edge and
	// nothing moves when Edit is pressed.
	$: paneWide = paneHasMargin(paneWidth);
	$: readingArticle = Boolean(selectedPage) && !editMode && !showNewPage;
	$: outlineVisible = readingArticle && showsOutline(outline);
	// Heading markers hang in the margin only where the column has free page beside it.
	$: hangMarkers = hangsMarkers(paneWidth);
	$: if (proseEl && renderedBody !== undefined) void tick().then(collectHeadings);
	$: if (!readingArticle) outlineHeadings = [];

	function collectHeadings() {
		if (!proseEl) { outlineHeadings = []; return; }
		const nodes = [...proseEl.querySelectorAll<HTMLElement>(':scope > :is(h1, h2, h3, h4)')];
		const ids = headingAnchorIds(nodes.map((node) => node.textContent ?? ''), `wiki-${draftSurface}`);
		nodes.forEach((node, index) => {
			node.id = ids[index];
			node.tabIndex = -1;
		});
		outlineHeadings = nodes.map((node, index) => ({ id: ids[index], level: Number(node.tagName.slice(1)), text: node.textContent?.trim() ?? '' }));
		trackSection();
	}

	let sectionFrame = 0;
	function trackSection() {
		if (sectionFrame || typeof window === 'undefined') return;
		sectionFrame = requestAnimationFrame(() => {
			sectionFrame = 0;
			if (!readingPane || !proseEl || outlineEntries.length === 0) { currentOutlineId = null; return; }
			const top = readingPane.getBoundingClientRect().top;
			const nodes = outlineEntries.map((entry) => proseEl?.querySelector<HTMLElement>(`#${CSS.escape(entry.id)}`) ?? null);
			const tops = nodes.map((node) => (node ? node.getBoundingClientRect().top - top : Number.POSITIVE_INFINITY));
			const index = currentSectionIndex(tops, 96);
			currentOutlineId = index >= 0 ? outlineEntries[index].id : null;
		});
	}

	function goToSection(event: MouseEvent, id: string) {
		event.preventDefault();
		const target = proseEl?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
		if (!target) return;
		const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduce';
		target.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
		target.focus({ preventScroll: true });
		currentOutlineId = id;
	}

	onDestroy(() => {
		draftOwner?.save(snapshot());
		mounted = false;
		stopDraftEvents?.();
		stopAuth(); stopContext(); stopRevocation();
		wikiWorkspace.dispose();
		selectedPageId = null;
		if (sectionFrame) cancelAnimationFrame(sectionFrame);
	});

	if (typeof window !== 'undefined') {
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!editIsDirty && !(showNewPage && (newPageTitle.trim() || newPageBody.trim()))) return;
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('beforeunload', handleBeforeUnload);
		onDestroy(() => window.removeEventListener('beforeunload', handleBeforeUnload));
	}
</script>

<svelte:document on:fullscreenchange={() => expandedReading = document.fullscreenElement === readingPane} />

{#snippet outlineList(entries: OutlineEntry[], labelled: boolean)}
	<nav class="w-outline wiki-outline" aria-label={$_('wiki.on_this_page')}>
		{#if labelled}<p class="w-outline__title">{$_('wiki.on_this_page')}</p>{/if}
		<ol>
			{#each entries as entry (entry.id)}
				<li>
					<a href={`#${entry.id}`} aria-current={currentOutlineId === entry.id ? 'location' : undefined} on:click={(event) => goToSection(event, entry.id)}>{entry.text}</a>
					{#if entry.children.length}
						<ol>
							{#each entry.children as child (child.id)}
								<li><a href={`#${child.id}`} aria-current={currentOutlineId === child.id ? 'location' : undefined} on:click={(event) => goToSection(event, child.id)}>{child.text}</a></li>
							{/each}
						</ol>
					{/if}
				</li>
			{/each}
		</ol>
	</nav>
{/snippet}

{#snippet writingTools(primaryLabel: string, primaryBusy: string, onPrimary: () => void, primaryDisabled: boolean, onCancel: () => void, busy: boolean)}
	<div class="wiki-crumb-actions wiki-write-actions">
		<Menu class="w-btn w-btn--quiet wiki-insert" label="Insert" triggerLabel="Insert" heading="Insert" items={insertItems} align="end" disabled={busy}>
			<Icon name="plus" size={16} /><span class="wiki-action-words">Insert</span>
		</Menu>
		<div class="w-seg wiki-mode" role="group" aria-label="Writing mode">
			<button type="button" aria-pressed={!previewing} on:click={() => { previewing = false; void tick().then(() => writer?.focus()); }}>Write</button>
			<button type="button" aria-pressed={previewing} on:click={() => { previewing = true; }}>Preview</button>
		</div>
		<button type="button" class="w-btn w-btn--quiet wiki-cancel" aria-label={$_('common.cancel')} disabled={busy} on:click={onCancel}><Icon name="x" size={16} class="wiki-cancel-icon" /><span class="wiki-action-words" aria-hidden="true">{$_('common.cancel')}</span></button>
		<button type="button" class="w-btn w-btn--primary" aria-busy={busy} disabled={primaryDisabled} on:click={onPrimary}>
			<span class="w-btn__swap"><span>{primaryLabel}</span><span>{primaryBusy}</span></span>
		</button>
	</div>
{/snippet}

{#snippet pagesToggle()}
	<!-- Shown only while the tree stacks above the page (wiki.css): it opens and closes the tree. -->
	<button type="button" class="w-btn w-btn--quiet w-btn--sm wiki-pages-toggle" aria-expanded={showTreeOnMobile} on:click={() => { showTreeOnMobile = !showTreeOnMobile; }}>
		<Icon name="sidebarLeft" size={14} />{$_('wiki.pages')}
	</button>
{/snippet}

<div class="wiki-channel" class:in-panel={inPanel} bind:clientWidth={wikiWidth}>
	<input class="wiki-image-input" type="file" accept="image/*" tabindex="-1" aria-hidden="true" bind:this={imageInput} on:change={(event) => { const file = (event.currentTarget as HTMLInputElement).files?.[0]; if (file) void handleImage(file); }} />
	<div class="wiki-body" class:has-drawer={showHistory}>
		<div class="wiki-side" class:hidden-mobile={!showTreeOnMobile}>
			<WikiPageTree
				pages={allPages}
				activePageId={showNewPage ? null : selectedPageId}
				onSelect={selectPage}
				onNewChild={canWrite ? handleNewChild : undefined}
				searchQuery={wikiSearchQuery}
				onSearch={(query) => { wikiSearchQuery = query; }}
				loading={isLoading}
				quiet={inPanel || editMode || showNewPage}
				newPageDisabled={showNewPage || creatingPage || saveState === 'saving'}
				idPrefix={`wiki-${draftSurface}`}
			/>
			{#if outlineVisible && outlineAt === 'side'}
				<div class="wiki-side-outline">{@render outlineList(outline, true)}</div>
			{/if}
		</div>

		<div class="wiki-content-pane" class:is-wide={paneWide} bind:this={readingPane} bind:clientWidth={paneWidth} on:scroll={trackSection}>
			<LoadLine active={isLoading} label="Loading pages" class="wiki-loadline" />
			{#if showNewPage}
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<section class="wiki-writing" aria-label="New page draft" on:keydown={(event) => { if (event.key === 'Escape' && !event.defaultPrevented) handleCancelNewPage(); }}>
					<div class="wiki-crumbs-row wiki-crumbs-row--writing"><div class="wiki-crumbs-inner">
						{@render pagesToggle()}
						<nav class="wiki-crumbs" aria-label="Breadcrumb">
							<ol>
								<li><button type="button" class="wiki-crumb" on:click={goToOverview}>{$_('places.wiki')}</button></li>
								{#each newPageCrumbs as crumb (crumb.pageId)}
									<li><Icon name="chevRight" size={14} class="wiki-crumb-sep" /><button type="button" class="wiki-crumb" on:click={() => { const page = allPages.find((p) => p.pageId === crumb.pageId); if (page) selectPage(page); }}>{crumb.title}</button></li>
								{/each}
								<li><Icon name="chevRight" size={14} class="wiki-crumb-sep" /><span class="wiki-crumb wiki-crumb--current" aria-current="page">{$_('wiki.new_page')}</span></li>
							</ol>
						</nav>
						{@render writingTools('Create page', 'Creating…', handleCreateNewPage, creatingPage || !newPageTitle.trim(), handleCancelNewPage, creatingPage)}
					</div></div>
					{#if copyError}
						<div class="wiki-page wiki-page--notice"><div class="wiki-article">
							<Notice title={copyError} tone="info" ondismiss={() => { copyError = ''; }} />
						</div></div>
					{/if}
					<div class="wiki-page">
						<div class="wiki-article wiki-article--writing">
							<header class="wiki-article-head">
								<input class="wiki-title-input" type="text" aria-label="Page title" placeholder="Page title" bind:value={newPageTitle} disabled={creatingPage} />
								<p class="wiki-meta">
									<span>{newPageParent ? `Under ${newPageParent.title}` : 'Top-level page'}</span>
									<span class="wiki-meta-sep" aria-hidden="true">·</span>
									<span class="wiki-meta-status" class:problem={Boolean(createError)} role="status">{#if createError}<span class="w-dot w-dot--danger" aria-hidden="true"></span>{:else if newPageDirty && !creatingPage}<span class="w-dot w-dot--warn" aria-hidden="true"></span>{/if}{newPageStatus}</span>
								</p>
							</header>
							{#if previewing}
								<div class="w-prose wiki-prose wiki-preview">{#if newPageBody.trim()}{@html renderWikiBody(newPageBody)}{:else}<p class="wiki-preview-empty">Nothing to preview yet.</p>{/if}</div>
							{:else}
								{#key editorEpoch}
									<WritingEditor bind:this={writer} value={newPageBody} onchange={(value) => { newPageBody = value; }} ariaLabel="Page text" placeholder={WRITING_PLACEHOLDER} readonly={creatingPage} hang={hangMarkers} onimage={() => imageInput?.click()} imageBusy={imageUploading} class="wiki-writer" />
								{/key}
							{/if}
						</div>
					</div>
				</section>
			{:else if !selectedPage}
				{#if isLoading && allPages.length === 0}
					<div class="wiki-page"><div class="wiki-article"><Skeleton variant="text" rows={3} label="Loading pages" /></div></div>
				{:else if error && allPages.length === 0}
					<div class="wiki-page"><div class="wiki-article wiki-notice">
						<Notice title="This wiki could not be loaded" text="Nothing you were writing here was lost." error={error} onretry={() => effectiveChannel && loadWiki(effectiveChannel)} />
					</div></div>
				{:else if allPages.length === 0}
					<div class="wiki-page"><div class="wiki-article">
						<EmptyState variant="top" title="No pages yet" text={canWrite ? 'Pages keep what this community wants to remember: guides, plans and answers. Start one with New page.' : 'Pages written here will show up in this list.'} as="h2" />
					</div></div>
				{:else}
					{#if error}
						<div class="wiki-page wiki-page--notice"><div class="wiki-article">
							<Notice title="Part of this wiki could not be loaded" text="The pages below are the last ones this view received." error={error} onretry={() => effectiveChannel && loadWiki(effectiveChannel)} ondismiss={() => wikiErrorStore.set(null)} />
						</div></div>
					{/if}
					<div class="wiki-page">
						<section class="wiki-article wiki-start" aria-labelledby={`wiki-start-title-${draftSurface}`}>
							<h1 class="wiki-start-title" id={`wiki-start-title-${draftSurface}`} tabindex="-1" bind:this={startTitleEl}>Explore this wiki</h1>
							<p class="wiki-start-hint">Browse a topic, search page titles and contents, or pick up a recently updated page.</p>
							<p class="w-kicker wiki-start-kicker">Topics</p>
							<ul class="wiki-start-list">
								{#each allPages.filter(page => !page.parentPageId || !allPages.some(parent => parent.pageId === page.parentPageId)) as page (page.pageId)}
									{@const children = allPages.filter(child => child.parentPageId === page.pageId).length}
									<li><button type="button" class="wiki-start-row" on:click={() => selectPage(page)}><span class="wiki-start-row-title">{page.title}</span>{#if children > 0}<span class="w-count">{children} {children === 1 ? 'page' : 'pages'}</span>{/if}</button></li>
								{/each}
							</ul>
							<p class="w-kicker wiki-start-kicker">Recently updated</p>
							<ul class="wiki-start-list">
								{#each [...allPages].sort((a,b) => b.updatedAtMicros-a.updatedAtMicros).slice(0,5) as page (page.pageId)}
									<li><button type="button" class="wiki-start-row" on:click={() => selectPage(page)}><span class="wiki-start-row-title">{page.title}</span><span class="wiki-start-time">{formatWikiTime(page.updatedAtMicros)}</span></button></li>
								{/each}
							</ul>
						</section>
					</div>
				{/if}
			{:else}
				<div class="wiki-crumbs-row" class:wiki-crumbs-row--writing={editMode}><div class="wiki-crumbs-inner">
					{@render pagesToggle()}
					<nav class="wiki-crumbs" aria-label="Breadcrumb">
						<ol>
							<li><button type="button" class="wiki-crumb" on:click={goToOverview}>{$_('places.wiki')}</button></li>
							{#each ancestorCrumbs as crumb (crumb.pageId)}
								<li><Icon name="chevRight" size={14} class="wiki-crumb-sep" /><button type="button" class="wiki-crumb" on:click={() => { const page = allPages.find((p) => p.pageId === crumb.pageId); if (page) selectPage(page); }}>{crumb.title}</button></li>
							{/each}
							<li><Icon name="chevRight" size={14} class="wiki-crumb-sep" /><span class="wiki-crumb wiki-crumb--current" aria-current="page">{selectedPage.title}</span></li>
						</ol>
					</nav>
					{#if editMode}
						{@render writingTools($_('common.save'), 'Saving…', handleSaveEdit, saveState === 'saving' || !editIsDirty, handleCancelEdit, saveState === 'saving')}
					{:else}
						<div class="wiki-crumb-actions">
							{#if canWrite}
								<button type="button" class="w-btn w-btn--quiet wiki-edit-btn" aria-label="Edit page" on:click={handleEdit}><Icon name="pencil" size={16} /><span class="wiki-action-words" aria-hidden="true">Edit</span></button>
							{/if}
							<Tooltip text={expandedReading ? 'Exit fullscreen' : 'Fullscreen'} placement="bottom">
								<button type="button" class="w-ibtn" aria-label={expandedReading ? 'Exit fullscreen' : 'Fullscreen'} on:click={toggleReading}><Icon name={expandedReading ? 'collapse' : 'expand'} /></button>
							</Tooltip>
							{#if pageMenuItems.length}
								<Menu class="w-ibtn" label="Page actions" triggerLabel="Page actions" heading={selectedPage.title} align="end" items={pageMenuItems}><Icon name="more" /></Menu>
							{/if}
						</div>
					{/if}
				</div></div>

				{#if copyError}
					<div class="wiki-page wiki-page--notice"><div class="wiki-article">
						<Notice title={copyError} tone="info" ondismiss={() => { copyError = ''; }} />
					</div></div>
				{/if}
				{#if error && !editMode}
					<div class="wiki-page wiki-page--notice"><div class="wiki-article">
						<Notice title="Part of this wiki could not be loaded" text="The page below is the last version this view received." error={error} onretry={() => effectiveChannel && loadWiki(effectiveChannel)} ondismiss={() => wikiErrorStore.set(null)} />
					</div></div>
				{/if}

				{#if editMode}
					<div class="wiki-page">
						<div class="wiki-article wiki-article--writing">
							<header class="wiki-article-head">
								<input class="wiki-title-input" type="text" aria-label="Page title" placeholder="Page title" bind:value={editTitle} aria-invalid={saveProblem ? 'true' : undefined} />
								<p class="wiki-meta">
									<span>Editing</span>
									<span class="wiki-meta-sep" aria-hidden="true">·</span>
									<span class="wiki-meta-status" class:problem={saveState === 'failed'} role="status">{#if saveState === 'failed'}<span class="w-dot w-dot--danger" aria-hidden="true"></span>{:else if editIsDirty && saveState !== 'saving'}<span class="w-dot w-dot--warn" aria-hidden="true"></span>{/if}{editStatus}</span>
								</p>
							</header>
							{#if previewing}
								<div class="w-prose wiki-prose wiki-preview">{#if editBody.trim()}{@html renderWikiBody(editBody)}{:else}<p class="wiki-preview-empty">Nothing to preview yet.</p>{/if}</div>
							{:else}
								{#key editorEpoch}
									<WritingEditor bind:this={writer} value={editBody} onchange={(value) => { editBody = value; }} ariaLabel="Page text" placeholder={WRITING_PLACEHOLDER} readonly={saveState === 'saving'} hang={hangMarkers} onimage={() => imageInput?.click()} imageBusy={imageUploading} class="wiki-writer" />
								{/key}
							{/if}
						</div>
					</div>
				{:else}
					<div class="wiki-page">
						<article class="wiki-article" aria-labelledby={`wiki-title-${draftSurface}`}>
							{#if viewRevision}
								<div class="wiki-revision-banner" role="status">
									<Icon name="history" size={16} />
									<span class="wiki-revision-words">Viewing the version from {formatWikiTime(viewRevision.createdAtMicros)}</span>
									<button type="button" class="w-btn w-btn--sm" on:click={() => viewRevision && handleRestoreRevision(viewRevision)}>Restore this version</button>
									<button type="button" class="w-btn w-btn--sm w-btn--quiet" on:click={handleDismissRevision}>Back to current</button>
								</div>
							{/if}
							<header class="wiki-article-head">
								<h1 class="wiki-article-title" id={`wiki-title-${draftSurface}`}>{displayTitle}</h1>
								<p class="wiki-meta" style={$inkFor(displayAuthor?.color || displayAuthor?.roleColor)}>
									<span class="wiki-av" aria-hidden="true">
										{#if displayAuthor?.profilePicture}<ProfileMedia src={mediaUrl(displayAuthor.profilePicture)} alt="" />{:else}{(authorName || '?').charAt(0).toUpperCase()}{/if}
									</span>
									<span class="wiki-meta-name" title={displayAuthor ? undefined : 'This author is not in the server member directory.'}>{authorName}</span>
									<span class="wiki-meta-sep" aria-hidden="true">·</span>
									<span>Updated <time class="wiki-meta-time">{displayTime}</time></span>
									{#if !viewRevision}
										<span class="wiki-meta-sep" aria-hidden="true">·</span>
										{#if displayRevisionCount > 0}
											<button type="button" class="wiki-meta-link" aria-expanded={showHistory} on:click={handleHistory}>{wikiVersionNote(displayRevisionCount)}</button>
										{:else}
											<span>{wikiVersionNote(0)}</span>
										{/if}
									{/if}
								</p>
								{#if outlineVisible && outlineAt === 'inline'}
									<div class="wiki-outline-inline">
										<button type="button" class="w-disclosure" aria-expanded={outlineOpen} on:click={() => { outlineOpen = !outlineOpen; }}>
											<Icon name="chevRight" size={16} />{$_('wiki.on_this_page')}<span class="w-count">{outlineEntries.length}</span>
										</button>
										{#if outlineOpen}<div class="w-disclosure__body">{@render outlineList(outline, false)}</div>{/if}
									</div>
								{/if}
							</header>
							<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
							<div class="w-prose wiki-prose" bind:this={proseEl} on:click={handleBodyClick}>{@html renderedBody}</div>
							{#if mentionOpen}<UserPopout user={mentionedUser} bind:isOpen={mentionOpen} anchorElement={mentionAnchor} isOwnProfile={mentionedUser?.dbUserId === $presenceCurrentUser?.dbUserId} />{/if}
							{#if backlinks.length > 0 && !viewRevision}
								<aside class="wiki-backlinks" aria-label="Linked from">
									<p class="w-kicker">Linked from</p>
									<ul>
										{#each backlinks as page (page.pageId)}
											<li><button type="button" class="wiki-backlink" on:click={() => selectPage(page)}>{page.title}</button></li>
										{/each}
									</ul>
								</aside>
							{/if}
						</article>
						{#if outlineVisible && outlineAt === 'margin'}
							<aside class="wiki-margin">{@render outlineList(outline, true)}</aside>
						{/if}
					</div>
				{/if}
			{/if}
		</div>

		{#if showHistory}
			<WikiRevisionDrawer
				revisions={revisionsForDrawer}
				activeRevisionId={viewRevision?.revisionId || null}
				onSelectRevision={handleSelectRevision}
				onClose={handleCloseHistory}
			/>
		{/if}
	</div>
</div>
