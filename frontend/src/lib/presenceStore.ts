/**
 * presenceStore.ts
 * User presence, voice channels, and roles
 *
 * Extracted from socket-manager.ts for modularity.
 * Manages:
 * - User presence and status
 * - Voice channel members and participation
 * - Server membership and roles
 * - Role definitions and assignments
 */

import { writable, get } from 'svelte/store';
import type { Socket } from 'socket.io-client';
import { getSocket } from './socketConnection';
import type { User, UserBadge } from './socket-types';
import type { WhiteboardPresenceUser } from './whiteboard/boardTypes';
import { FALLBACK_BADGE_CATALOG } from './badges';
import { performGroupOperation } from './groupOperations';
import { groupMembership } from './groupAccess';
import { socket as socketState } from './socketConnectionState';
import { requestServerRoleChange } from './serverRoleCommands';
import { users, serverMembers, currentUser } from './presenceIdentity';
export { users, serverMembers, currentUser } from './presenceIdentity';

// ============================================================================
// TYPES
// ============================================================================

export interface VoiceChannelParticipant {
	userId: string;
	socketId?: string;
	username: string;
	isSpeaking: boolean;
	isMuted: boolean;
	isDeafened: boolean;
	transmitMode?: 'primary' | 'all-listening';
	videoEnabled?: boolean;
	screenShareEnabled?: boolean;
	connectionState?: string;
	profilePicture?: string;
}

export interface RoleDefinition {
	id: string;
	name: string;
	roleName: string;
	displayName: string;
	priority: number;
	permissions: string[];
	color?: string;
	claimable?: boolean;
}

// ============================================================================
// STORES
// ============================================================================

export const activeVoiceChannel = writable<string | null>(null);
export const voiceChannelMembers = writable<Record<string, VoiceChannelParticipant[]>>({});
export const roleDefinitions = writable<RoleDefinition[]>([]);
/** Assignable badge catalog (server BADGE_CATALOG via `badge-catalog`). */
export const badgeCatalog = writable<UserBadge[]>(FALLBACK_BADGE_CATALOG);

// Per-channel whiteboard presence: maps a channel id to the users currently
// on that channel's board. Populated by WhiteboardTab from its sync session so
// the channel sidebar can surface a "LIVE" indicator without re-subscribing.
export const whiteboardPresence = writable<Record<string, WhiteboardPresenceUser[]>>({});

export function setWhiteboardPresence(channelId: string, users: WhiteboardPresenceUser[]): void {
	if (!channelId) return;
	whiteboardPresence.update((map) => ({ ...map, [channelId]: users }));
}

export function clearWhiteboardPresence(channelId: string): void {
	if (!channelId) return;
	whiteboardPresence.update((map) => {
		if (!(channelId in map)) return map;
		const next = { ...map };
		delete next[channelId];
		return next;
	});
}

// ============================================================================
// PUBLIC API - Voice Channel Operations
// ============================================================================

export async function subscribeVoiceChannel(channelId: string): Promise<void> {
	const sock = getSocket();
	if (!sock?.connected) throw new Error('Listening requires an active server connection');
	const socketId = sock.id;
	const { joinVoiceChannel } = await import('./calling_impl_core');
	if (getSocket() !== sock || sock.id !== socketId || !sock.connected) throw new Error('Connection changed before voice subscription');
	await joinVoiceChannel(sock, channelId, { listenOnly: true });
}

export async function unsubscribeVoiceChannel(channelId: string): Promise<void> {
	const realm = groupMembership.realm();
	const { leaveVoiceChannel } = await import('./calling_impl_core');
	if (groupMembership.realm() !== realm) return;
	// Local leave must work while SocketManager is between socket objects.
	await leaveVoiceChannel(getSocket(), channelId);
}

export async function setVoiceTransmitMode(mode: 'primary' | 'all-listening'): Promise<void> {
	const sock = getSocket();
	// Recovery sends current local intent after admission, not an old queue item.
	if (sock?.connected) sock.emit('set-voice-transmit-mode', { mode });
}

// ============================================================================
// PUBLIC API - Role Operations
// ============================================================================

function toNumericUserId(userId: string | number): number | null {
	if (typeof userId === 'number' && Number.isFinite(userId)) return userId;
	const match = String(userId).match(/^(?:user-)?(\d+)$/);
	return match ? Number(match[1]) : null;
}

