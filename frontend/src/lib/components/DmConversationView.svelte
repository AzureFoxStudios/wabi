<script lang="ts">
  import { afterUpdate, onMount, tick } from 'svelte';
  import { layoutStore } from '$lib/layoutStore';
  import { selectedDmChannelId, dmOtherUser } from '$lib/layoutStoreStates';
  import { channelMessages, channelHasMoreHistory, channelHistoryLoading, currentUser, channels, users, serverMembers, joinChannel, loadHistory, loadOlderHistory, markChannelAsRead, sendMessage, updateChannelSettings } from '$lib/socket';
  import { DEFAULT_DM_RETENTION, MESSAGE_RETENTION_LABELS, MESSAGE_RETENTION_PRESETS, normalizeMessageRetentionDuration } from '../../../../shared/messageRetention.js';
  import ChatComposer from './chat/ChatComposer.svelte';
  import ChatMessagesPane from './chat/ChatMessagesPane.svelte';
  import GroupSettingsPanel from './GroupSettingsPanel.svelte';
  import { formatTypingUsers } from './chat/typing';
  import { channelPaneInTransition, channelPaneOutTransition } from './chat/transitions';
  import { filterMessages } from './chat/search';
  import type { Channel, Message, User } from '$lib/socket-types';
  import { resolveDmOtherUser } from '$lib/dmConversations';
  import { pushLocalDirectionsCard } from '$lib/directionsAssist';
  import { mediaUrl } from '$lib/mediaUrl';
  import { cachedE2eeStatus, refreshE2eeStatus, turnOnE2ee } from '$lib/dm/dmE2eeState';
  import type { E2eeRoomStatus } from '$lib/e2ee';

  export let context: 'center' | 'right' = 'right';
  export let channelIdProp: string | null = null;
  export let otherUserProp: User | null = null;
  export let channelProp: Channel | null = null;

  let lastJoinedChannelId = '';

  $: channelId = channelIdProp ?? $selectedDmChannelId;
  $: channel = (channelId ? ($channels || []).find((c: { id: string }) => c.id === channelId) || null : null) ?? channelProp;
  $: isGroup = channel?.type === 'group';
  $: layoutOtherUser = context === 'right' ? $dmOtherUser : null;
  $: otherUser = otherUserProp ?? layoutOtherUser ?? resolveDmOtherUser(channel, $currentUser, $users, $serverMembers);
  $: if (channelId && channelId !== lastJoinedChannelId) {
    lastJoinedChannelId = channelId;
    showGroupSettings = false;
    olderAnchor = null;
    joinChannel(channelId);
    loadHistory(channelId, { limit: 50 });
    followLatest = true;
    showJumpToLatest = false;
  }
  $: messages = channelId ? ($channelMessages[channelId] || []) : [];
  $: filteredMessages = filterMessages(messages, '', Number.POSITIVE_INFINITY);
  $: pinnedMessages = messages.filter((m: Message) => m.isPinned);
  $: channelDisplayName = isGroup ? (channel?.name || 'Group message') : (otherUser?.username || otherUser?.handle || 'Recipient unavailable');
  $: selectedRetention = channel?.autoDeleteAfter === null || String(channel?.autoDeleteAfter) === 'forever'
    ? ''
    : channel?.autoDeleteAfter || DEFAULT_DM_RETENTION;

  function handleRetentionChange(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    if (!channelId || !channel) return;
    const next = normalizeMessageRetentionDuration(select.value);
    select.value = selectedRetention;
    void updateChannelSettings(channelId, { autoDeleteAfter: next });
  }

  let replyingTo: Message | null = null;
  let composerVisible = true;
  let isTextareaFocused = false;
  let chatContainer: HTMLDivElement | undefined;
  let chatComposer: ChatComposer;
  let followLatest = true;
  let showJumpToLatest = false;
  let lastMessageKey = '';
  let showGroupSettings = false;
  let olderAnchor: { channelId: string; firstId: string; height: number; top: number } | null = null;

  // ── E2EE conversation state ──────────────────────────────────────────────
  let e2eeStatus: E2eeRoomStatus | null = null;
  let e2eeBusy = false;
  let e2eeError = '';

  $: e2eeEnabled = !!e2eeStatus?.enabled;

  async function loadE2eeStatus(targetChannelId: string | null): Promise<void> {
    if (!targetChannelId) {
      e2eeStatus = null;
      return;
    }
    e2eeStatus = cachedE2eeStatus(targetChannelId) ?? null;
    // Refresh once so the pill reflects the real server state after a restart.
    try {
      const status = await refreshE2eeStatus(targetChannelId);
      if (channelId === targetChannelId) e2eeStatus = status;
    } catch {
      // Keep the last known state until this device can refresh it.
    }
  }

  async function enableE2ee(): Promise<void> {
    if (!channelId || e2eeBusy) return;
    const targetChannelId = channelId;
    e2eeBusy = true;
    e2eeError = '';
    try {
      const status = await turnOnE2ee(targetChannelId);
      if (channelId !== targetChannelId) return;
      if (!status) {
        e2eeError = 'Could not enable encryption on this device. Check that you are signed in and try again.';
        return;
      }
      e2eeStatus = status;
    } finally {
      e2eeBusy = false;
    }
  }

  $: void loadE2eeStatus(channelId);

  function handleReply(msg: Message) {
    replyingTo = msg;
    chatComposer?.focus();
  }

  async function executeCommand(command: string): Promise<void> {
    if (!channelId) throw new Error('Conversation is unavailable.');
    const [name, ...args] = command.slice(1).trim().split(/\s+/);
    if (name === 'directions' || name === 'dir' || name === 'where') {
      const target = args.join(' ').trim();
      if (!target) throw new Error('Enter a place after /directions.');
      if (!(await pushLocalDirectionsCard(channelId, target))) throw new Error(`Place "${target}" was not found.`);
      return;
    }
    const result = await sendMessage(channelId, command, 'text');
    if (!result.ok) throw new Error('Message was not sent. Try again.');
  }

  function markVisibleMessagesRead(): void {
    if (channelId && document.visibilityState === 'visible' && chatContainer?.getClientRects().length) {
      markChannelAsRead(channelId);
    }
  }

  function handleScroll(): void {
    if (!chatContainer) return;
    followLatest = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 128;
    showJumpToLatest = !followLatest && messages.length > 0;
    if (chatContainer.scrollTop < 72) loadEarlier();
  }

  function loadEarlier(): void {
    if (!channelId || !chatContainer || olderAnchor || !$channelHasMoreHistory[channelId] || $channelHistoryLoading[channelId]) return;
    const firstId = messages.find((message: Message) => message.id && !message.id.startsWith('optimistic:'))?.id;
    if (!firstId) return;
    olderAnchor = { channelId, firstId, height: chatContainer.scrollHeight, top: chatContainer.scrollTop };
    followLatest = false;
    loadOlderHistory(channelId);
  }

  async function scrollToLatest(): Promise<void> {
    followLatest = true;
    showJumpToLatest = false;
    await tick();
    chatContainer?.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
    markVisibleMessagesRead();
  }

  afterUpdate(() => {
    if (olderAnchor && olderAnchor.channelId !== channelId) olderAnchor = null;
    if (olderAnchor && chatContainer) {
      const firstId = messages.find((message: Message) => message.id && !message.id.startsWith('optimistic:'))?.id;
      if (firstId && firstId !== olderAnchor.firstId) {
        chatContainer.scrollTop = olderAnchor.top + chatContainer.scrollHeight - olderAnchor.height;
        olderAnchor = null;
      } else if (!$channelHistoryLoading[channelId || '']) {
        olderAnchor = null;
      }
    }
    const newest = messages.at(-1);
    const nextKey = `${channelId}:${messages.length}:${newest?.id || ''}`;
    if (nextKey !== lastMessageKey) {
      lastMessageKey = nextKey;
      if (followLatest && chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
      markVisibleMessagesRead();
    }
  });

  onMount(() => {
    document.addEventListener('visibilitychange', markVisibleMessagesRead);
    void tick().then(markVisibleMessagesRead);
    return () => document.removeEventListener('visibilitychange', markVisibleMessagesRead);
  });

  async function handleClose() {
    if (showGroupSettings) {
      showGroupSettings = false;
      return;
    }
    if (context === 'center') {
      const closedChannelId = channelId;
      layoutStore.closeCenterDm();
      await tick();
      const row = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-dm-channel-id]'))
        .find((node) => node.dataset.dmChannelId === closedChannelId);
      row?.focus();
    } else {
      layoutStore.closeDM();
    }
  }

  function handleToggleSurface() {
    if (!channelId) return;
    if (isGroup && channel) {
      if (context === 'right') layoutStore.openCenterGroupDm(channelId, channel);
      else layoutStore.openGroupDM(channelId, channel);
      return;
    }
    if (context === 'right') {
      layoutStore.openCenterDm(channelId, otherUser);
    } else {
      layoutStore.openDM(channelId, otherUser);
    }
  }
