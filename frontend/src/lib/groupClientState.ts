import { get, type Writable } from 'svelte/store';
import { groupMembership } from './groupAccess';
import { channels, currentChannel, channelLoadedArchives, channelAvailableArchives, channelLoadingOlder,
  _updatePinnedChannels, persistLastChannel } from './channelStore';
import { channelMessages, channelUnreadCounts, unreadCount } from './messageStore';
import { voiceChannelMembers } from './presenceStore';
import { _clearTypingUsers } from './typingStore';
import { incomingCall } from './callingStateStores';
import { selectedDmChannelId, dmOtherUser, selectedGroupChannel,
  centerDmChannelId, centerDmOtherUser, centerGroupChannel } from './layoutStoreStates';
import type { Channel } from './socket-types';
import { channelHistoryLoading, channelHasMoreHistory, channelOldestMessageId, _deletePendingHistoryRequest } from './messagePagination';

function omitChannel<T>(store: Writable<Record<string, T>>, id: string): void {
  store.update(value => { const { [id]: _removed, ...rest } = value; return rest; });
}

/** Only the affected surface is closed. A group in the right dock must not
 * close a different DM in center stage, or erase an unrelated voice roster. */
function removeGroupView(id: string): void {
  channels.update(list => list.filter(channel => channel.id !== id));
  omitChannel(channelMessages, id);
  const unread = get(channelUnreadCounts)[id] || 0;
  omitChannel(channelUnreadCounts, id);
  unreadCount.update(count => Math.max(0, count - unread));
  omitChannel(channelLoadedArchives, id);
  omitChannel(channelAvailableArchives, id);
  omitChannel(channelLoadingOlder, id);
  omitChannel(channelHistoryLoading, id);
  omitChannel(channelHasMoreHistory, id);
  omitChannel(channelOldestMessageId, id);
  _deletePendingHistoryRequest(id);
  omitChannel(voiceChannelMembers, id);
  _clearTypingUsers(id);
  if (get(incomingCall)?.channelId === id) incomingCall.set(null);
  if (get(selectedDmChannelId) === id) { selectedDmChannelId.set(null); dmOtherUser.set(null); }
  if (get(selectedGroupChannel)?.id === id) selectedGroupChannel.set(null);
  if (get(centerDmChannelId) === id) { centerDmChannelId.set(null); centerDmOtherUser.set(null); }
  if (get(centerGroupChannel)?.id === id) centerGroupChannel.set(null);
  _updatePinnedChannels();
  if (get(currentChannel) === id) {
    const remaining = get(channels);
    const fallback = remaining.find(channel => channel.type !== 'dm' && channel.type !== 'group') || remaining[0];
    currentChannel.set(fallback?.id || '');
    persistLastChannel(fallback?.id || '');
  }
}

// Registered once for the shared browser/Tauri state, not once per socket.
groupMembership.onRevoked(({ channelId }) => removeGroupView(channelId));
groupMembership.onContextChanged(previousGroups => {
  // A logout/guest transition has no new realm in which to write a tombstone,
  // but must still clear the previous account's private group surfaces.
  const old = new Set([...previousGroups, ...get(channels).filter(channel => channel.type === 'group').map(channel => channel.id)]);
  for (const id of old) removeGroupView(id);
});

export function updateGroupPanels(channel: Channel): void {
  selectedGroupChannel.update(current => current?.id === channel.id ? channel : current);
  centerGroupChannel.update(current => current?.id === channel.id ? channel : current);
}
