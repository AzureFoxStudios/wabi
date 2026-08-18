import { describe, expect, test } from 'bun:test';
import { upsertBreakoutRooms, removeBreakoutRooms } from './breakoutChannels';
import type { Channel } from './socket-types';

function textChannel(id: string): Channel {
	return { id, name: `chan-${id}`, type: 'text' } as Channel;
}

describe('upsertBreakoutRooms', () => {
	test('appends new breakout rooms marked with isBreakout and parent', () => {
		const out = upsertBreakoutRooms([textChannel('main')], {
			parentChannelId: 'main',
			rooms: [
				{ id: 'br1', name: 'Main 1', breakoutIndex: 1 },
				{ id: 'br2', name: 'Main 2', breakoutIndex: 2 }
			]
		});
		expect(out).toHaveLength(3);
		const br1 = out.find((c) => c.id === 'br1')!;
		expect(br1.isBreakout).toBe(true);
		expect(br1.parentChannelId).toBe('main');
		expect(br1.type).toBe('voice');
		expect(br1.breakoutIndex).toBe(1);
	});

	test('merges flags when the channel already exists from the normal create flow', () => {
		const existing: Channel[] = [
			textChannel('main'),
			{ id: 'br1', name: 'br1', type: 'voice', isBreakout: false } as Channel
		];
		const out = upsertBreakoutRooms(existing, {
			parentChannelId: 'main',
			rooms: [{ id: 'br1', name: 'Main 1' }]
		});
		expect(out).toHaveLength(2);
		const br1 = out.find((c) => c.id === 'br1')!;
		expect(br1.isBreakout).toBe(true);
		expect(br1.parentChannelId).toBe('main');
	});

	test('falls back to the payload-level parentChannelId when a room omits it', () => {
		const out = upsertBreakoutRooms([], {
			parentChannelId: 'parent',
			rooms: [{ id: 'br1', name: 'Room' }]
		});
		expect(out[0].parentChannelId).toBe('parent');
	});

	test('skips rooms without ids and returns the same list for empty payloads', () => {
		const list = [textChannel('a')];
		expect(upsertBreakoutRooms(list, { rooms: [] })).toBe(list);
		expect(upsertBreakoutRooms(list, { rooms: [{ name: 'no-id' }] })).toBe(list);
	});
});

describe('removeBreakoutRooms', () => {
	test('removes exactly the closed room ids', () => {
		const list = [textChannel('main'), { id: 'br1', type: 'voice' } as Channel, textChannel('keep')];
		const out = removeBreakoutRooms(list, [{ id: 'br1' }]);
		expect(out.map((c) => c.id)).toEqual(['main', 'keep']);
	});

	test('returns the same list for empty or id-less payloads', () => {
		const list = [textChannel('a')];
		expect(removeBreakoutRooms(list, [])).toBe(list);
		expect(removeBreakoutRooms(list, [{ name: 'no-id' }])).toBe(list);
		expect(removeBreakoutRooms(list, undefined)).toBe(list);
	});
});
