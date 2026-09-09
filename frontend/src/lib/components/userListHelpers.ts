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
	owner: 'Owner', admin: 'Admin', developer: 'Developer', artist: 'Artist',
	mod: 'Moderator', member: 'Member', guest: 'Guest'
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
	/** Live role catalog (role-definitions-updated). Drives the role menu. */
	roleDefinitions?: Array<{
		roleName: string;
		displayName: string;
		priority: number;
		capabilities?: string[];
	}> | null;
}

/** A role the viewer may grant/revoke from the member menu. */
export interface AssignableRoleEntry {
	roleName: string;
	displayName: string;
	priority: number;
}

/**
 * Lore roles = catalog roles that carry lore capabilities, i.e. every role
 * except the moderation (`mod`) and guest shells. The client role store
 * strips unknown fields, so when no entry carries `capabilities` (store not
 * yet refreshed) fall back to the same heuristic on role names.
 */
export function selectLoreRoles(
	defs: Array<{ roleName: string; displayName: string; priority: number; capabilities?: string[] }> | null | undefined
): AssignableRoleEntry[] {
	if (!defs || defs.length === 0) return [];
	const withCaps = defs.filter((d) => Array.isArray(d.capabilities) && d.capabilities.length > 0);
	const lore = withCaps.length > 0
		? withCaps
		: defs.filter((d) => d.roleName !== 'mod' && d.roleName !== 'guest');
	return [...lore]
		.map((d) => ({ roleName: d.roleName, displayName: d.displayName, priority: d.priority ?? 0 }))
		.sort((a, b) => b.priority - a.priority);
}

/**
 * Full offerable set for the member menu: lore roles (minus owner/member/
 * guest — owner is never grantable here, member is covered by reset) plus
 * `mod` for moderation. Falls back to the classic four when the catalog has
 * not loaded yet so the menu never goes empty.
 */
export function selectAssignableRoles(
	defs: Array<{ roleName: string; displayName: string; priority: number; capabilities?: string[] }> | null | undefined,
	rolePriority?: Record<string, number>
): AssignableRoleEntry[] {
	const excluded = new Set(['owner', 'member', 'guest']);
	if (!defs || defs.length === 0) {
		return [
			{ roleName: 'admin', displayName: 'Admin', priority: 90 },
			{ roleName: 'mod', displayName: 'Moderator', priority: 70 },
			{ roleName: 'developer', displayName: 'Developer', priority: 60 },
			{ roleName: 'artist', displayName: 'Artist', priority: 50 }
		];
	}
	const priorityOf = (roleName: string, fallback: number): number =>
		rolePriority?.[roleName] ?? fallback;
	const lore = selectLoreRoles(defs).filter((r) => !excluded.has(r.roleName));
	const offerable = [...lore];
	if (!offerable.some((r) => r.roleName === 'mod')) {
		const modDef = defs.find((d) => d.roleName === 'mod');
		offerable.push({
			roleName: 'mod',
			displayName: modDef?.displayName || 'Moderator',
			priority: modDef?.priority ?? priorityOf('mod', 70)
		});
	}
	return offerable.sort((a, b) => b.priority - a.priority);
}

/** Role names (roleName) the target currently holds — highestRole + roles. */
export function getTargetRoleNames(user: User): Set<string> {
	const names = new Set<string>();
	if (user.highestRole) names.add(user.highestRole);
	for (const role of user.roles || []) {
		if (typeof role === 'string' && role) names.add(role);
	}
	return names;
}

interface LiveRoleSocket {
	connected: boolean;
	on(event: string, listener: (payload: any) => void): unknown;
	off(event: string, listener: (payload: any) => void): unknown;
	emit(event: string, payload: unknown): unknown;
}

function toNumericDbUserId(userId: string | number | null | undefined): number | null {
	if (typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0) return userId;
	const match = String(userId ?? '').match(/^(?:user-)?(\d+)$/);
	return match ? Number(match[1]) : null;
}

/**
 * The existing assign-role flow, minus the stale built-in-only whitelist, so
 * user-defined role ids assign exactly like admin/mod/artist/developer.
 * Correlates `assign-role-success` / `assign-role-error` by requestId.
 * Removing a role = assigning `member` (the server reverts to Member).
 */
export function requestLiveRoleChange(
	socket: LiveRoleSocket | null | undefined,
	userId: string | number | null | undefined,
	roleName: string,
	options?: { timeoutMs?: number }
): Promise<void> {
	const sock: LiveRoleSocket | null | undefined = socket;
	if (!sock?.connected) return Promise.reject(new Error('Reconnect before changing roles.'));
	const targetUserId = toNumericDbUserId(userId);
	if (!targetUserId || !roleName.trim()) {
		return Promise.reject(new Error('Choose a registered member.'));
	}
	const requestId = crypto.randomUUID();
	return new Promise<void>((resolve, reject) => {
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.off('assign-role-success', onSuccess);
			sock.off('assign-role-error', onError);
			sock.off('disconnect', onDisconnect);
			if (error) reject(error);
			else resolve();
		};
		const onSuccess = (payload: any) => {
			if (payload?.requestId !== requestId || payload.targetUserId !== targetUserId) return;
			finish();
		};
		const onError = (payload: any) => {
			if (payload?.requestId !== requestId) return;
			finish(new Error(typeof payload?.error === 'string' ? payload.error : 'The server could not change this role.'));
		};
		const onDisconnect = () => finish(new Error('Connection changed before the role change was confirmed. Check the member’s role after reconnecting.'));
		sock.on('assign-role-success', onSuccess);
		sock.on('assign-role-error', onError);
		sock.on('disconnect', onDisconnect);
		timer = setTimeout(() => finish(new Error('The server did not confirm the role change. Reload the member list before trying again.')), options?.timeoutMs ?? 10_000);
		try {
			sock.emit('assign-role', { targetUserId, roleName, requestId });
		} catch {
			onDisconnect();
		}
	});
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
		const targetRoles = getTargetRoleNames(contextMenuUser);
		// Live role list: lore roles from the catalog plus mod for moderation.
		// `make-role:<id>` grants, `remove-role:<id>` reverts to member — the
		// host component maps those ids to the assign-role flow.
		const offerable = selectAssignableRoles(ctx.roleDefinitions, ctx.rolePriority);

		items.push({ id: 'role-divider', type: 'separator' });

		for (const role of offerable) {
			const hasRole = targetRoles.has(role.roleName);
			items.push({
				id: hasRole ? `remove-role:${role.roleName}` : `make-role:${role.roleName}`,
				label: hasRole ? `Remove ${role.displayName}` : `Make ${role.displayName}`,
				icon: 'settings',
				danger: hasRole,
				onSelect: () => {}
			});
		}

		if (offerable.some((role) => targetRoles.has(role.roleName))) {
			items.push({ id: 'reset-member', label: 'Reset to Member', icon: 'settings', danger: true, onSelect: () => {} });
		}

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
