<!--
	The frame around an open document, spreadsheet or deck (design contract §7.23, §8.8).

	Row A of the stage masthead is the editor header (OfficeEditorHeader, registered with
	setStageHeader): crumb back to the library, PREVIEW, the title, the locality truth and the save
	state, then Share… and ⋯. There are no extra bands: everything the old button wall held lives
	in ⋯ (Export, private copy, links, drafts, discussion, undo), errors show as one notice above the
	content and passing confirmations as toasts. Comments on shared files are a 320px aside.
-->
<script lang="ts">
	import ArtifactHandoff from './ArtifactHandoff.svelte';
	import OfficeEditorHeader, { type OfficeHeaderModes } from './OfficeEditorHeader.svelte';
	import { onDestroy, type Snippet } from 'svelte';
	import { get } from 'svelte/store';
	import { serverMembers, currentUser } from '$lib/presenceIdentity';
	import { channels } from '$lib/channelStore';
	import { workspaceLink, openWorkspace, type Role, type Review } from './bridge';
	import { ArtifactSession, download, editText, makePrivateCopy, type PrivateDraft } from './session';
	import { describeAnchor, linkAnchor } from './anchors';
	import { setWorkspaceAddonEnabled } from './addonState';
	import { compactStatus } from './officeStatus';
	import { clearStageHeader, setStageHeader, type StageHeaderAction } from '$lib/stageHeader';
	import { confirmAction } from '$lib/confirm';
	import { isMobile } from '$lib/layoutStoreStates';
	import { toast } from '$lib/toast';
	import BaseModal from '$lib/components/BaseModal.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import Notice from '$lib/components/ui/Notice.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Segmented from '$lib/components/ui/Segmented.svelte';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import './workspace.css';

	let {
		session,
		onlibrary,
		initialShare,
		children,
		selectionAnchor = null,
		onanchor,
		oncopy,
		modes = null,
		exports = []
	}: {
		session: ArtifactSession;
		onlibrary: () => void | Promise<void>;
		initialShare?: 'snapshot' | 'live';
		children: Snippet;
		selectionAnchor?: string | null;
		onanchor?: (anchor: string) => void;
		oncopy?: (copy: ArtifactSession) => void | Promise<void>;
		/** The tool's mode segment for row A (Documents: Write | Read). */
		modes?: OfficeHeaderModes | null;
		/** Tool exports for the ⋯ Export group, each with its format truth as the hint. */
		exports?: MenuEntry[];
	} = $props();

	const sessionState = session.state;
	const HEADER_OWNER = 'office-editor';
	const tool = $derived(session.record.kind === 'document' ? 'documents' : session.record.kind);
	const toolName = $derived(tool === 'documents' ? 'Documents' : tool === 'sheets' ? 'Sheets' : 'Present');
	const noun = $derived(tool === 'documents' ? 'document' : tool === 'sheets' ? 'spreadsheet' : 'presentation');

	let shareOpen = $state(false), error = $state(''), busy = $state(false), reviewOpen = $state(false), recoveryOpen = $state(false);
	let moreAnchor = $state<HTMLElement | null>(null), moreOpen = $state(false);
	let handoff = $state<ArtifactHandoff>();
	let mode = $state<'snapshot' | 'live'>(initialShare || 'live'), recipient = $state(''), recipientRole = $state<Role>('editor');
	let grants = $state<Record<string, Role>>({}), channelId = $state(''), channelRole = $state<Role>('viewer'), accessRevision = $state(0);
	let openedInitial = false, alive = true;
	let comment = $state(''), proposal = $state(''), suggestion = $state(false), suggestionBase = $state(0), reviewAnchor = $state<string | null>(null), replyTo = $state<string | null>(null);
	let reviewId: string = crypto.randomUUID();
	let draftId = $state('review:' + crypto.randomUUID());

	const editable = $derived(!$sessionState.meta || ['owner', 'editor'].includes($sessionState.meta.role));
	const title = $derived.by(() => { $sessionState.tick; return session.title; });
	const references = $derived.by(() => { $sessionState.tick; return Object.fromEntries($sessionState.reviews.map((item) => [item.id, describeAnchor(session.doc, item.anchor)])); });
	const stagedReviews = $derived(Object.entries($sessionState.drafts).filter(([, draft]) => draft.kind === 'review'));
	const draftCount = $derived(Object.keys($sessionState.drafts).length);
	const openReviews = $derived($sessionState.reviews.filter((item) => item.state === 'open').length);
	const selectedReference = $derived.by(() => { $sessionState.tick; return describeAnchor(session.doc, selectionAnchor); });
	const isOwner = $derived(!$sessionState.meta || $sessionState.meta.role === 'owner');
	const isAdmin = $derived(['owner', 'admin'].includes($currentUser?.highestRole ?? ''));
	const people = $derived($serverMembers.filter((user) => user.dbUserId && !(String(user.dbUserId) in grants)));
	const serverHost = $derived.by(() => { try { return new URL(session.scope.server).host; } catch { return session.scope.server; } });

	async function run(fn: () => Promise<unknown>) {
		if (busy) return;
		busy = true;
		error = '';
		try { await fn(); } catch (e) { if (alive) error = e instanceof Error ? e.message : String(e); }
		finally { if (alive) busy = false; }
	}
	/** A passing confirmation: a toast, never a band that moves the editor. */
	function note(message: string) {
		toast(message, { tone: 'info', timeout: 7000 });
	}

	function showSharing() {
		const meta = session.record.meta;
		mode = initialShare || meta?.mode || 'live';
		grants = { ...(meta?.grants || {}) };
		channelId = meta?.channelId || '';
		channelRole = meta?.channelRole || 'viewer';
		accessRevision = meta?.accessRevision || 0;
		error = '';
		shareOpen = true;
	}
	$effect(() => { if (initialShare && !openedInitial) { openedInitial = true; showSharing(); } });
	async function share() {
		await session.publish(mode);
		await session.access(grants, channelId || null, channelRole, mode, accessRevision || session.record.meta!.accessRevision);
		if (alive) shareOpen = false;
	}
	async function freezeLiveEditing() {
		if (session.record.meta?.role !== 'owner' || session.record.meta.mode !== 'live') throw new Error('Only the owner can freeze a collaborative document.');
		const freeze = await confirmAction({
			title: 'Freeze live editing?',
			body: 'Existing shared content and access will remain. Later edits stay private until you explicitly publish or resume collaboration.',
			confirm: 'Freeze live editing'
		});
		if (!freeze) return;
		await session.sync();
		if (!alive || !session.scope.isCurrent()) return;
		const meta = session.record.meta;
		if (!meta || meta.role !== 'owner' || meta.mode !== 'live') throw new Error('Sharing changed. Review the current document before freezing.');
		// Preserve the current grants and compare the ACL revision. The server increments the
		// mode generation, rejecting late old-generation writes.
		await session.access(meta.grants || {}, meta.channelId || null, meta.channelRole, 'snapshot', meta.accessRevision);
		if (alive) note('Live editing is frozen. Shared content and access are retained; subsequent edits remain private until explicitly published.');
	}
	function addRecipient() {
		if (!/^[1-9]\d*$/.test(recipient)) return;
		grants = { ...grants, [recipient]: recipientRole };
		recipient = '';
	}
	function recipientName(id: string) {
		return $serverMembers.find((user) => String(user.dbUserId) === id)?.username || 'Someone no longer on this server';
	}
	function stageReview() {
		try {
			session.stageDraft(draftId, { kind: 'review', text: comment, context: { proposal, suggestion, suggestionBase, reviewId, anchor: reviewAnchor, parentId: replyTo }, updatedAt: Date.now() });
		} catch (e) { error = e instanceof Error ? e.message : String(e); }
	}
	function changeComment(value: string) {
		if (!comment && !proposal && !replyTo) reviewAnchor = selectionAnchor;
		comment = value;
		stageReview();
	}
	function prepareSuggestion() {
		suggestion = !suggestion;
		replyTo = null;
		if (suggestion) { proposal = session.body.toString(); suggestionBase = session.record.meta?.sequence || 0; reviewAnchor = selectionAnchor; }
		else proposal = '';
		stageReview();
	}
	function resetComposer() {
		reviewId = crypto.randomUUID();
		draftId = 'review:' + crypto.randomUUID();
		comment = ''; proposal = ''; suggestion = false; reviewAnchor = null; replyTo = null;
	}
	async function addReview() {
		await session.flush();
		await session.review({ action: 'add', id: reviewId, kind: suggestion ? 'suggestion' : 'comment', body: comment, anchor: reviewAnchor, ...(replyTo ? { parentId: replyTo } : {}), ...(suggestion ? { proposal, baseSequence: suggestionBase } : {}) });
		session.stageDraft(draftId, null);
		await session.flush();
		if (alive) resetComposer();
	}
	function restoreReview(id: string, draft: PrivateDraft) {
		if (comment || proposal) { error = 'Submit or clear the current composer first. Both saved drafts are retained.'; return; }
		draftId = id;
		comment = draft.text;
		proposal = typeof draft.context.proposal === 'string' ? draft.context.proposal : '';
		suggestion = draft.context.suggestion === true;
		suggestionBase = Number(draft.context.suggestionBase) || 0;
		reviewId = typeof draft.context.reviewId === 'string' ? draft.context.reviewId : crypto.randomUUID();
		reviewAnchor = typeof draft.context.anchor === 'string' ? draft.context.anchor : null;
		replyTo = typeof draft.context.parentId === 'string' ? draft.context.parentId : null;
		reviewOpen = true;
		recoveryOpen = false;
	}
	function reply(item: Review) {
		if (comment || proposal) { error = 'Submit or clear the current draft before replying.'; return; }
		replyTo = item.id;
		reviewAnchor = item.anchor;
		reviewOpen = true;
		stageReview();
	}
	async function clearComposer() {
		session.stageDraft(draftId, null);
		await session.flush();
		resetComposer();
	}
	function backup() {
		const value = JSON.parse(session.recovery());
		if (comment || proposal) value.visibleReviewRecovery = { comment, proposal, suggestion, suggestionBase, reviewId, anchor: reviewAnchor, parentId: replyTo };
		download(`${session.title}.wabi.json`, JSON.stringify(value, null, 2));
	}
	async function privateCopy() {
		const copy = await makePrivateCopy(session);
		if (!alive || !session.scope.isCurrent()) { await copy.close(); return; }
		if (oncopy) await oncopy(copy);
		else { const id = copy.id, kind = copy.record.kind; await copy.close(); openWorkspace(kind === 'document' ? 'documents' : kind, { id }); }
	}
	async function copyLink() {
		await navigator.clipboard.writeText(workspaceLink(session.scope.server, session.id, session.record.kind));
		if (alive) note('Link copied. It opens only for people who already have access.');
	}
	async function copyReference() {
		if (!session.record.meta) throw new Error('Share the document before copying an access-controlled reference.');
		await navigator.clipboard.writeText(workspaceLink(session.scope.server, session.id, session.record.kind, linkAnchor(selectionAnchor)));
		if (alive) note('Reference copied. It grants no additional access and contains no selected text.');
	}
	function exportOriginal() {
		const original = session.record.original;
		if (original) download(original.name, original.blob);
	}
	async function turnOffTool() {
		if (tool !== 'sheets' && tool !== 'present') return;
		const off = await confirmAction({
			title: `Turn off ${toolName} on this device?`,
			body: `Your ${noun === 'spreadsheet' ? 'spreadsheets' : 'presentations'} stay on this device and nothing is shared or deleted. Its editor stops loading until you turn it on again.`,
			confirm: `Turn off ${toolName}`
		});
		if (!off) return;
		await session.flush();
		await setWorkspaceAddonEnabled(tool, false);
	}
	/** Open Comments on the current selection (the writing page's bubble on a shared document). */
	export function commentOnSelection() {
		reviewAnchor = selectionAnchor;
		reviewOpen = true;
	}
	function openServerSettings() {
		window.dispatchEvent(new CustomEvent('wabi:open-settings', { detail: { tab: 'admin' } }));
	}

	const menuItems = $derived.by((): MenuEntry[] => {
		const meta = $sessionState.meta;
		const items: MenuEntry[] = [
			// On a phone the crumb steps out of row A for the title; the library is reachable here.
			...($isMobile ? [{ id: 'library', label: `${toolName} library`, icon: 'arrowLeft', onSelect: () => void run(async () => { await session.flush(); if (alive) await onlibrary(); }) } satisfies MenuEntry] : []),
			// …and so do the tool's modes (Write | Read), as radio rows.
			...($isMobile && modes
				? [
						{ id: 'k-mode', type: 'kicker', label: modes.label } satisfies MenuEntry,
						...modes.options.map((option) => ({ id: `mode-${option.value}`, label: option.label, role: 'menuitemradio', checked: modes!.value === option.value, onSelect: () => modes!.onchange(option.value) }) satisfies MenuEntry)
					]
				: []),
			{ id: 'k-export', type: 'kicker', label: 'Export' },
			...exports,
			{ id: 'backup', label: 'Backup (.wabi.json)', icon: 'download', hint: 'Everything here, private drafts included', onSelect: backup },
			...(session.record.original ? [{ id: 'original', label: 'Original file', icon: 'file', hint: session.record.original.name, keepCase: true, onSelect: exportOriginal } satisfies MenuEntry] : []),
			{ id: 'sep-1', type: 'separator', label: '' },
			{ id: 'copy', label: 'Make private copy', icon: 'copy', disabled: busy, onSelect: () => void run(privateCopy) }
		];
		if (meta) {
			items.push({ id: 'link', label: 'Copy link', icon: 'link', hint: 'Opens only with access', onSelect: () => void run(copyLink) });
			if (selectionAnchor) {
				items.push(
					{ id: 'comment-sel', label: 'Comment on selection', icon: 'chat', hint: selectedReference.label, onSelect: commentOnSelection },
					{ id: 'link-sel', label: 'Copy selection link', icon: 'link', onSelect: () => void run(copyReference) }
				);
			}
			if (meta.role === 'owner') {
				if (meta.mode === 'live') items.push({ id: 'freeze', label: 'Freeze live editing', icon: 'lock', disabled: busy, onSelect: () => void run(freezeLiveEditing) });
				else items.push({ id: 'resume', label: 'Resume collaboration…', icon: 'users', disabled: busy, onSelect: () => { showSharing(); mode = 'live'; } });
			}
		}
		if (draftCount) items.push({ id: 'drafts', label: `Private drafts (${draftCount})`, icon: 'history', onSelect: () => { recoveryOpen = !recoveryOpen; } });
		items.push(
			{ id: 'discuss', label: 'Discuss in chat…', icon: 'chat', disabled: busy || !meta, hint: meta ? undefined : 'Share it first', onSelect: () => handoff?.showDiscussion() },
			{ id: 'task', label: 'Create private task', icon: 'calendarCheck', disabled: busy || !meta, hint: meta ? undefined : 'Share it first', onSelect: () => void handoff?.createTask() },
			{ id: 'sep-2', type: 'separator', label: '' },
			{ id: 'undo', label: 'Undo', icon: 'undo', shortcut: 'Ctrl Z', disabled: !editable || busy, onSelect: () => { session.undo.undo(); } },
			{ id: 'redo', label: 'Redo', icon: 'redo', shortcut: 'Ctrl Shift Z', disabled: !editable || busy, onSelect: () => { session.undo.redo(); } }
		);
		if (tool === 'sheets' || tool === 'present' || isAdmin) items.push({ id: 'sep-3', type: 'separator', label: '' });
		if (tool === 'sheets' || tool === 'present') items.push({ id: 'off', label: `Turn off ${toolName} on this device…`, icon: 'eyeOff', onSelect: () => void run(turnOffTool) });
		if (isAdmin) items.push({ id: 'server', label: 'Server sharing settings', icon: 'gear', hint: 'Admins', onSelect: openServerSettings });
		return items;
	});

	const headerActions = $derived.by((): StageHeaderAction[] => {
		const meta = $sessionState.meta;
		const list: StageHeaderAction[] = [];
		if (meta) list.push({ id: 'review', label: openReviews ? `Review, ${openReviews} open` : 'Review', icon: 'chat', iconOnly: true, pressed: reviewOpen, onSelect: () => { reviewOpen = !reviewOpen; } });
		if (meta?.mode === 'snapshot' && meta.role === 'owner') list.push({ id: 'publish', label: 'Publish revision', icon: 'upload', variant: 'default', disabled: busy, onSelect: () => void run(() => session.sync(true)) });
		// On a phone Share… is its icon (the name stays for assistive tech) so the title keeps its room.
		if (isOwner) list.push({ id: 'share', label: 'Share…', icon: 'share', variant: 'default', iconOnly: $isMobile, disabled: busy, onSelect: showSharing });
		list.push({ id: 'more', label: `${toolName} options`, icon: 'more', iconOnly: true, onSelect: (anchor) => { moreAnchor = anchor; moreOpen = !moreOpen; } });
		return list;
	});

	// When the session's words last changed: "Saved 09:41" names the save, not the render.
	let statusAt = $state(new Date());
	let lastStatus = '';
	$effect(() => {
		const status = $sessionState.status;
		if (status !== lastStatus) { lastStatus = status; statusAt = new Date(); }
	});

	$effect(() => {
		const meta = $sessionState.meta;
		setStageHeader(HEADER_OWNER, {
			view: tool,
			title,
			component: OfficeEditorHeader,
			props: {
				tool,
				title,
				editable,
				ontitle: (value: string) => editText(session.doc.getText('title'), value, session.origin),
				onlibrary: () => void run(async () => { await session.flush(); if (alive) await onlibrary(); }),
				shared: meta ? { role: meta.role, mode: meta.mode } : null,
				status: compactStatus($sessionState.status, statusAt),
				selection: selectionAnchor ? selectedReference.label : null,
				modes
			},
			actions: headerActions
		});
	});

	onDestroy(() => {
		alive = false;
		clearStageHeader(HEADER_OWNER);
	});
