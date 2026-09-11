import { describe, expect, test } from 'bun:test';
import type { Channel, User } from './socket-types';
import { resolveDmEntry } from './dmEntry';

function user(id: string, dbUserId?: number): User {
	return {
		id,
		dbUserId,
		username: `user-${dbUserId ?? id}`,
		color: '#98D8C8',
		status: 'offline'
	} as User;
}

describe('resolveDmEntry', () => {
	test('reuses an existing DM without creating a duplicate', async () => {
		const target = user('socket-target', 22);
		const existing = {
			id: 'dm-existing',
			name: 'DM with target',
			type: 'dm',
			createdAt: 1,
			members: ['user-11', 'user-22'],
			otherUser: target,
			minRole: 'member'
		} as Channel;
		let createCalls = 0;

		const result = await resolveDmEntry({
			channels: [existing],
			target,
			createDm: async () => {
				createCalls += 1;
				return { ok: true, channelId: 'dm-duplicate' };
			}
		});

		expect(result).toEqual({ ok: true, channelId: 'dm-existing', existing: true });
		expect(createCalls).toBe(0);
	});

	test('creates a DM with the stable directory identity for an offline member', async () => {
		const target = user('stale-socket-id', 42);
		let requestedTarget = '';

		const result = await resolveDmEntry({
			channels: [],
			target,
			createDm: async (targetId) => {
				requestedTarget = targetId;
				return { ok: true, channelId: 'dm-created' };
			}
		});

		expect(requestedTarget).toBe('user-42');
		expect(result).toEqual({ ok: true, channelId: 'dm-created', existing: false });
	});

	test('returns creation failures without inventing a channel', async () => {
		const result = await resolveDmEntry({
			channels: [],
			target: user('guest-target'),
			createDm: async () => ({ ok: false, error: 'DMs disabled' })
		});

		expect(result).toEqual({ ok: false, error: 'DMs disabled' });
	});
});
