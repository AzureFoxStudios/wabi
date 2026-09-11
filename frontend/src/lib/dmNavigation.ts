import type { Channel } from './socket-types';
import { selectedDmChannelId, dmOtherUser, selectedGroupChannel } from './layoutStoreStates';
import { openRightPanel } from './layoutStoreRightPanel';

/** Open a persisted group in the side panel, preserving the complete channel.
 * Navigation selects a conversation; it does not infer members or create one.
 * Keep this explicit so callers cannot confuse a group channel with a user list.
 */
export function openRightGroupDm(channel: Channel): void {
  if (channel.type !== 'group') throw new TypeError('Expected a group conversation.');
  dmOtherUser.set(null);
  selectedGroupChannel.set(channel);
  selectedDmChannelId.set(channel.id);
  openRightPanel('dms');
}
