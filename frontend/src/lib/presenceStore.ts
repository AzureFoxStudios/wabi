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
import { getSocket, connected } from './socketConnection';
import { getWabiDB } from '$lib/wabidb';
import type { User, UserBadge } from './socket-types';
import type { WhiteboardPresenceUser } from './whiteboard/boardTypes';
import { FALLBACK_BADGE_CATALOG } from './badges';

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

export const users = writable<User[]>([]);
export const serverMembers = writable<User[]>([]);
export const currentUser = writable<User | null>(null);
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
	if (!sock) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'voice-channel-subscribe', payload: { channelId } });
		return;
	}
	sock.emit('voice-channel-subscribe', { channelId });
}

export async function unsubscribeVoiceChannel(channelId: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'voice-channel-leave', payload: { channelId } });
		return;
	}
	sock.emit('voice-channel-unsubscribe', { channelId });
}

export async function setVoiceTransmitMode(mode: 'primary' | 'all-listening'): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'set-voice-transmit-mode', payload: { mode } });
		return;
	}
	sock.emit('set-voice-transmit-mode', { mode });
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
	if (!sock) return;
	const targetUserId = toNumericUserId(userId);
	if (!targetUserId) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'assign-role', payload: { targetUserId, roleName: roleId } });
		return;
	}
	sock.emit('assign-role', { targetUserId, roleName: roleId });
}

export async function removeUserRole(userId: string | number, roleId: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const targetUserId = toNumericUserId(userId);
	if (!targetUserId) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'remove-role', payload: { targetUserId, roleName: roleId } });
		return;
	}
	sock.emit('remove-role', { targetUserId, roleName: roleId });
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
// PUBLIC API - User Management
// ============================================================================

export async function banUser(userId: string | number, reason?: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const targetUserId = toNumericUserId(userId);
	if (!targetUserId) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'ban-user', payload: { targetUserId, reason } });
		return;
	}
	sock.emit('ban-user', { targetUserId, reason });
}

// ============================================================================
// PUBLIC API - Group Operations
// ============================================================================

export async function createGroup(groupName: string, userIds: string[]): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'create-group', payload: { groupName, userIds } });
		return;
	}
	sock.emit('create-group', { groupName, userIds });
}

export async function leaveGroup(groupId: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'leave-group', payload: { channelId: groupId } });
		return;
	}
	sock.emit('leave-group', { channelId: groupId });
}

export async function kickGroupMember(groupId: string, userId: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'kick-group-member', payload: { channelId: groupId, targetUserId: userId } });
		return;
	}
	sock.emit('kick-group-member', { channelId: groupId, targetUserId: userId });
}

export async function addGroupMember(groupId: string, userId: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'add-group-member', payload: { channelId: groupId, userId } });
		return;
	}
	sock.emit('add-group-member', { channelId: groupId, userId });
}

export async function updateGroupAvatar(groupId: string, avatarUrl: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'update-group-avatar', payload: { channelId: groupId, avatarUrl } });
		return;
	}
	sock.emit('update-group-avatar', { channelId: groupId, avatarUrl });
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

