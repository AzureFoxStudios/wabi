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
import { createChannelApi, deleteChannelApi } from './api';

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
	const pinned = allChannels.filter((channel) => channel.pinnedBy && channel.pinnedBy.length > 0);
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

export async function createChannel(channelName: string, description?: string, channelType: 'text' | 'voice' | 'forum' | 'gallery' | 'wiki' | 'stage' = 'text'): Promise<void> {
	try {
		await createChannelApi(channelName, channelType, description);
	} catch (e) {
		console.error('[channelStore] Failed to create channel:', e);
		throw e;
	}
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

export async function deleteChannel(channelId: string): Promise<void> {
	try {
		await deleteChannelApi(channelId);
	} catch (e) {
		console.error('[channelStore] Failed to delete channel:', e);
		throw e;
	}
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
	minRole?: string;
	autoDeleteAfter?: string | number | null;
	persistMessages?: boolean;
	watchQueueEnabled?: boolean;
}): void {
	const sock = getSocket();
	if (!sock) return;
	// Optimistic local channel patch so timers/UI update immediately
	channels.update((list) =>
		list.map((ch) =>
			ch.id === channelId
				? {
						...ch,
						...(settings.name !== undefined ? { name: settings.name } : {}),
						...(settings.description !== undefined ? { description: settings.description } : {}),
						...(settings.autoDeleteAfter !== undefined
							? { autoDeleteAfter: settings.autoDeleteAfter as any }
							: {}),
						...(settings.persistMessages !== undefined
							? { persistMessages: settings.persistMessages }
							: {}),
						...(settings.watchQueueEnabled !== undefined
							? { watchQueueEnabled: settings.watchQueueEnabled }
							: {}),
						...(settings.voiceSettings !== undefined
							? { voiceSettings: settings.voiceSettings }
							: {})
					}
				: ch
		)
	);
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
