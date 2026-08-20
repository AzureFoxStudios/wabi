<script lang="ts">
  import { layoutStore } from '$lib/layoutStore';
  import { centerDmChannelId } from '$lib/layoutStoreStates';
  import { channels, channelMessages, currentUser, userLookup, channelUnreadCounts, createDM, joinChannel } from '$lib/socket';
  import { get } from 'svelte/store';
  import type { Channel, User, Message } from '$lib/socket-types';
  import { getDMOtherUser } from '$lib/userLookupStore';
  import PeoplePicker from './PeoplePicker.svelte';
  import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';

  import { openDetachedPanel } from '$lib/detachedPanels';

  let showPeoplePicker = false;

  let showExternalConfig = false;
  let externalApp = 'obsidian' as 'obsidian' | 'notion' | 'logseq' | 'custom' | 'none';
  let customAppUrl = '';
  let externalAppTestResult = '';

  function parseMsgSeq(msgId: string): number {
    const m = /^msg_([0-9a-f]+)/.exec(msgId || "");
    if (!m) return -1;
    return parseInt(m[1], 16);
  }

  /**
   * DM ordering: pinned → last timestamp desc → last msg seq desc → name.
   *
   * Why seq as a tie-break: Wabi message ids are msg_{commit_seq} where
   * seq is the engine commit counter (monotonic). Two messages landing in
   * the same millisecond need a deterministic tie-break, and seq gives
   * that for free — directly analogous to Discord's last_message_id snowflake.
   */
  function sortDms(a: Channel, b: Channel): number {
    // 1. Pinned first
    const aPinned = ((a as any).pinnedBy?.length ?? 0) > 0 ? 1 : 0;
    const bPinned = ((b as any).pinnedBy?.length ?? 0) > 0 ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;

    // 2. Last timestamp desc (most recent first)
    const aMsgs = $channelMessages[a.id] || [];
    const bMsgs = $channelMessages[b.id] || [];
    const aLastTs = aMsgs.length ? aMsgs[aMsgs.length - 1].timestamp : 0;
    const bLastTs = bMsgs.length ? bMsgs[bMsgs.length - 1].timestamp : 0;
    if (aLastTs !== bLastTs) return bLastTs - aLastTs;

    // 3. Last msg seq desc (monotonic commit counter, tie-break same-ms)
    const aSeq = aMsgs.length ? parseMsgSeq(aMsgs[aMsgs.length - 1].id) : -1;
    const bSeq = bMsgs.length ? parseMsgSeq(bMsgs[bMsgs.length - 1].id) : -1;
    if (aSeq !== bSeq) return bSeq - aSeq;

    // 4. Name alphabetical
    return conversationLabel(a).localeCompare(conversationLabel(b));
  }

  $: dmChannels = ($channels || [])
    .filter((ch: Channel) => ch.type === "dm" || ch.type === "group")
    .sort(sortDms);

  let contextMenuOpen = false;
  let contextMenuPos = { x: 0, y: 0 };
  let contextMenuChannel: Channel | null = null;

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

  function openInCenter(channel: Channel) {
    const other = otherUserFor(channel);
    if (channel.type === 'group') {
      layoutStore.openCenterGroupDm(channel.id, channel);
    } else if (other) {
      layoutStore.openCenterDm(channel.id, other);
    }
    joinChannel(channel.id);
  }

  function openInSidePanel(channel: Channel) {
    const other = otherUserFor(channel);
    if (channel.type === 'group') {
      layoutStore.openGroupDM(channel.id, channel);
    } else if (other) {
      layoutStore.openDM(channel.id, other);
    }
    joinChannel(channel.id);
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
        { id: 'open-side', label: 'Open in side panel', leading: '▥', onSelect: () => openInSidePanel(contextMenuChannel!) },
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
      layoutStore.openCenterDm(existing.id, user);
      joinChannel(existing.id);
      return;
    }
    createDM(user.id);
    const unsubscribe = channels.subscribe((allChannels: Channel[]) => {
      const newDM = allChannels.find(
        (ch: Channel) => ch.type === 'dm' && (ch.otherUser?.id === user.id)
      );
      if (newDM) {
        layoutStore.openCenterDm(newDM.id, user);
        joinChannel(newDM.id);
        unsubscribe();
      }
    });
  }

  /**
   * Finding 23: only allow known safe schemes. Reject javascript:/data:/etc,
   * credentials, and control chars. Always open with noopener,noreferrer.
   */
  const ALLOWED_EXTERNAL_SCHEMES = new Set([
    'https:',
    'http:',
    'obsidian:',
    'logseq:',
    'notion:'
  ]);

  function isSafeExternalUrl(raw: string): { ok: true; href: string } | { ok: false; reason: string } {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, reason: 'Enter a URL first' };
    // Block control characters and obvious script payloads
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      return { ok: false, reason: 'URL contains control characters' };
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { ok: false, reason: 'Invalid URL' };
    }
    if (!ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) {
      return { ok: false, reason: `Scheme not allowed: ${parsed.protocol}` };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, reason: 'URLs with credentials are not allowed' };
    }
    return { ok: true, href: parsed.href };
  }

  function openExternalSafe(url: string): boolean {
    const check = isSafeExternalUrl(url);
    if (check.ok === false) {
      externalAppTestResult = check.reason;
      return false;
    }
    window.open(check.href, '_blank', 'noopener,noreferrer');
    return true;
  }

  function testExternalApp() {
    const app = externalApp;
    if (app === 'none') {
      externalAppTestResult = 'local-only';
      return;
    }
    if (app === 'obsidian') {
      if (openExternalSafe('obsidian://vault')) externalAppTestResult = 'ok';
    } else if (app === 'notion') {
      if (openExternalSafe('https://www.notion.so')) externalAppTestResult = 'ok';
    } else if (app === 'logseq') {
      if (openExternalSafe('logseq://')) externalAppTestResult = 'ok';
    } else if (app === 'custom') {
      if (!customAppUrl) {
        externalAppTestResult = 'Enter a URL first';
        return;
      }
      if (openExternalSafe(customAppUrl)) externalAppTestResult = 'ok';
    } else {
      externalAppTestResult = 'Unknown app';
    }
  }
