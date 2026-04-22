import type { User } from './socket-types';

function normalizeLookupValue(value: string): string {
	return value.trim().toLowerCase();
}

function getStatusPriority(status: User['status']): number {
	if (status === 'active') return 0;
	if (status === 'away') return 1;
	if (status === 'busy') return 2;
	return 3;
}

function isCurrentUser(user: User, currentUser: User | null | undefined): boolean {
	if (!currentUser) return false;
	if (user.id === currentUser.id) return true;
	return typeof user.dbUserId === 'number' && typeof currentUser.dbUserId === 'number' && user.dbUserId === currentUser.dbUserId;
}

export function getDmDirectoryKey(user: User): string {
	return typeof user.dbUserId === 'number' ? `user-${user.dbUserId}` : user.id;
}

export function buildDmDirectoryUsers(options: {
	onlineUsers: User[];
	serverMembers: User[];
	currentUser: User | null | undefined;
	searchQuery?: string;
}): User[] {
	const { onlineUsers, serverMembers, currentUser, searchQuery = '' } = options;
	const normalizedQuery = normalizeLookupValue(searchQuery);
	const candidates = new Map<string, User>();

	for (const user of serverMembers) {
		if (isCurrentUser(user, currentUser)) continue;
		candidates.set(getDmDirectoryKey(user), user);
	}

	for (const user of onlineUsers) {
		if (isCurrentUser(user, currentUser)) continue;
		candidates.set(getDmDirectoryKey(user), user);
	}

	return Array.from(candidates.values())
		.filter((user) => {
			if (!normalizedQuery) return true;
			const username = normalizeLookupValue(user.username);
			const handle = normalizeLookupValue(user.handle || '');
			return username.includes(normalizedQuery) || handle.includes(normalizedQuery);
		})
		.sort((left, right) => {
			const statusDelta = getStatusPriority(left.status) - getStatusPriority(right.status);
			if (statusDelta !== 0) return statusDelta;
			return left.username.localeCompare(right.username);
		});
}

export function findDmDirectoryUserByUsername(options: {
	username: string;
	onlineUsers: User[];
	serverMembers: User[];
	currentUser: User | null | undefined;
}): User | null {
	const normalizedUsername = normalizeLookupValue(options.username).replace(/^@/, '');
	if (!normalizedUsername) return null;

	return (
		buildDmDirectoryUsers({
			onlineUsers: options.onlineUsers,
			serverMembers: options.serverMembers,
			currentUser: options.currentUser
		}).find((user) => {
			const username = normalizeLookupValue(user.username);
			const handle = normalizeLookupValue(user.handle || '');
			return username === normalizedUsername || handle === normalizedUsername;
		}) || null
	);
}
