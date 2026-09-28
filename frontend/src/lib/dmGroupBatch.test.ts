import { expect, test } from 'bun:test';
import { leaveSelectedGroupChannels } from './dmGroupBatch';
import type { Channel } from './socket-types';

test('batch leave excludes one-to-one DMs and reports partial failures', async () => {
	const channels = [
		{ id: 'dm', type: 'dm' }, { id: 'group-a', type: 'group' }, { id: 'group-b', type: 'group' }
	] as Channel[];
	const attempted: string[] = [];
	const result = await leaveSelectedGroupChannels(channels, ['dm', 'group-a', 'group-b'], async (id) => {
		attempted.push(id);
		if (id === 'group-b') throw new Error('not confirmed');
	});
	expect(attempted).toEqual(['group-a', 'group-b']);
	expect(result).toEqual({ attempted: 2, leftIds: ['group-a'], failedIds: ['group-b'] });
});
