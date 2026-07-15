<script lang="ts">
  import { layoutStore } from '$lib/layoutStore';
  import { selectedDmChannelId } from '$lib/layoutStoreStates';
  import { channels, channelMessages, currentUser, userLookup, channelUnreadCounts, createDM } from '$lib/socket';
  import { get } from 'svelte/store';
  import type { Channel, User, Message } from '$lib/socket-types';
  import { getDMOtherUser } from '$lib/userLookupStore';
  import PeoplePicker from './PeoplePicker.svelte';
  import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
  import { openDetachedPanel } from '$lib/detachedPanels';

  let showPeoplePicker = false;

  let contextMenuOpen = false;
  let contextMenuPos = { x: 0, y: 0 };
  let contextMenuChannel: Channel | null = null;

  $: dmChannels = ($channels || []).filter(
    (ch: Channel) => ch.type === 'dm' || ch.type === 'group'
  );

  function otherUserFor(channel: Channel): User | null {
    if (channel.otherUser) return channel.otherUser;
    return getDMOtherUser(channel, $currentUser, $userLookup);
  }

  function conversationLabel(channel: Channel): string {
    if (channel.type === 'group') {
      return channel.name || channel.id;
    }
    const other = otherUserFor(channel);
    return other?.handle || other?.username || 'Unknown';
  }

  function conversationAvatar(channel: Channel): string | null {
    if (channel.type === 'group') {
      return channel.avatar || null;
    }
    const other = otherUserFor(channel);
    return other?.profilePicture || null;
  }

  function lastMessagePreview(channel: Channel): string {
    const msgs: Message[] = $channelMessages[channel.id] || [];
    if (msgs.length === 0) return '';
    const last = msgs[msgs.length - 1];
    if (last.type === 'file') return last.fileName || '[File]';
    if (last.type === 'gif') return '[GIF]';
    if (last.type === 'emoji') return '[Emoji]';
    return last.text || '';
  }

  function lastMessageTime(channel: Channel): string {
    const msgs: Message[] = $channelMessages[channel.id] || [];
    if (msgs.length === 0) return '';
    const ts = msgs[msgs.length - 1].timestamp;
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    const isThisYear = d.getFullYear() === now.getFullYear();
    if (isThisYear) {
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function statusColor(user: User | null): string {
    if (!user) return 'var(--status-offline, #708090)';
    switch (user.status) {
      case 'active': return 'var(--color-success, #22c55e)';
      case 'away': return 'var(--color-warning, #f59e0b)';
      case 'busy': return 'var(--color-danger, #ef4444)';
      default: return 'var(--status-offline, #708090)';
    }
  }

  function openConversation(channel: Channel) {
    const other = otherUserFor(channel);
    if (channel.type === 'group') {
      layoutStore.openGroupDM(channel.id, channel);
    } else if (other) {
      layoutStore.openDM(channel.id, other);
    }
  }

  function openInCenter(channel: Channel) {
    const other = otherUserFor(channel);
    if (channel.type === 'group') {
      layoutStore.openCenterGroupDm(channel.id, channel);
    } else if (other) {
      layoutStore.openCenterDm(channel.id, other);
    }
  }

  function handleContextMenu(channel: Channel, e: MouseEvent) {
    e.preventDefault();
    contextMenuChannel = channel;
    contextMenuPos = { x: e.clientX, y: e.clientY };
    contextMenuOpen = true;
  }

  $: contextMenuItems = contextMenuChannel
    ? [
        { id: 'open-center', label: 'Open in main view', leading: '▣', onSelect: () => openInCenter(contextMenuChannel!) },
        { id: 'open-side', label: 'Open in side panel', leading: '▥', onSelect: () => openConversation(contextMenuChannel!) },
        { id: 'open-window', label: 'Open in OS window', leading: '⧉', onSelect: () => openDetachedPanel({ kind: 'channel-chat', channelId: contextMenuChannel!.id, channelName: conversationLabel(contextMenuChannel!) }) }
      ]
    : [];

  async function handlePersonSelected(user: User) {
    showPeoplePicker = false;
    if (!user.dbUserId) return;
    const self = $currentUser;
    if (!self || user.dbUserId === self.dbUserId) return;
    const existing = ($channels || []).find(
      (ch: Channel) => ch.type === 'dm' && ch.otherUser?.id === user.id
    );
    if (existing) {
      layoutStore.openDM(existing.id, user);
      return;
    }
    createDM(user.id);
    const unsubscribe = channels.subscribe((allChannels: Channel[]) => {
      const newDM = allChannels.find(
        (ch: Channel) => ch.type === 'dm' && (ch.otherUser?.id === user.id)
      );
      if (newDM) {
        layoutStore.openDM(newDM.id, user);
        unsubscribe();
      }
    });
  }
</script>

<div class="dm-list-panel">
  <div class="dm-list-header">
    <span class="dm-list-title">Messages</span>
    <button
      class="dm-list-new-btn"
      on:click={() => (showPeoplePicker = !showPeoplePicker)}
      title="New conversation"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
  </div>

  {#if showPeoplePicker}
    <PeoplePicker on:select={async (e) => handlePersonSelected(e.detail)} on:close={() => (showPeoplePicker = false)} />
  {/if}

  <div class="dm-list-scroll">
    {#if dmChannels.length === 0}
      <div class="dm-list-empty">
        <p>No conversations yet.</p>
        <button class="dm-list-empty-btn" on:click={() => (showPeoplePicker = true)}>
          Start a conversation
        </button>
      </div>
    {:else}
      {#each dmChannels as channel (channel.id)}
        {@const other = otherUserFor(channel)}
        {@const unread = $channelUnreadCounts[channel.id] || 0}
        <button
          class="dm-conversation"
          class:active={$layoutStore.selectedDmChannelId === channel.id}
          class:unread={unread > 0}
          on:click={() => openConversation(channel)}
          on:contextmenu={(e) => handleContextMenu(channel, e)}
        >
          <div class="dm-conv-avatar-wrap">
            {#if conversationAvatar(channel)}
              <img class="dm-conv-avatar" src={conversationAvatar(channel)} alt="" />
            {:else}
              <div class="dm-conv-avatar dm-conv-avatar-placeholder">
                {(conversationLabel(channel) || '?')[0]}
              </div>
            {/if}
            {#if other}
              <span class="dm-conv-status-dot" style:background={statusColor(other)}></span>
            {/if}
          </div>
          <div class="dm-conv-body">
            <div class="dm-conv-top">
              <span class="dm-conv-name">{conversationLabel(channel)}</span>
              {#if lastMessageTime(channel)}
                <span class="dm-conv-time">{lastMessageTime(channel)}</span>
              {/if}
            </div>
            <div class="dm-conv-bottom">
              <span class="dm-conv-preview">{lastMessagePreview(channel) || 'No messages yet'}</span>
              {#if unread > 0}
                <span class="dm-conv-badge">{unread > 99 ? '99+' : unread}</span>
              {/if}
            </div>
          </div>
        </button>
      {/each}
    {/if}
  </div>
</div>

<ContextMenu
  open={contextMenuOpen}
  x={contextMenuPos.x}
  y={contextMenuPos.y}
  items={contextMenuItems}
  ariaLabel="Conversation actions"
  headerLabel={contextMenuChannel ? conversationLabel(contextMenuChannel) : null}
  on:close={() => (contextMenuOpen = false)}
/>

<style>
  .dm-list-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    background: var(--surface-base, #24243e);
    flex: 1;
  }

  .dm-list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-bottom: 1px solid var(--color-border-primary, #302b63);
    flex-shrink: 0;
    min-height: 34px;
  }

  .dm-list-title {
    font-size: var(--text-sm, 13px);
    font-weight: var(--font-weight-semibold, 600);
    color: var(--text-heading, #e0e0ff);
    letter-spacing: 0.3px;
  }

  .dm-list-new-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary, #b3b3ff);
    cursor: pointer;
    padding: 0;
    transition: background 0.1s;
  }
  .dm-list-new-btn:hover {
    background: rgba(255,255,255,0.08);
    color: var(--text-heading, #e0e0ff);
  }

  .dm-list-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding-bottom: 2px;
  }

  .dm-list-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 100%;
    padding: 12px;
    text-align: center;
    color: var(--text-muted, #9999ff);
    font-size: var(--text-sm, 13px);
  }

  .dm-conversation {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
  }
  .dm-conversation:hover {
    background: rgba(255,255,255,0.03);
  }
  .dm-conversation.active {
    background: rgba(99, 102, 241, 0.12);
  }

  .dm-conv-avatar-wrap {
    position: relative;
    flex-shrink: 0;
  }

  .dm-conv-avatar {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-full, 9999px);
    object-fit: cover;
  }
  .dm-conv-avatar-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-primary, #6366f1);
    color: #fff;
    font-size: 13px;
    font-weight: var(--font-weight-semibold, 600);
    width: 32px;
    height: 32px;
  }

  .dm-conv-status-dot {
    position: absolute;
    bottom: -1px;
    right: -1px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 2px solid var(--surface-base, #24243e);
  }

  .dm-conv-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .dm-conv-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
  }

  .dm-conv-name {
    font-size: 12px;
    font-weight: var(--font-weight-medium, 500);
    color: var(--text-heading, #e0e0ff);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dm-conversation.unread .dm-conv-name {
    font-weight: var(--font-weight-semibold, 600);
  }

  .dm-conv-time {
    font-size: 10px;
    color: var(--text-muted, #9999ff);
    flex-shrink: 0;
  }

  .dm-conv-bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 3px;
  }

  .dm-conv-preview {
    font-size: 11px;
    color: var(--text-secondary, #b3b3ff);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .dm-conversation.unread .dm-conv-preview {
    color: var(--text-heading, #e0e0ff);
  }

  .dm-conv-badge {
    flex-shrink: 0;
    min-width: 19px;
    height: 19px;
    padding: 0 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-full, 9999px);
    background: var(--accent-primary, #6366f1);
    color: #fff;
    font-size: 10px;
    font-weight: var(--font-weight-semibold, 600);
    line-height: 1;
  }

	@media (prefers-reduced-motion: reduce) {
		.dm-list-new-btn, .dm-conversation { transition: none; }
	}
</style>
