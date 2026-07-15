import type { User } from '$lib/socket';

export function isCurrentUserEntry(user: User, currentUser: User | null): boolean {
	if (!currentUser) return false;
	if (user.id === currentUser.id) return true;
	if (user.dbUserId && currentUser.dbUserId && user.dbUserId === currentUser.dbUserId) return true;
	return false;
}

// DM helpers removed in 2026-06-16 DM-strip pass. Stubs retained so
// existing import sites keep compiling. Each is a no-op that returns
// a value safe for the previous call sites (empty string, 0, null).

export function formatBadgeStub(_count: number): string {
	return '';
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

export function computeTotalUnreadDMsStub(_channelUnreadCounts: Record<string, number>): number {
	return 0;
}

export function getUserUnreadCountStub(
	_user: User,
	channelUnreadCounts: Record<string, number>,
	_dmIdFn: (current: User, target: User) => string,
	_currentUser: User | null
): number {
	return 0;
}

export function createSyntheticMouseEvent(touch: Touch): MouseEvent {
	return {
		preventDefault: () => {},
		stopPropagation: () => {},
		clientX: touch.clientX,
		clientY: touch.clientY
	} as unknown as MouseEvent;
}

export function extractUserFromEventStub(
	event: CustomEvent<{ user: User }> | User | undefined,
	contextMenuUser: User | null
): User | null {
	if (!event) return contextMenuUser;
	if ('detail' in event && event.detail?.user) return event.detail.user;
	if ('id' in event) return event as User;
	return contextMenuUser;
}
