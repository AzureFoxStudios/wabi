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

// ============================================================================
// TYPES
// ============================================================================

export interface VoiceChannelParticipant {
	userId: string;
	username: string;
	isSpeaking: boolean;
	isMuted: boolean;
	isDeafened: boolean;
	videoEnabled?: boolean;
	screenShareEnabled?: boolean;
	connectionState?: string;
}

export interface RoleDefinition {
	id: string;
	name: string;
	permissions: string[];
	color?: string;
}

// ============================================================================
// STORES
// ============================================================================

export const users = writable<Record<string, any>>({});
export const serverMembers = writable<Record<string, any>>({});
export const currentUser = writable<any>(null);
export const activeVoiceChannel = writable<string | null>(null);
export const voiceChannelMembers = writable<Record<string, VoiceChannelParticipant[]>>({});
export const roleDefinitions = writable<RoleDefinition[]>([]);

// ============================================================================
// PUBLIC API - Voice Channel Operations
// ============================================================================

export function subscribeVoiceChannel(channelId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('subscribe-voice-channel', { channelId });
}

export function unsubscribeVoiceChannel(channelId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('unsubscribe-voice-channel', { channelId });
}

export function setVoiceTransmitMode(mode: 'always' | 'push-to-talk' | 'auto'): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('set-voice-transmit-mode', { mode });
}

// ============================================================================
// PUBLIC API - Role Operations
// ============================================================================

export function assignRole(userId: string, roleId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('assign-role', { userId, roleId });
}

export function removeUserRole(userId: string, roleId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('remove-user-role', { userId, roleId });
}

// ============================================================================
// PUBLIC API - User Management
// ============================================================================

export function banUser(userId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('ban-user', { userId });
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
	sock.emit('leave-group', { groupId });
}

export function kickGroupMember(groupId: string, userId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('kick-group-member', { groupId, userId });
}

export function addGroupMember(groupId: string, userId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('add-group-member', { groupId, userId });
}

export function updateGroupAvatar(groupId: string, avatarUrl: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('update-group-avatar', { groupId, avatarUrl });
}

// ============================================================================
// INTERNAL EXPORTS FOR SOCKET-MANAGER
// ============================================================================

export function _setUsers(usersData: Record<string, any>): void {
	users.set(usersData);
}

export function _setCurrentUser(userData: any): void {
	currentUser.set(userData);
}

export function _setServerMembers(membersData: Record<string, any>): void {
	serverMembers.set(membersData);
}

export function _setActiveVoiceChannel(channelId: string | null): void {
	activeVoiceChannel.set(channelId);
}

export function _setVoiceChannelMembers(channelId: string, members: VoiceChannelParticipant[]): void {
	voiceChannelMembers.update((channels) => ({
		...channels,
		[channelId]: members
	}));
}

export function _setRoleDefinitions(roles: RoleDefinition[]): void {
	roleDefinitions.set(roles);
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
