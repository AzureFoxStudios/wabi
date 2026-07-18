<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { get } from 'svelte/store';
  import type { Channel, Message, User } from '$lib/socket';
  import { currentUser, sendMessage, users, userLookup } from '$lib/socket';
  import { getSocket } from '$lib/socketConnection';
  import { joinChannel } from '$lib/channelStore';
  import { isLiveRetention } from '../../../../../shared/messageRetention.js';
  import LiveEmptyState from './LiveEmptyState.svelte';
  import LiveConnectionBar from './LiveConnectionBar.svelte';

  const DEFAULT_TTL_MS = 10 * 60 * 1000;

  export let channel: Channel;
  export let liveTtlMs: number = DEFAULT_TTL_MS;
  export let afkAnnounce: boolean = true;

  let joined = false;
  let liveCount = 0;
  let participants = new Map<string, { status: 'active' | 'afk' | 'you' }>();
  let messages: Message[] = [];
  let now = Date.now();
  let ageTicker: ReturnType<typeof setInterval> | null = null;
  let messageContainer: HTMLElement;
  let textInput = '';
  let showParticipants = false;

  function getLiveRenderWindow(): number {
    try {
      const v = localStorage.getItem('wabi:liveRenderWindow');
      if (v !== null) {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch {}
    return 250;
  }

  function setLiveRenderWindow(val: number) {
    try {
      localStorage.setItem('wabi:liveRenderWindow', String(val));
    } catch {}
  }

  $: renderWindow = getLiveRenderWindow();

  function getBornAt(msg: Message): number {
    return (msg as any).bornAt ?? msg.timestamp;
  }

  function computeAgeClass(msg: Message): number {
    const bornAt = getBornAt(msg);
    const elapsed = now - bornAt;
    if (elapsed <= 0) return 1;
    const progress = elapsed / liveTtlMs;
    if (progress < 0.25) return 1;
    if (progress < 0.5) return 2;
    if (progress < 0.75) return 3;
    return 4;
  }

  function computeRemainingTime(msg: Message): string {
    const bornAt = getBornAt(msg);
    const elapsed = now - bornAt;
    const remaining = Math.max(0, liveTtlMs - elapsed);
    const minutes = Math.ceil(remaining / 60000);
    if (minutes < 1) return '<1m';
    return `${minutes}m`;
  }

  function handleSnapshot(payload: { channelId: string; messages: Message[] }) {
    if (payload.channelId !== channel.id) return;
    const msgs = Array.isArray(payload.messages) ? payload.messages : [];
    messages = msgs.slice(-renderWindow);
  }

  function handleMessage(payload: { channelId?: string; message?: Message }) {
    if (!payload?.channelId || !payload.message) return;
    if (payload.channelId !== channel.id) return;
    const msg = payload.message;
    if (msg.isDeleted) return;
    messages = [...messages, msg].slice(-renderWindow);
  }

  function handleMessageDeleted(payload: { channelId?: string; messageId?: string }) {
    if (!payload?.channelId || !payload.messageId) return;
    if (payload.channelId !== channel.id) return;
    const id = payload.messageId;
    const el = messageContainer?.querySelector(`[data-message-id="${id}"]`);
    if (el) {
      el.classList.add('live-msg-removing');
      setTimeout(() => {
        messages = messages.filter(m => m.id !== id);
      }, 300);
    } else {
      messages = messages.filter(m => m.id !== id);
    }
  }

  function handleLiveCount(payload: { channelId: string; count: number }) {
    if (payload.channelId !== channel.id) return;
    liveCount = payload.count;
  }

  function handlePresenceAfk(payload: { channelId: string; userId: string; username?: string }) {
    if (payload.channelId !== channel.id) return;
    const uid = payload.userId;
    const isYou = uid === $currentUser?.id;
    participants.set(uid, { status: isYou ? 'you' : 'afk' });
    participants = new Map(participants);
    if (afkAnnounce && payload.username) {
      appendSystemLine(`${payload.username} is AFK`);
    }
  }

  function handlePresenceBack(payload: { channelId: string; userId: string; username?: string }) {
    if (payload.channelId !== channel.id) return;
    const uid = payload.userId;
    const isYou = uid === $currentUser?.id;
    participants.set(uid, { status: isYou ? 'you' : 'active' });
    participants = new Map(participants);
    if (afkAnnounce && payload.username) {
      appendSystemLine(`${payload.username} is back`);
    }
  }

  function appendSystemLine(text: string) {
    const systemMsg: Message = {
      id: `system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      user: '',
      userId: '',
      color: '',
      text,
      timestamp: Date.now(),
      isDeleted: false,
      clientMessageId: undefined,
      senderStableId: undefined,
      type: 'text' as any
    };
    messages = [...messages, systemMsg].slice(-renderWindow);
  }

  function handleJoin() {
    joined = true;
    joinChannel(channel.id);
  }

  function handleLeave() {
    joined = false;
    messages = [];
    participants = new Map();
  }

  function handleSend() {
    const text = textInput.trim();
    if (!text) return;
    sendMessage(channel.id, text, 'text');
    textInput = '';
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function getUserDisplayName(uid: string): string {
    const u = $userLookup?.[uid];
    if (u) return u.username || u.id || uid;
    const found = $users.find(u => u.id === uid);
    return found?.username || found?.handle || uid;
  }

  $: participantEntries = [...participants.entries()].sort((a, b) => {
    const order = { you: 0, active: 1, afk: 2 };
    return (order[a[1].status] || 3) - (order[b[1].status] || 3);
  });

  onMount(() => {
    ageTicker = setInterval(() => { now = Date.now(); }, 10000);
    const sock = getSocket();
    if (!sock) return;
    sock.on('live-buffer-snapshot', handleSnapshot);
    sock.on('live-count', handleLiveCount);
    sock.on('presence-afk', handlePresenceAfk);
    sock.on('presence-back', handlePresenceBack);
    sock.on('message', handleMessage);
    sock.on('message-deleted', handleMessageDeleted);
    joinChannel(channel.id);
  });

  onDestroy(() => {
    if (ageTicker) clearInterval(ageTicker);
    const sock = getSocket();
    if (!sock) return;
    sock.off('live-buffer-snapshot', handleSnapshot);
    sock.off('live-count', handleLiveCount);
    sock.off('presence-afk', handlePresenceAfk);
    sock.off('presence-back', handlePresenceBack);
    sock.off('message', handleMessage);
    sock.off('message-deleted', handleMessageDeleted);
  });
</script>

{#if !joined}
  <LiveEmptyState {channel} {liveCount} onJoin={handleJoin} />
{:else}
  <div class="live-channel-view">
    <div class="live-header">
      <div class="live-header-content">
        <h2 class="live-title">Welcome to #{channel.name}</h2>
        <p class="live-subtitle">be here now</p>
      </div>
      <div class="live-header-actions">
        <button
          class="participants-toggle"
          class:active={showParticipants}
          on:click={() => (showParticipants = !showParticipants)}
          title="Participants"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-icon">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
            <circle cx="9" cy="7" r="4"></circle>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
          </svg>
          <span class="participant-count">{liveCount}</span>
        </button>
      </div>
    </div>

    <div class="live-body">
      <div class="live-messages" bind:this={messageContainer}>
        {#each messages as msg (msg.id)}
          {@const ageClass = computeAgeClass(msg)}
          {@const remaining = computeRemainingTime(msg)}
          {@const isSystem = !msg.userId}
          <div
            class="live-msg live-msg-age-{ageClass}"
            class:live-msg-system={isSystem}
            data-message-id={msg.id}
            title={isSystem ? '' : `Fades in ${remaining}`}
          >
            {#if !isSystem}
              <div class="live-msg-avatar">
                {#if msg.userId && $userLookup?.[msg.userId]?.profilePicture}
                  <img src={$userLookup[msg.userId].profilePicture} alt="" class="live-avatar-img" />
                {:else}
                  <div class="live-avatar-placeholder" style="background-color: {msg.color || '#98D8C8'}">
                    {msg.user?.charAt(0)?.toUpperCase() || '?'}
                  </div>
                {/if}
              </div>
              <div class="live-msg-content">
                <div class="live-msg-meta">
                  <span class="live-msg-user" style="color: {msg.color}">{msg.user || 'Unknown'}</span>
                </div>
                <div class="live-msg-text">{msg.text}</div>
              </div>
              <div class="live-msg-remaining" title="Time remaining">{remaining}</div>
            {:else}
              <div class="live-system-line">{msg.text}</div>
            {/if}
          </div>
        {/each}
      </div>

      {#if showParticipants}
        <div class="participants-panel">
          <h3 class="participants-title">Participants</h3>
          <div class="participants-list">
            {#each participantEntries as [uid, p]}
              <div class="participant-row" class:afk={p.status === 'afk'} class:is-you={p.status === 'you'}>
                <div class="participant-avatar">
                  {#if $userLookup?.[uid]?.profilePicture}
                    <img src={$userLookup[uid].profilePicture} alt="" class="p-avatar-img" />
                  {:else}
                    <div class="p-avatar-placeholder" style="background-color: {$userLookup?.[uid]?.color || '#98D8C8'}">
                      {(getUserDisplayName(uid)).charAt(0).toUpperCase()}
                    </div>
                  {/if}
                </div>
                <span class="participant-name">{getUserDisplayName(uid)}</span>
                {#if p.status === 'afk'}
                  <span class="afk-chip">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="chip-icon"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"></path></svg>
                    AFK
                  </span>
                {/if}
                {#if p.status === 'you'}
                  <span class="you-chip">You</span>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <div class="live-composer">
      <div class="composer-input-wrap">
        <input
          type="text"
          class="composer-input"
          placeholder="Send a message..."
          bind:value={textInput}
          on:keydown={handleKeydown}
        />
        <button
          class="composer-send-btn"
          on:click={handleSend}
          disabled={!textInput.trim()}
          aria-label="Send"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="send-icon">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>
    </div>

    <LiveConnectionBar
      channelName={channel.name}
      onLeave={handleLeave}
    />
  </div>
{/if}

<style>
  .live-channel-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    position: relative;
  }

  .live-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-subtle, #3f4147);
    flex-shrink: 0;
  }

  .live-header-content {
    display: flex;
    flex-direction: column;
  }

  .live-title {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
    color: var(--text-primary, #f2f3f5);
  }

  .live-subtitle {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--text-muted, #8e9297);
    font-style: italic;
  }

  .participants-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted, #8e9297);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }

  .participants-toggle:hover,
  .participants-toggle.active {
    color: var(--accent-primary-color, #5b8dee);
    background: rgba(91, 141, 238, 0.1);
  }

  .participant-count {
    font-size: 13px;
  }

  .btn-icon {
    width: 16px;
    height: 16px;
  }

  .live-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .live-messages {
    flex: 1;
    overflow-y: auto;
    padding: 8px 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .live-msg {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 6px;
    transition: opacity 0.3s;
  }

  .live-msg-age-1 { opacity: 1; }
  .live-msg-age-2 { opacity: 0.75; }
  .live-msg-age-3 { opacity: 0.5; }
  .live-msg-age-4 { opacity: 0.3; }

  .live-msg-removing {
    opacity: 0 !important;
    transform: translateX(-20px);
    transition: opacity 0.3s, transform 0.3s;
  }

  .live-msg-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    overflow: hidden;
    flex-shrink: 0;
  }

  .live-avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .live-avatar-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    color: #fff;
    font-size: 12px;
  }

  .live-msg-content {
    flex: 1;
    min-width: 0;
  }

  .live-msg-meta {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 2px;
  }

  .live-msg-user {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary, #f2f3f5);
  }

  .live-msg-text {
    font-size: 14px;
    color: var(--text-primary, #f2f3f5);
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .live-msg-remaining {
    font-size: 10px;
    color: var(--text-muted, #8e9297);
    flex-shrink: 0;
    align-self: center;
    opacity: 0.6;
  }

  .live-msg-system {
    justify-content: center;
    padding: 4px 8px;
  }

  .live-system-line {
    font-size: 12px;
    font-style: italic;
    color: var(--text-muted, #8e9297);
    text-align: center;
    width: 100%;
  }

  .participants-panel {
    width: 220px;
    flex-shrink: 0;
    border-left: 1px solid var(--border-subtle, #3f4147);
    padding: 12px;
    overflow-y: auto;
    background: var(--surface-base, #1e1f22);
  }

  .participants-title {
    margin: 0 0 12px;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted, #8e9297);
  }

  .participants-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .participant-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    font-size: 14px;
    color: var(--text-primary, #f2f3f5);
  }

  .participant-row.is-you {
    background: rgba(91, 141, 238, 0.08);
  }

  .participant-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    overflow: hidden;
    flex-shrink: 0;
  }

  .p-avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .p-avatar-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    color: #fff;
    font-size: 10px;
  }

  .participant-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .afk-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(250, 166, 26, 0.15);
    color: #faa61a;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    flex-shrink: 0;
  }

  .chip-icon {
    width: 10px;
    height: 10px;
  }

  .you-chip {
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(91, 141, 238, 0.15);
    color: var(--accent-primary-color, #5b8dee);
    font-size: 10px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .live-composer {
    flex-shrink: 0;
    padding: 8px 16px;
    background: var(--surface-base, #1e1f22);
    border-top: 1px solid var(--border-subtle, #3f4147);
  }

  .composer-input-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--surface-highlight, #2b2d31);
    border-radius: 8px;
    padding: 0 12px;
  }

  .composer-input {
    flex: 1;
    border: none;
    background: transparent;
    padding: 10px 0;
    font-size: 14px;
    color: var(--text-primary, #f2f3f5);
    outline: none;
    font-family: inherit;
  }

  .composer-input::placeholder {
    color: var(--text-muted, #8e9297);
  }

  .composer-send-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 6px;
    background: var(--accent-primary-color, #5b8dee);
    color: #fff;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }

  .composer-send-btn:hover:not(:disabled) {
    background: var(--accent-primary-hover, #4a7bd5);
  }

  .composer-send-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .send-icon {
    width: 14px;
    height: 14px;
  }
</style>
