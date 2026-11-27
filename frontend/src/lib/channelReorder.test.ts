import { describe, expect, test } from 'bun:test';
import { sharedChannelsOnly, sharedReorderBatch } from './channelReorder';

const channels = [
	{ id: 'general', type: 'text' },
	{ id: 'lobby', type: 'voice' },
	{ id: 'folder', type: 'category' },
	{ id: 'dm_1', type: 'dm' },
	{ id: 'grp_1', type: 'group' },
	{ id: 'old' }
];

describe('channel reorder batches', () => {
	test('direct messages and groups are never part of the shared order', () => {
		expect(sharedChannelsOnly(channels).map((c) => c.id)).toEqual(['general', 'lobby', 'folder', 'old']);
	});

	test('a batch drops conversations, as the room or as the parent', () => {
		const batch = sharedReorderBatch(
			[
				{ id: 'general', position: 0, parentId: null },
				{ id: 'dm_1', position: 1, parentId: null },
				{ id: 'lobby', position: 2, parentId: 'grp_1' },
				{ id: 'old', position: 3, parentId: 'folder' }
			],
			channels
		);
		expect(batch.map((o) => o.id)).toEqual(['general', 'old']);
	});
});