</script>

<div class="dm-hub">
    <div class="dm-hub-header">
      <div class="dm-hub-title-wrap">
        <span class="dm-hub-title">Direct Messages</span>
        <span class="dm-hub-subtitle">Your conversations</span>
      </div>
      <button class="dm-hub-new-btn" on:click={() => (showPeoplePicker = !showPeoplePicker)} title="New conversation">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>

    {#if showPeoplePicker}
      <div class="dm-hub-picker">
        <PeoplePicker on:select={async (e) => handlePersonSelected(e.detail)} on:close={() => (showPeoplePicker = false)} />
      </div>
    {/if}

    <div class="dm-hub-scroll">
      {#if dmChannels.length === 0}
        <div class="dm-hub-empty">
          <p>No conversations yet.</p>
          <button class="dm-hub-empty-btn" on:click={() => (showPeoplePicker = true)}>
            Start a conversation
          </button>
        </div>
      {:else}
        {#each dmChannels as channel (channel.id)}
          {@const other = otherUserFor(channel)}
          {@const unread = $channelUnreadCounts[channel.id] || 0}
          <button
            class="dm-hub-conversation"
            class:active={$centerDmChannelId === channel.id}
            class:unread={unread > 0}
            on:click={() => openInCenter(channel)}
            on:contextmenu={(e) => handleContextMenu(channel, e)}
          >
            <div class="dm-hub-avatar-wrap">
              {#if conversationAvatar(channel)}
                <img class="dm-hub-avatar" src={conversationAvatar(channel)} alt="" />
              {:else}
                <div class="dm-hub-avatar dm-hub-avatar-placeholder">
                  {(conversationLabel(channel) || '?')[0]}
                </div>
              {/if}
              {#if other}
                <span class="dm-hub-status-dot" style:background={statusColor(other)}></span>
              {/if}
            </div>
            <div class="dm-hub-body">
              <div class="dm-hub-top">
                <span class="dm-hub-name">{conversationLabel(channel)}</span>
                {#if lastMessageTime(channel)}
                  <span class="dm-hub-time">{lastMessageTime(channel)}</span>
                {/if}
              </div>
              <div class="dm-hub-bottom">
                <span class="dm-hub-preview">{lastMessagePreview(channel) || 'No messages yet'}</span>
                {#if unread > 0}
                  <span class="dm-hub-badge">{unread > 99 ? '99+' : unread}</span>
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
  .dm-hub {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    background: var(--surface-base, #24243e);
  }

  .dm-hub-tabs {
    display: flex;
    gap: var(--space-1, 4px);
    padding: var(--space-1, 4px) var(--space-3, 12px) 0;
    border-bottom: 1px solid var(--color-border-primary, #302b63);
    flex-shrink: 0;
  }

  .dm-hub-tab {
    padding: var(--space-2, 8px) var(--space-3, 12px);
    border: none;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-muted, #9999ff);
    font-size: var(--font-size-sm, 13px);
    font-weight: var(--font-weight-medium, 500);
    cursor: pointer;
    border-radius: var(--radius-sm, 4px) var(--radius-sm, 4px) 0 0;
    transition: background var(--duration-fast, 150ms), color var(--duration-fast, 150ms);
  }
  .dm-hub-tab:hover {
    color: var(--text-heading, #e0e0ff);
    background: color-mix(in srgb, var(--text-heading) 6%, transparent);
  }
  .dm-hub-tab.active {
    color: var(--text-heading, #e0e0ff);
    font-weight: var(--font-weight-semibold, 600);
    border-bottom-color: var(--accent-primary-color, #6366f1);
  }

  .dm-hub-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4, 16px) var(--space-6, 24px);
    border-bottom: 1px solid var(--color-border-primary, #302b63);
    flex-shrink: 0;
  }

  .dm-hub-title-wrap {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 4px);
  }
  .dm-hub-title {
    font-size: var(--font-size-xl, 20px);
    font-weight: 700;
    color: var(--text-heading, #e0e0ff);
    letter-spacing: 0.2px;
  }
  .dm-hub-subtitle {
    font-size: var(--font-size-sm, 13px);
    color: var(--text-muted, #9999ff);
  }

  .dm-hub-new-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 1px solid var(--color-border-primary, #302b63);
    border-radius: var(--radius-md, 8px);
    background: var(--surface-raised, rgba(255, 255, 255, 0.04));
    color: var(--text-secondary, #b3b3ff);
    cursor: pointer;
    padding: 0;
    transition: background var(--duration-instant, 100ms), color var(--duration-instant, 100ms);
  }
  .dm-hub-new-btn:hover {
    background: color-mix(in srgb, var(--text-heading) 8%, transparent);
    color: var(--text-heading, #e0e0ff);
  }

  .dm-hub-picker {
    padding: var(--space-3, 12px) var(--space-6, 24px);
    border-bottom: 1px solid var(--color-border-primary, #302b63);
  }

  .dm-hub-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: var(--space-3, 12px) var(--space-4, 16px) var(--space-4, 16px);
    max-width: 720px;
    width: 100%;
    margin: 0 auto;
  }

  .dm-hub-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3, 12px);
    height: 100%;
    padding: var(--space-3, 12px);
    text-align: center;
    color: var(--text-muted, #9999ff);
    font-size: var(--font-size-lg, 16px);
  }

  .dm-hub-empty-btn {
    padding: var(--space-2, 8px) var(--space-4, 16px);
    background: var(--accent-primary-color, #6366f1);
    color: #fff;
    border: none;
    border-radius: var(--radius-md, 8px);
    font-size: var(--font-size-sm, 13px);
    font-weight: var(--font-weight-medium, 500);
    cursor: pointer;
  }
  .dm-hub-empty-btn:hover {
    opacity: var(--opacity-90, 0.9);
  }

  .dm-hub-conversation {
    display: flex;
    align-items: center;
    gap: var(--space-3, 12px);
    width: 100%;
    padding: var(--space-2, 8px) var(--space-3, 12px);
    border: 1px solid transparent;
    border-radius: var(--radius-lg, 12px);
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    transition: background var(--duration-instant, 100ms), border-color var(--duration-instant, 100ms);
  }
  .dm-hub-conversation:hover {
    background: color-mix(in srgb, var(--text-heading) 3%, transparent);
    border-color: var(--color-border-primary, #302b63);
  }
  .dm-hub-conversation.active {
    background: color-mix(in srgb, var(--accent-primary-color) 12%, transparent);
    border-color: color-mix(in srgb, var(--accent-primary-color) 40%, transparent);
  }

  .dm-hub-avatar-wrap {
    position: relative;
    flex-shrink: 0;
  }
  .dm-hub-avatar {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-full, 9999px);
    object-fit: cover;
  }
  .dm-hub-avatar-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-primary-color, #6366f1);
    color: #fff;
    font-size: var(--font-size-sm, 13px);
    font-weight: var(--font-weight-semibold, 600);
    width: 32px;
    height: 32px;
  }
  .dm-hub-status-dot {
    position: absolute;
    bottom: -1px;
    right: -1px;
    width: var(--space-2, 8px);
    height: var(--space-2, 8px);
    border-radius: 50%;
    border: 2px solid var(--surface-base, #24243e);
  }

  .dm-hub-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 4px);
  }
  .dm-hub-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2, 8px);
  }
  .dm-hub-name {
    font-size: var(--font-size-lg, 16px);
    font-weight: var(--font-weight-medium, 500);
    color: var(--text-heading, #e0e0ff);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dm-hub-conversation.unread .dm-hub-name {
    font-weight: var(--font-weight-semibold, 600);
  }
  .dm-hub-time {
    font-size: var(--font-size-xs, 11px);
    color: var(--text-muted, #9999ff);
    flex-shrink: 0;
  }
  .dm-hub-bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2, 8px);
  }
  .dm-hub-preview {
    font-size: var(--font-size-sm, 13px);
    color: var(--text-secondary, #b3b3ff);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .dm-hub-conversation.unread .dm-hub-preview {
    color: var(--text-heading, #e0e0ff);
  }
  .dm-hub-badge {
    flex-shrink: 0;
    min-width: var(--space-5, 20px);
    height: var(--space-5, 20px);
    padding: 0 var(--space-2, 8px);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-full, 9999px);
    background: var(--accent-primary-color, #6366f1);
    color: #fff;
    font-size: var(--font-size-xs, 11px);
    font-weight: var(--font-weight-semibold, 600);
    line-height: 1;
  }

  .dm-hub-notes {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .notes-external-config {
    padding: var(--space-3, 12px) var(--space-4, 16px);
    border-bottom: 1px solid var(--color-border-primary, #302b63);
    flex-shrink: 0;
  }

  .notes-external-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2, 8px);
  }

  .notes-external-title {
    font-size: var(--font-size-sm, 13px);
    font-weight: var(--font-weight-semibold, 600);
    color: var(--text-heading, #e0e0ff);
  }

  .notes-external-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: 1px solid var(--color-border-primary, #302b63);
    border-radius: var(--radius-sm, 4px);
    background: transparent;
    color: var(--text-secondary, #b3b3ff);
    cursor: pointer;
    transition: background var(--duration-fast, 150ms), color var(--duration-fast, 150ms);
  }
  .notes-external-toggle:hover {
    color: var(--text-heading, #e0e0ff);
    background: var(--surface-hover, #302b63);
  }

  .notes-external-settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 8px);
    margin-top: var(--space-3, 12px);
  }

  .notes-external-label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 4px);
    font-size: var(--font-size-sm, 13px);
    color: var(--text-secondary, #b3b3ff);
  }

  .notes-external-select,
  .notes-external-input {
    width: 100%;
    padding: var(--space-2, 8px) var(--space-3, 12px);
    border: 1px solid var(--color-border-primary, #302b63);
    border-radius: var(--radius-md, 8px);
    background: var(--surface-input, #24243e);
    color: var(--text-heading, #e0e0ff);
    font-size: var(--font-size-sm, 13px);
  }

  .notes-external-test {
    align-self: flex-start;
    padding: var(--space-2, 8px) var(--space-3, 12px);
    border: 1px solid var(--color-border-primary, #302b63);
    border-radius: var(--radius-md, 8px);
    background: var(--surface-button, #302b63);
    color: var(--text-heading, #e0e0ff);
    font-size: var(--font-size-sm, 13px);
    font-weight: var(--font-weight-medium, 500);
    cursor: pointer;
  }
  .notes-external-test:hover {
    background: var(--surface-hover, #302b63);
  }

  .notes-external-result {
    font-size: var(--font-size-sm, 13px);
    color: var(--text-muted, #9999ff);
  }
  .notes-external-result.success {
    color: var(--color-success, #22c55e);
  }
  .notes-external-result.error {
    color: var(--color-danger, #ef4444);
  }

	@media (prefers-reduced-motion: reduce) {
		.dm-hub-new-btn, .dm-hub-conversation, .dm-hub-tab, .dm-hub-empty-btn,
		.notes-external-toggle, .notes-external-test { transition: none; }
	}
</style>