export async function assignRole(userId: string | number, roleId: string): Promise<void> {
	const sock = getSocket();
	if (!sock?.connected) throw new Error('Reconnect before changing roles.');
	const targetUserId = toNumericUserId(userId);
	if (!targetUserId) throw new Error('Choose a registered member.');
	const realm = groupMembership.realm();
	await requestServerRoleChange(sock, targetUserId, roleId, {
		isCurrent: () => !!realm && groupMembership.realm() === realm && getSocket() === sock,
		onInvalidated: (cancel) => socketState.subscribe((current) => { if (current !== sock) cancel(); })
	});
}

export async function removeUserRole(userId: string | number, roleId: string): Promise<void> {
	if (!['admin', 'mod', 'member'].includes(roleId)) throw new Error('Choose a valid member role.');
	await assignRole(userId, 'member');
}

/** Assign an assignable badge (server BADGE_CATALOG id). Admin-gated server-side. */
export async function assignBadge(userId: string | number, badgeId: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const targetUserId = toNumericUserId(userId);
	if (!targetUserId || !badgeId) return;
	sock.emit('assign-badge', { targetUserId, badgeId });
}

/** Remove a previously assigned badge. Admin-gated server-side. */
export async function removeBadge(userId: string | number, badgeId: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const targetUserId = toNumericUserId(userId);
	if (!targetUserId || !badgeId) return;
	sock.emit('remove-badge', { targetUserId, badgeId });
}

// ============================================================================
// PUBLIC API - User Management (server-wide bans)
// ============================================================================

/** Client-side mirror of server ban enforcement, fed by `user-banned` /
 *  `user-unbanned` broadcasts. The server is the source of truth; this set
 *  only drives Ban vs Unban affordances until a durable roster arrives. */
export const bannedUserIds = writable<Set<number>>(new Set());

function addBannedUserId(targetUserId: number): void {
	bannedUserIds.update((current) => {
		if (current.has(targetUserId)) return current;
		const next = new Set(current);
		next.add(targetUserId);
		return next;
	});
}

function removeBannedUserId(targetUserId: number): void {
	bannedUserIds.update((current) => {
		if (!current.has(targetUserId)) return current;
		const next = new Set(current);
		next.delete(targetUserId);
		return next;
	});
}

/** Reactive Ban vs Unban check for moderation UI. */
export function isUserBanned(dbUserId: string | number | null | undefined): boolean {
	if (dbUserId == null) return false;
	const targetUserId = toNumericUserId(dbUserId);
	if (!targetUserId) return false;
	return get(bannedUserIds).has(targetUserId);
}

interface BanCommandSocket {
	connected: boolean;
	on(event: string, listener: (payload: any) => void): unknown;
	off(event: string, listener: (payload: any) => void): unknown;
	emit(event: string, payload: unknown): unknown;
}

const pendingBanCommands = new WeakMap<object, Set<string>>();
const banListenerSockets = new WeakSet<object>();

function toBanPayloadTarget(value: unknown): number | null {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
	if (typeof value === 'string') return toNumericUserId(value);
	return null;
}

/**
 * Listen for server ban broadcasts on a socket and mirror them into
 * `bannedUserIds`. Idempotent per socket instance; returns a detach cleanup.
 *
 * NOTE: there is no global assign-role listener site to co-locate this with —
 * role acks are correlated per-request inside serverRoleCommands.ts. Call this
 * for each fresh socket (it is also ensured lazily by banUser/unbanUser).
 * The natural persistent home would be socketConnectionCore.ts next to
 * bindStateEventListeners, which is outside the files this change may touch.
 */
export function attachUserBanListeners(sock: BanCommandSocket | Socket): () => void {
	if (banListenerSockets.has(sock)) return () => {};
	banListenerSockets.add(sock);
	const socket = sock as BanCommandSocket;
	const onBanned = (payload: any) => {
		const targetUserId = toBanPayloadTarget(payload?.targetUserId);
		if (targetUserId) addBannedUserId(targetUserId);
	};
	const onUnbanned = (payload: any) => {
		const targetUserId = toBanPayloadTarget(payload?.targetUserId);
		if (targetUserId) removeBannedUserId(targetUserId);
	};
	socket.on('user-banned', onBanned);
	socket.on('user-unbanned', onUnbanned);
	return () => {
		socket.off('user-banned', onBanned);
		socket.off('user-unbanned', onUnbanned);
		banListenerSockets.delete(sock);
	};
}

/** Request/ack correlation for admin ban commands, modeled on
 *  requestServerRoleChange: per-socket pending de-dupe, requestId
 *  correlation, 10s timeout, disconnect/auth-revoked cleanup. */