</script>

<section class="wabi-workspace" aria-label={`${toolName} editor`}>
	{#if error || $sessionState.error}
		<Notice class="workspace-notice" title={error || $sessionState.error} text="Your work is still here on this device.">
			{#snippet actions()}
				<button type="button" class="w-btn w-btn--sm" disabled={busy} onclick={() => run(async () => { await session.flush(); await session.sync(); session.startPolling(); })}>Retry</button>
				<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={backup}>Export recovery</button>
			{/snippet}
		</Notice>
	{/if}
	{#if recoveryOpen}
		<section class="workspace-recovery" aria-label="Private draft recovery">
			<div class="workspace-recovery__head">
				<h2 class="workspace-recovery__title">Unsubmitted work on this device</h2>
				<button type="button" class="w-ibtn w-ibtn--sm" aria-label="Close recovery" onclick={() => (recoveryOpen = false)}><Icon name="x" /></button>
			</div>
			<p class="workspace-recovery__text">These buffers are private. Restoring one does not publish it.</p>
			{#each stagedReviews as [id, draft] (id)}
				<div class="workspace-recovery__row">
					<span class="workspace-recovery__draft">{draft.text.slice(0, 140) || 'Unsubmitted suggestion'}</span>
					<button type="button" class="w-btn w-btn--sm" onclick={() => restoreReview(id, draft)}>Restore review</button>
				</div>
			{/each}
			{#if Object.values($sessionState.drafts).some((draft) => draft.kind === 'cell')}
				<p class="workspace-recovery__text">Cell drafts can be restored from the spreadsheet’s recovery controls. Export backup retains every buffer.</p>
			{/if}
			<div class="workspace-recovery__foot"><button type="button" class="w-btn w-btn--sm" onclick={backup}>Export all recovery data</button></div>
		</section>
	{/if}
	<div class="workspace-body">
		<main class="workspace-content">{@render children()}</main>
		{#if reviewOpen}
			<aside class="workspace-reviews" aria-label="Comments">
				<div class="workspace-reviews__head">
					<h2 class="workspace-reviews__title">Comments</h2>
					<button type="button" class="w-ibtn w-ibtn--sm" aria-label="Close comments" onclick={() => (reviewOpen = false)}><Icon name="x" /></button>
				</div>
				{#if $sessionState.meta?.role !== 'viewer'}
					<div class="workspace-reviews__composer">
						{#if replyTo}
							<p class="workspace-reviews__context">Reply to {recipientName(String($sessionState.reviews.find((item) => item.id === replyTo)?.authorUserId || ''))}<button type="button" class="w-btn w-btn--quiet w-btn--sm" onclick={() => { replyTo = null; stageReview(); }}>New thread instead</button></p>
						{/if}
						{#if reviewAnchor}
							<p class="workspace-reviews__context">On {describeAnchor(session.doc, reviewAnchor).label}<button type="button" class="w-btn w-btn--quiet w-btn--sm" disabled={!!replyTo} onclick={() => { reviewAnchor = null; stageReview(); }}>Use whole {noun}</button></p>
						{/if}
						<textarea class="w-field workspace-reviews__field" aria-label="Review comment" value={comment} oninput={(event) => changeComment(event.currentTarget.value)} maxlength="8192" placeholder={`Discuss this ${noun}…`}></textarea>
						{#if session.record.kind === 'document'}
							<button type="button" class="w-btn w-btn--quiet w-btn--sm" aria-pressed={suggestion} onclick={prepareSuggestion}>{suggestion ? 'Cancel suggestion' : 'Suggest wording'}</button>
						{/if}
						{#if suggestion}
							<p class="workspace-reviews__hint">The proposed text stays separate. Applying it requires an unchanged source or a new review.</p>
							<textarea class="w-field workspace-reviews__field workspace-reviews__field--tall" aria-label="Proposed document text" value={proposal} oninput={(event) => { proposal = event.currentTarget.value; stageReview(); }} maxlength="1048576"></textarea>
						{/if}
						<div class="workspace-reviews__actions">
							{#if comment || proposal}
								<span class="workspace-reviews__hint">Saved privately until submitted.</span>
								<button type="button" class="w-btn w-btn--quiet w-btn--sm" disabled={busy} onclick={() => run(clearComposer)}>Discard draft</button>
							{/if}
							<button type="button" class="w-btn w-btn--primary w-btn--sm" disabled={busy || (!comment.trim() && !suggestion)} onclick={() => run(addReview)}>Comment</button>
						</div>
					</div>
				{/if}
				{#each $sessionState.reviews as item (item.id)}
					<article class="workspace-review">
						<p class="workspace-review__by"><strong>{item.authorName}</strong><span class="workspace-review__meta"> · {item.kind} · {item.state}{item.parentId ? ' · reply' : ''}</span></p>
						{#if item.anchor}
							<button type="button" class="workspace-review__anchor" disabled={!onanchor || references[item.id]?.missing} onclick={() => onanchor?.(item.anchor!)}>{references[item.id]?.label || 'Reference'}{references[item.id]?.missing ? ' — content removed' : ''}</button>
							{#if references[item.id]?.quote}<blockquote class="workspace-review__quote">{references[item.id].quote}</blockquote>{/if}
						{/if}
						<p class="workspace-review__body">{item.body}</p>
						{#if item.proposal !== null}<details class="workspace-review__proposal"><summary>Proposed wording</summary><pre>{item.proposal}</pre></details>{/if}
						<div class="workspace-review__actions">
							{#if $sessionState.meta?.role !== 'viewer'}<button type="button" class="w-btn w-btn--quiet w-btn--sm" onclick={() => reply(item)}>Reply</button>{/if}
							{#if editable}
								{#if item.kind === 'suggestion' && item.state === 'open'}
									<button type="button" class="w-btn w-btn--sm" disabled={busy || $sessionState.meta?.mode !== 'live'} onclick={() => run(() => session.review({ action: 'accept', id: item.id }))}>Apply</button>
									<button type="button" class="w-btn w-btn--quiet w-btn--sm" disabled={busy} onclick={() => run(() => session.review({ action: 'reject', id: item.id }))}>Reject</button>
								{/if}
								<button type="button" class="w-btn w-btn--quiet w-btn--sm" disabled={busy} onclick={() => run(() => session.review({ action: item.state === 'resolved' ? 'reopen' : 'resolve', id: item.id }))}>{item.state === 'resolved' ? 'Reopen' : 'Resolve'}</button>
							{/if}
						</div>
					</article>
				{:else}
					<p class="workspace-reviews__empty">No comments yet.</p>
				{/each}
			</aside>
		{/if}
	</div>
</section>

<ArtifactHandoff bind:this={handoff} {session} anchor={selectionAnchor} />

{#if moreAnchor}
	<Menu items={menuItems} label={`${toolName} options`} anchor={moreAnchor} bind:open={moreOpen} align="end" heading={title} subheading={`${$sessionState.meta ? `Shared · ${$sessionState.meta.role}. Server-readable.` : 'Private · this device.'} ${compactStatus($sessionState.status, statusAt)}`} />
{/if}

<BaseModal isOpen={shareOpen} onClose={() => { if (!busy) shareOpen = false; }} size="md" padded title={`Share ${title}`} ariaLabel="Document sharing">
	<form class="workspace-share" id="workspace-share-form" onsubmit={(event) => { event.preventDefault(); void run(share); }}>
		<p class="workspace-share__truth"><Icon name="lockOpen" size={16} /><span>Publishes to <strong>{serverHost}</strong>. The server operator can read this document. No public link is created.</span></p>

		<div class="workspace-share__field">
			<span class="w-label" id="share-mode-label">Working mode</span>
			<Segmented class="workspace-share__modes" labelledby="share-mode-label" options={[{ value: 'live', label: 'Collaborative' }, { value: 'snapshot', label: 'Snapshot' }]} bind:value={mode} />
			<p class="workspace-share__hint">{mode === 'live' ? 'Edits sync for everyone with access.' : 'Revisions publish only when you choose.'}</p>
		</div>

		<div class="workspace-share__field">
			<span class="w-label">Add people by name</span>
			<div class="workspace-share__add">
				<label class="w-field workspace-share__person"><select aria-label="Person" bind:value={recipient}><option value="">Choose a person</option>{#each people as user (user.dbUserId)}<option value={String(user.dbUserId)}>{user.username}</option>{/each}</select><Icon name="chevDown" /></label>
				<label class="w-field workspace-share__role"><select aria-label="Recipient permission" bind:value={recipientRole}><option value="viewer">Viewer</option><option value="commenter">Commenter</option><option value="editor">Editor</option></select><Icon name="chevDown" /></label>
				<button type="button" class="w-btn" disabled={!recipient} onclick={addRecipient}>Add person</button>
			</div>
		</div>

		{#if Object.keys(grants).length}
			<ul class="workspace-share__people" aria-label="People with access">
				{#each Object.entries(grants) as [id, role] (id)}
					<li class="workspace-share__grant">
						<span class="workspace-share__name">{recipientName(id)}</span>
						<label class="w-field workspace-share__role"><select aria-label={`Permission for ${recipientName(id)}`} value={role} onchange={(event) => (grants = { ...grants, [id]: event.currentTarget.value as Role })}><option value="viewer">Viewer</option><option value="commenter">Commenter</option><option value="editor">Editor</option></select><Icon name="chevDown" /></label>
						<button type="button" class="w-ibtn w-ibtn--sm" aria-label={`Remove access for ${recipientName(id)}`} onclick={() => { const next = { ...grants }; delete next[id]; grants = next; }}><Icon name="x" /></button>
					</li>
				{/each}
			</ul>
		{/if}

		<div class="workspace-share__field">
			<span class="w-label">Or share with a channel</span>
			<div class="workspace-share__add">
				<label class="w-field workspace-share__person"><select aria-label="Sharing channel" bind:value={channelId}><option value="">No channel</option>{#each $channels as channel (channel.id)}<option value={channel.id}>{channel.name}</option>{/each}</select><Icon name="chevDown" /></label>
				{#if channelId}<label class="w-field workspace-share__role"><select aria-label="Channel permission" bind:value={channelRole}><option value="viewer">Viewer</option><option value="commenter">Commenter</option><option value="editor">Editor</option></select><Icon name="chevDown" /></label>{/if}
			</div>
			{#if channelId}<p class="workspace-share__hint">Private conversation channels are not supported for server-readable files.</p>{/if}
		</div>

		{#if error}<p class="workspace-share__error" role="alert"><Icon name="alert" size={16} />{error}</p>{/if}
	</form>
	<div slot="footer" class="w-dialog__foot">
		<button type="button" class="w-btn w-btn--quiet" disabled={busy} onclick={() => (shareOpen = false)}>Cancel</button>
		<button type="submit" form="workspace-share-form" class="w-btn w-btn--primary" disabled={busy}>{busy ? 'Sharing…' : 'Share'}</button>
	</div>
</BaseModal>
