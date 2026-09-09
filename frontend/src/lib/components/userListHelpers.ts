import type { User } from '$lib/socket';
import type { ContextMenuItem } from '$lib/context-menu/types';
import { isTrackedPersonStatusAlertsEnabled, rememberPeople, toggleTrackedPersonStatusAlerts } from '$lib/peopleTracker';
import { queueConversationPaymentLaunch } from '$lib/payments/paymentLaunch';
import { getUserIdentityKey } from '$lib/localNicknames';
import { startCall } from '$lib/calling';

const fallbackRolePriority: Record<string, number> = {
	owner: 100, admin: 90, mod: 70, member: 10, guest: 0
};

const fallbackRoleLabels: Record<string, string> = {
	owner: 'Owner', admin: 'Admin', mod: 'Moderator', member: 'Member', guest: 'Guest'
};

export function buildRolePriority(roleDefinitions: Array<{ roleName: string; priority: number }>): Record<string, number> {
	const map: Record<string, number> = { ...fallbackRolePriority };
	for (const role of roleDefinitions) {
		map[role.roleName] = role.priority;
	}
	return map;
}

export function buildRoleLabelMap(roleDefinitions: Array<{ roleName: string; displayName: string }>): Record<string, string> {
	const map: Record<string, string> = { ...fallbackRoleLabels };
	for (const role of roleDefinitions) {
		map[role.roleName] = role.displayName;
	}
	return map;
}

export function getRoleLabel(role: string, roleLabelMap: Record<string, string>): string {
	return roleLabelMap[role] || role;
}

export function isCurrentUserEntry(user: User, currentUser: User | null): boolean {
	if (!currentUser) return false;
	if (user.id === currentUser.id) return true;
	if (user.dbUserId && currentUser.dbUserId && user.dbUserId === currentUser.dbUserId) return true;
	return false;
}

function toStatusPriority(status: User['status']): number {
	if (status === 'active') return 0;
	if (status === 'away') return 1;
	if (status === 'busy') return 2;
	return 3;
}

export function sortUsersList(
	input: User[],
	sortMode: 'role' | 'name' | 'status',
	rolePriority: Record<string, number>,
	betterFriendListEnabled: boolean
): User[] {
	const sorted = [...input];
	if (!betterFriendListEnabled || sortMode === 'role') {
		sorted.sort((a, b) => {
			const priorityDelta = (rolePriority[b.highestRole || 'member'] || 0) - (rolePriority[a.highestRole || 'member'] || 0);
			if (priorityDelta !== 0) return priorityDelta;
			return a.username.localeCompare(b.username);
		});
		return sorted;
	}
	if (sortMode === 'name') {
		sorted.sort((a, b) => a.username.localeCompare(b.username));
		return sorted;
	}
	if (sortMode === 'status') {
		sorted.sort((a, b) => {
			const statusDelta = toStatusPriority(a.status) - toStatusPriority(b.status);
			if (statusDelta !== 0) return statusDelta;
			return a.username.localeCompare(b.username);
		});
		return sorted;
	}
	return sorted;
}

export function matchesSearch(user: User, query: string, betterFriendListEnabled: boolean, getDisplayName: (user: User) => string): boolean {
	if (!betterFriendListEnabled) return true;
	const normalized = query.trim().toLowerCase();
	if (!normalized) return true;
	const username = user.username.toLowerCase();
	const displayName = getDisplayName(user).toLowerCase();
	const handle = (user.handle || '').toLowerCase();
	return username.includes(normalized) || displayName.includes(normalized) || handle.includes(normalized);
}

export function matchesPresenceFilter(user: User, filter: 'all' | 'active' | 'away' | 'busy' | 'offline', offline: boolean, betterFriendListEnabled: boolean): boolean {
	if (!betterFriendListEnabled) return true;
	if (filter === 'all') return true;
	if (filter === 'offline') return offline;
	if (offline) return false;
	return user.status === filter;
}

export interface BuildMenuContext {
	contextMenuUser: User | null;
	currentUser: User | null;
	rolePriority: Record<string, number>;
	localNicknamesEnabled: boolean;
	hasLocalNickname: boolean;
	socket: unknown;
	bannedUserIds?: Set<number> | null;
}

