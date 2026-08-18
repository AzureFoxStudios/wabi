/**
 * breakoutChannels.ts — pure helpers for tracking breakout rooms in the
 * channel store. Kept free of browser/socket imports so the marking logic
 * is unit-testable (see breakoutChannels.test.ts).
 */

import type { Channel } from './socket-types';

export interface BreakoutRoomView {
	id?: string;
	name?: string;
	parentChannelId?: string;
	breakoutIndex?: number;
}

export interface BreakoutRoomsCreatedPayload {
	parentChannelId?: string;
	rooms?: BreakoutRoomView[];
}

/**
 * Upsert breakout rooms into a channel list. Rooms arrive from the
 * `breakout-rooms-created` socket event; they may already be present (the
 * normal channel-create flow can win the race), in which case the breakout
 * flags are merged in.
 */
export function upsertBreakoutRooms(
	list: Channel[],
	payload: BreakoutRoomsCreatedPayload
): Channel[] {
	const rooms = payload?.rooms ?? [];
	if (rooms.length === 0) return list;
	let next = list;
	for (const room of rooms) {
		if (!room?.id) continue;
		const parentChannelId = room.parentChannelId || payload.parentChannelId;
		const view: Channel = {
			id: room.id,
			name: room.name || 'Breakout',
			type: 'voice',
			createdAt: 0,
			isBreakout: true,
			...(parentChannelId ? { parentChannelId } : {}),
			...(typeof room.breakoutIndex === 'number' ? { breakoutIndex: room.breakoutIndex } : {})
		};
		next = next.some((c) => c.id === view.id)
			? next.map((c) => (c.id === view.id ? { ...c, ...view } : c))
			: [...next, view];
	}
	return next;
}

/** Remove closed breakout rooms (`breakout-rooms-closed`) from a channel list. */
export function removeBreakoutRooms(
	list: Channel[],
	rooms: BreakoutRoomView[] | undefined
): Channel[] {
	const removedIds = new Set(
		(rooms ?? []).map((room) => room?.id).filter((id): id is string => Boolean(id))
	);
	if (removedIds.size === 0) return list;
	return list.filter((c) => !removedIds.has(c.id));
}
