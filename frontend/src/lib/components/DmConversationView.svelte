<script lang="ts">
  import { layoutStore } from '$lib/layoutStore';
  import { selectedDmChannelId, dmOtherUser, centerDmChannelId } from '$lib/layoutStoreStates';
  import { channelMessages, currentUser, channels } from '$lib/socket';
  import ChatComposer from './chat/ChatComposer.svelte';
  import ChatMessagesPane from './chat/ChatMessagesPane.svelte';
  import { formatTypingUsers } from './chat/typing';
  import { channelPaneInTransition, channelPaneOutTransition } from './chat/transitions';
  import { filterMessages } from './chat/search';
  import type { Message, User } from '$lib/socket-types';

  export let context: 'center' | 'right' = 'right';
  export let channelIdProp: string | null = null;
  export let otherUserProp: User | null = null;

  $: channelId = channelIdProp ?? $selectedDmChannelId;
  $: otherUser = otherUserProp ?? $dmOtherUser;
  $: messages = channelId ? ($channelMessages[channelId] || []) : [];
  $: filteredMessages = filterMessages(messages, '', Number.POSITIVE_INFINITY);
  $: pinnedMessages = messages.filter((m: Message) => m.isPinned);
  $: channel = channelId ? ($channels || []).find((c: { id: string }) => c.id === channelId) : null;
  $: channelDisplayName = otherUser?.handle || otherUser?.username || '';

  let replyingTo: Message | null = null;
  let composerVisible = true;
  let isTextareaFocused = false;
  let chatContainer: HTMLDivElement | undefined;
  let chatComposer: ChatComposer;

  function handleReply(msg: Message) {
    replyingTo = msg;
  }

  function handleClose() {
    if (context === 'center') {
      layoutStore.closeCenterDm();
    } else {
      layoutStore.closeDM();
    }
  }

  function handleToggleSurface() {
    if (!channelId) return;
    if (context === 'right') {
      layoutStore.openCenterDm(channelId, otherUser);
    } else {
      layoutStore.openDM(channelId, otherUser);
    }
  }
</script>

<div class="dm-conversation">
  <div class="dm-header">
    <button class="dm-header-back" on:click={handleClose} title="Close DM">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>
    <div class="dm-header-info">
      <span class="dm-header-name">{channelDisplayName}</span>
      <div class="dm-header-meta">
        <span class="dm-badge">DM</span>
      </div>
    </div>
    <div class="dm-header-actions">
      <button class="dm-header-action" title={context === 'right' ? 'Open in main view' : 'Move to side panel'} on:click={handleToggleSurface}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
        </svg>
      </button>
      <button class="dm-header-action" title="Close DM (Esc)" on:click={handleClose}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  </div>

  <div
    class="dm-messages"
    bind:this={chatContainer}
    on:scroll={() => {}}
  >
    <ChatMessagesPane
      currentChannel={channelId || ''}
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
      {channelPaneInTransition}
      {channelPaneOutTransition}
      formatTypingUsers={(users: string[]) => formatTypingUsers(users)}
      onSearchCurrentQueryInBrowser={() => {}}
      onToggleFullHistorySearchBackfill={() => {}}
      onReply={handleReply}
      onQuickMention={() => {}}
      onOpenSettings={() => {}}
    />
  </div>

  <div class="dm-composer">
    <ChatComposer
      bind:this={chatComposer}
      isDMChannel={true}
      channelId={channelId}
      paymentButtonEnabled={false}
      bind:replyingTo
      bind:composerVisible
      bind:isTextareaFocused
      onExecuteCommand={async (_cmd: string) => {}}
      onOpenPaymentSheet={() => {}}
      onOpenManualCash={() => {}}
    />
  </div>
</div>

<style>
  .dm-conversation {
    display: flex;
    flex-direction: column;
    height: 100%;
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
    min-height: 48px;
  }

  .dm-header-back {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: var(--radius-sm, 4px);
    background: transparent;
    color: var(--text-secondary, #b3b3ff);
    cursor: pointer;
    padding: 0;
  }
  .dm-header-back:hover {
    background: rgba(255,255,255,0.08);
    color: var(--text-heading, #e0e0ff);
  }

  .dm-header-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
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
    font-size: var(--text-xs, 11px);
  }

  .dm-badge {
    padding: 1px 5px;
    border-radius: var(--radius-sm, 4px);
    background: var(--accent-primary, #6366f1);
    color: #fff;
    font-weight: var(--font-weight-semibold, 600);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-size: 10px;
  }

  .dm-header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }

  .dm-header-action {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: var(--radius-sm, 4px);
    background: transparent;
    color: var(--text-secondary, #b3b3ff);
    cursor: pointer;
    padding: 0;
  }
  .dm-header-action:hover {
    background: rgba(255,255,255,0.08);
    color: var(--text-heading, #e0e0ff);
  }

  .dm-messages {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
  }

  .dm-composer {
    flex-shrink: 0;
    border-top: 1px solid var(--color-border-primary, #302b63);
  }
</style>