export function buildUserMenuItems(ctx: BuildMenuContext): ContextMenuItem[] {
	const { contextMenuUser, currentUser, localNicknamesEnabled, hasLocalNickname } = ctx;
	if (!contextMenuUser) return [];

	const isSelf = isCurrentUserEntry(contextMenuUser, currentUser);
	const myRole = currentUser?.highestRole;
	const canManageRoles = myRole === 'owner' || myRole === 'admin';

	const canManageContextUserRoles = (): boolean => {
		if (!contextMenuUser.dbUserId || contextMenuUser.isRegistered === false || isSelf || !canManageRoles) return false;
		return contextMenuUser.highestRole !== 'owner';
	};

	const items: ContextMenuItem[] = [
		{
			id: 'message',
			label: isSelf ? 'Open Notes' : 'Message',
			icon: 'message-circle',
			onSelect: () => {}
		},
	];

	if (!isSelf) {
		items.push(
			{ id: 'request-payment', label: 'Request Payment', icon: 'credit-card', disabled: !contextMenuUser?.dbUserId, onSelect: () => {} },
			{ id: 'voice', label: 'Voice Call', icon: 'phone', onSelect: () => {} },
			{ id: 'video', label: 'Video Call', icon: 'video', onSelect: () => {} },
			{
				id: 'track-status',
				label: isTrackedPersonStatusAlertsEnabled(contextMenuUser) ? 'Stop Status Alerts' : 'Track Status Alerts',
				icon: 'settings',
				disabled: !contextMenuUser?.dbUserId,
				onSelect: () => { rememberPeople([contextMenuUser]); toggleTrackedPersonStatusAlerts(contextMenuUser); }
			}
		);
	}

	if (localNicknamesEnabled) {
		items.push({ id: 'nickname-set', label: 'Set Local Nickname', icon: 'settings', onSelect: () => {} });
		if (hasLocalNickname) {
			items.push({ id: 'nickname-clear', label: 'Clear Local Nickname', icon: 'settings', danger: true, onSelect: () => {} });
		}
	}

	if (canManageContextUserRoles() && contextMenuUser) {
		const roles = contextMenuUser.roles || [];
		const isAdmin = roles.includes('admin') || contextMenuUser.highestRole === 'admin';
		const isDeveloper = roles.includes('developer') || contextMenuUser.highestRole === 'developer';
		const isMod = roles.includes('mod') || contextMenuUser.highestRole === 'mod';
		const isArtist = roles.includes('artist') || contextMenuUser.highestRole === 'artist';

		items.push({ id: 'role-divider', type: 'separator' });

		if (!isAdmin) items.push({ id: 'make-admin', label: 'Make Admin', icon: 'settings', onSelect: () => {} });
		else items.push({ id: 'remove-admin', label: 'Remove Admin', icon: 'settings', danger: true, onSelect: () => {} });

		if (!isDeveloper) items.push({ id: 'make-developer', label: 'Make Developer', icon: 'settings', onSelect: () => {} });
		else items.push({ id: 'remove-developer', label: 'Remove Developer', icon: 'settings', danger: true, onSelect: () => {} });

		if (!isMod) items.push({ id: 'make-mod', label: 'Make Moderator', icon: 'settings', onSelect: () => {} });
		else items.push({ id: 'remove-mod', label: 'Remove Moderator', icon: 'settings', danger: true, onSelect: () => {} });

		if (!isArtist) items.push({ id: 'make-artist', label: 'Make Artist', icon: 'settings', onSelect: () => {} });
		else items.push({ id: 'remove-artist', label: 'Remove Artist', icon: 'settings', danger: true, onSelect: () => {} });

		if (isAdmin || isDeveloper || isMod || isArtist) items.push({ id: 'reset-member', label: 'Reset to Member', icon: 'settings', danger: true, onSelect: () => {} });

		const isBanned = typeof contextMenuUser.dbUserId === 'number'
			? ctx.bannedUserIds?.has(contextMenuUser.dbUserId) ?? false
			: false;
		if (isBanned) items.push({ id: 'unban-user', label: 'Unban', icon: 'settings', onSelect: () => {} });
		else items.push({ id: 'ban-user', label: 'Ban from server', icon: 'settings', danger: true, onSelect: () => {} });
	}

	return items;
}

export function queuePayment(user: User): void {
	if (!user.dbUserId) return;
	queueConversationPaymentLaunch({
		surface: 'payment_request',
		targetUserId: user.id,
		targetDbUserId: user.dbUserId
	});
}

export async function startDMCall(socket: unknown, user: User, video: boolean): Promise<void> {
	if (!socket) return;
	await startCall(socket as any, getUserIdentityKey(user), video, { scope: 'dm', displayName: user.username });
}
