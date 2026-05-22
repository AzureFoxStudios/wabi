import type { User } from '$lib/socket';

export function isCurrentUserEntry(user: User, currentUser: User | null): boolean {
	if (!currentUser) return false;
	if (user.id === currentUser.id) return true;
	if (user.dbUserId && currentUser.dbUserId && user.dbUserId === currentUser.dbUserId) return true;
	return false;
}

export function formatBadge(count: number): string {
	if (count === 0) return '';
	if (count <= 10) return `+${count}`;
	return '•';
}

export function getStatusColor(status: string): string {
	switch (status) {
		case 'active':
			return 'var(--status-online)';
		case 'away':
			return 'var(--status-away)';
		case 'busy':
			return 'var(--status-busy)';
		default:
			return 'var(--status-offline)';
	}
}

export function computeTotalUnreadDMs(channelUnreadCounts: Record<string, number>): number {
	return Object.entries(channelUnreadCounts)
		.filter(([channelId]) => channelId.startsWith('dm-'))
		.reduce((sum, [, count]) => sum + count, 0);
}

export function getUserUnreadCount(
	user: User,
	channelUnreadCounts: Record<string, number>,
	getDMChannelIdForUser: (currentUser: User | null, user: User) => string,
	currentUser: User | null
): number {
	const dmId = getDMChannelIdForUser(currentUser, user);
	return channelUnreadCounts[dmId] || 0;
}

export function createSyntheticMouseEvent(touch: Touch): MouseEvent {
	return {
		preventDefault: () => {},
		stopPropagation: () => {},
		clientX: touch.clientX,
		clientY: touch.clientY
	} as unknown as MouseEvent;
}

export function extractUserFromEvent(
	event: CustomEvent<{ user: User }> | User | null,
	contextMenuUser: User | null
): User | null {
	if (!event) return contextMenuUser;
	if ('detail' in event && event.detail?.user) return event.detail.user;
	if ('id' in event) return event as User;
	return contextMenuUser;
}
