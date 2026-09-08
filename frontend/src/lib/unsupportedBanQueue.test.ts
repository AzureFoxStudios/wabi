import { expect, test } from 'bun:test';
import { GroupMembership } from './groupMembership';
import { BAN_QUEUE_ERROR, groupQueueDecision, queueRejectionReason } from './wabidb/queue/groupPolicy';
import type { QueuedAction } from './wabidb/types';

test('old Ban requests reject before realm or membership checks, never defer for later replay', () => {
	const membership = new GroupMembership({ context: () => ({ server: 'server', account: '1' }) });
	const realm = membership.realm()!;
	for (const ready of [false, true]) {
		if (ready) membership.finishInit(realm);
		for (const authority of [undefined, { realm }, { realm: 'another-account' }]) {
			const action = { type: 'ban-user', authority, payload: { targetUserId: 2 } } as QueuedAction;
			expect(groupQueueDecision(action, membership)).toBe('reject');
			expect(queueRejectionReason(action)).toBe(BAN_QUEUE_ERROR);
		}
	}
});

test('retiring unsupported Ban intent does not retire supported unrelated actions', () => {
	const membership = new GroupMembership({ context: () => ({ server: 'server', account: '1' }) });
	membership.finishInit(membership.realm()!);
	expect(groupQueueDecision({ type: 'update-profile', payload: {} } as QueuedAction, membership)).toBe('send');
});
