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
import { ensureChannelMembership } from './api/channelAccess';
import { getAuthToken } from './authSession';
import { getServerUrl } from './serverUrl';
import { showToast } from './toast';
import { captureGroupAccess, groupMembership } from './groupAccess';

export const channels = writable<Channel[]>([]);
export const pinnedChannels = writable<Channel[]>([]);
export const currentChannel = writable<string>('general');

const LAST_CHANNEL_STORAGE_KEY = 'wabi:last-channel';

export function readLastChannel(): string | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const value = localStorage.getItem(LAST_CHANNEL_STORAGE_KEY);
		return value?.trim() || null;
	} catch {
		return null;
	}
}

export function persistLastChannel(channelId: string): void {
	try { localStorage.setItem(LAST_CHANNEL_STORAGE_KEY, channelId); }
	catch { /* best-effort UI preference */ }
}

export const channelLoadedArchives = writable<Record<string, Set<string>>>({});
export const channelAvailableArchives = writable<Record<string, string[]>>({});
export const channelLoadingOlder = writable<Record<string, boolean>>({});

function getChannelById(channelId: string | null | undefined): Channel | undefined {
	if (!channelId) return undefined;
	return get(channels).find((c) => c.id === channelId);
}

function updatePinnedChannels(): void {
	const allChannels = get(channels);
	pinnedChannels.set(allChannels.filter((channel) => channel.pinnedBy && channel.pinnedBy.length > 0));
}

export function joinChannel(channelId: string): void {
	const sock = getSocket();
	if (!sock || !channelId) return;
	const socketId = sock.id;
	let hasAccess: () => boolean;
	try { hasAccess = captureGroupAccess(channelId); }
	catch { showToast('You no longer have access to this group', 'error'); return; }
	void ensureChannelMembership(channelId).then(() => {
		if (hasAccess() && getSocket() === sock && (!socketId || sock.id === socketId)) sock.emit('join-channel', channelId);
	}).catch((error: unknown) => {
		if (getSocket() === sock && sock.id === socketId) showToast(error instanceof Error ? error.message : 'Could not open channel', 'error');
	});
}

export function switchChannel(channelId: string): void {
	if (!channelId) return;
	if (!groupMembership.acceptsContent(channelId)) return;
	persistLastChannel(channelId);
	const currentChannelId = get(currentChannel);
	if (currentChannelId !== channelId) {
		const previousChannel = get(channels).find((channel) => channel.id === currentChannelId);
		currentChannel.set(channelId);
		if ((previousChannel?.autoDeleteAfter as string | null | undefined) === 'live') {
			void import('./messageStore').then(({ channelMessages }) => {
				channelMessages.update((state) => {
					const next = { ...state };
					delete next[currentChannelId];
					return next;
				});
			});
		}
	}
	joinChannel(channelId);
}

export type CreateableChannelType = 'text' | 'voice' | 'forum' | 'gallery' | 'wiki' | 'stage' | 'lore' | 'planning' | 'reception' | 'category';

export async function createChannel(
	channelName: string,
	description?: string,
	channelType: CreateableChannelType = 'text',
	forceSpoiler?: boolean,
	assetStorage?: boolean,
	parentId?: string | null
): Promise<string | null> {
	try {
		const created = await createChannelApi(channelName, channelType, description, forceSpoiler, assetStorage ?? channelType === 'lore', parentId);
		if (created?.id) {
			const nestedParent = created.parent_id || (parentId && parentId.trim() ? parentId.trim() : undefined) || undefined;
			const next: Channel = {
				id: created.id,
				name: created.name || channelName,
				createdAt: Date.now(),
				type: (created.channel_type || channelType || 'text') as Channel['type'],
				...(created.force_spoiler != null ? { forceSpoiler: created.force_spoiler } : {}),
				...(nestedParent ? { parentId: nestedParent } : {})
			} as Channel;
			channels.update((list) => list.some((c) => c.id === next.id)
				? list.map((c) => (c.id === next.id ? { ...c, ...next } : c))
				: [...list, next]);
			_updatePinnedChannels();
			return created.id;
		}
		return null;
	} catch (e) {
		console.error('[channelStore] Failed to create channel:', e);
		throw e;
	}
}

export function createBreakoutRooms(parentChannelId: string, roomCount = 2, autoAssign = true): void {
	const sock = getSocket(); if (!sock) return;
	sock.emit('create-breakout-rooms', { parentChannelId, roomCount, autoAssign });
}
export function closeBreakoutRooms(parentChannelId: string): void { const sock = getSocket(); if (sock) sock.emit('close-breakout-rooms', { parentChannelId }); }
export function moveUserToBreakout(parentChannelId: string, targetUserId: string, toChannelId: string): void { const sock = getSocket(); if (sock) sock.emit('move-user-to-breakout', { parentChannelId, targetUserId, toChannelId }); }
export function moveUserToVoiceChannel(targetUserId: string, toChannelId: string): void { const sock = getSocket(); if (sock) sock.emit('move-user-to-voice-channel', { targetUserId, toChannelId }); }
export function kickVoiceMember(channelId: string, targetUserId: string): void { const sock = getSocket(); if (sock) sock.emit('voice-channel-kick', { channelId, targetUserId }); }
export function createThread(parentChannelId: string, name: string, options?: { description?: string; isPrivate?: boolean; }): void { const sock = getSocket(); if (sock) sock.emit('create-thread', { parentChannelId, name, ...options }); }

