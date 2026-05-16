import { get } from 'svelte/store';
import { _ } from '$lib/i18n';
import type { User } from '$lib/socket';

export function formatTypingUsers(users: string[]): string {
	const t = get(_);
	if (users.length === 0) return '';
	if (users.length === 1) return t('chat.typing.one', { values: { user: users[0] } });
	if (users.length === 2) return t('chat.typing.two', { values: { user1: users[0], user2: users[1] } });
	if (users.length >= 6) return t('chat.typing.many');

	const allButLast = users.slice(0, -1).join(', ');
	const lastUser = users[users.length - 1];
	return t('chat.typing.multi', { values: { users: allButLast, lastUser } });
}

function getTypingUserPriority(username: string, users: User[]): number {
	const user = users.find((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
	const role = (user?.highestRole || '').toLowerCase();

	if (role.includes('owner')) return 4;
	if (role.includes('admin')) return 3;
	if (role.includes('mod')) return 2;
	if (role.includes('staff')) return 1;
	return 0;
}

export function getVisibleTypingUsers(names: string[], currentUser: User | null, users: User[]): string[] {
	const currentUsername = (currentUser?.username || '').toLowerCase();
	const deduped = Array.from(new Set(names.filter(Boolean)));
	const othersOnly = deduped.filter((name) => name.toLowerCase() !== currentUsername);

	return othersOnly.sort((a, b) => {
		const priorityDiff = getTypingUserPriority(b, users) - getTypingUserPriority(a, users);
		if (priorityDiff !== 0) return priorityDiff;
		return a.localeCompare(b);
	});
}
