import { expect, test } from 'bun:test';
import { GroupMembership } from './groupMembership';
import { ADMIN_ROLE_QUEUE_ERROR, groupQueueDecision, queueRejectionReason } from './wabidb/queue/groupPolicy';
import type { QueuedAction } from './wabidb/types';

test('legacy administrative role intent is permanently rejected, never replayed after reconnect', () => {
  const membership = new GroupMembership({ context: () => ({ server: 'server', account: '1' }) });
  const realm = membership.realm()!;
  membership.finishInit(realm);
  for (const type of ['assign-role', 'remove-role']) {
    const action = { type, authority: { realm }, payload: { userId: 2, role: 'admin' } } as QueuedAction;
    expect(groupQueueDecision(action, membership)).toBe('reject');
    expect(groupQueueDecision({ ...action, authority: undefined }, membership)).toBe('reject');
    expect(queueRejectionReason(action)).toBe(ADMIN_ROLE_QUEUE_ERROR);
  }
});