export function descendantIds(all: Channel[], channelId: string): Set<string> {
	const out = new Set<string>();
	const stack = [channelId];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		for (const ch of all) {
			if (ch.parentId === cur && !out.has(ch.id)) { out.add(ch.id); stack.push(ch.id); }
		}
	}
	return out;
}

export async function deleteChannel(channelId: string, options: { preserveChildren?: boolean } = {}): Promise<void> {
	try {
		await deleteChannelApi(channelId, options);
		const removedIds = descendantIds(get(channels), channelId);
		removedIds.add(channelId);
		if (options.preserveChildren) {
			channels.update((list) => list.map((channel) => removedIds.has(channel.id) && channel.id !== channelId ? { ...channel, parentId: undefined } : channel));
			removedIds.clear(); removedIds.add(channelId);
		}
		const remaining = get(channels).filter((channel) => !removedIds.has(channel.id));
		channels.set(remaining); _updatePinnedChannels();
		if (removedIds.has(get(currentChannel))) {
			const fallback = remaining.find((channel) => channel.type !== 'dm' && channel.type !== 'group') || remaining[0];
			if (fallback) switchChannel(fallback.id);
		}
	} catch (e) {
		console.error('[channelStore] Failed to delete channel:', e);
		throw e;
	}
}

export async function pinChannel(channelId: string): Promise<void> {
	const sock = getSocket(); if (!sock) return;
	const db = getWabiDB(); const online = get(connected);
	if (db && !online) { await db.enqueue({ scopeId: 'corechat', type: 'pin-channel', payload: { channelId } }); return; }
	sock.emit('pin-channel', { channelId });
}
export async function unpinChannel(channelId: string): Promise<void> {
	const sock = getSocket(); if (!sock) return;
	const db = getWabiDB(); const online = get(connected);
	if (db && !online) { await db.enqueue({ scopeId: 'corechat', type: 'unpin-channel', payload: { channelId } }); return; }
	sock.emit('unpin-channel', { channelId });
}

export function reorderChannels(orders: { id: string; position: number; parentId: string | null }[]): void {
	channels.update(list => list.map(ch => {
		const order = orders.find(o => o.id === ch.id);
		return order ? { ...ch, position: order.position, parentId: order.parentId ?? undefined } : ch;
	}));
	const sock = getSocket(); if (sock) sock.emit('reorder-channels', { channels: orders });
}

function retentionWireValue(value: string | number | null): string {
	if (value === null) return 'forever';
	if (typeof value === 'number') return `${Math.max(1, Math.round(value))}ms`;
	const trimmed = value.trim();
	return trimmed || 'forever';
}

async function persistRetentionChoice(channelId: string, value: string | number | null): Promise<void> {
	const token = getAuthToken();
	if (!token) throw new Error('Sign in again before changing retention.');
	const response = await fetch(`${getServerUrl()}/api/channels/${encodeURIComponent(channelId)}/retention`, {
		method: 'PUT',
		credentials: 'include',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ retention: retentionWireValue(value) })
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || `Retention could not be saved (${response.status}).`);
}

export async function updateChannelSettings(channelId: string, settings: {
	name?: string;
	description?: string;
	isPrivate?: boolean;
	voiceSettings?: any;
	minRole?: string;
	autoDeleteAfter?: string | number | null;
	persistMessages?: boolean;
	watchQueueEnabled?: boolean;
	forceSpoiler?: boolean;
}): Promise<void> {
	const sock = getSocket();
	if (!sock) return;

	// Retention is privacy-sensitive. Persist the exact choice before publishing
	// the optimistic/socket settings update so Live/1h/etc. survive restarts.
	if (settings.autoDeleteAfter !== undefined) {
		try {
			await persistRetentionChoice(channelId, settings.autoDeleteAfter);
		} catch (error) {
			showToast(error instanceof Error ? error.message : 'Retention could not be saved.', 'error');
			return;
		}
	}

	channels.update((list) => list.map((ch) => ch.id === channelId ? {
		...ch,
		...(settings.name !== undefined ? { name: settings.name } : {}),
		...(settings.description !== undefined ? { description: settings.description } : {}),
		...(settings.autoDeleteAfter !== undefined ? { autoDeleteAfter: settings.autoDeleteAfter as any } : {}),
		...(settings.persistMessages !== undefined ? { persistMessages: settings.persistMessages } : {}),
		...(settings.watchQueueEnabled !== undefined ? { watchQueueEnabled: settings.watchQueueEnabled } : {}),
		...(settings.forceSpoiler !== undefined ? { forceSpoiler: settings.forceSpoiler } : {}),
		...(settings.voiceSettings !== undefined ? { voiceSettings: settings.voiceSettings } : {})
	} : ch));
	sock.emit('update-channel-settings', { channelId, settings });
}

export function _updatePinnedChannels(): void { updatePinnedChannels(); }
export function _getChannelById(channelId: string | null | undefined): Channel | undefined { return getChannelById(channelId); }
