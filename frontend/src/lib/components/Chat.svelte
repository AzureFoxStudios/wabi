<script lang="ts">
	import { onMount, onDestroy, tick, createEventDispatcher } from 'svelte';
	import { get } from 'svelte/store';
	import { showToast } from '$lib/toast';
	import { deletionModeEnabled as deletionModeStore } from '$lib/moderationDeleteMode';
	import {
		channelMessagesStore,
		channels,
		currentChannel,
		typingUsers,
		sendMessage,
		lastReadMessageId,
		currentUser,
		users,
		serverMembers,
		dmPanelSignal,
		createDM,
		getDMChannelIdForUser,
		getDMOtherUser,
		userLookup,
		loadOlderHistory,
		channelHasMoreHistory,
		channelHistoryLoading,
		loadOlderMessages,
		channelLoadingOlder,
		pinChannel,
		unpinChannel,
		type Message,
		type User,
		type Channel
	} from '$lib/socket';
	import { todos, projects, calendarEvents, diaryEntries } from '$lib/business/store';
	import { layoutStore } from '$lib/layoutStore';
	import { isMobile } from '$lib/layoutStoreStates';
	import { isInCall } from '$lib/callingStateStores';
	import VideoBackground from './VideoBackground.svelte';
	import { _, currentLocale } from '$lib/i18n';
	import { animationPassStore } from '$lib/animationPass';
	import { getAuthToken } from '$lib/authSession';
	import { paymentAccessStore, refreshPaymentAccess } from '$lib/payments/paymentAccessStore';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { getSearchEngineProvider, openExternalSearch } from '$lib/searchEngineJump';
	import { openFullMapTab } from '$lib/mapWorkspace';
	import { openModelViewportSurface } from '$lib/modelViewportTab';
	import { openReaderSurface } from '$lib/readerWorkspace';
	import { pushLocalDirectionsCard } from '$lib/directionsAssist';
	import { currentChatSurface } from '$lib/whiteboard/whiteboardSurface';
	import { activeWorkspaceView } from '$lib/workspaceNavigationState';
	import { isRoutedChannelType, isTextLikeChannelType } from '$lib/channelTypes';
	import { isLiveRetention } from '../../../../shared/messageRetention.js';
	import ChannelModePlaceholder from './ChannelModePlaceholder.svelte';
	import ChatComposer from './chat/ChatComposer.svelte';
	// Row A of the stage masthead (StageBar) shows the channel header and owns the search field;
	// this stream filters by its query and reports the result facts back.
	import { chatSearch, chatStageInfo, resetChatSearch, setChatSearchQuery } from './chat/ChatHeader.svelte';
	import ChatMessagesPane from './chat/ChatMessagesPane.svelte';
	import { executeChatCommand } from './chat/commandExecutor';
	import { filterMessages, getChannelHistoryFlags, waitForHistoryIdle } from './chat/search';
	import { formatTypingUsers, getVisibleTypingUsers } from './chat/typing';
	import { channelPaneInTransition, channelPaneOutTransition } from './chat/transitions';
	import { isNearMessageBottom } from '$lib/messageViewport';

	const dispatch = createEventDispatcher();
	let PaymentSheetCmp: typeof import('$lib/payments/PaymentSheet.svelte').default | null = null;
	type SendChatMessage = (channelId: string, text: string, type: string, opts?: Record<string, unknown>) => void;
	const sendChatMessage = sendMessage as unknown as SendChatMessage;
	const resolveDmChannelId = "" as unknown as (u: User | null, t: User) => string;
	const openExistingDmSignal = dmPanelSignal as unknown as { set(v: { channelId: string; otherUser: User }): void };

	$: chatSurface = $currentChatSurface;
	$: if (paymentSheetOpen && !PaymentSheetCmp) void import('$lib/payments/PaymentSheet.svelte').then((module) => (PaymentSheetCmp = module.default));

	// The Project workspace owns the visible Board / Wiki / Discussion navigation.
	// Keep this local mode so the ordinary channel stream and composer render only
	// while Discussion is selected.
	let projectChannelMode: 'files' | 'chat' = 'files';
	$: if (currentChannelType !== 'lore' && currentChannelType !== 'planning') projectChannelMode = 'files';

	function setProjectChannelMode(mode: 'files' | 'chat'): void {
		projectChannelMode = mode;
	}

	// Scoped per-channel store: re-emits only when THIS channel's array
	// changes (god-store fix) — other channels' traffic no longer recomputes
	// the message list / pinned filter chain below.
	$: messagesForChannel = channelMessagesStore($currentChannel);
	$: messages = $messagesForChannel || [];
	$: pinnedMessages = messages.filter((m: Message) => m.isPinned);
	$: currentChannelData = $channels.find(ch => ch.id === $currentChannel);
	$: channelDisplayName = currentChannelData?.name || $currentChannel;

	$: isDMChannel = currentChannelData?.type === 'dm';
	$: isGroupChannel = currentChannelData?.type === 'group';
	$: currentChannelType = (currentChannelData?.type || 'text') as string;
	$: channelUsesChatStream = isTextLikeChannelType(currentChannelType)
		|| ((currentChannelType === 'planning' || currentChannelType === 'lore') && projectChannelMode === 'chat');
	$: isLiveChannel = isLiveRetention(currentChannelData?.autoDeleteAfter);
	$: dmCallTargetUser = getDMOtherUser(currentChannelData, $currentUser, $userLookup);
	let paymentTargetKind: 'channel' | 'dm' | 'group' | 'workspace' | null = null;
	$: paymentTargetLabel = (() => {
		if (isDMChannel && dmCallTargetUser?.username) return `DM with ${dmCallTargetUser.username}`;
		if (isGroupChannel) return channelDisplayName;
		return channelDisplayName ? `#${channelDisplayName}` : $currentChannel;
	})();
	$: paymentTargetKind = isDMChannel ? 'dm' : isGroupChannel ? 'group' : 'channel';
	$: channelPaneAnimation = (() => {
		const baseDuration = $animationPassStore.level === 'full' ? 340 : 250;
		const baseDistance = $animationPassStore.level === 'full' ? 34 : 22;
		return {
			enabled: $animationPassStore.enabled,
			preset: $animationPassStore.preset,
			duration: Math.max(0, Math.round(baseDuration * $animationPassStore.durationMultiplier)),
			distance: Math.max(0, Math.round(baseDistance * $animationPassStore.durationMultiplier))
		};
	})();

	// ── Payment modals ──────────────────────────────────────────────────────────
	let paymentSheetOpen = false;
	let paymentSheetOpenSeed = 0;
	let paymentSheetPrefillAmountInput: string | null = null;
	let paymentSheetPrefillDescription: string | null = '';
	let paymentSheetPrefillCustomerRef: string | null = '';
	$: paymentButtonEnabled = Boolean($currentUser?.dbUserId) && Boolean(getAuthToken()) && $paymentAccessStore.loaded && $paymentAccessStore.canCreate;
	$: if ($currentUser?.dbUserId) void refreshPaymentAccess();

	type PaymentSheetPrefill = { amountInput?: string | null; description?: string | null; customerRef?: string | null };

	function openPaymentSheet(prefill: PaymentSheetPrefill = {}): void {
		if (!paymentButtonEnabled) { alert('Sign in with a registered account to create payments.'); return; }
		paymentSheetPrefillAmountInput = typeof prefill.amountInput === 'string' && prefill.amountInput.trim().length > 0 ? prefill.amountInput.trim() : null;
		paymentSheetPrefillDescription = typeof prefill.description === 'string' ? prefill.description.trim() : '';
		paymentSheetPrefillCustomerRef = typeof prefill.customerRef === 'string' ? prefill.customerRef.trim() : '';
		paymentSheetOpenSeed += 1;
		paymentSheetOpen = true;
	}

	// ── Composer bindings ───────────────────────────────────────────────────────
	let chatComposer: ChatComposer;
	let replyingTo: Message | null = null;
	let composerVisible = true;
	let isTextareaFocused = false;

	function handleReply(message: Message) {
		replyingTo = message;
		chatComposer?.focus();
	}

	function handleQuickMention(message: Message) {
		chatComposer?.insertQuickMention(message.user);
	}

	// ── Drag and drop (delegates file handling to ChatComposer) ─────────────────
	let isDragging = false;
	let dragCounter = 0;

	function handleDragEnter(e: DragEvent) {
		e.preventDefault(); e.stopPropagation();
		dragCounter++;
		if (e.dataTransfer?.types.includes('Files')) isDragging = true;
	}
	function handleDragLeave(e: DragEvent) {
		e.preventDefault(); e.stopPropagation();
		if (--dragCounter === 0) isDragging = false;
	}
	function handleDragOver(e: DragEvent) { e.preventDefault(); e.stopPropagation(); }
	async function handleDrop(e: DragEvent) {
		e.preventDefault(); e.stopPropagation();
		isDragging = false; dragCounter = 0;
		const files = Array.from(e.dataTransfer?.files || []);
		if (files.length) await chatComposer?.receiveFiles(files, 'replace');
	}

	// ── Search ──────────────────────────────────────────────────────────────────
	let chatContainer: HTMLElement;
	let followLatestMessages = true;
	let scrollChannelId = '';
	// The query lives in the masthead's search store (StageBar row A); read it here.
	$: searchInput = $chatSearch.query;
	let filteredMessages: Message[] = [];
	const MESSAGE_WORKING_SET_LIMIT_EPHEMERAL = 600;
	const MESSAGE_WORKING_SET_LIMIT_PERSISTENT_IDLE = 1200;
	const MESSAGE_WORKING_SET_LIMIT_PERSISTENT_SEARCH = 5000;
	const SEARCH_BACKFILL_THROTTLE_MS = 700;
	let lastSearchBackfillAt = 0;
	let isFullHistorySearchRunning = false;
	let fullHistorySearchAbortRequested = false;
	let fullHistorySearchPagesLoaded = 0;
	let fullHistorySearchStatus = '';
	const MAX_FULL_HISTORY_SEARCH_PAGES = 80;
	let visibleTypingUsers: string[] = [];

	function getWorkingSetLimit(): number {
		if (currentChannelData?.persistMessages) {
			return searchInput.trim() ? MESSAGE_WORKING_SET_LIMIT_PERSISTENT_SEARCH : MESSAGE_WORKING_SET_LIMIT_PERSISTENT_IDLE;
		}
		return MESSAGE_WORKING_SET_LIMIT_EPHEMERAL;
	}

	$: filteredMessages = filterMessages(messages, searchInput, getWorkingSetLimit());
	$: visibleTypingUsers = getVisibleTypingUsers($typingUsers[$currentChannel] || [], $currentUser, $users as User[]);
	$: if (!searchInput.trim()) fullHistorySearchStatus = '';
	$: searchBackfillBusy =
		Boolean(searchInput.trim()) && Boolean(currentChannelData?.persistMessages) &&
		(($channelHistoryLoading[$currentChannel] || false) || ($channelLoadingOlder[$currentChannel] || false));
	$: {
		if (searchInput.trim() && currentChannelData?.persistMessages && $currentChannel && !isFullHistorySearchRunning) {
			const now = Date.now();
			if (now - lastSearchBackfillAt >= SEARCH_BACKFILL_THROTTLE_MS) {
				const { hasMoreServer, serverLoading, hasMoreArchive, archiveLoading } = getChannelHistoryFlags($currentChannel);
				if (hasMoreServer && !serverLoading) { lastSearchBackfillAt = now; loadOlderHistory($currentChannel); }
				else if (hasMoreArchive && !archiveLoading) { lastSearchBackfillAt = now; void loadOlderMessages($currentChannel); }
			}
		}
	}

	async function scrollToBottom(force = false) {
		if (!force && !followLatestMessages) return;
		await tick();
		if (!chatContainer) return;
		chatContainer.scrollTop = chatContainer.scrollHeight;
		followLatestMessages = true;
	}

	function handleConversationScroll(target: HTMLElement): void {
		followLatestMessages = isNearMessageBottom(target);
		// The composer is structural phone UI. Reading/scrolling messages must
		// never make the user hunt for the input box again.
		if ($isMobile) composerVisible = true;
	}

	$: if ($currentChannel && $currentChannel !== scrollChannelId) {
		scrollChannelId = $currentChannel;
		followLatestMessages = true;
		void scrollToBottom(true);
	}
	$: if (messages.length) void scrollToBottom();

	async function runFullHistorySearchBackfill(): Promise<void> {
		if (!searchInput.trim() || !currentChannelData?.persistMessages || !$currentChannel) return;
		if (isFullHistorySearchRunning) return;
		const channelId = $currentChannel;
		const querySnapshot = searchInput.trim();
		isFullHistorySearchRunning = true;
		fullHistorySearchAbortRequested = false;
		fullHistorySearchPagesLoaded = 0;
		fullHistorySearchStatus = get(_)('chat.search.status.scanning');
		try {
			for (let i = 0; i < MAX_FULL_HISTORY_SEARCH_PAGES; i += 1) {
				if (fullHistorySearchAbortRequested) { fullHistorySearchStatus = get(_)('chat.search.status.stopped'); return; }
				if ($currentChannel !== channelId || searchInput.trim() !== querySnapshot) { fullHistorySearchStatus = get(_)('chat.search.status.changed'); return; }
				const flags = getChannelHistoryFlags(channelId);
				if (flags.serverLoading || flags.archiveLoading) { await waitForHistoryIdle(channelId); continue; }
				if (flags.hasMoreServer) { loadOlderHistory(channelId); fullHistorySearchPagesLoaded += 1; }
				else if (flags.hasMoreArchive) { await loadOlderMessages(channelId); fullHistorySearchPagesLoaded += 1; }
				else { fullHistorySearchStatus = get(_)('chat.search.status.loaded'); return; }
				await waitForHistoryIdle(channelId);
				await tick();
			}
			fullHistorySearchStatus = get(_)('chat.search.status.limit');
		} finally { isFullHistorySearchRunning = false; }
	}

	function toggleFullHistorySearchBackfill(): void {
		if (isFullHistorySearchRunning) { fullHistorySearchAbortRequested = true; return; }
		void runFullHistorySearchBackfill();
	}

	function searchCurrentQueryInBrowser(): void {
		if (!$displayEnhancementSettingsStore.googleSearchReplaceEnabled) return;
		openExternalSearch(searchInput, getSearchEngineProvider());
	}

	// ── Commands (provided as callback to ChatComposer) ─────────────────────────
	async function executeCommand(commandInput: string) {
		await executeChatCommand(commandInput, {
			currentChannel: $currentChannel, currentUser: $currentUser,
			users: $users as User[], serverMembers: $serverMembers as User[],
			channels: $channels, todos: $todos, calendarEvents: $calendarEvents,
			diaryEntries: $diaryEntries, projects: $projects, currentLocale: $currentLocale,
			paymentButtonEnabled, sendMessage: sendChatMessage, pinChannel, unpinChannel,
			setSearchInput: setChatSearchQuery,
			openReaderSurface, openModelViewportSurface, openFullMapTab,
			openPaymentSheet, dispatchLogout: () => dispatch('logout'),
			onToggleDeletionMode: () => {
				const next = !get(deletionModeStore);
				if (next) {
					const confirmed = window.confirm('Deletion mode removes messages immediately for everyone. Turn it on?');
					if (!confirmed) return;
				}
				deletionModeStore.set(next);
				if (next) showToast?.('Deletion mode on — click a message to remove it. Esc exits.', 'info');
				else showToast?.('Deletion mode off.', 'info');
			},
			undefined, "": resolveDmChannelId,
			openExistingDM: (channelId, otherUser) => openExistingDmSignal.set({ channelId, otherUser }),
			pushLocalDirectionsCard,
			navigateTo: path => { window.location.href = path; }
		});
	}

	// ── Lifecycle ───────────────────────────────────────────────────────────────
	onMount(() => {
		scrollToBottom();
	});

	// What the masthead search shows about this stream: the result count, history backfill and
	// the full-history scan. Only text-like streams showing messages filter by the query.
	$: chatStageInfo.set({
		channelId: $currentChannel,
		searchable: channelUsesChatStream && !isLiveChannel && chatSurface === 'messages',
		resultCount: filteredMessages.length,
		backfillBusy: searchBackfillBusy,
		persistMessages: Boolean(currentChannelData?.persistMessages),
		fullHistoryRunning: isFullHistorySearchRunning,
		fullHistoryPages: fullHistorySearchPagesLoaded,
		fullHistoryStatus: fullHistorySearchStatus,
		onSearchWeb: searchCurrentQueryInBrowser,
		onToggleFullHistory: toggleFullHistorySearchBackfill
	});
	// Leaving the stream ends its search, as it always did when the header lived in here.
	// A stream mounted meanwhile (a quick view switch) keeps what it published.
	onDestroy(() => {
		if (get(chatStageInfo)?.onSearchWeb !== searchCurrentQueryInBrowser) return;
		chatStageInfo.set(null);
		resetChatSearch();
	});