function requestAdminBanCommand(
	sock: BanCommandSocket,
	kind: 'ban' | 'unban',
	targetUserId: number,
	options: {
		isCurrent: () => boolean;
		onInvalidated: (cancel: () => void) => () => void;
		timeoutMs?: number;
		reason?: string;
	}
): Promise<void> {
	if (!sock.connected || !options.isCurrent()) return Promise.reject(new Error('Reconnect before changing bans.'));
	let pending = pendingBanCommands.get(sock);
	if (!pending) { pending = new Set(); pendingBanCommands.set(sock, pending); }
	const key = `${kind}:${targetUserId}`;
	if (pending.has(key)) return Promise.reject(new Error('A ban change for this member is already in progress.'));
	pending.add(key);
	const pendingSet = pending;
	const requestId = crypto.randomUUID();
	const emitEvent = kind === 'ban' ? 'admin-ban-user' : 'admin-unban-user';
	const successEvent = kind === 'ban' ? 'admin-ban-success' : 'admin-unban-success';
	const errorEvent = kind === 'ban' ? 'admin-ban-error' : 'admin-unban-error';
	return new Promise<void>((resolve, reject) => {
		let done = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe = () => {};
		const finish = (error?: Error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.off(successEvent, onSuccess);
			sock.off(errorEvent, onError);
			sock.off('disconnect', onDisconnect);
			sock.off('auth-revoked', onDisconnect);
			unsubscribe();
			pendingSet.delete(key);
			if (error) { reject(error); return; }
			if (kind === 'ban') addBannedUserId(targetUserId);
			else removeBannedUserId(targetUserId);
			resolve();
		};
		const onDisconnect = () => finish(new Error('Connection changed before the ban change was confirmed. Check the member list after reconnecting.'));
		const onSuccess = (payload: any) => {
			if (payload?.requestId !== requestId) return;
			if (payload?.targetUserId != null && toBanPayloadTarget(payload.targetUserId) !== targetUserId) return;
			if (!options.isCurrent()) { onDisconnect(); return; }
			finish();
		};
		const onError = (payload: any) => {
			if (payload?.requestId !== requestId) return;
			finish(new Error(typeof payload.error === 'string' && payload.error ? payload.error : 'The server could not change this ban.'));
		};
		sock.on(successEvent, onSuccess);
		sock.on(errorEvent, onError);
		sock.on('disconnect', onDisconnect);
		sock.on('auth-revoked', onDisconnect);
		unsubscribe = options.onInvalidated(onDisconnect);
		if (done) { unsubscribe(); return; }
		timer = setTimeout(() => finish(new Error('The server did not confirm the ban change. Reload the member list before trying again.')), options.timeoutMs ?? 10_000);
		try {
			const payload = kind === 'ban' && options.reason
				? { targetUserId, reason: options.reason, requestId }
				: { targetUserId, requestId };
			sock.emit(emitEvent, payload);
		} catch { onDisconnect(); }
	});
}

function banCommandGuards(sock: Socket | null, userId: string | number): number {
	if (!sock?.connected) throw new Error('Reconnect before changing bans.');
	const targetUserId = toNumericUserId(userId);
	if (!targetUserId) throw new Error('Choose a registered member.');
	const selfId = get(currentUser)?.dbUserId;
	if (typeof selfId === 'number' && selfId === targetUserId) throw new Error('You cannot ban yourself.');
	return targetUserId;
}

function banCommandScope(sock: Socket) {
	const realm = groupMembership.realm();
	return {
		isCurrent: () => !!realm && groupMembership.realm() === realm && getSocket() === sock,
		onInvalidated: (cancel: () => void) => socketState.subscribe((current) => { if (current !== sock) cancel(); })
	};
}

/** Ban a member server-wide. They are logged out and blocked from signing in. */
export async function banUser(userId: string | number, reason?: string): Promise<void> {
	const sock = getSocket();
	const targetUserId = banCommandGuards(sock, userId);
	if (!sock) throw new Error('Reconnect before changing bans.');
	try { attachUserBanListeners(sock); } catch { /* listener attach is best-effort */ }
	await requestAdminBanCommand(sock, 'ban', targetUserId, { ...banCommandScope(sock), reason });
}

/** Lift a server-wide ban. */
export async function unbanUser(userId: string | number): Promise<void> {
	const sock = getSocket();
	if (!sock?.connected) throw new Error('Reconnect before changing bans.');
	const targetUserId = toNumericUserId(userId);
	if (!targetUserId) throw new Error('Choose a registered member.');
	try { attachUserBanListeners(sock); } catch { /* listener attach is best-effort */ }
	await requestAdminBanCommand(sock, 'unban', targetUserId, banCommandScope(sock));
}

// ============================================================================
// PUBLIC API - Group Operations
// ============================================================================

