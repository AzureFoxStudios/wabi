<script lang="ts">
  import { layoutStore } from '$lib/layoutStore';
  import { selectedDmChannelId, dmOtherUser } from '$lib/layoutStoreStates';
  import { channelMessages, currentUser, channels, users, serverMembers, joinChannel } from '$lib/socket';
  import ChatComposer from './chat/ChatComposer.svelte';
  import ChatMessagesPane from './chat/ChatMessagesPane.svelte';
  import DmConversationHeader from './DmConversationHeader.svelte';
  import GroupSettingsPanel from './GroupSettingsPanel.svelte';
  import { formatTypingUsers } from './chat/typing';
  import { channelPaneInTransition, channelPaneOutTransition } from './chat/transitions';
  import { filterMessages } from './chat/search';
  import type { Channel, Message, User } from '$lib/socket-types';
  import { resolveDmOtherUser } from '$lib/dmConversations';
  import { dmPersonName } from '$lib/dmPresentation';

  export let context: 'center' | 'right' = 'right';
  export let channelIdProp: string | null = null;
  export let otherUserProp: User | null = null;
  export let channelProp: Channel | null = null;
  let lastJoinedChannelId = '';
  let replyingTo: Message | null = null;
  let composerVisible = true;
  let isTextareaFocused = false;
  let chatComposer: ChatComposer;
  let showGroupSettings = false;

  $: channelId = channelIdProp ?? $selectedDmChannelId;
  $: channel = channelProp ?? (channelId ? ($channels || []).find((c: Channel) => c.id === channelId) || null : null);
  $: isGroup = channel?.type === 'group';
  $: layoutOtherUser = context === 'right' ? $dmOtherUser : null;
  $: otherUser = otherUserProp ?? layoutOtherUser ?? resolveDmOtherUser(channel, $currentUser, $users, $serverMembers);
  $: if (channelId && channelId !== lastJoinedChannelId) {
    lastJoinedChannelId = channelId;
    replyingTo = null; showGroupSettings = false;
    joinChannel(channelId);
  }
  $: messages = channelId ? ($channelMessages[channelId] || []) : [];
  $: filteredMessages = filterMessages(messages, '', Number.POSITIVE_INFINITY);
  $: pinnedMessages = messages.filter((m: Message) => m.isPinned);
  $: channelDisplayName = isGroup ? (channel?.name || 'Group message') : dmPersonName(otherUser);

  function handleReply(message: Message) { replyingTo = message; }
  function handleClose() { if (context === 'center') layoutStore.closeCenterDm(); else layoutStore.closeDM(); }
</script>

<div class="dm-conversation">
  <DmConversationHeader {channel} {otherUser} {context} onBack={handleClose} onGroupSettings={isGroup ? () => showGroupSettings = !showGroupSettings : undefined} groupSettingsOpen={showGroupSettings} />
  {#if showGroupSettings && channel}<div class="dm-messages"><GroupSettingsPanel {channel} /></div>{:else}
  <div class="dm-messages">
    <ChatMessagesPane
      currentChannel={channelId || ''} searchInput="" {channelDisplayName} {filteredMessages} {pinnedMessages}
      firstUnreadMessageId={null} channelPaneAnimation={{ enabled: false, preset: 'slip', duration: 120, distance: 18 }}
      searchBackfillBusy={false} currentChannelPersistMessages={false} isFullHistorySearchRunning={false}
      fullHistorySearchPagesLoaded={0} fullHistorySearchStatus="" visibleTypingUsers={[]}
      emptyStateIcon={isGroup ? '👥' : '💬'}
      emptyStateSubtitle={isGroup ? 'Messages in this group appear here.' : 'Messages in this conversation appear here.'}
      emptyStateActionLabel="Send a message" {channelPaneInTransition} {channelPaneOutTransition}
      formatTypingUsers={(typing: string[]) => formatTypingUsers(typing)}
      onSearchCurrentQueryInBrowser={() => {}} onToggleFullHistorySearchBackfill={() => {}}
      onReply={handleReply} onQuickMention={() => {}} onOpenSettings={() => {}}
    />
  </div>
  <div class="dm-composer">
    {#key `${context}:${$currentUser?.dbUserId || $currentUser?.id || ''}:${channelId}`}
      <ChatComposer bind:this={chatComposer} isDMChannel={true} {channelId} draftSurface={`dm-${context}`} paymentButtonEnabled={false}
        bind:replyingTo bind:composerVisible bind:isTextareaFocused onExecuteCommand={async (_cmd: string) => {}} onOpenPaymentSheet={() => {}} />
    {/key}
  </div>
  {/if}
</div>

<style>
  .dm-conversation { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; overflow:hidden; background:var(--surface-base, #111b20); }
  .dm-messages { flex:1; overflow-y:auto; overflow-x:hidden; min-height:0; overscroll-behavior:contain; }
  .dm-composer { flex-shrink:0; border-top:1px solid var(--color-border-primary, #334047); }
</style>
