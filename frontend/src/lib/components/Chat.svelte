<script lang="ts">
	import { onMount, onDestroy, tick, createEventDispatcher } from 'svelte';
	import { get } from 'svelte/store';
	import {
		channelMessages,
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
		socket,
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
	import PaymentSheet from '$lib/payments/PaymentSheet.svelte';
	import { layoutStore } from '$lib/layoutStore';
	import { isMobile } from '$lib/layoutStoreStates';
	import { callMode, isInCall, outgoingCall } from '$lib/callingStateStores';
	import { startCall } from '$lib/calling';
	import { _, currentLocale } from '$lib/i18n';
	import { getUserIdentityKey } from '$lib/localNicknames';
	import { animationPassStore } from '$lib/animationPass';
	import { getAuthToken } from '$lib/authSession';
	import { paymentAccessStore, refreshPaymentAccess } from '$lib/payments/paymentAccessStore';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { getSearchEngineProvider, openExternalSearch } from '$lib/searchEngineJump';
	import { isExperimentalWabidbCallEnabled, setExperimentalWabidbCallEnabled } from '$lib/experimentalWabidbCalls';
	import { MAP_ADDON_ID, focusedMapPlace, openFullMapTab } from '$lib/mapWorkspace';
	import { MODEL_VIEWPORT_ADDON_ID, modelViewportSelection, openModelViewportSurface } from '$lib/modelViewportTab';
	import { READER_ADDON_ID, openReaderSurface, readerSelection } from '$lib/readerWorkspace';
	import { MEDIA_ALBUMS_ADDON_ID } from '$lib/mediaAlbumsWorkspace';
	import { mobileTabQueue } from '$lib/mobileTabQueue';
	import { pushLocalDirectionsCard } from '$lib/directionsAssist';
	import { currentChatSurface, setWhiteboardSurface } from '$lib/whiteboard/whiteboardSurface';
	import { isRoutedChannelType, isTextLikeChannelType } from '$lib/channelTypes';
	import { isLiveRetention } from '../../../../shared/messageRetention.js';
	import LiveChannelView from './live/LiveChannelView.svelte';
	import WhiteboardTab from './WhiteboardTab.svelte';
	import ChannelModePlaceholder from './ChannelModePlaceholder.svelte';
	import ChatComposer from './chat/ChatComposer.svelte';
	import ChatHeader from './chat/ChatHeader.svelte';
	import ChatMessagesPane from './chat/ChatMessagesPane.svelte';
	import GalleryChannel from './GalleryChannel.svelte';
	import LoreChannelShell from './lore/LoreChannelShell.svelte';
	import ForumChannel from './ForumChannel.svelte';
	import WikiChannel from './WikiChannel.svelte';
import ReceptionBoard from './ReceptionBoard.svelte';
import { PLANNER_ADDON_ID } from '$lib/plannerWorkspace';
import { NOTES_ADDON_ID } from '$lib/notesWorkspace';
import { LORE_ADDON_ID } from '$lib/loreWorkspace';
import { FILES_ADDON_ID } from '$lib/filesWorkspace';
import PlannerWorkspace from '$lib/components/business/PlannerWorkspace.svelte';
import KeepNotesView from './KeepNotesView.svelte';
import LoreWorkspace from './LoreWorkspace.svelte';
import FilesWorkspace from './FilesWorkspace.svelte';
	import { executeChatCommand } from './chat/commandExecutor';
	import { filterMessages, getChannelHistoryFlags, waitForHistoryIdle } from './chat/search';
	import { formatTypingUsers, getVisibleTypingUsers } from './chat/typing';
	import { channelPaneInTransition, channelPaneOutTransition } from './chat/transitions';
	import type { WorkspaceViewKey } from './chat/types';

	const dispatch = createEventDispatcher();
	type SendChatMessage = (channelId: string, text: string, type: string, opts?: Record<string, unknown>) => void;
	const sendChatMessage = sendMessage as unknown as SendChatMessage;
	const resolveDmChannelId = "" as unknown as (u: User | null, t: User) => string;
	const openExistingDmSignal = dmPanelSignal as unknown as { set(v: { channelId: string; otherUser: User }): void };

	$: chatSurface = $currentChatSurface;
	const { activeTabId: mobileQueueActiveTabId } = mobileTabQueue;
	let selectedWorkspaceView: WorkspaceViewKey = 'messages';
	$: selectedWorkspaceView = (() => {
		if (chatSurface === 'whiteboard') return 'whiteboard' as const;
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(READER_ADDON_ID)) return 'reader' as const;
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(MODEL_VIEWPORT_ADDON_ID)) return 'model' as const;
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(MAP_ADDON_ID)) return 'map' as const;
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(MEDIA_ALBUMS_ADDON_ID)) return 'media' as const;
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(PLANNER_ADDON_ID)) return 'planner' as const;
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(NOTES_ADDON_ID)) return 'notes' as const;
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(LORE_ADDON_ID)) return 'lore' as const;
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(FILES_ADDON_ID)) return 'files' as const;
		return 'messages' as const;
	})();

	$: messages = $channelMessages[$currentChannel] || [];
	$: pinnedMessages = messages.filter((m: Message) => m.isPinned);
	$: currentChannelData = $channels.find(ch => ch.id === $currentChannel);
	$: channelDisplayName = currentChannelData?.name || $currentChannel;
	$: channelDescription = currentChannelData?.description?.trim() || '';
	$: workspaceSurfaceLabel = (() => {
		switch (selectedWorkspaceView) {
			case 'whiteboard': return 'Whiteboard';
			case 'reader': return 'Reader';
			case 'model': return '3D Viewport';
			case 'map': return 'Map';
			case 'media': return 'Media Albums';
			case 'files': return 'Files';
			default: return '';
		}
	})();
	$: workspaceHeaderTitle = (() => {
		switch (selectedWorkspaceView) {
			case 'reader': return $readerSelection?.title || 'Reader';
			case 'model': return $modelViewportSelection?.fileName || '3D model';
			case 'map': return $focusedMapPlace?.name || 'Map';
			default: return channelDisplayName;
		}
	})();
	$: workspaceHeaderSubtitle = (() => {
		switch (selectedWorkspaceView) {
			case 'whiteboard': return channelDescription || 'Shared board for this channel';
			case 'reader': return `Opened from #${channelDisplayName}`;
			case 'model': return `Opened from #${channelDisplayName}`;
			case 'map': return channelDisplayName ? `Opened from #${channelDisplayName}` : 'Map workspace';
			case 'lore': return channelDescription;
			case 'files': return "Shared files across this server's spaces";
			default: return channelDescription;
		}
	})();

	$: isDMChannel = currentChannelData?.type === 'dm';
	$: isGroupChannel = currentChannelData?.type === 'group';
	$: currentChannelType = (currentChannelData?.type || 'text') as string;
	$: channelUsesChatStream = isTextLikeChannelType(currentChannelType);
	$: isLiveChannel = isLiveRetention(currentChannelData?.autoDeleteAfter);
	$: dmCallTargetUser = getDMOtherUser(currentChannelData, $currentUser, $userLookup);
	let paymentTargetKind: 'channel' | 'dm' | 'group' | 'workspace' | null = null;
	$: paymentTargetLabel = (() => {
		if (isDMChannel && dmCallTargetUser?.username) return `DM with ${dmCallTargetUser.username}`;
		if (isGroupChannel) return channelDisplayName;
		return channelDisplayName ? `#${channelDisplayName}` : $currentChannel;
	})();
	$: paymentTargetKind = isDMChannel ? 'dm' : isGroupChannel ? 'group' : 'channel';
	$: dmDirectCallActive = ($isInCall && $callMode === 'direct') || Boolean($outgoingCall);
	$: dmDirectCallPending = Boolean($outgoingCall) && !$isInCall && $callMode === 'direct';
	$: experimentalScopeVisible = isDMChannel || isGroupChannel;
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

	// ── DM calls ────────────────────────────────────────────────────────────────
	async function startDMVoiceCall() {
		if (!$socket || !dmCallTargetUser || dmDirectCallActive) return;
		try { await startCall($socket, getUserIdentityKey(dmCallTargetUser), false, { scope: 'dm', displayName: dmCallTargetUser.username }); }
		catch (error) { console.warn('[Call] DM voice call failed to start:', error); }
	}
	async function startDMVideoCall() {
		if (!$socket || !dmCallTargetUser || dmDirectCallActive) return;
		try { await startCall($socket, getUserIdentityKey(dmCallTargetUser), true, { scope: 'dm', displayName: dmCallTargetUser.username }); }
		catch (error) { console.warn('[Call] DM video call failed to start:', error); }
	}

	// ── Search ──────────────────────────────────────────────────────────────────
	let chatContainer: HTMLElement;
	let lastScrollTop = 0;
	let searchInput = '';
	let searchExpanded = false;
	let searchContainerElement: HTMLElement | null = null;
	let searchInputElement: HTMLInputElement | null = null;
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
	let experimentalWabidbCallsEnabled = false;

	function getWorkingSetLimit(): number {
		if (currentChannelData?.persistMessages) {
			return searchInput.trim() ? MESSAGE_WORKING_SET_LIMIT_PERSISTENT_SEARCH : MESSAGE_WORKING_SET_LIMIT_PERSISTENT_IDLE;
		}
		return MESSAGE_WORKING_SET_LIMIT_EPHEMERAL;
	}

	$: filteredMessages = filterMessages(messages, searchInput, getWorkingSetLimit());
	$: if (searchInput.trim() && !searchExpanded) searchExpanded = true;
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

	async function scrollToBottom() {
		await tick();
		if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
	}
	$: if (messages.length) scrollToBottom();

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

	async function openSearch(): Promise<void> {
		if (!searchExpanded) { searchExpanded = true; await tick(); }
		searchInputElement?.focus();
	}

	function collapseSearchIfIdle(): void { if (!searchInput.trim()) searchExpanded = false; }

	function handleSearchInputKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		if (searchInput.trim()) { searchInput = ''; return; }
		searchExpanded = false;
		searchInputElement?.blur();
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
			setSearchInput: v => { searchInput = v; },
			openReaderSurface, openModelViewportSurface, openFullMapTab,
			openPaymentSheet, dispatchLogout: () => dispatch('logout'),
			undefined, "": resolveDmChannelId,
			openExistingDM: (channelId, otherUser) => openExistingDmSignal.set({ channelId, otherUser }),
			pushLocalDirectionsCard,
			navigateTo: path => { window.location.href = path; }
		});
	}

	// ── Lifecycle ───────────────────────────────────────────────────────────────
	onMount(() => {
		scrollToBottom();
		experimentalWabidbCallsEnabled = isExperimentalWabidbCallEnabled();
		const onGlobalClick = (e: MouseEvent) => {
			const t = e.target as Node | null;
			if (t && searchContainerElement?.contains(t)) return;
			collapseSearchIfIdle();
		};
		document.addEventListener('click', onGlobalClick);
		return () => document.removeEventListener('click', onGlobalClick);
	});

	async function toggleExperimentalWabidbCallUi() {
		const next = !experimentalWabidbCallsEnabled;
		experimentalWabidbCallsEnabled = next;
		await setExperimentalWabidbCallEnabled(next);
	}

	function returnToMessagesView(): void {
		if (chatSurface !== 'messages') setWhiteboardSurface($currentChannel, 'messages');
		if ($layoutStore.rightPanelMode !== 'none' && $layoutStore.activeRightTab === 'media') layoutStore.closeRightPanel();
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(READER_ADDON_ID)) mobileTabQueue.closeAddonTab(READER_ADDON_ID);
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(MODEL_VIEWPORT_ADDON_ID)) mobileTabQueue.closeAddonTab(MODEL_VIEWPORT_ADDON_ID);
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(MAP_ADDON_ID)) mobileTabQueue.closeAddonTab(MAP_ADDON_ID);
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(MEDIA_ALBUMS_ADDON_ID)) mobileTabQueue.closeAddonTab(MEDIA_ALBUMS_ADDON_ID);
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(PLANNER_ADDON_ID)) mobileTabQueue.closeAddonTab(PLANNER_ADDON_ID);
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(NOTES_ADDON_ID)) mobileTabQueue.closeAddonTab(NOTES_ADDON_ID);
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(LORE_ADDON_ID)) mobileTabQueue.closeAddonTab(LORE_ADDON_ID);
		if ($mobileQueueActiveTabId === mobileTabQueue.toAddonTabId(FILES_ADDON_ID)) mobileTabQueue.closeAddonTab(FILES_ADDON_ID);
	}
