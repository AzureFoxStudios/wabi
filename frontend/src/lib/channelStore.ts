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
import { socket, connected } from './socketConnection';
import { getSocket } from './socketConnection';
import { getWabiDB } from '$lib/wabidb';
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
	if (!sock || !channelId) return;
	sock.emit('join-channel', channelId);
}

/** Select a channel in the UI and join its socket room. Always updates
 * `currentChannel` — do not gate on registry presence (that blocked navigation
 * when type/list race left the channel briefly unlisted). */
export function switchChannel(channelId: string): void {
	if (!channelId) return;
	const currentChannelId = get(currentChannel);
	if (currentChannelId !== channelId) {
		currentChannel.set(channelId);
	}
	joinChannel(channelId);
}

export async function createChannel(channelName: string, description?: string, channelType: 'text' | 'voice' | 'forum' | 'gallery' | 'wiki' | 'stage' = 'text', forceSpoiler?: boolean): Promise<void> {
	try {
		const created = await createChannelApi(channelName, channelType, description, forceSpoiler);
		// REST create does not always fan out a socket event (and even when it
		// does, the caller may not be in the right room yet). Optimistically
		// upsert so the sidebar updates immediately.
		if (created?.id) {
			const next: Channel = {
				id: created.id,
				name: created.name || channelName,
				createdAt: Date.now(),
				type: (created.channel_type || channelType || 'text') as Channel['type'],
				...(created.force_spoiler != null ? { forceSpoiler: created.force_spoiler } : {})
			} as Channel;
			channels.update((list) => {
				if (list.some((c) => c.id === next.id)) {
					return list.map((c) => (c.id === next.id ? { ...c, ...next } : c));
				}
				return [...list, next];
			});
			_updatePinnedChannels();
		}
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

export async function pinChannel(channelId: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'pin-channel', payload: { channelId } });
		return;
	}
	sock.emit('pin-channel', { channelId });
}

export async function unpinChannel(channelId: string): Promise<void> {
	const sock = getSocket();
	if (!sock) return;
	const db = getWabiDB();
	const online = get(connected);
	if (db && !online) {
		await db.enqueue({ scopeId: 'corechat', type: 'unpin-channel', payload: { channelId } });
		return;
	}
	sock.emit('unpin-channel', { channelId });
}

export function reorderChannels(orders: { id: string; position: number; parentId: string | null }[]): void {
  channels.update(list =>
    list.map(ch => {
      const order = orders.find(o => o.id === ch.id);
      if (order) {
        return { ...ch, position: order.position, parentId: order.parentId ?? undefined };
      }
      return ch;
    })
  );
  const sock = getSocket();
  if (!sock) return;
  sock.emit('reorder-channels', { channels: orders });
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
	forceSpoiler?: boolean;
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
						...(settings.forceSpoiler !== undefined
							? { forceSpoiler: settings.forceSpoiler }
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
