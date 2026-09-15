import type { Channel, Message, User } from './socket-types';

export function dmPersonName(user: User | null | undefined): string {
	return user?.username?.trim() || user?.handle?.replace(/^@+/, '').trim() || 'Recipient unavailable';
}

export function dmHandle(user: User | null | undefined): string {
	const handle = user?.handle?.replace(/^@+/, '').trim();
	return handle ? `@${handle}` : '';
}

export function dmPreview(messages: readonly Message[] | undefined): string {
	const last = messages?.at(-1);
	// An empty client cache is not proof of an empty server history.
	if (!last) return 'Open to load messages';
	if (last.type === 'file') return last.fileName ? `File: ${last.fileName}` : 'File attachment';
	if (last.type === 'gif') return 'GIF';
	if (last.type === 'emoji') return last.text || 'Emoji';
	return last.text || 'Message';
}

export function dmActivityTime(messages: readonly Message[] | undefined): number | null {
	const value = messages?.at(-1)?.timestamp;
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function dmTimeLabel(timestamp: number | null, now = new Date()): string {
	if (timestamp === null || !Number.isFinite(timestamp)) return '';
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) return '';
	return date.toDateString() === now.toDateString()
		? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
		: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}) });
}

function messageSequence(messages: readonly Message[] | undefined): bigint {
	const match = /^msg_([0-9a-f]+)$/i.exec(messages?.at(-1)?.id ?? '');
	return match ? BigInt(`0x${match[1]}`) : -1n;
}

/** Both inbox placements use the same personal pins, recency and deterministic ties. */
export function sortDmConversations(
	channels: readonly Channel[],
	messages: Record<string, Message[]>,
	pinnedIds: ReadonlySet<string>,
	label: (channel: Channel) => string
): Channel[] {
	return [...channels].sort((left, right) => {
		const pinOrder = Number(pinnedIds.has(right.id)) - Number(pinnedIds.has(left.id));
		if (pinOrder) return pinOrder;
		const timeOrder = (dmActivityTime(messages[right.id]) ?? 0) - (dmActivityTime(messages[left.id]) ?? 0);
		if (timeOrder) return timeOrder;
		const a = messageSequence(messages[left.id]), b = messageSequence(messages[right.id]);
		if (a !== b) return a > b ? -1 : 1;
		return label(left).localeCompare(label(right)) || left.id.localeCompare(right.id);
	});
}
