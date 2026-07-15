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
import type { User } from './socket-types';
import type { WhiteboardPresenceUser } from './whiteboard/boardTypes';

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

export function subscribeVoiceChannel(channelId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('voice-channel-subscribe', { channelId });
}

export function unsubscribeVoiceChannel(channelId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('voice-channel-leave', { channelId });
}

export function setVoiceTransmitMode(mode: 'primary' | 'all-listening'): void {
	const sock = getSocket();
	if (!sock) return;
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

export function assignRole(userId: string | number, roleId: string): void {
	const sock = getSocket();
	if (!sock) return;
	const targetUserId = toNumericUserId(userId);
	if (!targetUserId) return;
	sock.emit('assign-role', { targetUserId, roleName: roleId });
}

export function removeUserRole(userId: string | number, roleId: string): void {
	const sock = getSocket();
	if (!sock) return;
	const targetUserId = toNumericUserId(userId);
	if (!targetUserId) return;
	sock.emit('remove-role', { targetUserId, roleName: roleId });
}

// ============================================================================
// PUBLIC API - User Management
// ============================================================================

export function banUser(userId: string | number, reason?: string): void {
	const sock = getSocket();
	if (!sock) return;
	const targetUserId = toNumericUserId(userId);
	if (!targetUserId) return;
	sock.emit('ban-user', { targetUserId, reason });
}

// ============================================================================
// PUBLIC API - Group Operations
// ============================================================================

export function createGroup(groupName: string, userIds: string[]): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('create-group', { groupName, userIds });
}

export function leaveGroup(groupId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('leave-group', { channelId: groupId });
}

export function kickGroupMember(groupId: string, userId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('kick-group-member', { channelId: groupId, targetUserId: userId });
}

export function addGroupMember(groupId: string, userId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('add-group-member', { channelId: groupId, userId });
}

export function updateGroupAvatar(groupId: string, avatarUrl: string): void {
	const sock = getSocket();
	if (!sock) return;
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
		return {
			...channels,
			[channelId]: members.map((m) =>
				m.userId === userId ? { ...m, ...updates } : m
			)
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
