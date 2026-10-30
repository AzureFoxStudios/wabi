<!--
  A DM or group conversation on center stage (design contract §7.23 DM row, §8.10).
  - Masthead 96 (the shared rule at y = 96, level with the DMs hub): row A is back, the avatar
    28, the name in --w-t-title and the seal chip (PrivacyBadge, which owns every privacy word),
    then call, video and "Move to side panel"; row B is presence or the members, then the
    conversation's tools: Turn on experimental encryption (when it can start), the message
    lifetime menu ("Kept 24 hours") and Shared notes / Group settings. Phones keep one 52px bar;
    row B's tools move into its ⋯ sheet, where the lifetime is one row that opens its own sheet.
  - Stream and composer as in chat. While sending is paused the composer is replaced by one row
    that names the state and the one thing to do (lib/dm/dmConversationCopy.ts); a failed request
    is a notice in plain words, never the raw error and never "E2EE".
  - StageBar is not mounted over the DM split layout (MainLayout), so this view draws its own
    row A with the same type and kit instead of calling setStageHeader.
-->
<script lang="ts">
  import { afterUpdate, onMount, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { layoutStore } from '$lib/layoutStore';
  import { selectedDmChannelId, dmOtherUser, isMobile } from '$lib/layoutStoreStates';
  import { channelMessages, channelHasMoreHistory, channelHistoryLoading, currentUser, channels, users, serverMembers, connected, getSocket, joinChannel, loadHistory, loadOlderHistory, markChannelAsRead, sendMessage, socket, updateChannelSettings } from '$lib/socket';
  import { normalizeMessageRetentionDuration } from '../../../../shared/messageRetention.js';
  import { brandName } from '$lib/branding';
  import { callMode, incomingCall, isInCall, outgoingCall } from '$lib/callingStateStores';
  import { startCall, startGroupCall, type GroupCallRingingTarget } from '$lib/calling';
  import { getUserIdentityKey } from '$lib/localNicknames';
  import { showToast } from '$lib/toast';
  import { inkFor } from '$lib/theme/identity';
  import { dmCallStartError, dmEncryptionError, dmGateActionView, dmRetentionChoice, dmRetentionControlLabel, dmRetentionOptions, dmRetentionPhrase, dmSendGate, type DmActionError, type DmEncryptionAction, type DmSendGateActionId } from '$lib/dm/dmConversationCopy';
  import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
  import Icon from '$lib/components/ui/Icon.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import PrivacyBadge from './PrivacyBadge.svelte';
  import GroupAvatar from './GroupAvatar.svelte';
  import ChatComposer from './chat/ChatComposer.svelte';
  import ChatMessagesPane from './chat/ChatMessagesPane.svelte';
  import GroupSettingsPanel from './GroupSettingsPanel.svelte';
  import SharedConversationNotes from './SharedConversationNotes.svelte';
  import { formatTypingUsers } from './chat/typing';
  import { channelPaneInTransition, channelPaneOutTransition } from './chat/transitions';
  import { filterMessages } from './chat/search';
  import type { Channel, Message, User } from '$lib/socket-types';
  import { resolveDmOtherUser } from '$lib/dmConversations';
  import { groupRecipientSummary, livePresenceForUser, missingDeviceParticipantLabel } from '$lib/dmPresentation';
  import { pushLocalDirectionsCard } from '$lib/directionsAssist';
  import { mediaUrl } from '$lib/mediaUrl';
  import ProfileMedia from './ProfileMedia.svelte';
  import { cachedE2eeStatus, chooseServerReadable, prepareNewConversationEncryption, rekeyE2ee, turnOnE2ee } from '$lib/dm/dmE2eeState';
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
  $: recipientPresence = isGroup ? 'unavailable' : livePresenceForUser(otherUser, $users, $connected);
  $: recipientPresenceLabel = recipientPresence === 'active' ? 'Online' : recipientPresence === 'away' ? 'Away' : recipientPresence === 'busy' ? 'Busy' : recipientPresence === 'offline' ? 'Offline' : '';
  $: groupParticipants = groupRecipientSummary(channel, $currentUser, [...$serverMembers, ...$users]);
  $: missingDeviceLabel = missingDeviceParticipantLabel(e2eeStatus?.missingUserIds || [], [...$serverMembers, ...$users]);
  $: if (channelId && channelId !== lastJoinedChannelId) {
    lastJoinedChannelId = channelId;
    showGroupSettings = false;
    showNotes = false;
    notesMounted = false;
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
  $: selectedRetention = dmRetentionChoice(channel);
  // The control shows the server-confirmed lifetime: a choice that fails to save snaps back.
  let retentionValue = '';
  $: retentionValue = selectedRetention;
  $: retentionWords = dmRetentionPhrase(retentionValue);
  // The popover's Kept fact only when the room says (never a guessed default).
  $: retentionKnown = Boolean(channel) && channel?.autoDeleteAfter !== undefined;
  $: retentionPolicy = retentionKnown ? (selectedRetention || 'forever') : null;
  const retentionOptions = dmRetentionOptions();

  async function setRetention(value: string): Promise<void> {
    if (!channelId || !channel || value === retentionValue) return;
    retentionValue = value;
    await updateChannelSettings(channelId, { autoDeleteAfter: normalizeMessageRetentionDuration(value) });
    await tick();
    retentionValue = dmRetentionChoice(get(channels).find((entry) => entry.id === channelId) ?? channel);
  }

  // "Keep new messages for": one radio menu, the same rows on desktop and in the phone sheet.
  let retentionItems: MenuEntry[] = [];
  $: retentionItems = retentionOptions.map((option) => ({
    id: `kept-${option.value || 'forever'}`,
    label: option.label,
    role: 'menuitemradio',
    checked: option.value === retentionValue,
    keepCase: true,
    onSelect: () => void setRetention(option.value)
  }) as MenuEntry);

  // Phones: the ⋯ sheet has one "Kept 24 hours" row that opens the choices as their own sheet.
  let headerActions: HTMLDivElement | undefined;
  let keptSheetAnchor: HTMLElement | null = null;
  let keptSheetOpen = false;

  function openKeptSheet(): void {
    keptSheetAnchor = headerActions?.querySelector<HTMLElement>('.dm-header-more') ?? headerActions ?? null;
    // After the ⋯ sheet has closed and handed focus back, so the two sheets never overlap.
    window.setTimeout(() => {
      keptSheetOpen = true;
    }, 0);
  }

  $: phone = $isMobile;

  let replyingTo: Message | null = null;
  let composerVisible = true;
  let isTextareaFocused = false;
  let chatContainer: HTMLDivElement | undefined;
  let chatComposer: ChatComposer;
  let followLatest = true;
  let showJumpToLatest = false;
  let lastMessageKey = '';
  let showGroupSettings = false;
  let showNotes = false;
  let notesMounted = false;
  let olderAnchor: { channelId: string; firstId: string; height: number; top: number } | null = null;

  // ── E2EE conversation state ──────────────────────────────────────────────
  let e2eeStatus: E2eeRoomStatus | null = null;
  let e2eeBusy = false;
  let e2eeChecking = false;
  let e2eeError: DmActionError | null = null;

  $: e2eeEnabled = !!e2eeStatus?.enabled;
  $: sendGate = dmSendGate(e2eeStatus, missingDeviceLabel);
  // An older server-readable room (or one this member chose server-readable) whose devices are
  // all ready can start experimental encryption for new messages.
  $: canEncrypt = Boolean(e2eeStatus && !e2eeStatus.enabled && !e2eeStatus.pendingDefault && e2eeStatus.missingUserIds.length === 0 && (!e2eeStatus.serverReadableSelected || e2eeStatus.serverReadableAllowedByMe));
  $: waitingForDevices = Boolean(e2eeStatus && !e2eeStatus.enabled && !e2eeStatus.pendingDefault && !e2eeStatus.serverReadableSelected && e2eeStatus.missingUserIds.length > 0);

  /** Plain words on screen; the raw cause goes to the log only. */
  function failed(action: DmEncryptionAction, error: unknown): DmActionError {
    if (error) console.warn(`[DM] ${action} failed:`, error);
    return dmEncryptionError(action, error);
  }

  function runGateAction(id: DmSendGateActionId): void {
    if (id === 'rekey') void updateEncryptionKeys();
    else if (id === 'server-readable') void useServerReadable();
    else void loadE2eeStatus(channelId);
  }

  // Both flags are named here, so the buttons re-render when a request ends or fails.
  $: gateActions = (sendGate?.actions ?? []).map((action) => dmGateActionView(action, { checking: e2eeChecking, busy: e2eeBusy }));

  async function loadE2eeStatus(targetChannelId: string | null): Promise<void> {
    if (!targetChannelId) {
      e2eeStatus = null;
      return;
    }
    e2eeStatus = cachedE2eeStatus(targetChannelId) ?? null;
    e2eeChecking = true;
    try {
      const status = await prepareNewConversationEncryption(targetChannelId);
      if (channelId === targetChannelId) {
        e2eeStatus = status;
        e2eeError = null;
      }
    } catch (error) {
      if (channelId === targetChannelId) e2eeError = failed('check', error);
    } finally {
      if (channelId === targetChannelId) e2eeChecking = false;
    }
  }

  async function useServerReadable(): Promise<void> {
    if (!channelId || e2eeBusy) return;
    const targetChannelId = channelId;
    e2eeBusy = true;
    e2eeError = null;
    try {
      const status = await chooseServerReadable(targetChannelId);
      if (channelId === targetChannelId) e2eeStatus = status;
    } catch (error) {
      if (channelId === targetChannelId) e2eeError = failed('server-readable', error);
    } finally {
      e2eeBusy = false;
    }
  }

  async function updateEncryptionKeys(): Promise<void> {
    if (!channelId || e2eeBusy) return;
    const targetChannelId = channelId;
    e2eeBusy = true;
    e2eeError = null;
    try {
      const status = await rekeyE2ee(targetChannelId);
      if (channelId === targetChannelId) {
        if (status) e2eeStatus = status;
        else e2eeError = failed('rekey', null);
      }
    } catch (error) {
      if (channelId === targetChannelId) e2eeError = failed('rekey', error);
    } finally {
      e2eeBusy = false;
    }
  }

  async function enableE2ee(): Promise<void> {
    if (!channelId || e2eeBusy) return;
    const targetChannelId = channelId;
    e2eeBusy = true;
    e2eeError = null;
    try {
      const status = await turnOnE2ee(targetChannelId);
      if (channelId !== targetChannelId) return;
      if (!status) {
        e2eeError = failed('enable', null);
        return;
      }
      e2eeStatus = status;
    } catch (error) {
      if (channelId === targetChannelId) e2eeError = failed('enable', error);
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
    let observedSocket: ReturnType<typeof getSocket> = null;
    const onEncryptionUpdate = (payload: { channelId?: string }) => {
      if (payload?.channelId === channelId) void loadE2eeStatus(channelId);
    };
    const bindSocket = () => {
      const next = getSocket();
      if (next === observedSocket) return;
      observedSocket?.off('e2ee-room-updated', onEncryptionUpdate);
      observedSocket = next;
      observedSocket?.on('e2ee-room-updated', onEncryptionUpdate);
      if (next && channelId) void loadE2eeStatus(channelId);
    };
    const onFocus = () => { if (channelId) void loadE2eeStatus(channelId); };
    window.addEventListener('focus', onFocus);
    bindSocket();
    const poll = window.setInterval(() => {
      bindSocket();
      if (channelId && e2eeStatus && !e2eeStatus.enabled && !e2eeStatus.serverReadableSelected && !e2eeChecking && !e2eeBusy) void loadE2eeStatus(channelId);
    }, 5000);
    return () => {
      document.removeEventListener('visibilitychange', markVisibleMessagesRead);
      window.removeEventListener('focus', onFocus);
      observedSocket?.off('e2ee-room-updated', onEncryptionUpdate);
      window.clearInterval(poll);
    };
  });

  async function handleClose() {
    if (showNotes) {
      showNotes = false;
      return;
    }
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

  function toggleSharedNotes(): void {
    showNotes = !showNotes;
    if (showNotes) {
      notesMounted = true;
      showGroupSettings = false;
    }
  }

  function toggleGroupSettings(): void {
    showGroupSettings = !showGroupSettings;
    if (showGroupSettings) showNotes = false;
  }

  // ── Calls (the same paths as the DMs companion) ──────────────────────────
  // A direct call (or one ringing out) is said in the header; any direct or group call, or one
  // ringing in, blocks a new one (startCall refuses it). A voice room does not.
  $: callActive = ($isInCall && $callMode === 'direct') || Boolean($outgoingCall);
  $: callBlocked = callActive || Boolean($incomingCall) || ($isInCall && $callMode === 'group');
  $: callWord = callActive ? (Boolean($outgoingCall) && !$isInCall ? 'Calling…' : 'Call active') : '';
  $: callBlockedWord = callBlocked ? (callWord || 'Another call is on') : '';
  $: callTarget = isGroup ? (channel?.name || 'the group') : channelDisplayName;
  $: canCall = Boolean($socket) && (isGroup ? channel?.type === 'group' : Boolean(otherUser));

  async function startConversationCall(withVideo: boolean): Promise<void> {
    const live = $socket;
    if (!live || callBlocked) return;
    try {
      if (isGroup && channel) {
        const myStableId = $currentUser?.dbUserId ? `user-${$currentUser.dbUserId}` : $currentUser?.id;
        const invitees = new Map<string, GroupCallRingingTarget>();
        for (const memberId of channel.members || []) {
          if (!memberId || memberId === myStableId) continue;
          if (memberId.startsWith('user-')) {
            const dbUserId = Number.parseInt(memberId.substring(5), 10);
            const member = [...$users, ...$serverMembers].find((u) => u.dbUserId === dbUserId);
            invitees.set(memberId, { stableUserId: memberId, username: member?.username || 'Member' });
            continue;
          }
          const member = [...$users, ...$serverMembers].find((u) => u.id === memberId);
          if (member) {
            const stableUserId = typeof member.dbUserId === 'number' ? `user-${member.dbUserId}` : member.id;
            invitees.set(stableUserId, { stableUserId, username: member.username });
          }
        }
        await startGroupCall(live, channel.id, channel.name || 'Group', withVideo, {
          localDisplayName: $currentUser?.username || `${brandName} User`,
          invitees: Array.from(invitees.values())
        });
      } else if (otherUser) {
        await startCall(live, getUserIdentityKey(otherUser), withVideo, { scope: 'dm', displayName: otherUser.username });
      }
    } catch (error) {
      console.warn(`[Call] ${isGroup ? 'group' : 'DM'} ${withVideo ? 'video' : 'voice'} call failed to start:`, error);
      showToast(dmCallStartError(error, withVideo), 'error');
    }
  }

  // Phones keep one bar: row B's tools and the calls move into ⋯.
  let phoneMenuItems: MenuEntry[] = [];
  $: phoneMenuItems = [
    ...(canCall
      ? [
          { id: 'voice', label: `Call ${callTarget}`, icon: 'phone', keepCase: true, disabled: callBlocked, hint: callBlockedWord || undefined, onSelect: () => void startConversationCall(false) },
          { id: 'video', label: `Video call ${callTarget}`, icon: 'video', keepCase: true, disabled: callBlocked, hint: callBlockedWord || undefined, onSelect: () => void startConversationCall(true) }
        ] as MenuEntry[]
      : []),
    { id: 'notes', label: showNotes ? 'Back to messages' : 'Shared notes', icon: 'note', onSelect: toggleSharedNotes },
    ...(isGroup ? [{ id: 'group', label: showGroupSettings ? 'Back to group messages' : 'Group settings', icon: 'users', onSelect: toggleGroupSettings } as MenuEntry] : []),
    ...(canEncrypt ? [{ id: 'encrypt', label: e2eeBusy ? 'Turning on…' : 'Turn on experimental encryption', icon: 'lock', seal: true, disabled: e2eeBusy, keepCase: true, onSelect: () => void enableE2ee() } as MenuEntry] : []),
    ...(channelId && channel
      ? [{ id: 'kept', label: retentionWords, icon: 'clock', keepCase: true, hint: 'Change', onSelect: openKeptSheet } as MenuEntry]
      : [])
  ];
</script>

<div class="dm-conversation" class:phone>
  <header class="dm-header" class:dm-header--phone={phone}>
    <div class="dm-header-a">
      <Tooltip text={context === 'center' ? 'Back to conversations' : 'Close DM'} placement="bottom">
        <button type="button" class="w-ibtn dm-header-back" on:click={handleClose} aria-label={context === 'center' ? 'Back to conversations' : 'Close DM'}>
          <Icon name="chevLeft" />
        </button>
      </Tooltip>
      <span class="dm-header-lead">
        {#if isGroup && channel}
          <span class="dm-header-avatar dm-header-avatar--group" aria-hidden="true"><GroupAvatar {channel} size={28} /></span>
        {:else if otherUser?.profilePicture}
          <ProfileMedia class="dm-header-avatar" src={mediaUrl(otherUser.profilePicture)} decorative />
        {:else}
          <span class="dm-header-avatar dm-header-avatar--stamp" style={$inkFor(otherUser?.roleColor || otherUser?.color)} aria-hidden="true">{channelDisplayName.charAt(0).toUpperCase()}</span>
        {/if}
        <h2 class="dm-header-name">
          {channelDisplayName}
        </h2>
        <PrivacyBadge
          variant="popover-trigger"
          input={{ channelType: isGroup ? 'group' : 'dm', policy: e2eeStatus }}
          retention={retentionPolicy}
          showRetention={false}
          room={channelDisplayName}
          placement="bottom"
          class="dm-header-seal"
        />
      </span>
      <div class="dm-header-actions" bind:this={headerActions}>
        {#if callActive && !phone}
          <span class="w-tag dm-header-call" role="status" aria-live="polite"><span class="w-dot w-dot--online"></span>{callWord}</span>
        {/if}
        {#if phone}
          <Menu
            items={phoneMenuItems}
            label="Conversation actions"
            triggerLabel="Conversation actions"
            class="w-ibtn dm-header-more"
            align="end"
            heading={channelDisplayName}
            subheading={isGroup ? groupParticipants || null : [recipientPresenceLabel, otherUser?.handle ? `@${otherUser.handle}` : ''].filter(Boolean).join(' · ') || null}
          >
            <Icon name="more" />
          </Menu>
        {:else}
          {#if canCall}
            <Tooltip text={callBlockedWord ? `Call ${callTarget} · ${callBlockedWord}` : `Call ${callTarget}`} placement="bottom">
              <button type="button" class="w-ibtn" aria-label={`Call ${callTarget}`} disabled={callBlocked} on:click={() => void startConversationCall(false)}><Icon name="phone" /></button>
            </Tooltip>
            <Tooltip text={callBlockedWord ? `Video call ${callTarget} · ${callBlockedWord}` : `Video call ${callTarget}`} placement="bottom">
              <button type="button" class="w-ibtn" aria-label={`Video call ${callTarget}`} disabled={callBlocked} on:click={() => void startConversationCall(true)}><Icon name="video" /></button>
            </Tooltip>
          {/if}
          <Tooltip text={context === 'right' ? 'Open in center stage' : 'Move to side panel'} placement="bottom">
            <button type="button" class="w-ibtn" aria-label={context === 'right' ? 'Open in center stage' : 'Move to side panel'} on:click={handleToggleSurface}>
              <Icon name={context === 'right' ? 'expand' : 'sidebarRight'} />
            </button>
          </Tooltip>
        {/if}
      </div>
    </div>
    {#if !phone}
      <div class="dm-header-b">
        <p class="dm-header-sub">
          {#if isGroup}
            <span class="dm-header-kind">Group</span>
            <span class="dm-header-detail" title={groupParticipants}>{groupParticipants || ((channel?.members?.length || channel?.memberUsers?.length) ? `${channel?.members?.length || channel?.memberUsers?.length} members` : 'Members loading')}</span>
          {:else if otherUser}
            {#if recipientPresenceLabel}
              <span class="dm-header-presence" data-presence={recipientPresence}><span class="dm-header-presence-dot" aria-hidden="true"></span>{recipientPresenceLabel}</span>
            {/if}
            {#if otherUser.handle}<span class="dm-header-detail">@{otherUser.handle}</span>{/if}
          {:else}
            <span class="dm-header-detail" role="status">Recipient details aren’t available. Reconnect to refresh this conversation.</span>
          {/if}
        </p>
        <div class="dm-header-tools">
          {#if canEncrypt}
            <Tooltip text="Applies to new messages. Not independently verified." placement="bottom">
              <button type="button" class="w-btn w-btn--sm dm-header-encrypt" aria-busy={e2eeBusy} disabled={e2eeBusy} on:click={() => void enableE2ee()}>
                <Icon name="lock" size={14} />{e2eeBusy ? 'Turning on…' : 'Turn on experimental encryption'}
              </button>
            </Tooltip>
          {/if}
          {#if channelId && channel}
            <Tooltip text="Applies to new messages. Earlier messages keep their own lifetime." placement="bottom">
              <Menu
                items={retentionItems}
                label="Keep new messages for"
                triggerLabel={dmRetentionControlLabel(retentionValue)}
                class="w-select dm-header-kept"
                align="end"
                heading="Keep new messages for"
              >
                <Icon name="clock" size={14} /><span class="w-select__value">{retentionWords}</span><Icon name="chevDown" size={16} />
              </Menu>
            </Tooltip>
          {/if}
          <button type="button" class="w-btn w-btn--quiet w-btn--sm dm-notes-action" aria-pressed={showNotes} on:click={toggleSharedNotes}>
            <Icon name="note" size={14} /><span class="dm-tool-label">Shared notes</span>
          </button>
          {#if isGroup}
            <button type="button" class="w-btn w-btn--quiet w-btn--sm dm-group-action" aria-pressed={showGroupSettings} on:click={toggleGroupSettings}>
              <Icon name="users" size={14} /><span class="dm-tool-label">Group settings</span>
            </button>
          {/if}
        </div>
      </div>
    {/if}
  </header>

  {#if phone && keptSheetAnchor}
    <Menu
      items={retentionItems}
      label="Keep new messages for"
      anchor={keptSheetAnchor}
      bind:open={keptSheetOpen}
      align="end"
      heading="Keep new messages for"
    />
  {/if}

  {#if waitingForDevices}
    <p class="dm-header-wait" role="status">Encryption starts when {missingDeviceLabel || 'every participant'} {missingDeviceLabel.includes(',') ? 'have' : 'has'} an updated device. Until then new messages stay server-readable.</p>
  {/if}

  <div class="dm-stream" class:hidden={showGroupSettings || showNotes}>
    <div
      class="dm-messages"
      bind:this={chatContainer}
      on:scroll={handleScroll}
    >
      {#if channelId && $channelHasMoreHistory[channelId]}
        <button type="button" class="w-btn w-btn--quiet w-btn--sm dm-load-earlier" aria-busy={$channelHistoryLoading[channelId]} disabled={$channelHistoryLoading[channelId]} on:click={loadEarlier}>
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
        emptyStateSubtitle={isGroup ? `A conversation with ${groupParticipants || 'this group'} starts here.` : `You’re messaging ${channelDisplayName}.`}
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
    {#if showJumpToLatest}
      <button type="button" class="dm-jump-latest" aria-label="Jump to the latest messages" on:click={() => void scrollToLatest()}>
        Latest<Icon name="chevDown" size={16} />
      </button>
    {/if}
  </div>

  {#if showGroupSettings && isGroup && channel}
    <div class="dm-group-settings" aria-label="Group settings"><GroupSettingsPanel {channel} /></div>
  {/if}

  {#if notesMounted && channelId}
    <div class="dm-shared-notes" class:hidden={!showNotes} aria-label="Shared conversation notes"><SharedConversationNotes {channelId} surface="center" /></div>
  {/if}

  <div class="dm-composer" class:hidden={showGroupSettings || showNotes} class:gated={Boolean(sendGate)}>
    {#if e2eeError && !(sendGate?.kind === 'checking' && e2eeError.action === 'check')}
      <div class="w-notice dm-notice" role="alert">
        <Icon name="alert" size={16} />
        <p class="w-notice__title">{e2eeError.title}</p>
        <p class="w-notice__text">{e2eeError.text}</p>
        <div class="w-notice__actions">
          <button type="button" class="w-ibtn w-ibtn--sm" aria-label="Dismiss" on:click={() => (e2eeError = null)}><Icon name="x" size={16} /></button>
        </div>
      </div>
    {/if}
    {#if !sendGate}
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
    {:else}
      {@const failedCheck = sendGate.kind === 'checking' && e2eeError?.action === 'check' ? e2eeError : null}
      <div class="w-notice dm-gate" class:w-notice--info={!failedCheck} class:dm-gate--failed={failedCheck} role={failedCheck ? 'alert' : 'status'} data-gate={sendGate.kind}>
        <Icon name={failedCheck ? 'alert' : sendGate.glyph} size={16} />
        <p class="w-notice__title">{failedCheck ? failedCheck.title : sendGate.title}</p>
        <p class="w-notice__text">{#if failedCheck}{failedCheck.text}{:else}{sendGate.text}{#if sendGate.detail} <span class="dm-gate-detail">{sendGate.detail}</span>{/if}{/if}</p>
        <div class="w-notice__actions">
          {#each gateActions as action (action.id)}
            <button
              type="button"
              class="w-btn w-btn--sm"
              aria-busy={action.busy}
              disabled={action.busy}
              on:click={() => runGateAction(action.id)}
            >{action.label}</button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* DM / group conversation on center stage (§7.23 DM row, §8.10). Roles, type tokens, kit. */
  .dm-conversation {
    position: relative;
    display: flex;
    container: dm-conversation / inline-size;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--w-bg);
    color: var(--w-text);
  }

  /* ---------- masthead: row A 56 + row B 40, one hairline at y = --w-mast ---------- */
  .dm-header {
    flex: none;
    display: grid;
    grid-template-rows: var(--w-head-a) var(--w-head-b);
    box-sizing: border-box;
    height: var(--w-mast);
    padding: 0 var(--w-gutter, 32px) 0 calc(var(--w-gutter, 32px) - 10px);
    border-bottom: var(--w-bw) solid var(--w-line);
    background: var(--w-bg);
  }
  .dm-header-a {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .dm-header-lead {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 10px;
    min-width: 0;
    /* The seal chip's focus ring stays clear of the clip. */
    margin: -4px;
    padding: 4px;
    overflow: hidden;
  }
  .dm-header-back {
    flex: none;
  }
  .dm-header-lead :global(.dm-header-avatar),
  .dm-header-avatar {
    flex: none;
    box-sizing: border-box;
    width: 28px;
    height: 28px;
    border-radius: var(--w-avr);
    object-fit: cover;
  }
  .dm-header-avatar--stamp {
    display: grid;
    place-items: center;
    background: var(--disc, var(--w-raise));
    color: var(--on, var(--w-text));
    font: 600 calc(12px * var(--w-fs)) / 1 var(--w-serif);
  }
  .dm-header-avatar--group {
    display: grid;
    place-items: center;
    overflow: hidden;
  }
  .dm-header-name {
    flex: 0 1 auto;
    min-width: min(96px, 100%);
    margin: 0;
    overflow: hidden;
    color: var(--w-text);
    font: var(--w-t-title);
    letter-spacing: 0.005em;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .dm-header-lead :global(.dm-header-seal) {
    flex: none;
  }
  .dm-header-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
    margin-inline-start: auto;
  }
  .dm-header-call {
    margin-inline-end: 4px;
  }

  .dm-header-b {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    min-width: 0;
    padding-left: 10px;
  }
  .dm-header-sub {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 12px;
    min-width: 0;
    height: 28px;
    margin: 0;
    overflow: hidden;
    color: var(--w-mute);
    font: var(--w-t-small);
    white-space: nowrap;
  }
  .dm-header-kind {
    flex: none;
    color: var(--w-faint);
    font: var(--w-t-kicker);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .dm-header-detail {
    min-width: 0;
    overflow: hidden;
    color: var(--w-faint);
    font: var(--w-t-mono);
    text-overflow: ellipsis;
  }
  .dm-header-kind + .dm-header-detail {
    font: var(--w-t-small);
  }
  .dm-header-presence {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 6px;
  }
  .dm-header-presence-dot {
    width: 7px;
    height: 7px;
    border-radius: var(--w-avr);
    box-shadow: inset 0 0 0 1.5px var(--w-faint);
  }
  .dm-header-presence[data-presence='active'] .dm-header-presence-dot {
    background: var(--w-online);
    box-shadow: none;
  }
  .dm-header-presence[data-presence='away'] .dm-header-presence-dot {
    background: var(--w-warn);
    box-shadow: none;
  }
  .dm-header-presence[data-presence='busy'] .dm-header-presence-dot {
    background: var(--w-danger);
    box-shadow: none;
  }
  .dm-header-tools {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    height: 28px;
  }
  .dm-header-tools :global(.dm-header-kept) {
    height: 28px;
    font: var(--w-t-caption);
    cursor: pointer;
  }
  .dm-header-tools :global(.w-btn[aria-pressed='true']) {
    background: var(--w-raise);
    color: var(--w-text);
  }
  .dm-header-encrypt :global(svg) {
    color: var(--w-seal);
  }
  .dm-header-wait {
    flex: none;
    margin: 0;
    padding: 8px var(--w-gutter, 32px);
    border-bottom: var(--w-bw) solid var(--w-line);
    color: var(--w-mute);
    font: var(--w-t-small);
  }

  /* Phones: one 52px bar (§8.12); the tools are in ⋯. */
  .dm-header--phone {
    display: flex;
    align-items: center;
    height: auto;
    min-height: 52px;
    padding: env(safe-area-inset-top, 0px) 4px 0 4px;
  }
  .dm-header--phone .dm-header-a {
    flex: 1 1 auto;
    height: 52px;
  }
  .dm-header--phone .dm-header-name {
    font: 600 calc(20px * var(--w-fs)) / calc(26px * var(--w-fs)) var(--w-serif);
  }
  .dm-header--phone .dm-header-back,
  .dm-header--phone :global(.dm-header-more) {
    width: 44px;
    height: 44px;
  }
  .dm-header--phone .dm-header-lead {
    gap: 8px;
  }

  /* Below a 640px stage the presence line gives way to the tools; the words stay in ⋯ on phones.
     Below 720px, Shared notes and Group settings keep their glyph and say their name to
     assistive tech only, so the lifetime and encryption words never have to shrink. */
  @container dm-conversation (max-width: 639.98px) {
    .dm-header-sub {
      display: none;
    }
    .dm-header-b {
      justify-content: flex-end;
    }
  }
  @container dm-conversation (max-width: 719.98px) {
    .dm-tool-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .dm-notes-action,
    .dm-group-action {
      width: 28px;
      padding: 0;
      justify-content: center;
    }
  }

  /* ---------- stream ---------- */
  .dm-stream {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }
  .dm-messages {
    flex: 1 1 auto;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
  .dm-stream.hidden,
  .dm-composer.hidden,
  .dm-shared-notes.hidden {
    display: none;
  }
  .dm-group-settings,
  .dm-shared-notes {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .dm-load-earlier {
    display: flex;
    margin: 8px auto 12px;
  }
  .dm-jump-latest {
    position: absolute;
    right: var(--w-gutter, 32px);
    bottom: 12px;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    box-sizing: border-box;
    height: 32px;
    padding: 0 10px 0 14px;
    border: var(--w-bw) solid var(--w-line-strong);
    border-radius: var(--w-pill);
    background: var(--w-bg2);
    box-shadow: var(--w-shadow);
    color: var(--w-text);
    font: var(--w-t-label-sm);
    cursor: pointer;
  }
  .dm-jump-latest:hover {
    background: var(--w-raise);
  }
  .dm-jump-latest:focus-visible {
    outline: 2px solid var(--w-accent);
    outline-offset: 2px;
  }

  /* ---------- composer, or the row that says why sending is paused ---------- */
  .dm-composer {
    flex: none;
    min-width: 0;
  }
  /* The paused row stands in the 80px footer band with its top edge on the footer rule (D21),
     like the composer field it replaces; taller words grow it upward. */
  .dm-composer.gated {
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    box-sizing: border-box;
    min-height: var(--w-foot, 80px);
  }
  .dm-gate,
  .dm-notice {
    margin: 0 var(--w-gutter, 32px) 12px;
  }
  .dm-notice {
    margin-top: 8px;
  }
  .dm-gate {
    min-height: 52px;
  }
  /* The glyph is about who can read the conversation: the seal, never a warning colour. */
  .dm-gate > :global(svg:first-child) {
    color: var(--w-seal);
  }
  .dm-gate--failed > :global(svg:first-child) {
    color: var(--w-danger);
  }
  .dm-gate-detail {
    color: var(--w-faint);
  }
  /* A narrow stage puts the actions under the words instead of squeezing them. */
  @container dm-conversation (max-width: 559.98px) {
    .dm-gate :global(.w-notice__actions) {
      grid-column: 2 / span 2;
      grid-row: auto;
      justify-self: start;
      margin-top: 8px;
    }
    .dm-gate,
    .dm-notice {
      margin-inline: 16px;
    }
    .dm-jump-latest {
      right: 16px;
    }
  }

  /* Touch and the phone shell: every target in the row reaches 44px. */
  @media (pointer: coarse) {
    .dm-gate :global(.w-btn),
    .dm-notice :global(.w-ibtn) {
      min-height: 44px;
    }
  }
  .phone .dm-gate :global(.w-btn) {
    height: 44px;
  }
  .phone .dm-notice :global(.w-ibtn) {
    width: 44px;
    height: 44px;
  }
</style>