export async function createGroup(groupName: string, userIds: string[]): Promise<void> {
	await performGroupOperation('create', { groupName, userIds });
}

export async function leaveGroup(groupId: string): Promise<void> {
	await performGroupOperation('leave', { channelId: groupId });
}

export async function kickGroupMember(groupId: string, userId: string): Promise<void> {
	await performGroupOperation('kick', { channelId: groupId, targetUserId: userId });
}

export async function addGroupMember(groupId: string, userId: string): Promise<void> {
	await performGroupOperation('add', { channelId: groupId, userId });
}

export async function updateGroupAvatar(_groupId: string, _avatarUrl: string): Promise<void> {
	throw new Error('Group avatar uploads are not supported yet');
}

// ============================================================================
// INTERNAL EXPORTS FOR SOCKET-MANAGER
// ============================================================================

function normalizeUserList(value: unknown): User[] {
	if (Array.isArray(value)) return value as User[];
	if (value && typeof value === 'object') return Object.values(value as Record<string, User>);
	return [];
}

export function _setUsers(usersData: User[] | Record<string, User>): void {
	users.set(normalizeUserList(usersData));
}

export function _setCurrentUser(userData: User | null): void {
	currentUser.set(userData);
}

/// Merge profile fields (avatar, font, bio, status) from an updated
/// `UserView` into the current user without clobbering other fields.
export function _mergeCurrentUserProfile(patch: Partial<User>): void {
	currentUser.update((current) => {
		if (!current) return current;
		return { ...current, ...patch };
	});
}

export function _setServerMembers(membersData: User[] | Record<string, User>): void {
	serverMembers.set(normalizeUserList(membersData));
}

export function _setActiveVoiceChannel(channel: string | { id: string; name?: string } | null): void {
	activeVoiceChannel.set(typeof channel === 'string' ? channel : channel?.id ?? null);
}

export function _setVoiceChannelMembers(channelId: string, members: VoiceChannelParticipant[]): void {
	voiceChannelMembers.update((channels) => ({
		...channels,
		[channelId]: members
	}));
}

export function _setRoleDefinitions(roles: Array<Partial<RoleDefinition> & { roleName?: string; displayName?: string; name?: string; priority?: number }>): void {
	roleDefinitions.set(roles.map((role) => {
		const roleName = role.roleName || role.name || role.id || 'member';
		return {
			id: role.id || roleName,
			name: role.name || roleName,
			roleName,
			displayName: role.displayName || role.name || roleName,
			priority: role.priority ?? 0,
			permissions: role.permissions || [],
			color: role.color
		};
	}));
}

export function _updateVoiceChannelMember(channelId: string, userId: string, updates: Partial<VoiceChannelParticipant>): void {
	voiceChannelMembers.update((channels) => {
		const members = channels[channelId] || [];
		const existing = members.find((m) => m.userId === userId);
		if (existing) {
			return {
				...channels,
				[channelId]: members.map((m) =>
					m.userId === userId ? { ...m, ...updates } : m
				),
			};
		}
		const newMember: VoiceChannelParticipant = {
			userId,
			username: userId,
			isSpeaking: false,
			isMuted: false,
			isDeafened: false,
			profilePicture: existing?.profilePicture ?? updates.profilePicture,
			...updates,
		};
		return {
			...channels,
			[channelId]: [...members, newMember],
		};
	});
}

export function _removeVoiceChannelMember(channelId: string, userId: string): void {
	voiceChannelMembers.update((channels) => {
		const members = channels[channelId] || [];
		return {
			...channels,
			[channelId]: members.filter((m) => m.userId !== userId)
		};
	});
}

// ============================================================================
// BADGES (assignable, server `user_badges` projection)
// ============================================================================

export function _setBadgeCatalog(catalog: UserBadge[] | undefined | null): void {
	if (Array.isArray(catalog) && catalog.length > 0) badgeCatalog.set(catalog);
}

function patchUserBadges(list: User[], dbUserId: number, badges: UserBadge[]): User[] {
	let touched = false;
	const next = list.map((candidate) => {
		if (candidate.dbUserId !== dbUserId) return candidate;
		touched = true;
		return { ...candidate, badges };
	});
	return touched ? next : list;
}

/** Fan-out from the server's `user-badges-updated`: patch every store that
 *  may hold the user so all name surfaces re-render immediately. */
export function _setUserBadges(dbUserId: number, badges: UserBadge[]): void {
	users.update((list) => patchUserBadges(list, dbUserId, badges));
	serverMembers.update((list) => patchUserBadges(list, dbUserId, badges));
	currentUser.update((current) =>
		current && current.dbUserId === dbUserId ? { ...current, badges } : current
	);
}