</script>

<div class="dm-conversation">
  <div class="dm-header">
    <button class="dm-header-back" on:click={handleClose} title={context === 'center' ? 'Back to conversations' : 'Close DM'} aria-label={context === 'center' ? 'Back to conversations' : 'Close DM'}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>
    {#if !isGroup}
      {#if otherUser?.profilePicture}
        <img class="dm-header-avatar" src={mediaUrl(otherUser.profilePicture)} alt="" />
      {:else}
        <span class="dm-header-avatar dm-header-avatar-fallback" aria-hidden="true">{channelDisplayName.charAt(0).toUpperCase()}</span>
      {/if}
    {/if}
    <div class="dm-header-info">
      <span class="dm-header-name">{channelDisplayName}</span>
      <div class="dm-header-meta">
        <span class="dm-badge">{isGroup ? `${channel?.members?.length || 0} members` : otherUser?.handle ? `@${otherUser.handle}` : 'Direct message'}</span>
        {#if !isGroup && !otherUser}<span role="status">Recipient details aren’t available. Reconnect to refresh this conversation.</span>{/if}
        {#if isGroup}
          <span class="dm-header-pill" title="The server operator is part of the trust boundary. Experimental encryption is not a verified confidentiality guarantee.">Server-readable by default</span>
        {:else if e2eeEnabled}
          <span class="dm-header-pill dm-header-pill-secure" title="End-to-end encrypted · experimental · not independently verified">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM15.1 8H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>
            End-to-end encrypted
          </span>
        {:else}
          <button
            type="button"
            class="dm-header-pill dm-header-pill-action"
            title="The server operator is part of the trust boundary. Turn on end-to-end encryption for this conversation?"
            on:click={() => enableE2ee()}
            disabled={e2eeBusy}
          >
            {e2eeBusy ? 'Enabling…' : 'Enable encryption'}
          </button>
        {/if}
      </div>
      {#if e2eeError}
        <div class="dm-e2ee-error" role="alert">{e2eeError}</div>
      {/if}
    </div>
    <div class="dm-header-actions">
      {#if isGroup}
        <button type="button" class="dm-header-action" title={showGroupSettings ? 'Back to group messages' : 'Group settings'} aria-label={showGroupSettings ? 'Back to group messages' : 'Group settings'} aria-pressed={showGroupSettings} on:click={() => (showGroupSettings = !showGroupSettings)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1"/><circle cx="18" cy="9" r="2"/><path d="M18 15a4 4 0 0 1 4 4v1"/></svg>
        </button>
      {/if}
      <button class="dm-header-action" title={context === 'right' ? 'Open in main view' : 'Move to side panel'} aria-label={context === 'right' ? 'Open in main view' : 'Move to side panel'} on:click={handleToggleSurface}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" />
        </svg>
      </button>
    </div>
  </div>

  {#if channelId && channel}
    <div class="dm-retention-bar">
      <label class="dm-retention-control">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><path d="M8 4.5v3.7l2.35 1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>Keep new messages</span>
        <select value={selectedRetention} on:change={handleRetentionChange} aria-label="Retention for new messages">
          <option value="">Forever</option>
          {#each MESSAGE_RETENTION_PRESETS as duration}
            <option value={duration}>{MESSAGE_RETENTION_LABELS[duration]}</option>
          {/each}
        </select>
      </label>
      <span class="dm-retention-hint">Earlier messages keep their original lifetime.</span>
    </div>
  {/if}

  <div
    class="dm-messages"
    class:hidden={showGroupSettings}
    bind:this={chatContainer}
    on:scroll={handleScroll}
  >
    {#if channelId && $channelHasMoreHistory[channelId]}
      <button type="button" class="dm-load-earlier" disabled={$channelHistoryLoading[channelId]} on:click={loadEarlier}>
        {$channelHistoryLoading[channelId] ? 'Loading earlier messages…' : 'Load earlier messages'}
      </button>
    {/if}
    <ChatMessagesPane
      currentChannel={channelId || ''}
      messageDomScope={`dm-conversation-${context}`}
      searchInput=""
      {channelDisplayName}
      filteredMessages={filteredMessages}
      {pinnedMessages}
      firstUnreadMessageId={null}
      channelPaneAnimation={{ enabled: false, preset: 'slip', duration: 120, distance: 18 }}
      searchBackfillBusy={false}
      currentChannelPersistMessages={false}
      isFullHistorySearchRunning={false}
      fullHistorySearchPagesLoaded={0}
      fullHistorySearchStatus=""
      visibleTypingUsers={[]}
      emptyStateIcon={isGroup ? '◎' : '@'}
      emptyStateSubtitle={isGroup ? 'This is the beginning of this group message.' : 'This is the beginning of this direct message.'}
      emptyStateActionLabel="Send a message"
      {channelPaneInTransition}
      {channelPaneOutTransition}
      formatTypingUsers={(users: string[]) => formatTypingUsers(users)}
      onSearchCurrentQueryInBrowser={() => {}}
      onToggleFullHistorySearchBackfill={() => {}}
      onReply={handleReply}
      onQuickMention={() => {}}
      onOpenSettings={() => {}}
      onFocusComposer={() => chatComposer?.focus()}
    />
  </div>

  {#if showGroupSettings && isGroup && channel}
    <div class="dm-group-settings" aria-label="Group settings"><GroupSettingsPanel {channel} /></div>
  {/if}

  {#if showJumpToLatest && !showGroupSettings}
    <button type="button" class="dm-jump-latest" on:click={() => void scrollToLatest()}>↓ New messages</button>
  {/if}

  <div class="dm-composer" class:hidden={showGroupSettings}>
    {#key `${context}:${$currentUser?.dbUserId || $currentUser?.id || ''}:${channelId}`}
    <ChatComposer
      bind:this={chatComposer}
      isDMChannel={true}
      channelId={channelId}
      draftSurface={`dm-${context}`}
      paymentButtonEnabled={false}
      encryptSend={e2eeEnabled}
      e2eeStatus={e2eeStatus}
      bind:replyingTo
      bind:composerVisible
      bind:isTextareaFocused
      onExecuteCommand={executeCommand}
      onOpenPaymentSheet={() => {}}
    />
    {/key}
  </div>
</div>

<style>
  .dm-retention-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem 0.85rem;
    flex-wrap: wrap;
    min-height: 2.25rem;
    padding: 0.3rem 0.85rem;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-app);
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .dm-retention-control {
    display: inline-flex;
    align-items: center;
    gap: 0.38rem;
    white-space: nowrap;
  }

  .dm-retention-control svg {
    width: 0.82rem;
    height: 0.82rem;
    opacity: 0.7;
  }

  .dm-retention-control select {
    max-width: 8.5rem;
    min-height: 1.65rem;
    padding: 0 0.55rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-full);
    background: var(--surface-raised);
    color: var(--text-heading);
    font: inherit;
    cursor: pointer;
  }

  .dm-retention-control select:focus-visible {
    outline: 2px solid var(--accent-primary-color);
    outline-offset: 2px;
  }

  .dm-retention-hint { opacity: 0.74; }

  @container dm-conversation (max-width: 420px) {
    .dm-retention-bar { gap: 0.2rem; padding-inline: 0.65rem; }
    .dm-retention-hint { flex-basis: 100%; margin-left: 1.2rem; }
  }

  .dm-conversation {
    position: relative;
    display: flex;
    container: dm-conversation / inline-size;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--surface-base, #24243e);
  }

  .dm-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--color-border-primary, #302b63);
    background: var(--surface-raised, #302b63);
    flex-shrink: 0;
    min-height: 72px;
  }

  .dm-header-back {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border: none;
    border-radius: var(--radius-md, 8px);
    background: transparent;
    color: var(--text-secondary, #b3b3ff);
    cursor: pointer;
    padding: 0;
  }
  .dm-header-back:hover {
    background: color-mix(in srgb, var(--text-heading, #e0e0ff) 8%, transparent);
    color: var(--text-heading, #e0e0ff);
  }

  .dm-header-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .dm-header-avatar {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: var(--radius-full);
    object-fit: cover;
    background: var(--surface-hover);
  }

  .dm-header-avatar-fallback {
    display: grid;
    place-items: center;
    color: var(--text-heading);
    font-size: var(--text-base);
    font-weight: var(--font-weight-semibold);
  }

  .dm-header-name {
    font-size: var(--text-base, 14px);
    font-weight: var(--font-weight-semibold, 600);
    color: var(--text-heading, #e0e0ff);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dm-header-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: var(--text-xs, 11px);
  }

  .dm-badge {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    line-height: var(--line-height-normal);
  }

  /* E2EE header pill: muted warning when off, green lock when encrypted. */
  .dm-header-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    max-width: 22rem;
    min-height: 24px;
    padding: 2px 8px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    background: var(--surface-hover);
    font-family: inherit;
    font-size: var(--text-xs);
    font-weight: var(--font-weight-medium);
    line-height: var(--line-height-normal);
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .dm-header-pill-action {
    cursor: pointer;
    transition: background var(--duration-fast), color var(--duration-fast);
  }

  .dm-header-pill-action:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-secondary, #818cf8) 16%, transparent);
    color: var(--text-heading);
  }

  .dm-header-pill-action:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .dm-header-pill-secure {
    color: color-mix(in srgb, #34d399 88%, var(--text-heading) 12%);
    border-color: color-mix(in srgb, #34d399 36%, transparent);
    background: color-mix(in srgb, #34d399 10%, transparent);
  }

  .dm-header-pill-secure svg {
    width: 10px;
    height: 10px;
  }

  .dm-e2ee-error {
    width: 100%;
    font-size: 0.7rem;
    color: var(--text-danger, #ff8a80);
  }

  .dm-header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-1, 4px);
    flex-shrink: 0;
  }

  .dm-header-action {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border: none;
    border-radius: var(--radius-md, 8px);
    background: transparent;
    color: var(--text-secondary, #b3b3ff);
    cursor: pointer;
    padding: 0;
  }
  .dm-header-action:hover {
    background: color-mix(in srgb, var(--text-heading, #e0e0ff) 8%, transparent);
    color: var(--text-heading, #e0e0ff);
  }

  .dm-messages {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
    padding: var(--space-2);
  }
  .dm-messages.hidden, .dm-composer.hidden { display: none; }
  .dm-group-settings { flex: 1; min-height: 0; overflow: hidden; }

  .dm-load-earlier {
    display: block; min-height: 36px; margin: var(--space-1) auto var(--space-3); padding: 0 var(--space-3);
    border: 1px solid var(--border-subtle); border-radius: var(--radius-full);
    background: var(--surface-raised); color: var(--text-secondary); font: inherit; cursor: pointer;
  }
  .dm-load-earlier:hover:not(:disabled) { color: var(--text-heading); background: var(--surface-hover); }
  .dm-load-earlier:disabled { opacity: .65; cursor: wait; }

  .dm-jump-latest {
    position: absolute;
    bottom: calc(var(--app-chrome-height) + var(--space-3));
    left: 50%;
    transform: translateX(-50%);
    min-height: 36px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-full);
    background: var(--surface-raised);
    color: var(--text-heading);
    box-shadow: var(--shadow-md);
    cursor: pointer;
    white-space: nowrap;
  }

  .dm-composer {
    flex-shrink: 0;
    border-top: 1px solid var(--color-border-primary, #302b63);
  }

  @container dm-conversation (max-width: 420px) {
    .dm-header { padding: var(--space-2); gap: var(--space-2); }
    .dm-header-avatar { width: 36px; height: 36px; }
    .dm-header-pill { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
    .dm-messages { padding: var(--space-1); }
    .dm-messages :global(.message-header .header-left) {
      flex-wrap: wrap;
      min-width: 0;
      row-gap: var(--space-1);
    }
    .dm-messages :global(.message-header .username) {
      white-space: nowrap;
    }
    .dm-composer :global(.input-container) {
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .dm-composer :global(.input-container textarea) {
      flex: 1 0 100%;
      width: 100%;
    }
  }
</style>
