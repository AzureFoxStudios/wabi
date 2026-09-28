import { expect, test } from 'bun:test';
import { GroupMembership } from './groupMembership';
import { CHANNEL_CLEAR_QUEUE_ERROR, groupQueueDecision, queueRejectionReason } from './wabidb/queue/groupPolicy';
import { QueueManager } from './wabidb/queue/manager';
import type { QueuedAction } from './wabidb/types';

test('old queued channel clears require a fresh online request', () => {
	const membership = new GroupMembership({ context: () => ({ server: 'server', account: '1' }) });
	const realm = membership.realm()!;
	for (const ready of [false, true]) {
		if (ready) membership.finishInit(realm);
		for (const authority of [undefined, { realm }, { realm: 'another-account' }]) {
			const action = { type: 'clear-channel-messages', authority, payload: { channelId: 'room' } } as QueuedAction;
			expect(groupQueueDecision(action, membership)).toBe('reject');
			expect(queueRejectionReason(action)).toBe(CHANNEL_CLEAR_QUEUE_ERROR);
		}
	}
});

test('new channel clear cannot enter the offline queue', async () => {
	const queue = new QueueManager();
	await expect(queue.enqueue({
		scopeId: 'corechat',
		type: 'clear-channel-messages',
		payload: { channelId: 'room' }
	})).rejects.toThrow(CHANNEL_CLEAR_QUEUE_ERROR);
});
