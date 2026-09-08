import { describe, expect, test } from 'bun:test';
import { GroupMembership, type MembershipContext } from './groupMembership';
import type { Channel } from './socket-types';
import type { QueuedAction } from './wabidb/types';
import { MESSAGE_QUEUE_ACTIONS, MESSAGE_QUEUE_OWNERSHIP_ERROR, GROUP_QUEUE_ERROR,
	BAN_QUEUE_ERROR, ADMIN_ROLE_QUEUE_ERROR, CALL_QUEUE_ERROR,
	groupQueueDecision, queueRejectionReason } from './wabidb/queue/groupPolicy';

function fixture() {
	let context: MembershipContext | null = { server: 'https://one.example', account: '1' };
	const membership = new GroupMembership({ context: () => context });
	const realm = membership.realm()!;
	return { membership, realm, setContext(next: MembershipContext | null) { context = next; } };
}

function action(type: string, channelId: string, authority?: QueuedAction['authority']): QueuedAction {
	return { id: 'saved-intent', scopeId: 'corechat', type, status: 'pending', createdAt: 1,
		payload: { channelId, clientMessageId: 'client-canary', text: 'Original account draft' }, authority };
}

describe('message queue account/server ownership', () => {
	test('unowned public, DM and group messages reject without adopting the current account', () => {
		const { membership, realm } = fixture();
		membership.finishInit(realm);
		expect([...MESSAGE_QUEUE_ACTIONS]).toEqual(['send-message', 'message']);
		for (const type of MESSAGE_QUEUE_ACTIONS) {
			for (const channelId of ['general', 'dm-user-1-user-2', 'group-test']) {
				const queued = action(type, channelId);
				const original = structuredClone(queued);
				expect(groupQueueDecision(queued, membership)).toBe('reject');
				expect(queueRejectionReason(queued)).toBe(MESSAGE_QUEUE_OWNERSHIP_ERROR);
				expect(queued).toEqual(original);
			}
		}
	});

	test('missing, null, non-string and blank legacy realm values cannot become sendable', () => {
		const { membership } = fixture();
		for (const type of MESSAGE_QUEUE_ACTIONS) {
			for (const authority of [undefined, null, {}, { realm: null }, { realm: 1 }, { realm: '' }, { realm: ' \t\n' }]) {
				const queued = action(type, 'general', authority as QueuedAction['authority']);
				expect(groupQueueDecision(queued, membership)).toBe('reject');
				expect(queueRejectionReason(queued)).toBe(MESSAGE_QUEUE_OWNERSHIP_ERROR);
			}
		}
	});

	test('a guest or cleared login cannot replay owned messages or adopt unowned ones', () => {
		const { membership, realm, setContext } = fixture();
		setContext(null);
		for (const type of MESSAGE_QUEUE_ACTIONS) {
			expect(groupQueueDecision(action(type, 'general', { realm }), membership)).toBe('defer');
			expect(groupQueueDecision(action(type, 'general'), membership)).toBe('reject');
		}
	});

	test('different account or server defers without rewriting original ownership', () => {
		for (const context of [{ server: 'https://one.example', account: '2' }, { server: 'https://two.example', account: '1' }]) {
			const { membership, realm, setContext } = fixture();
			for (const type of MESSAGE_QUEUE_ACTIONS) {
				const queued = action(type, 'general', { realm });
				setContext(context);
				expect(groupQueueDecision(queued, membership)).toBe('defer');
				expect(queued.authority).toEqual({ realm });
				setContext({ server: 'https://one.example', account: '1' });
				expect(groupQueueDecision(queued, membership)).toBe('send');
			}
		}
	});

	test('owned ordinary-channel intent remains eligible under its original account', () => {
		const { membership, realm } = fixture();
		for (const type of MESSAGE_QUEUE_ACTIONS) {
			for (const channelId of ['general', 'dm-user-1-user-2']) {
				expect(groupQueueDecision(action(type, channelId, { realm }), membership)).toBe('send');
			}
		}
	});

	test('known ownership does not bypass group init, revision, removal or re-add checks', () => {
		for (const type of MESSAGE_QUEUE_ACTIONS) {
			const { membership, realm } = fixture();
			const group = (revision: string): Channel => ({ id: 'group-test', name: 'Project', type: 'group',
				createdAt: 0, ownerId: 'user-1', members: ['user-1', 'user-2'], membershipRevision: revision });
			membership.apply(group('1'), realm);
			const queued = action(type, 'group-test', { realm, membershipRevision: '1' });
			expect(groupQueueDecision(queued, membership)).toBe('defer');
			membership.finishInit(realm);
			expect(groupQueueDecision(queued, membership)).toBe('send');
			const unversioned = action(type, 'group-test', { realm });
			expect(groupQueueDecision(unversioned, membership)).toBe('reject');
			expect(queueRejectionReason(unversioned)).toBe(GROUP_QUEUE_ERROR);
			membership.revoke('group-test', '2', realm);
			expect(groupQueueDecision(queued, membership)).toBe('reject');
			membership.apply(group('3'), realm);
			expect(groupQueueDecision(queued, membership)).toBe('reject');
			expect(groupQueueDecision(action(type, 'group-test', { realm, membershipRevision: '3' }), membership)).toBe('send');
		}
	});

	test('unrelated commands retain their existing decision and specific rejection reasons', () => {
		const { membership } = fixture();
		expect(groupQueueDecision(action('update-profile', 'general'), membership)).toBe('send');
		for (const [type, reason] of [['ban-user', BAN_QUEUE_ERROR], ['assign-role', ADMIN_ROLE_QUEUE_ERROR],
			['voice-channel-leave', CALL_QUEUE_ERROR], ['create-group', GROUP_QUEUE_ERROR]]) {
			expect(groupQueueDecision(action(type, 'general'), membership)).toBe('reject');
			expect(queueRejectionReason({ type })).toBe(reason);
		}
	});
});