</script>

<div
	class="chat-container"
	role="presentation"
	on:dragenter={handleDragEnter}
	on:dragleave={handleDragLeave}
	on:dragover={handleDragOver}
	on:drop={handleDrop}
>
	{#if isDragging}
		<div class="drag-overlay overlay">
			<div class="drag-overlay-content">
				<div class="drag-icon">📁</div>
				<div class="drag-text">{$_('chat.drag.drop_to_upload')}</div>
			</div>
		</div>
	{/if}

	<ChatHeader
		{isDMChannel}
		{workspaceSurfaceLabel}
		{workspaceHeaderTitle}
		{workspaceHeaderSubtitle}
		{selectedWorkspaceView}
		currentChannel={$currentChannel}
		{dmCallTargetUser}
		{dmDirectCallActive}
		{dmDirectCallPending}
		{experimentalScopeVisible}
		{experimentalWabidbCallsEnabled}
		currentChannelPersistMessages={Boolean(currentChannelData?.persistMessages)}
		bind:searchExpanded
		bind:searchInput
		bind:searchContainerElement
		bind:searchInputElement
		filteredMessageCount={filteredMessages.length}
		{searchBackfillBusy}
		{isFullHistorySearchRunning}
		{fullHistorySearchPagesLoaded}
		{fullHistorySearchStatus}
		onReturnToMessages={returnToMessagesView}
		onStartDMVoiceCall={startDMVoiceCall}
		onStartDMVideoCall={startDMVideoCall}
		onToggleExperimentalWabidbCall={toggleExperimentalWabidbCallUi}
		onOpenSearch={openSearch}
		onSearchInputKeydown={handleSearchInputKeydown}
		onSearchCurrentQueryInBrowser={searchCurrentQueryInBrowser}
		onToggleFullHistorySearchBackfill={toggleFullHistorySearchBackfill}
	/>

	{#if chatSurface === 'whiteboard'}
		<div class="whiteboard-surface">
			<WhiteboardTab channelId={$currentChannel} />
		</div>
	{/if}

	{#if currentChannelType === 'lore' && selectedWorkspaceView === 'messages'}
		<!-- Project channels ARE their view: the repo workspace is the default
		     surface, not a teaser card pointing at the server-wide hub. -->
		<div class="lore-channel-surface">
			<LoreChannelShell />
		</div>
	{/if}

	<!-- TEMPORARY: DMs now render in center like channels -->
	<div
		class="messages"
		bind:this={chatContainer}
		class:surface-hidden={chatSurface !== 'messages' || (currentChannelType === 'lore' && selectedWorkspaceView === 'messages')}
		on:scroll={(e) => {
			// Mobile composer auto-hide on scroll
			if ($isMobile) {
				const currentScrollTop = e.currentTarget.scrollTop;
				const scrollDelta = lastScrollTop - currentScrollTop;
				// Show when scrolling down or at top, hide when scrolling up
				if (scrollDelta > 10 || currentScrollTop < 50) {
					composerVisible = true;
				} else if (scrollDelta < -10 && !isTextareaFocused) {
					composerVisible = false;
				}
				lastScrollTop = currentScrollTop;
			}
		}}
	>
		{#if isLiveChannel}
			<LiveChannelView channel={currentChannelData} />
		{:else if selectedWorkspaceView === 'planner'}
			<PlannerWorkspace />
		{:else if selectedWorkspaceView === 'notes'}
			<KeepNotesView />
		{:else if selectedWorkspaceView === 'lore'}
			<LoreWorkspace />
		{:else if selectedWorkspaceView === 'files'}
			<FilesWorkspace />
		{:else if currentChannelType === 'gallery'}
			<GalleryChannel />
		{:else if currentChannelType === 'forum'}
			<ForumChannel />
		{:else if currentChannelType === 'wiki'}
			<WikiChannel />
		{:else if currentChannelType === 'planning'}
				<PlannerWorkspace />
		{:else if currentChannelType === 'reception'}
				<ReceptionBoard />
		{:else if isRoutedChannelType(currentChannelType)}
			<ChannelModePlaceholder channel={currentChannelData} mode={currentChannelType as 'stage'} />
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

		{#if channelUsesChatStream && !isLiveChannel && chatSurface === 'messages' && !($isMobile && $isInCall)}
			<ChatComposer
				bind:this={chatComposer}
				{isDMChannel}
				channelId={$currentChannel}
				{paymentButtonEnabled}
				bind:replyingTo
				bind:composerVisible
				bind:isTextareaFocused
				onExecuteCommand={executeCommand}
				onOpenPaymentSheet={openPaymentSheet}
			/>
		{/if}
	</div>

		<PaymentSheet
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
