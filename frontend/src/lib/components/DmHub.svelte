<!--
  DMs hub (design contract §8.10, D6): center stage when the DMs destination is open.
  - Masthead (96, the shared rule at y = 96): row A is the serif title "DMs" and the segmented
    Conversations | Friends (the friend-request count as an ink badge on Friends); row B is the
    hub's search and the split "New message ▾" primary (DMs are not inside a channel, so there is
    no folio here). No "Server home" pseudo-tab: Server home is reached from the community block.
  - Rows are 52px with the person's identity disc, presence, name ink, the last message and an
    ink badge; the open conversation takes the selection grammar (--w-raise, aria-current). A
    row's accessible name is its visible words plus visually hidden kind, presence and unread.
  - Leaving several groups is a selection mode with one confirm.
  - "New message" in the masthead is the view's one primary; empty-state actions are default.
-->
<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { layoutStore } from '$lib/layoutStore';
  import { centerDmChannelId } from '$lib/layoutStoreStates';
  import { channels, channelMessages, currentUser, users, serverMembers, connected, channelUnreadCounts, createDM, joinChannel, markChannelAsRead, leaveGroup } from '$lib/socket';
  import type { Channel, User, Message } from '$lib/socket-types';
  import { getDmDirectoryKey } from '$lib/dmUserDirectory';
  import { buildDmPlaceholderChannel, findExistingDmChannel, getDmStableUserId, resolveDmOtherUser } from '$lib/dmConversations';
  import PeoplePicker from './PeoplePicker.svelte';
  import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
  import FriendsPanel from './FriendsPanel.svelte';
  import CreateGroupModal from './CreateGroupModal.svelte';
  import { friendships, startFriendshipSync } from '$lib/friendships';
  import { mediaUrl } from '$lib/mediaUrl';
  import ProfileName from './ProfileName.svelte';
  import ProfileMedia from './ProfileMedia.svelte';
  import { E2EE_MESSAGE_PREFIX } from '$lib/e2ee';
  import { leaveSelectedGroupChannels } from '$lib/dmGroupBatch';
  import { livePresenceForUser } from '$lib/dmPresentation';

  import { openDetachedPanel } from '$lib/detachedPanels';
  import { _ } from '$lib/i18n';
  import { confirmAction } from '$lib/confirm';
  import { inkFor } from '$lib/theme/identity';
  import { conversationMatches } from '$lib/dm/dmConversationCopy';
  import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import EmptyState from '$lib/components/ui/EmptyState.svelte';
  import GroupAvatar from './GroupAvatar.svelte';

  export let friendsOpenRequest = 0;
  export let messagesOpenRequest = 0;
  // `serverHome` is kept for MainLayout's listener; the hub no longer offers a "Server home"
  // pseudo-tab (spec D6: Server home is reached from the community block only).
  const dispatch = createEventDispatcher<{ tabChange: { tab: 'messages' | 'friends' }; serverHome: void }>();

  let showPeoplePicker = false;
  let showCreateGroup = false;
  let activeTab: 'messages' | 'friends' = 'messages';
  let pendingDmUser: User | null = null;
  let pendingDmError = '';
  let batchMode = false;
  let selectedGroupIds: string[] = [];
  let batchBusy = false;
  let batchStatus = '';
  let hubQuery = '';
  let searchInput: HTMLInputElement | null = null;


  onMount(() => {
    const stopSync = startFriendshipSync();
    dispatch('tabChange', { tab: activeTab });
    return stopSync;
  });

  function selectTab(tab: 'messages' | 'friends') {
    if (tab === 'friends') {
      showPeoplePicker = false;
      layoutStore.closeCenterDm();
    }
    if (activeTab === tab) return;
    activeTab = tab;
    dispatch('tabChange', { tab });
  }

  // Both request props use one increasing sequence in MainLayout, so the
  // latest sidebar navigation still wins when this component remounts.
  $: if (friendsOpenRequest > messagesOpenRequest) selectTab('friends');
  $: if (messagesOpenRequest > friendsOpenRequest) selectTab('messages');

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
  function sortDms(a: Channel, b: Channel, messagesByChannel: Record<string, Message[]>): number {
    // 1. Pinned first
    const aPinned = ((a as any).pinnedBy?.length ?? 0) > 0 ? 1 : 0;
    const bPinned = ((b as any).pinnedBy?.length ?? 0) > 0 ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;

    // 2. Last timestamp desc (most recent first)
    const aMsgs = messagesByChannel[a.id] || [];
    const bMsgs = messagesByChannel[b.id] || [];
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

  // Keep the message store as an explicit reactive dependency. Reads hidden
  // inside helper functions did not refresh previews or conversation ordering.
  $: dmChannels = ($channels || [])
    .filter((ch: Channel) => ch.type === "dm" || ch.type === "group")
    .sort((a, b) => sortDms(a, b, $channelMessages));
  $: groupChannels = dmChannels.filter((channel) => channel.type === 'group');
  $: selectedGroups = groupChannels.filter((channel) => selectedGroupIds.includes(channel.id));

  function toggleGroupSelection(channelId: string): void {
    selectedGroupIds = selectedGroupIds.includes(channelId)
      ? selectedGroupIds.filter((id) => id !== channelId)
      : [...selectedGroupIds, channelId];
  }

  function exitBatchMode(): void {
    batchMode = false;
    selectedGroupIds = [];
  }

  async function reviewLeaveSelectedGroups(): Promise<void> {
    if (batchBusy || selectedGroups.length === 0) return;
    const names = selectedGroups.map((channel) => conversationLabel(channel));
    const shown = names.slice(0, 5).join(', ');
    const more = names.length > 5 ? ` and ${names.length - 5} more` : '';
    const count = selectedGroups.length;
    const leave = await confirmAction({
      title: `Leave ${count} group ${count === 1 ? 'conversation' : 'conversations'}?`,
      body: `${shown}${more}. You may lose access to ${count === 1 ? 'it' : 'them'} on this server; other servers are not affected.`,
      confirm: count === 1 ? 'Leave group' : 'Leave groups',
      danger: true
    });
    if (leave) await leaveSelectedGroups();
  }

  async function leaveSelectedGroups(): Promise<void> {
    if (batchBusy || selectedGroups.length === 0) return;
    const targetIds = selectedGroups.map((channel) => channel.id);
    batchBusy = true;
    batchStatus = '';
    const result = await leaveSelectedGroupChannels($channels, targetIds, leaveGroup);
    batchBusy = false;
    if (result.failedIds.length === 0) {
      batchStatus = `Left ${result.leftIds.length} group ${result.leftIds.length === 1 ? 'conversation' : 'conversations'}.`;
      exitBatchMode();
    } else {
      selectedGroupIds = result.failedIds;
      batchStatus = `Left ${result.leftIds.length} of ${result.attempted} groups. ${result.failedIds.length} could not be confirmed; review and retry them.`;
    }
  }

  let contextMenuOpen = false;
  let contextMenuPos = { x: 0, y: 0 };
  let contextMenuChannel: Channel | null = null;

  function otherUserFor(channel: Channel): User | null {
    return resolveDmOtherUser(channel, $currentUser, $users, $serverMembers);
  }

  function conversationLabel(channel: Channel): string {
    if (channel.type === 'group') {
      return channel.name || channel.id;
    }
    const other = otherUserFor(channel);
    return other?.handle || other?.username || 'Recipient unavailable';
  }

  function lastMessagePreview(msgs: Message[] | undefined): string {
    if (!msgs) return 'Open to load the conversation';
    if (msgs.length === 0) return 'No messages yet';
    const last = msgs[msgs.length - 1];
    // An envelope this device has not opened yet: say what to do, never a privacy claim.
    if (last.encrypted || last.text?.startsWith(E2EE_MESSAGE_PREFIX)) return 'Open to read the latest message';
    if (last.type === 'file') return last.fileName || '[File]';
    if (last.type === 'gif') return '[GIF]';
    if (last.type === 'emoji') return '[Emoji]';
    return last.text || 'Message';
  }

  function lastMessageTime(msgs: Message[] | undefined): string {
    msgs ||= [];
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

  async function openInCenter(channel: Channel, fallbackUser: User | null = null) {
    selectTab('messages');
    const other = fallbackUser || otherUserFor(channel);
    if (channel.type === 'group') {
      layoutStore.openCenterGroupDm(channel.id, channel);
    } else {
      layoutStore.openCenterDm(channel.id, other);
    }
    joinChannel(channel.id);
    markChannelAsRead(channel.id);
    await tick();
    const list = document.querySelector('.center-dm-list');
    if (list && getComputedStyle(list).display === 'none') {
      document.querySelector<HTMLButtonElement>('.center-dm-thread .dm-header-back')?.focus();
    }
  }

  function openInSidePanel(channel: Channel, fallbackUser: User | null = null) {
    const other = fallbackUser || otherUserFor(channel);
    if (channel.type === 'group') {
      layoutStore.openGroupDM(channel.id, channel);
    } else {
      layoutStore.openDM(channel.id, other);
    }
    joinChannel(channel.id);
  }

  function openCreatedGroup(channel: Channel) {
    selectTab('messages');
    showPeoplePicker = false;
    layoutStore.openCenterGroupDm(channel.id, channel);
    joinChannel(channel.id);
    markChannelAsRead(channel.id);
  }

  function handleContextMenu(channel: Channel, e: MouseEvent) {
    e.preventDefault();
    contextMenuChannel = channel;
    contextMenuPos = { x: e.clientX, y: e.clientY };
    contextMenuOpen = true;
  }

  let contextMenuItems: MenuEntry[] = [];
  $: contextMenuItems = contextMenuChannel
    ? [
        { id: 'open-center', label: 'Open in center stage', icon: 'expand', onSelect: () => openInCenter(contextMenuChannel!) },
        { id: 'open-side', label: 'Open in side panel', icon: 'sidebarRight', onSelect: () => openInSidePanel(contextMenuChannel!) },
        { id: 'open-window', label: 'Open in a new window', icon: 'externalLink', onSelect: () => openDetachedPanel({ kind: 'channel-chat', channelId: contextMenuChannel!.id, channelName: conversationLabel(contextMenuChannel!) }) }
      ]
    : [];

  // The split "New message ▾" menu: the other ways to start, and the group batch tool.
  let newMenuItems: MenuEntry[] = [];
  $: newMenuItems = [
    { id: 'new-group', label: 'New group', icon: 'users', onSelect: () => { showCreateGroup = true; } },
    ...(groupChannels.length
      ? [{ id: 'manage-groups', label: 'Leave several groups…', icon: 'logout', onSelect: () => { batchMode = true; batchStatus = ''; selectTab('messages'); } } as MenuEntry]
      : [])
  ];

  function nameOf(channel: Channel): string[] {
    if (channel.type === 'group') return [channel.name || channel.id];
    const other = otherUserFor(channel);
    return [other?.handle, other?.username, other?.handle ? `@${other.handle}` : null].filter((value): value is string => Boolean(value));
  }

  $: listChannels = batchMode ? groupChannels : dmChannels;
  $: shownChannels = hubQuery.trim() ? listChannels.filter((channel) => conversationMatches(hubQuery, nameOf(channel))) : listChannels;

  /**
   * What the row says to assistive tech beyond its visible words (kind, presence, unread),
   * read right after the name. The visible name, time and last message stay in the row's
   * accessible name: this adds to them and never replaces them.
   */
  function rowExtras(channel: Channel, unread: number, presence: string): string {
    const parts: string[] = [];
    if (channel.type === 'group') parts.push('group');
    if (presence === 'active') parts.push('online');
    else if (presence === 'away' || presence === 'busy') parts.push(presence);
    if (unread > 0) parts.push(`${unread} unread`);
    return parts.length ? `, ${parts.join(', ')},` : ',';
  }

  function upsertLocalDmPlaceholder(channel: Channel): Channel {
    channels.update((allChannels) => {
      const existing = allChannels.find((candidate) => candidate.id === channel.id);
      if (existing) return allChannels.map((candidate) => (candidate.id === channel.id ? { ...candidate, ...channel } : candidate));
      return [...allChannels, channel];
    });
    return channel;
  }

  function isSelfUser(user: User): boolean {
    const selfStableId = getDmStableUserId($currentUser);
    const userStableId = getDmStableUserId(user);
    return Boolean(selfStableId && userStableId && selfStableId === userStableId);
  }

  async function handlePersonSelected(user: User) {
    selectTab('messages');
    pendingDmError = '';
    showPeoplePicker = false;
    if (isSelfUser(user)) return;

    const existing = findExistingDmChannel($channels || [], user);
    if (existing) {
      openInCenter(existing, user);
      return;
    }

    pendingDmUser = user;
    const result = await createDM(getDmDirectoryKey(user));
    const alreadyOpened = pendingDmUser === null;
    if (alreadyOpened) return;

    const created =
      (result.ok ? result.channel : undefined) ||
      (result.channelId ? ($channels || []).find((channel) => channel.id === result.channelId) : null) ||
      findExistingDmChannel($channels || [], user) ||
      (result.channelId ? upsertLocalDmPlaceholder(buildDmPlaceholderChannel(result.channelId, user, $currentUser)) : null);

    if (created) {
      pendingDmUser = null;
      openInCenter(created, user);
      return;
    }

    pendingDmUser = null;
    // Plain words; the server's own text goes to the log, never the screen.
    if (!result.ok) console.warn('[DMs] Could not start a conversation:', (result as { ok: false; error: string }).error);
    pendingDmError = result.ok
      ? 'The conversation was created but has not arrived yet. It appears in the list in a moment.'
      : 'Couldn’t start the conversation. Nothing was sent. Try again in a moment.';
    showPeoplePicker = true;
  }

  $: if (pendingDmUser) {
    const created = findExistingDmChannel($channels || [], pendingDmUser);
    if (created) {
      const user = pendingDmUser;
      pendingDmUser = null;
      openInCenter(created, user);
    }
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
  <header class="dm-hub-mast">
    <div class="dm-hub-a">
      <h2 class="dm-hub-title">{$_('places.dms')}</h2>
      <div class="w-seg dm-hub-seg" role="group" aria-label="Show">
        <button type="button" class="dm-hub-tab" aria-pressed={activeTab === 'messages'} on:click={() => selectTab('messages')}>{$_('places.conversations')}</button>
        <button
          type="button"
          class="dm-hub-tab"
          aria-pressed={activeTab === 'friends'}
          aria-label={$friendships.incoming.length > 0 ? `${$_('places.friends')}, ${$friendships.incoming.length} friend ${$friendships.incoming.length === 1 ? 'request' : 'requests'}` : undefined}
          on:click={() => selectTab('friends')}
        >
          {$_('places.friends')}{#if $friendships.incoming.length > 0}<span class="w-badge w-badge--sm dm-hub-request-badge" aria-hidden="true">{$friendships.incoming.length > 99 ? '99+' : $friendships.incoming.length}</span>{/if}
        </button>
      </div>
    </div>
    <div class="dm-hub-b">
      {#if activeTab === 'messages'}
        <label class="w-field w-field--chrome dm-hub-find">
          <Icon name="search" size={16} />
          <input
            type="search"
            bind:this={searchInput}
            bind:value={hubQuery}
            placeholder="Search DMs"
            aria-label="Search DMs"
            autocomplete="off"
            spellcheck="false"
            on:keydown={(event) => { if (event.key === 'Escape' && hubQuery) { event.preventDefault(); hubQuery = ''; } }}
          />
        </label>
        <div class="w-split dm-hub-new">
          <button
            type="button"
            class="w-btn w-btn--primary dm-hub-new-btn"
            aria-expanded={showPeoplePicker}
            on:click={() => (showPeoplePicker = !showPeoplePicker)}
          >New message</button>
          <Menu
            items={newMenuItems}
            label="More ways to start"
            triggerLabel="More ways to start a conversation"
            class="w-btn w-btn--primary w-split__menu"
            align="end"
            heading="New conversation"
          >
            <Icon name="chevDown" size={16} />
          </Menu>
        </div>
      {:else}
        <p class="dm-hub-b-note">People on this server{#if $friendships.outgoing.length > 0}<span class="w-count">{$friendships.outgoing.length} sent</span>{/if}</p>
      {/if}
    </div>
  </header>

  {#if activeTab === 'messages'}
    {#if showPeoplePicker}
      <section class="dm-hub-picker" aria-label="New message">
        <div class="dm-hub-picker-head">
          <span class="w-kicker">New message</span>
          <button type="button" class="w-ibtn w-ibtn--sm" aria-label="Close new message" on:click={() => { showPeoplePicker = false; pendingDmError = ''; }}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <PeoplePicker on:select={async (e) => handlePersonSelected(e.detail)} on:close={() => (showPeoplePicker = false)} />
        {#if pendingDmError}
          <div class="w-notice dm-hub-notice" role="alert">
            <Icon name="alert" size={16} />
            <p class="w-notice__title">Couldn’t open the conversation</p>
            <p class="w-notice__text">{pendingDmError}</p>
          </div>
        {/if}
      </section>
    {/if}

    {#if pendingDmUser}
      <p class="dm-hub-status" role="status">Opening the conversation with {pendingDmUser.username}…</p>
    {/if}
    {#if batchStatus}<p class="dm-hub-status" role="status">{batchStatus}</p>{/if}
    {#if batchMode}
      <div class="dm-hub-batch" role="group" aria-label="Leave several groups">
        <p class="dm-hub-batch-text">Choose the groups to leave. Unread and pinned groups start unselected; activity shows only when it is loaded on this device.</p>
        <div class="dm-hub-batch-actions">
          <button type="button" class="w-btn w-btn--quiet w-btn--sm" on:click={exitBatchMode} disabled={batchBusy}>Cancel</button>
          <button type="button" class="w-btn w-btn--danger w-btn--sm" aria-busy={batchBusy} on:click={() => void reviewLeaveSelectedGroups()} disabled={selectedGroups.length === 0 || batchBusy}>
            {batchBusy ? 'Leaving…' : selectedGroups.length ? `Leave ${selectedGroups.length} selected` : 'Leave selected'}
          </button>
        </div>
      </div>
    {/if}

    <div class="dm-hub-scroll">
      {#if listChannels.length === 0}
        <!-- The masthead's "New message" is this view's one primary, so these actions are default buttons. -->
        <EmptyState
          class="dm-hub-empty"
          as="p"
          icon="dm"
          title={batchMode ? 'No groups to leave' : 'No conversations yet'}
          text={batchMode ? 'You are not in any group conversations on this server.' : 'Start one with anyone in this community. It appears here.'}
        >
          {#snippet actions()}
            <button type="button" class="w-btn" on:click={() => { if (batchMode) exitBatchMode(); else showPeoplePicker = true; }}>{batchMode ? 'Done' : 'New message'}</button>
          {/snippet}
        </EmptyState>
      {:else if shownChannels.length === 0}
        <EmptyState
          class="dm-hub-empty"
          as="p"
          icon="search"
          title="No conversations match"
          text={`Nothing here is called “${hubQuery.trim()}”. Try another name.`}
        >
          {#snippet actions()}
            <button type="button" class="w-btn" on:click={() => { hubQuery = ''; searchInput?.focus(); }}>Clear search</button>
          {/snippet}
        </EmptyState>
      {:else}
        {#each shownChannels as channel (channel.id)}
          {@const other = resolveDmOtherUser(channel, $currentUser, $users, $serverMembers)}
          {@const avatar = channel.type === 'group' ? channel.avatar : other?.profilePicture}
          {@const presence = livePresenceForUser(other, $users, $connected)}
          {@const unread = $channelUnreadCounts[channel.id] || 0}
          {@const previewMessages = $channelMessages[channel.id]}
          {@const selected = batchMode ? selectedGroupIds.includes(channel.id) : $centerDmChannelId === channel.id}
          <button
            type="button"
            class="dm-hub-conversation"
            style={channel.type === 'dm' && other ? $inkFor(other.roleColor || other.color) : null}
            data-dm-channel-id={channel.id}
            aria-pressed={batchMode ? selected : undefined}
            aria-current={!batchMode && selected ? 'page' : undefined}
            class:active={selected}
            class:unread={unread > 0}
            on:click={() => batchMode ? toggleGroupSelection(channel.id) : openInCenter(channel)}
            on:contextmenu={(e) => { if (!batchMode) handleContextMenu(channel, e); }}
          >
            {#if batchMode}<span class="w-check dm-hub-check" aria-hidden="true" aria-checked={selected}></span>{/if}
            <span class="dm-hub-avatar-wrap" aria-hidden="true">
              {#if channel.type === 'group'}
                <GroupAvatar {channel} size={32} />
              {:else if avatar}
                <ProfileMedia class="dm-hub-stamp" src={mediaUrl(avatar)} decorative />
              {:else}
                <span class="dm-hub-stamp" aria-hidden="true">{(conversationLabel(channel) || '?').charAt(0).toUpperCase()}</span>
              {/if}
              {#if presence === 'active' || presence === 'away' || presence === 'busy'}
                <span class="dm-hub-status-dot" data-presence={presence} aria-hidden="true"></span>
              {/if}
            </span>
            <span class="dm-hub-body">
              <span class="dm-hub-top">
                <span class="dm-hub-name">{#if channel.type === 'dm' && other}<ProfileName username={other.handle || other.username} font={other.usernameFont} color={other.roleColor || other.color} />{:else}{conversationLabel(channel)}{/if}</span><span class="sr-only">{rowExtras(channel, unread, presence)}</span>
                {#if lastMessageTime(previewMessages)}
                  <span class="dm-hub-time">{lastMessageTime(previewMessages)}</span>
                {/if}
              </span>
              <span class="dm-hub-bottom">
                <span class="dm-hub-preview">{lastMessagePreview(previewMessages)}</span>
                {#if unread > 0}
                  <span class="w-badge w-badge--sm dm-hub-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>
                {/if}
              </span>
            </span>
          </button>
        {/each}
      {/if}
    </div>
  {:else}
    <FriendsPanel on:message={(event) => handlePersonSelected(event.detail)} />
  {/if}
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

<CreateGroupModal bind:isOpen={showCreateGroup} onCreated={openCreatedGroup} />

<style>
  /* DMs hub (§8.10). Roles, type tokens and kit classes only. */
  .dm-hub {
    display: flex;
    flex-direction: column;
    container: dm-hub / inline-size;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    background: var(--w-bg);
    color: var(--w-text);
    font: var(--w-t-ui);
  }

  /* ---------- masthead: row A 56 + row B 40, one hairline at y = --w-mast ---------- */
  .dm-hub-mast {
    flex: none;
    box-sizing: border-box;
    height: var(--w-mast);
    padding: 0 12px;
    border-bottom: var(--w-bw) solid var(--w-line);
  }
  .dm-hub-a {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    height: var(--w-head-a);
    min-width: 0;
  }
  .dm-hub-title {
    flex: none;
    margin: 0;
    color: var(--w-text);
    font: var(--w-t-title);
    letter-spacing: 0.005em;
  }
  .dm-hub-seg > :global(button) {
    padding: 0 10px;
  }
  .dm-hub-request-badge {
    margin-inline-start: -1px;
  }
  .dm-hub-b {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    height: var(--w-head-b);
    min-width: 0;
  }
  .dm-hub-find {
    flex: 1 1 auto;
    min-width: 96px;
    cursor: text;
  }
  .dm-hub-find > input[type='search'] {
    min-height: 0;
    height: 100%;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    color: var(--w-text);
    font: inherit;
    text-overflow: ellipsis;
    outline: none;
    appearance: none;
  }
  .dm-hub-find > input[type='search']::-webkit-search-cancel-button {
    display: none;
  }
  .dm-hub-new {
    flex: none;
  }
  .dm-hub-b-note {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0;
    padding-top: 6px;
    color: var(--w-mute);
    font: var(--w-t-small);
  }

  /* ---------- new message, batch mode and quiet status lines ---------- */
  .dm-hub-picker {
    flex: none;
    display: grid;
    gap: 8px;
    padding: 12px 12px 14px;
    border-bottom: var(--w-bw) solid var(--w-line);
  }
  .dm-hub-picker-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-left: 8px;
  }
  .dm-hub-notice {
    margin-top: 4px;
  }
  .dm-hub-status {
    flex: none;
    margin: 0;
    padding: 10px 20px 0;
    color: var(--w-mute);
    font: var(--w-t-small);
  }
  .dm-hub-batch {
    flex: none;
    display: grid;
    gap: 10px;
    padding: 12px 20px;
    border-bottom: var(--w-bw) solid var(--w-line);
  }
  .dm-hub-batch-text {
    margin: 0;
    color: var(--w-mute);
    font: var(--w-t-small);
    text-wrap: pretty;
  }
  .dm-hub-batch-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  /* ---------- the list: 52px rows on the selection grammar ---------- */
  .dm-hub-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 8px 0 16px;
  }
  .dm-hub-scroll :global(.dm-hub-empty) {
    padding: 32px 20px;
  }
  .dm-hub-conversation {
    --dm-hub-surface: var(--w-bg);
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
    align-items: center;
    column-gap: 12px;
    box-sizing: border-box;
    width: calc(100% - 16px);
    min-height: 52px;
    margin: 0 8px;
    padding: 6px 12px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--w-text);
    font: inherit;
    text-align: start;
    cursor: pointer;
    transition: background-color var(--w-dur-1) var(--w-ease), box-shadow var(--w-dur-1) var(--w-ease);
  }
  .dm-hub-conversation:has(.dm-hub-check) {
    grid-template-columns: 16px 32px minmax(0, 1fr);
  }
  .dm-hub-conversation:hover {
    --dm-hub-surface: color-mix(in srgb, var(--w-raise) 70%, var(--w-bg));
    background: color-mix(in srgb, var(--w-raise) 70%, transparent);
  }
  .dm-hub-conversation.active {
    --dm-hub-surface: var(--w-raise);
    background: var(--w-raise);
  }
  .dm-hub-conversation:focus-visible {
    outline: 2px solid var(--w-accent);
    outline-offset: -2px;
  }
  :global(:root[data-char='contrast']) .dm-hub-conversation:not(.active):hover {
    --dm-hub-surface: var(--w-bg);
    background: transparent;
  }
  :global(:root[data-char='contrast']) .dm-hub-conversation:hover,
  :global(:root[data-char='contrast']) .dm-hub-conversation.active {
    box-shadow: inset 0 0 0 1px var(--w-line-strong);
  }

  .dm-hub-avatar-wrap {
    position: relative;
    display: block;
    width: 32px;
    height: 32px;
  }
  .dm-hub-avatar-wrap :global(.dm-hub-stamp),
  .dm-hub-stamp {
    display: grid;
    place-items: center;
    box-sizing: border-box;
    width: 32px;
    height: 32px;
    border-radius: var(--w-avr);
    background: var(--disc, var(--w-raise));
    color: var(--on, var(--w-text));
    font: 600 calc(14px * var(--w-fs)) / 1 var(--w-serif);
    object-fit: cover;
    user-select: none;
  }
  .dm-hub-status-dot {
    position: absolute;
    right: -2px;
    bottom: -2px;
    box-sizing: border-box;
    width: 10px;
    height: 10px;
    border-radius: var(--w-avr);
    background: var(--w-online);
    box-shadow: 0 0 0 2px var(--dm-hub-surface);
  }
  .dm-hub-status-dot[data-presence='away'] {
    background: var(--w-warn);
  }
  .dm-hub-status-dot[data-presence='busy'] {
    background: var(--w-danger);
  }

  .dm-hub-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .dm-hub-top,
  .dm-hub-bottom {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .dm-hub-name {
    display: flex;
    flex: 0 1 auto;
    align-items: center;
    min-width: 0;
    height: calc(20px * var(--w-fs));
    overflow: hidden;
    font: var(--w-t-label);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .dm-hub-conversation.unread .dm-hub-name {
    font-weight: 700;
  }
  .dm-hub-time {
    flex: none;
    margin-left: auto;
    color: var(--w-faint);
    font: var(--w-t-micro);
    font-variant-numeric: tabular-nums;
  }
  .dm-hub-preview {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--w-faint);
    font: var(--w-t-small);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .dm-hub-conversation.unread .dm-hub-preview {
    color: var(--w-mute);
  }
  .dm-hub-badge {
    flex: none;
  }

  /* Phones and coarse pointers: 44px targets, 56px rows; the masthead keeps its 96px rule. */
  @media (pointer: coarse) {
    .dm-hub-conversation {
      min-height: 56px;
    }
  }
  @media (max-width: 768px) {
    .dm-hub-mast {
      padding: 0 16px;
    }
    .dm-hub-title {
      font: 600 calc(20px * var(--w-fs)) / calc(26px * var(--w-fs)) var(--w-serif);
    }
    .dm-hub-seg > :global(button) {
      height: 36px;
      padding: 0 12px;
    }
    .dm-hub-b {
      align-items: center;
      height: auto;
      min-height: var(--w-head-b);
      padding-bottom: 4px;
    }
    .dm-hub-find,
    .dm-hub-new :global(.w-btn) {
      height: 36px;
    }
    .dm-hub-mast {
      height: auto;
      min-height: var(--w-mast);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dm-hub-conversation {
      transition: none;
    }
  }
</style>
