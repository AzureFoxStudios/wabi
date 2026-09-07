/** Membership is an online, versioned command, never a replay of old UI intent. */
export const GROUP_QUEUE_ACTIONS = new Set([
  'create-group', 'leave-group', 'kick-group-member', 'add-group-member', 'update-group-avatar'
]);
export const GROUP_QUEUE_ERROR = 'Not sent: this old group action has no current membership confirmation. Open the group and review it before making a new change.';
export const CALL_QUEUE_ACTIONS = new Set([
  'voice-channel-join', 'voice-channel-subscribe', 'voice-channel-leave',
  'voice-channel-unsubscribe', 'set-voice-transmit-mode'
]);
export const CALL_QUEUE_ERROR = 'Not sent: this old voice action was replaced by current call intent. Join or leave the channel directly.';
export const queueRejectionReason = (action: Pick<QueuedAction, 'type'>): string =>
  CALL_QUEUE_ACTIONS.has(action.type) ? CALL_QUEUE_ERROR : GROUP_QUEUE_ERROR;

export function groupQueueDecision(action: QueuedAction, membership: GroupMembership): 'send' | 'defer' | 'reject' {
  if (GROUP_QUEUE_ACTIONS.has(action.type) || CALL_QUEUE_ACTIONS.has(action.type)) return 'reject';
  const realm = membership.realm();
  if (action.authority && action.authority.realm !== realm) return 'defer';
  const id = (action.payload as { channelId?: unknown } | null)?.channelId;
  const group = typeof id === 'string' && (membership.tracks(id) || action.authority?.membershipRevision !== undefined);
  if (!group) return 'send';
  if (!action.authority?.membershipRevision) return 'reject';
  if (!membership.ready()) return 'defer';
  return membership.revision(id) === action.authority.membershipRevision ? 'send' : 'reject';
}
import type { QueuedAction } from '../types';
import type { GroupMembership } from '$lib/groupMembership';
