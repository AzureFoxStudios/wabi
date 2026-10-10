import { describe, expect, test } from 'bun:test';
import { buildPushChannelRows } from './pushChannels';
import type { Channel } from '$lib/socket-types';

function channel(partial: Partial<Channel> & Pick<Channel, 'id'>): Channel {
	return { createdAt: 0, ...partial } as Channel;
}

describe('buildPushChannelRows', () => {
	test('lists server channels and groups, and never DMs or categories', () => {
		const rows = buildPushChannelRows([
			channel({ id: 'dm-user-2', type: 'dm', name: 'Ada' }),
			channel({ id: 'group-team', type: 'group', name: 'Testers' }),
			channel({ id: 'ch_general', type: 'text', name: 'general' }),
			channel({ id: 'ch_talk', type: 'voice', name: 'Talk' }),
			channel({ id: 'ch_meta', type: 'category', name: 'Meta' })
		]);
		expect(rows.map((row) => row.id)).toEqual(['ch_general', 'ch_talk', 'group-team']);
	});

	test('the row chip is the channel type', () => {
		const rows = buildPushChannelRows([
			channel({ id: 'ch_general', type: 'text', name: 'general' }),
			channel({ id: 'ch_talk', type: 'voice', name: 'Talk' }),
			channel({ id: 'group-team', type: 'group', name: 'Testers' })
		]);
		expect(rows.map((row) => row.type)).toEqual(['text', 'voice', 'group']);
	});

	test('labels come from the channel name and fall back to the id', () => {
		const named = buildPushChannelRows([
			channel({ id: 'ch_general', type: 'text', name: '  general  ' })
		]);
		expect(named[0].label).toBe('general');

		const blank = buildPushChannelRows([
			channel({ id: 'ch_x', type: 'text', name: '   ' })
		]);
		expect(blank[0].label).toBe('ch_x');
	});

	test('rows sort alphabetically with the id breaking ties', () => {
		const rows = buildPushChannelRows([
			channel({ id: 'ch_2', type: 'text', name: 'bo' }),
			channel({ id: 'ch_1', type: 'text', name: 'Alpha' }),
			channel({ id: 'ch_3', type: 'text', name: 'bo' })
		]);
		expect(rows.map((row) => row.id)).toEqual(['ch_1', 'ch_2', 'ch_3']);
	});
});