</script>

<div
	class="chat-container"
	role="presentation"
	on:dragenter={handleDragEnter}
	on:dragleave={handleDragLeave}
	on:dragover={handleDragOver}
	on:drop={handleDrop}
>
	<VideoBackground />
	{#if isDragging}
		<div class="drag-overlay overlay">
			<div class="drag-overlay-content">
				<div class="drag-icon">📁</div>
				<div class="drag-text">{$_('chat.drag.drop_to_upload')}</div>
			</div>
		</div>
	{/if}

	{#if chatSurface === 'whiteboard'}
		<div class="whiteboard-surface">
			{#await import('./WhiteboardTab.svelte') then module}
				<svelte:component this={module.default} channelId={$currentChannel} />
			{/await}
		</div>
	{/if}

	{#if (currentChannelType === 'lore' || currentChannelType === 'planning') && $activeWorkspaceView === 'messages'}
		<!-- Project channels ARE their view: the repo workspace is the default
		     surface, not a teaser card pointing at the server-wide hub.
		     Single occupant of the center stage — the messages pane below is
		     hidden while this renders (no sibling flex split). -->
		<div class="lore-channel-surface" class:discussion-mode={projectChannelMode === 'chat'}>
			{#await import('./ProjectWorkspace.svelte') then module}
				<svelte:component this={module.default} discussionAvailable discussionActive={projectChannelMode === 'chat'} onDiscussionChange={(active: boolean) => setProjectChannelMode(active ? 'chat' : 'files')} />
			{/await}
		</div>
	{/if}

	<!-- TEMPORARY: DMs now render in center like channels -->
	<div
		class="messages"
		bind:this={chatContainer}
		class:surface-hidden={chatSurface !== 'messages' || ((currentChannelType === 'lore' || currentChannelType === 'planning') && $activeWorkspaceView === 'messages' && projectChannelMode === 'files')}
		on:scroll={(e) => handleConversationScroll(e.currentTarget)}
	>
		{#if isLiveChannel}
			{#await import('./live/LiveChannelView.svelte') then module}
				<svelte:component this={module.default} channel={currentChannelData} />
			{/await}
		{:else if currentChannelType === 'gallery'}
			{#await import('./GalleryChannel.svelte') then module}
				<svelte:component this={module.default} />
			{/await}
		{:else if currentChannelType === 'forum'}
			{#await import('./ForumChannel.svelte') then module}
				<svelte:component this={module.default} />
			{/await}
		{:else if currentChannelType === 'wiki'}
			{#await import('./WikiChannel.svelte') then module}
				<svelte:component this={module.default} />
			{/await}
		{:else if currentChannelType === 'reception'}
			{#await import('./ReceptionBoard.svelte') then module}
				<svelte:component this={module.default} />
			{/await}
		{:else if isRoutedChannelType(currentChannelType) && currentChannelType !== 'lore' && currentChannelType !== 'planning'}
			<ChannelModePlaceholder channel={currentChannelData} mode={currentChannelType as 'forum' | 'wiki' | 'stage'} />
		{:else}
			<ChatMessagesPane
				currentChannel={$currentChannel}
				{searchInput}
				{channelDisplayName}
				{filteredMessages}
				{pinnedMessages}
				firstUnreadMessageId={$lastReadMessageId}
				{channelPaneAnimation}
				{searchBackfillBusy}
		currentChannelPersistMessages={Boolean(currentChannelData?.persistMessages)}
				{isFullHistorySearchRunning}
				{fullHistorySearchPagesLoaded}
				{fullHistorySearchStatus}
				{visibleTypingUsers}
				{channelPaneInTransition}
				{channelPaneOutTransition}
				{formatTypingUsers}
				onSearchCurrentQueryInBrowser={searchCurrentQueryInBrowser}
				onToggleFullHistorySearchBackfill={toggleFullHistorySearchBackfill}
				onReply={handleReply}
				onQuickMention={handleQuickMention}
				onOpenSettings={() => dispatch('openSettings')}
			/>
		{/if}
	</div>

		{#if $isMobile && !followLatestMessages && channelUsesChatStream && !isLiveChannel && chatSurface === 'messages'}
			<button
				type="button"
				class="mobile-jump-latest"
				on:click={() => { followLatestMessages = true; void scrollToBottom(true); }}
				aria-label="Jump to newest messages"
			>
				<span aria-hidden="true">↓</span> Newest
			</button>
		{/if}

		{#if channelUsesChatStream && !isLiveChannel && chatSurface === 'messages' && !($isMobile && $isInCall)}
			{#key `${$currentUser?.dbUserId || $currentUser?.id || ''}:${$currentChannel}`}
			<ChatComposer
				bind:this={chatComposer}
				{isDMChannel}
				channelId={$currentChannel}
				channelType={currentChannelData?.type ?? null}
				{paymentButtonEnabled}
				bind:replyingTo
				bind:composerVisible
				bind:isTextareaFocused
				onExecuteCommand={executeCommand}
				onOpenPaymentSheet={openPaymentSheet}
			/>
			{/key}
		{/if}
	</div>

		{#if PaymentSheetCmp}
		<svelte:component this={PaymentSheetCmp}
			isOpen={paymentSheetOpen}
			openSeed={paymentSheetOpenSeed}
			initialAmountInput={paymentSheetPrefillAmountInput}
			initialDescription={paymentSheetPrefillDescription}
			initialCustomerRef={paymentSheetPrefillCustomerRef}
			defaultTargetLabel={paymentTargetLabel}
			defaultTargetKind={paymentTargetKind}
			onClose={() => {
				paymentSheetOpen = false;
			}}
			onManageConnections={() => {
				paymentSheetOpen = false;
				dispatch('openSettings', { paymentSurface: 'connections' });
			}}
			defaultChannelId={$currentChannel}
		/>
		{/if}
