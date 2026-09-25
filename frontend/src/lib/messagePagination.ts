/**
 * messagePagination.ts
 * Message history loading and pagination
 *
 * Extracted from messageStore.ts for single responsibility.
 * Manages:
 * - Server-side history pagination
 * - Loading state tracking
 * - Message history fetching
 */

import { writable, get } from 'svelte/store';
import { getSocket } from './socketConnection';

// ============================================================================
// PAGINATION STORES
// ============================================================================

export const channelHistoryLoading = writable<Record<string, boolean>>({});
export const channelHasMoreHistory = writable<Record<string, boolean>>({});
export const channelOldestMessageId = writable<Record<string, string | null>>({});

// ============================================================================
// INTERNAL STATE
// ============================================================================

interface PendingHistoryRequest {
	requestId: string;
	requestKey: string;
	channelId: string;
	preview: boolean;
}

const pendingHistoryRequests = new Map<string, PendingHistoryRequest>();
let historyRequestSequence = 0;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function buildHistoryRequestKey(channelId: string, options?: {
	beforeMessageId?: string;
	afterMessageId?: string;
	limit?: number;
}): string {
	const parts = [channelId];
	if (options?.beforeMessageId) parts.push(`before:${options.beforeMessageId}`);
	if (options?.afterMessageId) parts.push(`after:${options.afterMessageId}`);
	if (options?.limit) parts.push(`limit:${options.limit}`);
	return parts.join('|');
}

function createHistoryRequestId(channelId: string): string {
	return `${channelId}:${++historyRequestSequence}`;
}

// ============================================================================
// PUBLIC API
// ============================================================================

export function loadHistory(channelId: string, options?: {
	beforeMessageId?: string;
	afterMessageId?: string;
	limit?: number;
}): void {
	const requestKey = buildHistoryRequestKey(channelId, options);
	if (pendingHistoryRequests.has(requestKey)) return;

	const requestId = createHistoryRequestId(channelId);
	pendingHistoryRequests.set(requestKey, {
		requestId, requestKey, channelId,
		preview: options?.limit === 1 && !options.beforeMessageId && !options.afterMessageId
	});

	channelHistoryLoading.update((state) => ({
		...state,
		[channelId]: true
	}));

	const sock = getSocket();
	if (!sock) {
		pendingHistoryRequests.delete(requestKey);
		channelHistoryLoading.update((state) => ({
			...state,
			[channelId]: false
		}));
		return;
	}

	sock.emit('load-history', {
		requestId,
		channelId,
		...options
	});
}

/** Fetch one server-owned row so an unopened DM has a truthful preview. */
export function loadDmPreview(channelId: string): void {
	loadHistory(channelId, { limit: 1 });
}

/** A response from an older socket must not settle a new connection's request. */
export function _completeHistoryRequest(channelId: string, requestId: string | null | undefined): PendingHistoryRequest | null {
	if (!requestId) return null;
	const entry = [...pendingHistoryRequests.entries()].find(([, request]) =>
		request.channelId === channelId && request.requestId === requestId);
	if (!entry) return null;
	pendingHistoryRequests.delete(entry[0]);
	if (![...pendingHistoryRequests.values()].some((request) => request.channelId === channelId)) {
		channelHistoryLoading.update((state) => ({ ...state, [channelId]: false }));
	}
	return entry[1];
}

export function _failHistoryRequests(channelId: string): void {
	for (const [key, request] of pendingHistoryRequests) {
		if (request.channelId === channelId) pendingHistoryRequests.delete(key);
	}
	channelHistoryLoading.update((state) => ({ ...state, [channelId]: false }));
}

export function _resetHistoryRequests(): void {
	pendingHistoryRequests.clear();
	channelHistoryLoading.set({});
}

export function loadOlderHistory(channelId: string): void {
	const oldest = get(channelOldestMessageId)[channelId];
	if (!oldest) return;
	loadHistory(channelId, { beforeMessageId: oldest, limit: 30 });
}

export function syncNewerMessages(channelId: string): void {
	const sock = getSocket();
	if (!sock) return;
	sock.emit('sync-newer', { channelId });
}

// ============================================================================
// INTERNAL EXPORTS FOR SOCKET-MANAGER
// ============================================================================

export function _getPendingHistoryRequest(channelId: string): PendingHistoryRequest | undefined {
	for (const request of pendingHistoryRequests.values()) {
		if (request.requestId.startsWith(channelId + ':')) return request;
	}
}

export function _deletePendingHistoryRequest(channelId: string): void {
	_failHistoryRequests(channelId);
}
