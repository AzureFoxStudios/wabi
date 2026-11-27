/**
 * Channel ordering is shared by the whole server, so it only ever covers shared
 * rooms and folders. Direct messages and groups live in the same store but are
 * private to their members; the server refuses a whole reorder batch if one of
 * them appears in it.
 */
type Typed = { id: string; type?: string };
export type ChannelOrder = { id: string; position: number; parentId: string | null };

export function isConversation(channel: { type?: string }): boolean {
	return channel.type === 'dm' || channel.type === 'group';
}

export function sharedChannelsOnly<T extends { type?: string }>(channels: T[]): T[] {
	return channels.filter((channel) => !isConversation(channel));
}

/** Drops entries that name a conversation, as the room itself or as its parent. */
export function sharedReorderBatch(orders: ChannelOrder[], channels: Typed[]): ChannelOrder[] {
	const conversations = new Set(channels.filter(isConversation).map((channel) => channel.id));
	return orders.filter(
		(order) => !conversations.has(order.id) && !(order.parentId && conversations.has(order.parentId))
	);
}
