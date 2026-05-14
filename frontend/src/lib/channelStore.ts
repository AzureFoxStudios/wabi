/**
 * channelStore.ts
 * Channel state management and operations
 *
 * Extracted from socket-manager.ts for modularity.
 * Manages:
 * - Channel list and metadata
 * - Current channel tracking
 * - Pinned channels
 * - Channel archive pagination
 * - Channel operations (create, delete, subscribe, etc.)
 */

import { writable, get } from 'svelte/store';
import type { Socket } from 'socket.io-client';
import type { Channel } from './socket-types';
import { socket } from './socketConnection';
import { getSocket } from './socketConnection';

// ============================================================================
// STORES
// ============================================================================

export const channels = writable<Channel[]>([]);
export const pinnedChannels = writable<Channel[]>([]);
export const currentChannel = writable<string>('general');

// Archive pagination (client-side)
export const channelLoadedArchives = writable<Record<string, Set<string>>>({});
export const channelAvailableArchives = writable<Record<string, string[]>>({});
export const channelLoadingOlder = writable<Record<string, boolean>>({});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getChannelById(channelId: string | null | undefined): Channel | undefined {
	if (!channelId) return undefined;
	return get(channels).find((c) => c.id === channelId);
}

function updatePinnedChannels(): void {
	const allChannels = get(channels);
	const pinned = allChannels.filter((channel) => channel.pinned);
	pinnedChannels.set(pinned);
}

// ============================================================================
// PUBLIC API - Channel Operations
// ============================================================================

export function joinChannel(channelId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('join-channel', channelId);
}

export function switchChannel(channelId: string): void {
	const currentChannelId = get(currentChannel);
	if (currentChannelId === channelId) return;

	const channel = getChannelById(channelId);
	if (channel) {
		currentChannel.set(channelId);
		joinChannel(channelId);
	}
}

export function createChannel(channelName: string, description?: string, channelType: 'text' | 'voice' = 'text'): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('create-channel', { channelName, description, channelType });
}

export function createBreakoutRooms(parentChannelId: string, roomCount = 2, autoAssign = true): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('create-breakout-rooms', { parentChannelId, roomCount, autoAssign });
}

export function closeBreakoutRooms(parentChannelId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('close-breakout-rooms', { parentChannelId });
}

export function moveUserToBreakout(parentChannelId: string, targetUserId: string, toChannelId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('move-user-to-breakout', { parentChannelId, targetUserId, toChannelId });
}

export function moveUserToVoiceChannel(targetUserId: string, toChannelId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('move-user-to-voice-channel', { targetUserId, toChannelId });
}

export function createThread(parentChannelId: string, name: string, options?: {
	description?: string;
	isPrivate?: boolean;
}): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('create-thread', { parentChannelId, name, ...options });
}

export function deleteChannel(channelId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('delete-channel', { channelId });
}

export function pinChannel(channelId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('pin-channel', { channelId });
}

export function unpinChannel(channelId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('unpin-channel', { channelId });
}

export function updateChannelSettings(channelId: string, settings: {
	name?: string;
	description?: string;
	isPrivate?: boolean;
	voiceSettings?: any;
}): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('update-channel-settings', { channelId, settings });
}

// ============================================================================
// INTERNAL EXPORTS FOR SOCKET-MANAGER
// ============================================================================

export function _updatePinnedChannels(): void {
	updatePinnedChannels();
}

export function _getChannelById(channelId: string | null | undefined): Channel | undefined {
	return getChannelById(channelId);
}
