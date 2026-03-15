/**
 * SocketManager v2 - Cross-Browser Stable WebSocket Management
 *
 * STABILITY GUARANTEES:
 * - Single socket instance per session (no duplicates)
 * - Finite state machine for connection lifecycle
 * - Browser-safe reconnection with exponential backoff
 * - Clean teardown on page unload/navigation
 * - Firefox and Chrome behavioral parity
 *
 * KEY FIXES FROM v1:
 * - Transport order: ['websocket', 'polling'] (WS preferred, polling fallback)
 * - State machine prevents race conditions
 * - Proper close code handling for Firefox
 * - Listener cleanup before rebinding
 * - Safe localStorage access
 */

import { writable, get } from 'svelte/store';
import { io, Socket } from 'socket.io-client';
import { browser } from '$app/environment';
import { showNotification, messageMentionsUser } from './notifications';
import { initEmotes, addEmote, removeEmote } from './markdown';
import { chatStorage } from './storage';
import { getChannelFollowPreference } from './following';
import { isChannelFollowed } from './following';
import {
	markFollowedChannelRead,
	recordFollowedMessageActivity,
	syncFollowedChannelSnapshot
} from './followingSnapshots';
import { setRecordingPresence } from './callRecordingPresence';
import * as calling from './calling';
import type { FileAttachment, Message, Emoji, User, Channel, MessageEntity, VoiceChannelSettings } from './socket-types';
	import { emojis } from './emoji-store';
	import { getServerUrl } from './serverUrl';
	import { authStore } from './authStore';
	import {
		clearGuestSessionId,
		getAuthToken,
		getGuestSessionId,
		getStoredDbUserId,
		setGuestSessionId,
		setStoredDbUserId,
		setStoredUsername
	} from './authSession';
	import { encryptDMMessage, decryptDMMessagePayload, isE2EAvailable } from './e2eManager';
	import { getDMPrivacyMode } from './dmPrivacyMode';
	import { mobileTabQueue } from './mobileTabQueue';
	import { emitPaymentRealtimeEvent } from './paymentRealtime';
	import { currentSavedServer, recordSuccessfulServerConnection } from './savedServers';
	import { consumePendingChannelNavigation } from './pendingServerNavigation';

function getFollowSnapshotServerInfo(): { serverUrl: string; serverName: string | null } {
	return {
		serverUrl: getServerUrl(),
		serverName: get(currentSavedServer)?.effectiveName || null
	};
}

function getSelfStableIdForSocketId(socketId: string | null | undefined): string | null {
	if (!socketId) return null;
	const me = get(currentUser);
	if (me?.id === socketId) {
		return typeof me.dbUserId === 'number' ? `user-${me.dbUserId}` : me.id;
	}
	if (browser && socketId === get(socket)?.id) {
		if (typeof me?.dbUserId === 'number') {
			return `user-${me.dbUserId}`;
		}
		const storedDbUserId = getStoredDbUserId();
		if (typeof storedDbUserId === 'number' && Number.isFinite(storedDbUserId) && storedDbUserId > 0) {
			return `user-${storedDbUserId}`;
		}
	}
	const onlineUsers = get(users);
	const socketUser = onlineUsers.find((u) => u.id === socketId);
	if (!socketUser) return null;
	return typeof socketUser.dbUserId === 'number' ? `user-${socketUser.dbUserId}` : socketUser.id;
}

function resolveOtherDmDbUserId(channel: Channel, socketId?: string | null): number | null {
	if (typeof channel.otherUser?.dbUserId === 'number') return channel.otherUser.dbUserId;
	if (!Array.isArray(channel.members)) return null;
	const selfStableId = getSelfStableIdForSocketId(socketId ?? get(socket)?.id);
	const otherMemberId = channel.members.find((id) => id !== selfStableId);
	if (otherMemberId?.startsWith('user-')) {
		const dbUserId = Number.parseInt(otherMemberId.substring(5), 10);
		if (Number.isFinite(dbUserId)) return dbUserId;
	}
	// Fallback: derive from DM channel ID format, e.g. dm-user-12-user-34
	// This helps when legacy member arrays are stale/malformed.
	const fromChannelId = Array.from(channel.id.matchAll(/user-(\d+)/g))
		.map((m) => Number.parseInt(m[1], 10))
		.filter((n) => Number.isFinite(n));
	const me = get(currentUser);
	const selfDbId = typeof me?.dbUserId === 'number' ? me.dbUserId : null;
	const candidate = fromChannelId.find((id) => id !== selfDbId) ?? fromChannelId[0];
	return typeof candidate === 'number' ? candidate : null;
}

function isFocusedAudioChannel(channel: Channel | undefined | null): boolean {
	return Boolean(channel?.type === 'voice' && channel.voiceSettings?.forceSolo);
}

function getChannelById(channelId: string | null | undefined): Channel | undefined {
	if (!channelId) return undefined;
	return get(channels).find((channel) => channel.id === channelId);
}

function getPrimaryCallingChannelId(): string | null {
	return get(calling.activeVoiceChannel)?.id || null;
}

function enforceFocusedAudioState(sock: Socket, focusedChannelId: string): void {
	const subscribedChannels = get(calling.listeningVoiceChannels);
	for (const channelId of subscribedChannels) {
		if (channelId === focusedChannelId) continue;
		calling.removeVoiceChannelListen(sock, channelId);
	}
	calling.setVoiceTransmitRoutingMode('primary');
}

/**
 * Decrypt an array of messages for a DM channel (in-place mutation of text field).
 * Skips non-encrypted messages. Requires channel to be a DM with a known otherUser.dbUserId.
 */
async function decryptMessagesForChannel(channelId: string, messages: Message[]): Promise<void> {
	if (!isE2EAvailable() || !browser) return;

	const token = getAuthToken();
	if (!token) return;

	const channelList = get(channels);
	const channel = channelList.find(ch => ch.id === channelId);
	if (!channel || channel.type !== 'dm') return;
	const otherDbUserId = resolveOtherDmDbUserId(channel);
	if (!otherDbUserId) return;

	await Promise.all(
		messages.map(async (msg) => {
			if (msg.encrypted && msg.iv) {
				const payload = await decryptDMMessagePayload(msg, otherDbUserId, token);
				msg.text = payload.text;
				msg.entities = payload.entities;
			}
		})
	);
}

export async function retryDecryptLoadedDmMessages(): Promise<void> {
	if (!browser || !isE2EAvailable()) return;

	const channelList = get(channels);
	const currentMessages = get(channelMessages);
	let changed = false;
	const nextState: Record<string, Message[]> = { ...currentMessages };

	for (const channel of channelList) {
		if (channel.type !== 'dm') continue;
		const messages = currentMessages[channel.id];
		if (!messages?.length) continue;

		const pending = messages.filter((msg) => msg.encrypted && msg.iv && msg.text !== '[Encrypted message]');
		if (pending.length === 0) continue;

		const clonedMessages = messages.map((msg) => ({ ...msg }));
		await decryptMessagesForChannel(channel.id, clonedMessages);

		const didChange = clonedMessages.some((msg, index) => msg.text !== messages[index]?.text);
		if (!didChange) continue;

		nextState[channel.id] = clonedMessages;
		changed = true;
	}

	if (changed) {
		channelMessages.set(nextState);
	}
}

import { handleP2PIncomingOffer, handleP2PAnswer, handleP2PIceCandidate } from './p2pFileTransfer';

/** The base browser tab title. Update this constant if the app is renamed. */
const APP_TITLE = 'Wabi Chat';
const MESSAGE_PURGE_VERSION_KEY = 'messagePurgeVersion';


// ============================================================================
// CONNECTION STATE MACHINE
// ============================================================================

/**
 * Finite state machine for socket lifecycle.
 * Prevents race conditions by enforcing valid state transitions.
 *
 * State Transitions:
 *   disconnected -> connecting -> connected
 *   connected -> reconnecting -> connecting -> connected
 *   any -> failed (terminal until manual reset)
 *   any -> disconnected (manual disconnect)
 */
export type ConnectionState =
	| 'disconnected'   // No active connection, not trying
	| 'connecting'     // Initial connection attempt in progress
	| 'connected'      // Successfully connected and operational
	| 'reconnecting'   // Connection lost, waiting to retry
	| 'failed';        // Unrecoverable error, requires user action

const VALID_TRANSITIONS: Record<ConnectionState, ConnectionState[]> = {
	disconnected: ['connecting'],
	connecting: ['connected', 'reconnecting', 'failed', 'disconnected'],
	connected: ['reconnecting', 'disconnected'],
	reconnecting: ['connecting', 'failed', 'disconnected'],
	failed: ['disconnected', 'connecting']  // Can reset from failed
};

// ============================================================================
// STORES - Single source of truth for all socket-related state
// ============================================================================

export const socket = writable<Socket | null>(null);
export interface RoleDefinition {
	roleName: string;
	displayName: string;
	priority: number;
	color: string | null;
	isHoisted: boolean;
}
export const channels = writable<Channel[]>([]);
export const pinnedChannels = writable<Channel[]>([]);
export const currentChannel = writable<string>('general');
export const channelMessages = writable<Record<string, Message[]>>({ general: [] });
export const users = writable<User[]>([]);
export const serverMembers = writable<User[]>([]);
export const typingUsers = writable<Record<string, string[]>>({});
export const currentUser = writable<User | null>(null);
export const connected = writable(false);
export const unreadCount = writable(0);
export const lastReadMessageId = writable<string | null>(null);
export const channelUnreadCounts = writable<Record<string, number>>({});
export const dmPanelSignal = writable<{ channelId: string; otherUser: User } | null>(null);
export interface VoiceChannelParticipant {
	userId: string;
	socketId?: string;
	username?: string;
	profilePicture?: string;
}
export const activeVoiceChannel = writable<string | null>(null);
export const voiceChannelMembers = writable<Record<string, VoiceChannelParticipant[]>>({});
export const roleDefinitions = writable<RoleDefinition[]>([]);
export { emojis };

// Pagination stores (client-side archive-based)
export const channelLoadedArchives = writable<Record<string, Set<string>>>({});
export const channelAvailableArchives = writable<Record<string, string[]>>({});
export const channelLoadingOlder = writable<Record<string, boolean>>({});

// Server-side history pagination stores
export const channelHistoryLoading = writable<Record<string, boolean>>({});
export const channelHasMoreHistory = writable<Record<string, boolean>>({});
export const channelOldestMessageId = writable<Record<string, string | null>>({});

// Connection state for UI feedback
export const connectionState = writable<ConnectionState>('disconnected');

// ============================================================================
// SOCKET MANAGER CLASS - Singleton with State Machine
// ============================================================================

class SocketManager {
	private socket: Socket | null = null;
	private username: string = '';
	private authToken: string | null = null;
	private pendingIncomingMessages = new Map<string, Message[]>();
	private incomingMessageFlushHandle: number | ReturnType<typeof setTimeout> | null = null;

	// State machine
	private state: ConnectionState = 'disconnected';

	// Reconnection configuration
	private reconnectAttempts = 0;
	private readonly maxReconnectAttempts = 10;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private baseDelay = 1000;
	private maxDelay = 30000;
	private reconnectJitterMs = 1000;
	private connectTimeoutMs = 20000;

	// Heartbeat/keepalive (for Firefox stability)
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private lastPong: number = 0;
	private readonly heartbeatIntervalMs = 25000;
	private readonly heartbeatTimeoutMs = 35000;

	// Listener tracking for clean rebinding
	private boundListeners: Set<string> = new Set();

	private scheduleIncomingMessageFlush(): void {
		if (this.incomingMessageFlushHandle !== null) return;

		if (browser && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
			this.incomingMessageFlushHandle = window.requestAnimationFrame(() => {
				this.incomingMessageFlushHandle = null;
				this.flushIncomingMessages();
			});
			return;
		}

		this.incomingMessageFlushHandle = setTimeout(() => {
			this.incomingMessageFlushHandle = null;
			this.flushIncomingMessages();
		}, 16);
	}

	private queueIncomingMessage(channelId: string, message: Message): void {
		const queued = this.pendingIncomingMessages.get(channelId) || [];
		if (queued.some((entry) => entry.id === message.id)) return;
		queued.push(message);
		this.pendingIncomingMessages.set(channelId, queued);
		this.scheduleIncomingMessageFlush();
	}

	private flushIncomingMessages(): void {
		if (this.pendingIncomingMessages.size === 0) return;

		const pendingByChannel = this.pendingIncomingMessages;
		this.pendingIncomingMessages = new Map();
		const addedMessages: Array<{ channelId: string; message: Message }> = [];

		channelMessages.update((msgs) => {
			let changed = false;
			const next = { ...msgs };

			for (const [channelId, pendingMessages] of pendingByChannel.entries()) {
				if (pendingMessages.length === 0) continue;
				const existing = next[channelId] || [];
				const existingIds = new Set(existing.map((message) => message.id));
				const additions = pendingMessages.filter((message) => !existingIds.has(message.id));
				if (additions.length === 0) continue;

				next[channelId] = [...existing, ...additions];
				for (const message of additions) {
					addedMessages.push({ channelId, message });
				}
				changed = true;
			}

			return changed ? next : msgs;
		});

		if (addedMessages.length === 0) return;

		const channelList = get(channels);
		const currentChannelId = get(currentChannel);
		const currentUserRecord = get(currentUser);
		const myUsername = currentUserRecord?.username || null;
		const onlineUsers = get(users);
		const currentSocketId = this.socket?.id || null;
		const currentStableId = getSelfStableIdForSocketId(currentSocketId);

		for (const { channelId, message } of addedMessages) {
			const channel = channelList.find((entry) => entry.id === channelId);
			if (channel?.persistMessages) {
				void chatStorage.saveMessage(channelId, message).catch((error) => {
					console.warn('[SocketManager] Failed to persist message in IndexedDB:', error);
				});
			}

			const isCurrentUser =
				(currentSocketId !== null && message.userId === currentSocketId) ||
				(currentStableId !== null && message.userId === currentStableId);
			if (isCurrentUser) {
				continue;
			}

			const isCurrentChannelActive = currentChannelId === channelId;
			const isMention = messageMentionsUser(message, myUsername);
			const shouldNotify = document.hidden || !isCurrentChannelActive || isMention;
			const followPreference = getChannelFollowPreference(channelId);
			const shouldShowNotification =
				shouldNotify &&
				(!followPreference || followPreference.alertLevel === 'all' || isMention);
			let dmClickTarget: User | null = null;
			if (shouldShowNotification && channel?.type === 'dm') {
				if (channel.otherUser) {
					dmClickTarget = channel.otherUser;
				} else {
					const myStableId = currentUserRecord?.dbUserId ? `user-${currentUserRecord.dbUserId}` : currentUserRecord?.id;
					const otherStableId = (channel.members || []).find((id) => id !== myStableId);
					if (otherStableId?.startsWith('user-')) {
						const dbId = parseInt(otherStableId.substring(5), 10);
						dmClickTarget = onlineUsers.find((user) => user.dbUserId === dbId) || null;
					} else if (otherStableId) {
						dmClickTarget = onlineUsers.find((user) => user.id === otherStableId) || null;
					}
				}
			}

			if (shouldShowNotification) {
				showNotification(message, isCurrentUser, channel?.name, {
					isMention,
					isCurrentChannelActive,
					onClick: dmClickTarget
						? () => {
							currentChannel.set(channelId);
							dmPanelSignal.set({ channelId, otherUser: dmClickTarget });
						}
						: undefined
				});
			}

			if (!isCurrentUser && (!isCurrentChannelActive || document.hidden)) {
				this.incrementUnreadCount(channelId, message.id);
			}

			if (channel && isChannelFollowed(channelId)) {
				const { serverUrl, serverName } = getFollowSnapshotServerInfo();
				recordFollowedMessageActivity({
					serverUrl,
					serverName,
					channel,
					message,
					incrementUnread: !isCurrentUser && (!isCurrentChannelActive || document.hidden)
				});
			}
		}
	}

	private applyVoiceState(state: Record<string, VoiceChannelParticipant[]> | undefined): void {
		if (!state) return;
		voiceChannelMembers.set(state);

		const me = get(currentUser);
		const currentUserId = me?.id;
		const currentStableId = me?.dbUserId ? `user-${me.dbUserId}` : null;
		if (!currentUserId) return;

		const connectedChannel = Object.entries(state).find(([, members]) =>
			members.some(member =>
				member.userId === currentUserId ||
				member.socketId === currentUserId ||
				(currentStableId ? member.userId === currentStableId : false)
			)
		)?.[0] || null;

		activeVoiceChannel.set(connectedChannel);
	}

	private resolveCurrentUser(userList: User[], socketId?: string): User | null {
		if (socketId) {
			const bySocketId = userList.find(user => user.id === socketId);
			if (bySocketId) return bySocketId;
		}

		const existingCurrentUser = get(currentUser);
		if (existingCurrentUser?.dbUserId) {
			const byCurrentDbUserId = userList.find(user => user.dbUserId === existingCurrentUser.dbUserId);
			if (byCurrentDbUserId) return byCurrentDbUserId;
		}

		if (existingCurrentUser?.id) {
			const byCurrentId = userList.find(user => user.id === existingCurrentUser.id);
			if (byCurrentId) return byCurrentId;
		}

		const storedDbUserId = getStoredDbUserId();
		if (storedDbUserId) {
			const byStoredDbUserId = userList.find(user => user.dbUserId === storedDbUserId);
			if (byStoredDbUserId) return byStoredDbUserId;
		}

		if (this.username) {
			const byUsername = userList.filter(user => user.username === this.username);
			if (byUsername.length === 1) return byUsername[0];
		}

		return null;
	}

	private isSameUserIdentity(candidate: User, reference: User | null, socketId?: string): boolean {
		if (socketId && candidate.id === socketId) return true;
		if (!reference) return false;
		if (candidate.id === reference.id) return true;
		if (candidate.dbUserId && reference.dbUserId && candidate.dbUserId === reference.dbUserId) return true;
		return false;
	}

	// ==================== STATE MACHINE ====================

	private canTransition(to: ConnectionState): boolean {
		const valid = VALID_TRANSITIONS[this.state];
		return valid.includes(to);
	}

	private transition(to: ConnectionState): boolean {
		if (to === this.state) {
			// Idempotent transitions are expected during HMR/unmount churn.
			return true;
		}
		if (!this.canTransition(to)) {
			console.warn(`[SocketManager] Invalid transition: ${this.state} -> ${to}`);
			return false;
		}
		console.log(`[SocketManager] State: ${this.state} -> ${to}`);
		this.state = to;
		connectionState.set(to);
		connected.set(to === 'connected');
		return true;
	}

	// ==================== PUBLIC API ====================

	getSocket(): Socket | null {
		return this.socket;
	}

	getState(): ConnectionState {
		return this.state;
	}

	private isLocalServerUrl(serverUrl: string): boolean {
		try {
			const parsed = new URL(serverUrl);
			const host = parsed.hostname.toLowerCase();
			return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'tauri.localhost';
		} catch {
			return false;
		}
	}

	private applyConnectionProfile(serverUrl: string): void {
		if (this.isLocalServerUrl(serverUrl)) {
			// Local dev: fail fast + quicker retries.
			this.baseDelay = 250;
			this.maxDelay = 5000;
			this.reconnectJitterMs = 120;
			this.connectTimeoutMs = 8000;
			return;
		}

		this.baseDelay = 1000;
		this.maxDelay = 30000;
		this.reconnectJitterMs = 1000;
		this.connectTimeoutMs = 20000;
	}

	/**
	 * Initialize socket connection.
	 * Safe to call multiple times - will not create duplicates.
	 */
	connect(username: string, authToken?: string): Socket | null {
		if (!browser) return null;

		// Guard: If already connecting or connected with same credentials, reuse
		if (this.state === 'connecting') {
			console.log('[SocketManager] Connection in progress, returning existing socket');
			return this.socket;
		}

		if (this.state === 'connected' && this.socket && this.username === username) {
			console.log('[SocketManager] Already connected with same username');
			return this.socket;
		}

		// Validate state transition
		if (!this.canTransition('connecting')) {
			console.warn(`[SocketManager] Cannot connect from state: ${this.state}`);
			// Force reset if stuck
			this.forceReset();
		}

		this.transition('connecting');
		this.username = username;
		this.authToken = authToken || null;

		// Clean up any existing socket BEFORE creating new one
		this.destroySocket();

		// Determine server URL
		let serverUrl = getServerUrl();
		this.applyConnectionProfile(serverUrl);

		// Get auth credentials safely
		const { token, sessionId } = this.getAuthCredentials(authToken);

		console.log('[SocketManager] Connecting to:', serverUrl, token ? '(token)' : sessionId ? '(session)' : '(new)');

		// Create socket with cross-browser optimized settings
		this.socket = io(serverUrl, {
			// WebSocket preferred, polling fallback for reliability across browsers
			transports: ['websocket', 'polling'],

			// Disable Socket.IO's auto-reconnect - we handle it manually
			// for better control over backoff and state
			reconnection: false,

			// Connection timeouts
			timeout: this.connectTimeoutMs,

			// CORS
			withCredentials: true,

			// Auth payload
			auth: {
				token: token || undefined,
				sessionId: !token ? sessionId || undefined : undefined
			},

			// Force new connection (prevents stale connection reuse)
			forceNew: true
		});

		// Bind all event listeners
		this.bindEventListeners();

		// Update store
		socket.set(this.socket);

		return this.socket;
	}

	/**
	 * Disconnect and clean up everything.
	 */
	disconnect(): void {
		console.log('[SocketManager] Disconnect requested');
		this.cancelReconnect();
		this.stopHeartbeat();
		this.destroySocket();
		this.username = '';
		this.authToken = null;
		this.reconnectAttempts = 0;
		this.transition('disconnected');
		activeVoiceChannel.set(null);
		voiceChannelMembers.set({});
	}

	/**
	 * Force reset from any state (recovery mechanism).
	 */
	forceReset(): void {
		console.log('[SocketManager] Force reset');
		this.cancelReconnect();
		this.stopHeartbeat();
		this.destroySocket();
		this.state = 'disconnected';
		connectionState.set('disconnected');
		connected.set(false);
		this.reconnectAttempts = 0;
		activeVoiceChannel.set(null);
		voiceChannelMembers.set({});
	}

	/**
	 * Emit an event if connected.
	 */
	emit(event: string, ...args: unknown[]): void {
		if (this.socket?.connected) {
			this.socket.emit(event, ...args);
		} else {
			console.warn(`[SocketManager] Cannot emit '${event}' - not connected (state: ${this.state})`);
		}
	}

	// ==================== PRIVATE: Socket Lifecycle ====================

	private destroySocket(): void {
		if (this.incomingMessageFlushHandle !== null) {
			if (browser && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function' && typeof this.incomingMessageFlushHandle === 'number') {
				window.cancelAnimationFrame(this.incomingMessageFlushHandle);
			} else {
				clearTimeout(this.incomingMessageFlushHandle as ReturnType<typeof setTimeout>);
			}
			this.incomingMessageFlushHandle = null;
		}
		this.pendingIncomingMessages.clear();

		if (this.socket) {
			// Remove all listeners to prevent memory leaks
			// This is safe because we're about to destroy the socket
			this.socket.removeAllListeners();
			this.boundListeners.clear();

			// Disconnect
			try {
				this.socket.disconnect();
			} catch (e) {
				// Ignore disconnect errors
			}

			this.socket = null;
		}
		socket.set(null);
	}

	private getAuthCredentials(providedToken?: string): { token: string | null; sessionId: string | null } {
		let token: string | null = null;
		let sessionId: string | null = null;

		try {
			token = providedToken || getAuthToken();
			if (!token) {
				sessionId = getGuestSessionId();
			}
		} catch (e) {
			console.warn('[SocketManager] Failed to resolve auth credentials:', e);
		}

		return { token, sessionId };
	}

	// ==================== PRIVATE: Reconnection ====================

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;

		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			console.error('[SocketManager] Max reconnection attempts reached');
			this.transition('failed');
			authStore.setAuthError('Connection lost. Please refresh the page.', 'connection_lost');
			return;
		}

		// Must be in a state that allows reconnecting
		if (this.state !== 'reconnecting' && !this.transition('reconnecting')) {
			return;
		}

		// Exponential backoff with jitter
		const delay = Math.min(
			this.baseDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * this.reconnectJitterMs,
			this.maxDelay
		);

		this.reconnectAttempts++;
		console.log(`[SocketManager] Reconnect attempt ${this.reconnectAttempts} in ${Math.round(delay)}ms`);

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.username && this.state === 'reconnecting') {
				this.connect(this.username, this.authToken || undefined);
			}
		}, delay);
	}

	private cancelReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	// ==================== PRIVATE: Heartbeat ====================

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.lastPong = Date.now();

		this.heartbeatInterval = setInterval(() => {
			if (!this.socket?.connected) {
				this.stopHeartbeat();
				return;
			}

			// Check if we've received a pong recently
			const elapsed = Date.now() - this.lastPong;
			if (elapsed > this.heartbeatTimeoutMs) {
				console.warn('[SocketManager] Heartbeat timeout, connection may be dead');
				// Don't force disconnect - Socket.IO will handle it
				// But this helps detect zombie connections faster
			}
		}, this.heartbeatIntervalMs);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}
	}

	// ==================== PRIVATE: Event Listeners ====================

	private bindEventListeners(): void {
		if (!this.socket) return;

		const sock = this.socket;

		// Clear any existing listeners and tracking
		sock.removeAllListeners();
		this.boundListeners.clear();

		// ==================== CONNECTION EVENTS ====================

		sock.on('connect', () => {
			console.log('[SocketManager] Connected, socket.id:', sock.id);

			this.transition('connected');
			this.reconnectAttempts = 0;
			this.startHeartbeat();

			// Send join/rejoin
			const { sessionId } = this.getAuthCredentials();
			if (sessionId && !this.authToken) {
				console.log('[SocketManager] Rejoin with sessionId');
				sock.emit('rejoin', sessionId);
			} else {
				console.log('[SocketManager] Join as:', this.username);
				sock.emit('join', this.username);
			}
		});

		sock.on('connect_error', (error) => {
			const msg = error?.message || String(error);
			console.error('[SocketManager] Connect error:', msg);

			// Classify error
			const errorInfo = this.classifyError(msg);

			// Non-recoverable errors
			if (errorInfo.fatal) {
				this.transition('failed');
				authStore.setAuthError(errorInfo.userMessage, errorInfo.errorType as any);
				return;
			}

			// Recoverable - schedule reconnect
			if (this.canTransition('reconnecting')) {
				this.scheduleReconnect();
			}
		});

		sock.on('disconnect', (reason, details) => {
			console.log('[SocketManager] Disconnected:', reason, details);

			this.stopHeartbeat();

			// Handle based on disconnect reason
			// See: https://socket.io/docs/v4/client-socket-instance/#disconnect
			switch (reason) {
				case 'io server disconnect':
					// Server kicked us - don't auto-reconnect
					this.transition('disconnected');
					break;

				case 'io client disconnect':
					// We called disconnect() - don't reconnect
					this.transition('disconnected');
					break;

				case 'ping timeout':
				case 'transport close':
				case 'transport error':
					// Connection lost - try to reconnect
					if (this.canTransition('reconnecting')) {
						this.scheduleReconnect();
					}
					break;

				default:
					// Unknown reason - attempt reconnect
					console.warn('[SocketManager] Unknown disconnect reason:', reason);
					if (this.canTransition('reconnecting')) {
						this.scheduleReconnect();
					}
			}
		});

		// Socket.IO engine events for debugging
		if (sock.io?.engine) {
			sock.io.engine.on('upgrade', (transport) => {
				console.log('[SocketManager] Transport upgraded to:', transport.name);
			});

			sock.io.engine.on('packet', () => {
				// Update last pong time on any packet received
				this.lastPong = Date.now();
			});
		}

		// ==================== SESSION EVENTS ====================

		sock.on('rejoin-failed', (data: { reason: string }) => {
			console.log('[SocketManager] Rejoin failed:', data.reason);
			clearGuestSessionId();
			sock.emit('join', this.username);
		});

		sock.on('init', async (data: {
			channels: Channel[];
			users: User[];
			serverMembers?: User[];
			excalidrawState: any;
			emotes: any[];
			emojis?: Emoji[];
			roleDefinitions?: RoleDefinition[];
			voiceState?: Record<string, VoiceChannelParticipant[]>;
			sessionId?: string;
			messagePurgeVersion?: number;
		}) => {
			console.log('[SocketManager] Init received');

			// Save session ID
			if (data.sessionId) {
				setGuestSessionId(data.sessionId);
			}

			users.set(data.users);
			if (data.serverMembers) serverMembers.set(data.serverMembers);

			// Process channels - server now enriches DM channels with otherUser
			const processedChannels = data.channels.map(channel => {
				if (channel.type === 'dm') {
					// Server provides otherUser; use it if available
					if (channel.otherUser) {
						return { ...channel, name: channel.otherUser.username };
					}
					// Fallback: try to resolve from online users list
					if (channel.members) {
						const selfStableId = getSelfStableIdForSocketId(sock.id);
						const otherUserId = channel.members.find(id => id !== selfStableId);
						let otherUser = data.users.find(u => u.id === otherUserId);
						if (!otherUser && otherUserId?.startsWith('user-')) {
							const dbId = Number.parseInt(otherUserId.substring(5), 10);
							otherUser =
								data.users.find(u => u.dbUserId === dbId) ||
								data.serverMembers?.find(u => u.dbUserId === dbId);
						}
						if (otherUser) {
							return { ...channel, name: otherUser.username, otherUser: { ...otherUser } };
						}
					}
				}
				return channel;
			});

			channels.set(processedChannels);
			await this.reconcileMessagePurgeVersion(data.messagePurgeVersion);
			this.loadMessagesWithPagination(processedChannels);

			if (data.emotes) initEmotes(data.emotes);
			if (data.emojis) emojis.set(data.emojis);
			if (data.roleDefinitions) roleDefinitions.set(data.roleDefinitions);
			this.applyVoiceState(data.voiceState);

			const user = this.resolveCurrentUser(data.users, sock.id);
			if (user) {
				currentUser.set(user);
				setStoredUsername(user.username || this.username);
				setStoredDbUserId(user.dbUserId ?? null);
				recordSuccessfulServerConnection({
					url: getServerUrl(),
					username: user.username || this.username,
					dbUserId: user.dbUserId ?? null
				});
				this.updatePinnedChannels();
			} else {
				console.warn('[SocketManager] Could not resolve current user from init payload');
				recordSuccessfulServerConnection({
					url: getServerUrl(),
					username: this.username,
					dbUserId: getStoredDbUserId()
				});
			}

			// On reconnect, sync newer messages for the current channel
			if (this.reconnectAttempts > 0) {
				const currentChan = get(currentChannel);
				const msgs = get(channelMessages)[currentChan];
				if (msgs && msgs.length > 0) {
					const newestMsg = msgs[msgs.length - 1];
					console.log(`[SocketManager] Reconnect: syncing messages after ${newestMsg.id}`);
					sock.emit('load-history', {
						channelId: currentChan,
						afterMessageId: newestMsg.id,
						limit: 100
					});
				}
			}

			const pendingChannelId = consumePendingChannelNavigation(getServerUrl());
			const initialChannelId =
				(pendingChannelId && processedChannels.some((channel) => channel.id === pendingChannelId)
					? pendingChannelId
					: processedChannels.some((channel) => channel.id === 'general')
						? 'general'
						: processedChannels[0]?.id) || 'general';
			currentChannel.set(initialChannelId);
			mobileTabQueue.setActiveChannel(initialChannelId);
			markChannelAsRead(initialChannelId);
			sock.emit('join-channel', initialChannelId);
			sock.emit('get-emojis');
			sock.emit('get-role-definitions');
		});

		sock.on('emojis-list', (data: Emoji[]) => {
			emojis.set(data || []);
		});

		sock.on('role-definitions-updated', (data: { roles: RoleDefinition[] }) => {
			roleDefinitions.set(data.roles || []);
		});

		sock.on('voice-state', (data: { voiceState: Record<string, VoiceChannelParticipant[]> }) => {
			this.applyVoiceState(data.voiceState);
		});

		sock.on('voice-channel-state', (data: { channelId: string; members: VoiceChannelParticipant[] }) => {
			voiceChannelMembers.update(state => ({
				...state,
				[data.channelId]: data.members || []
			}));
			this.applyVoiceState(get(voiceChannelMembers));
		});

		sock.on('voice-channel-joined', (data: { channelId: string; members?: VoiceChannelParticipant[]; user?: VoiceChannelParticipant }) => {
			voiceChannelMembers.update(state => {
				if (data.members) {
					return { ...state, [data.channelId]: data.members };
				}
				if (!data.user) return state;
				const existing = state[data.channelId] || [];
				if (existing.some(member => member.userId === data.user?.userId)) return state;
				return { ...state, [data.channelId]: [...existing, data.user] };
			});
			this.applyVoiceState(get(voiceChannelMembers));
		});

		sock.on('voice-channel-left', (data: { channelId: string; userId: string; members?: VoiceChannelParticipant[] }) => {
			voiceChannelMembers.update(state => {
				if (data.members) {
					return { ...state, [data.channelId]: data.members };
				}
				const existing = state[data.channelId] || [];
				return {
					...state,
					[data.channelId]: existing.filter(member => member.userId !== data.userId)
				};
			});
			this.applyVoiceState(get(voiceChannelMembers));
		});

		sock.on('voice-channel-subscribed', (data: { channelId: string; members?: VoiceChannelParticipant[] }) => {
			voiceChannelMembers.update(state => ({
				...state,
				[data.channelId]: data.members || state[data.channelId] || []
			}));
			this.applyVoiceState(get(voiceChannelMembers));
		});

		// ==================== MESSAGE EVENTS ====================

		sock.on('channel-messages', async (data: { channelId: string; messages: Message[]; hasMore?: boolean }) => {
			// Decrypt encrypted messages in DM channels
			await decryptMessagesForChannel(data.channelId, data.messages);

			channelMessages.update(msgs => {
				const existing = msgs[data.channelId] || [];
				if (data.messages.length === 0) {
					return { ...msgs, [data.channelId]: [] };
				}

				// Server channel-messages payload is authoritative for latest window.
				// Keep older local history, replace overlapping window with server snapshot.
				const serverIds = new Set(data.messages.map(m => m.id));
				const minServerTs = Math.min(...data.messages.map(m => m.timestamp));
				const olderLocal = existing.filter(m => m.timestamp < minServerTs && !serverIds.has(m.id));
				return { ...msgs, [data.channelId]: [...olderLocal, ...data.messages] };
			});

			void chatStorage.reconcileChannelWindow(data.channelId, data.messages).catch((error) => {
				console.warn('[SocketManager] Failed snapshot reconciliation in IndexedDB:', error);
			});

			const snapshotChannel = get(channels).find((channel) => channel.id === data.channelId);
			if (snapshotChannel && isChannelFollowed(data.channelId)) {
				const { serverUrl, serverName } = getFollowSnapshotServerInfo();
				syncFollowedChannelSnapshot(
					serverUrl,
					serverName,
					snapshotChannel,
					get(channelMessages)[data.channelId] || data.messages,
					get(channelUnreadCounts)[data.channelId] || 0
				);
			}

			// Initialize pagination state from server response
			if (data.hasMore !== undefined) {
				channelHasMoreHistory.update(s => ({ ...s, [data.channelId]: data.hasMore }));
			}
			if (data.messages.length > 0) {
				channelOldestMessageId.update(s => ({ ...s, [data.channelId]: data.messages[0].id }));
			}
		});

		// Handle server-side history loading response
		sock.on('history-loaded', async (data: {
			channelId: string;
			messages: Message[];
			hasMore: boolean;
			direction: 'older' | 'newer' | 'initial';
		}) => {
			// Decrypt encrypted messages in DM channels
			await decryptMessagesForChannel(data.channelId, data.messages);

			channelMessages.update(msgs => {
				const existing = msgs[data.channelId] || [];
				const existingIds = new Set(existing.map(m => m.id));
				const newMsgs = data.messages.filter(m => !existingIds.has(m.id));

				if (data.direction === 'older') {
					// Prepend older messages
					return { ...msgs, [data.channelId]: [...newMsgs, ...existing] };
				} else if (data.direction === 'newer') {
					// Append newer messages
					return { ...msgs, [data.channelId]: [...existing, ...newMsgs] };
				} else {
					// Initial load - replace if empty, merge if not
					if (existing.length === 0) {
						return { ...msgs, [data.channelId]: newMsgs };
					}
					return { ...msgs, [data.channelId]: [...newMsgs, ...existing] };
				}
			});

			// Update pagination state
			channelHasMoreHistory.update(s => ({ ...s, [data.channelId]: data.hasMore }));
			channelHistoryLoading.update(s => ({ ...s, [data.channelId]: false }));

			const snapshotChannel = get(channels).find((channel) => channel.id === data.channelId);
			if (snapshotChannel && isChannelFollowed(data.channelId)) {
				const { serverUrl, serverName } = getFollowSnapshotServerInfo();
				syncFollowedChannelSnapshot(
					serverUrl,
					serverName,
					snapshotChannel,
					get(channelMessages)[data.channelId] || data.messages,
					get(channelUnreadCounts)[data.channelId] || 0
				);
			}

			// Track oldest message for pagination
			if (data.messages.length > 0 && (data.direction === 'older' || data.direction === 'initial')) {
				const oldestMsg = data.messages[0];
				channelOldestMessageId.update(s => ({ ...s, [data.channelId]: oldestMsg.id }));
			}

			console.log(`[SocketManager] History loaded: ${data.messages.length} messages for ${data.channelId} (${data.direction})`);
		});

		sock.on('message', async (data: { channelId: string; message: Message }) => {
			// Validate incoming message
			if (!data?.channelId || !data?.message?.id) {
				console.warn('[SocketManager] Received malformed message:', data);
				return;
			}

			// Decrypt single encrypted message in DM channels
			if (data.message.encrypted && data.message.iv) {
				await decryptMessagesForChannel(data.channelId, [data.message]);
			}

			this.queueIncomingMessage(data.channelId, data.message);
		});

		sock.on('message-edited', (data: { channelId: string; messageId: string; newText: string }) => {
			channelMessages.update(msgs => ({
				...msgs,
				[data.channelId]: (msgs[data.channelId] || []).map(msg =>
					msg.id === data.messageId ? { ...msg, text: data.newText, isEdited: true, entities: [] } : msg
				)
			}));
		});

		sock.on('message-persist-failed', (data: {
			channelId: string;
			messageId: string;
			error?: string;
			detail?: string;
			attempts?: number;
		}) => {
			console.warn(
				`[SocketManager] Message ${data.messageId} failed to persist: ${data.detail || data.error || 'unknown error'}`
			);
			channelMessages.update(msgs => ({
				...msgs,
				[data.channelId]: (msgs[data.channelId] || []).map(msg =>
					msg.id === data.messageId
						? {
							...msg,
							persistenceState: 'failed',
							persistenceError: data.error || 'Message was shown, but it was not saved.',
							persistenceAttempts: Math.max(1, Math.floor(data.attempts || 1))
						}
						: msg
				)
			}));

			void chatStorage.deleteMessage(data.channelId, data.messageId).catch((error) => {
				console.warn('[SocketManager] Failed to remove unsaved message from IndexedDB:', error);
			});
		});

		sock.on('message-persisted', (data: { channelId: string; messageId: string; attempts?: number }) => {
			let persistedMessage: Message | null = null;
			channelMessages.update(msgs => {
				const channelMsgs = msgs[data.channelId] || [];
				return {
					...msgs,
					[data.channelId]: channelMsgs.map(msg => {
						if (msg.id !== data.messageId) return msg;
						const nextMessage: Message = {
							...msg,
							persistenceState: undefined,
							persistenceError: undefined,
							persistenceAttempts: undefined
						};
						persistedMessage = nextMessage;
						return nextMessage;
					})
				};
			});

			if (!persistedMessage) return;
			const channel = get(channels).find((entry) => entry.id === data.channelId);
			if (!channel?.persistMessages) return;
			void chatStorage.saveMessage(data.channelId, persistedMessage).catch((error) => {
				console.warn('[SocketManager] Failed to save retried message to IndexedDB:', error);
			});
		});

		sock.on('message-deleted', (data: { channelId: string; messageId: string }) => {
			channelMessages.update(msgs => ({
				...msgs,
				[data.channelId]: (msgs[data.channelId] || []).filter(msg => msg.id !== data.messageId)
			}));

			void chatStorage.deleteMessage(data.channelId, data.messageId).catch((error) => {
				console.warn('[SocketManager] Failed to remove deleted message from IndexedDB:', error);
			});
		});

		sock.on('messages-cleared', (data?: { scope?: string; messagePurgeVersion?: number }) => {
			channelMessages.update(msgs => {
				const cleared: Record<string, Message[]> = {};
				for (const key of Object.keys(msgs)) {
					cleared[key] = [];
				}
				if (!('general' in cleared)) {
					cleared.general = [];
				}
				return cleared;
			});
			channelAvailableArchives.set({});
			channelLoadedArchives.set({});
			channelHasMoreHistory.set({});
			channelOldestMessageId.set({});
			channelUnreadCounts.set({});
			unreadCount.set(0);
			lastReadMessageId.set(null);

			// Keep browser persistence aligned with server purge across all connected clients.
			void (async () => {
				try {
					await chatStorage.clearAllHistory();
				} catch (error) {
					console.warn('[SocketManager] Failed to clear IndexedDB after messages-cleared:', error);
				}
			})();

			this.safeLocalStorageRemove('channelUnreadCounts');
			this.safeLocalStorageRemove('unreadCount');
			this.safeLocalStorageRemove('lastReadMessageId');
			if (typeof data?.messagePurgeVersion === 'number' && Number.isFinite(data.messagePurgeVersion)) {
				this.setStoredMessagePurgeVersion(data.messagePurgeVersion);
			}
		});

		sock.on('message-pin-toggled', (data: { channelId: string; messageId: string; isPinned: boolean }) => {
			channelMessages.update(msgs => ({
				...msgs,
				[data.channelId]: (msgs[data.channelId] || []).map(msg =>
					msg.id === data.messageId ? { ...msg, isPinned: data.isPinned } : msg
				)
			}));
		});

		// ==================== USER EVENTS ====================

		sock.on('user-joined', (user: User) => {
			users.update(existingUsers => {
				const existingIndex = existingUsers.findIndex(existing =>
					existing.id === user.id ||
					(!!user.dbUserId && existing.dbUserId === user.dbUserId)
				);
				if (existingIndex === -1) return [...existingUsers, user];
				return existingUsers.map((existing, index) => index === existingIndex ? user : existing);
			});

			currentUser.update(existingCurrentUser =>
				this.isSameUserIdentity(user, existingCurrentUser, sock.id) ? user : existingCurrentUser
			);
		});

		sock.on('user-left', (data: { id: string; username: string; dbUserId?: number; joinedAt?: number | null }) => {
			users.update(existingUsers => existingUsers.filter(user => {
				const sameUser =
					user.id === data.id ||
					(!!data.dbUserId && !!user.dbUserId && user.dbUserId === data.dbUserId);
				if (!sameUser) return true;
				if (typeof data.joinedAt === 'number' && typeof user.joinedAt === 'number' && user.joinedAt !== data.joinedAt) {
					return true;
				}
				return false;
			}));
		});

		sock.on('typing', (data: { channelId: string; usernames: string[] }) => {
			typingUsers.update(u => ({
				...u,
				[data.channelId]: data.usernames || []
			}));
		});

		sock.on('profile-updated', (user: User) => {
			users.update(existingUsers => existingUsers.map(existing =>
				existing.id === user.id ||
				(!!user.dbUserId && existing.dbUserId === user.dbUserId)
					? user
					: existing
			));
			if (user.dbUserId) {
				serverMembers.update(members => members.map(m =>
					m.dbUserId === user.dbUserId
						? { ...m, username: user.username, handle: user.handle, color: user.color, profilePicture: user.profilePicture, roles: user.roles, highestRole: user.highestRole, roleColor: user.roleColor }
						: m
				));
			}

			const isCurrentUser = this.isSameUserIdentity(user, get(currentUser), sock.id);
			if (isCurrentUser) {
				currentUser.set(user);
				this.username = user.username;
				this.safeLocalStorageSet('username', user.username);
			} else {
				currentUser.update(existingCurrentUser =>
					this.isSameUserIdentity(user, existingCurrentUser, sock.id) ? user : existingCurrentUser
				);
			}
		});

		// ==================== CHANNEL EVENTS ====================

		sock.on('channel-created', (channel: Channel) => {
			let processedChannel = channel;
			if (channel.type === 'dm') {
				// Server may provide otherUser directly
				if (channel.otherUser) {
					processedChannel = { ...channel, name: channel.otherUser.username };
				} else if (channel.members) {
					const userList = get(users);
					const selfStableId = getSelfStableIdForSocketId(sock.id);
					const otherUserId = channel.members.find(id => id !== selfStableId);
					let otherUser = userList.find(u => u.id === otherUserId);
					if (!otherUser && otherUserId?.startsWith('user-')) {
						const dbId = Number.parseInt(otherUserId.substring(5), 10);
						otherUser =
							userList.find(u => u.dbUserId === dbId) ||
							get(serverMembers).find(u => u.dbUserId === dbId);
					}
					if (otherUser) {
						processedChannel = { ...channel, name: otherUser.username, otherUser: { ...otherUser } };
					}
				}
			}
			channels.update(chs => {
				if (chs.some(existing => existing.id === processedChannel.id)) return chs;
				return [...chs, processedChannel];
			});
			channelMessages.update(msgs => ({
				...msgs,
				[processedChannel.id]: msgs[processedChannel.id] || []
			}));
		});

		sock.on('channel-deleted', (channelId: string) => {
			channels.update(chs => chs.filter(ch => ch.id !== channelId));
			channelMessages.update(msgs => {
				const newMsgs = { ...msgs };
				delete newMsgs[channelId];
				return newMsgs;
			});
			currentChannel.update(ch => ch === channelId ? 'general' : ch);
		});

		sock.on('channel-pinned', (data: { channelId: string; channel: Channel }) => {
			channels.update(chs => chs.map(ch => ch.id === data.channelId ? data.channel : ch));
			this.updatePinnedChannels();
		});

		sock.on('channel-unpinned', (data: { channelId: string; channel: Channel }) => {
			channels.update(chs => chs.map(ch => ch.id === data.channelId ? data.channel : ch));
			this.updatePinnedChannels();
		});

		sock.on('channel-error', (error: string) => {
			console.error('[SocketManager] Channel error:', error);
			alert(error);
		});

		sock.on('channel-settings-updated', (data: {
			channelId: string;
			autoDeleteAfter?: '5s' | '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
			persistMessages?: boolean;
			description?: string;
			watchQueueEnabled?: boolean;
			minRole?: string;
			name?: string;
			voiceSettings?: VoiceChannelSettings;
		}) => {
			channels.update(chs => chs.map(ch =>
				ch.id === data.channelId
					? {
						...ch,
						...(data.autoDeleteAfter !== undefined ? { autoDeleteAfter: data.autoDeleteAfter } : {}),
						...(data.persistMessages !== undefined ? { persistMessages: data.persistMessages } : {}),
						...(data.minRole !== undefined ? { minRole: data.minRole } : {}),
						...(data.description !== undefined ? { description: data.description } : {}),
						...(data.watchQueueEnabled !== undefined ? { watchQueueEnabled: data.watchQueueEnabled } : {}),
						...(data.name !== undefined ? { name: data.name } : {}),
						...(data.voiceSettings !== undefined ? { voiceSettings: data.voiceSettings } : {})
					}
					: ch
			));

			const updatedChannel = getChannelById(data.channelId);
			if (!updatedChannel || !isFocusedAudioChannel(updatedChannel)) return;

			const primaryChannelId = getPrimaryCallingChannelId();
			if (primaryChannelId === data.channelId) {
				enforceFocusedAudioState(sock, data.channelId);
				return;
			}

			if (get(calling.listeningVoiceChannels).includes(data.channelId)) {
				calling.removeVoiceChannelListen(sock, data.channelId);
				alert(`Focused audio was enabled for ${updatedChannel.name}. It can no longer be a secondary listen-in channel.`);
			}
		});

		// ==================== DM/GROUP EVENTS ====================

		sock.on('dm-created', (data: { channelId: string; otherUser: User }) => {
			const dmChannel: Channel = {
				id: data.channelId,
				name: data.otherUser.username,
				createdAt: Date.now(),
				type: 'dm',
				otherUser: data.otherUser
			};

			channels.update(chs => {
				if (chs.some(ch => ch.id === data.channelId)) return chs;
				return [...chs, dmChannel];
			});

			channelMessages.update(msgs => ({
				...msgs,
				[data.channelId]: msgs[data.channelId] || []
			}));

			dmPanelSignal.set({ channelId: data.channelId, otherUser: data.otherUser });
		});

		sock.on('dm-channel-added', (data: { channelId: string; otherUser: User }) => {
			const dmChannel: Channel = {
				id: data.channelId,
				name: data.otherUser.username,
				createdAt: Date.now(),
				type: 'dm',
				otherUser: data.otherUser
			};

			channels.update(chs => {
				if (chs.some(ch => ch.id === data.channelId)) return chs;
				return [...chs, dmChannel];
			});

			channelMessages.update(msgs => ({
				...msgs,
				[data.channelId]: msgs[data.channelId] || []
			}));
		});

		sock.on('dm-deleted', (data: { channelId: string }) => {
			channels.update(chs => chs.filter(ch => ch.id !== data.channelId));
			channelMessages.update(msgs => {
				const newMsgs = { ...msgs };
				delete newMsgs[data.channelId];
				return newMsgs;
			});
			currentChannel.update(ch => ch === data.channelId ? 'general' : ch);
		});

		sock.on('user-role-changed', (data: {
			userId: string;
			dbUserId: number;
			roles: string[];
			highestRole: string;
			roleColor: string | null;
		}) => {
			users.update(u => u.map(existing =>
				existing.id === data.userId ||
				(!!existing.dbUserId && existing.dbUserId === data.dbUserId)
					? { ...existing, roles: data.roles, highestRole: data.highestRole, roleColor: data.roleColor }
					: existing
			));
			serverMembers.update(members =>
				members.map(existing =>
					!!existing.dbUserId && existing.dbUserId === data.dbUserId
						? { ...existing, roles: data.roles, highestRole: data.highestRole, roleColor: data.roleColor }
						: existing
				)
			);
			currentUser.update(cu =>
				cu && (cu.id === data.userId || (!!cu.dbUserId && cu.dbUserId === data.dbUserId))
					? { ...cu, roles: data.roles, highestRole: data.highestRole, roleColor: data.roleColor }
					: cu
			);
		});

		sock.on('group-created', (group: Channel) => {
			channels.update(chs => {
				if (chs.some(ch => ch.id === group.id)) return chs;
				return [...chs, group];
			});
			channelMessages.update(msgs => ({
				...msgs,
				[group.id]: msgs[group.id] || []
			}));
		});

		sock.on('group-removed', (data: { channelId: string }) => {
			channels.update(chs => chs.filter(ch => ch.id !== data.channelId));
			channelMessages.update(msgs => {
				const newMsgs = { ...msgs };
				delete newMsgs[data.channelId];
				return newMsgs;
			});
		});

		sock.on('group-member-removed', (data: { channelId: string; userId: string }) => {
			channels.update(chs => chs.map(ch => {
				if (ch.id !== data.channelId) return ch;
				return {
					...ch,
					members: ch.members?.filter(id => id !== data.userId),
					memberUsers: ch.memberUsers?.filter(u => u.id !== data.userId && `user-${u.dbUserId}` !== data.userId)
				};
			}));
		});

		sock.on('group-member-added', (data: { channelId: string; userId?: string; user?: any }) => {
			channels.update(chs => chs.map(ch => {
				if (ch.id !== data.channelId) return ch;
				const stableId =
					data.user?.dbUserId ? `user-${data.user.dbUserId}` :
					(data.userId || data.user?.id);
				const existingMembers = ch.members || [];
				const nextMembers = stableId && !existingMembers.includes(stableId)
					? [...existingMembers, stableId]
					: existingMembers;
				const nextMemberUsers = data.user
					? (ch.memberUsers?.some(u =>
						u.id === data.user.id ||
						(!!u.dbUserId && !!data.user.dbUserId && u.dbUserId === data.user.dbUserId)
					)
						? ch.memberUsers
						: [...(ch.memberUsers || []), data.user])
					: ch.memberUsers;
				return {
					...ch,
					members: nextMembers,
					memberUsers: nextMemberUsers
				};
			}));
		});

		sock.on('group-avatar-updated', (data: { channelId: string; avatar: string | null }) => {
			channels.update(chs => chs.map(ch =>
				ch.id === data.channelId ? { ...ch, avatar: data.avatar } : ch
			));
		});

		// ==================== EMOTE/EMOJI EVENTS ====================

		sock.on('emote-added', (emote: any) => addEmote(emote));
		sock.on('emote-deleted', (emoteName: string) => removeEmote(emoteName));
		sock.on('emote-error', (error: string) => {
			console.error('[SocketManager] Emote error:', error);
			alert(error);
		});

		sock.on('reaction-added', (data: {
			channelId: string;
			messageId: string;
			emojiId: string;
			userId: string;
			reactions: Record<string, string[]>;
		}) => {
			channelMessages.update(msgs => ({
				...msgs,
				[data.channelId]: (msgs[data.channelId] || []).map(msg =>
					msg.id === data.messageId ? { ...msg, reactions: data.reactions } : msg
				)
			}));
		});

		sock.on('reaction-removed', (data: {
			channelId: string;
			messageId: string;
			emojiId: string;
			userId: string;
			reactions: Record<string, string[]>;
		}) => {
			channelMessages.update(msgs => ({
				...msgs,
				[data.channelId]: (msgs[data.channelId] || []).map(msg =>
					msg.id === data.messageId ? { ...msg, reactions: data.reactions } : msg
				)
			}));
		});

		sock.on('emoji-added', (emoji: Emoji) => {
			emojis.update(e => [...e, emoji]);
		});

		sock.on('emoji-deleted', (emojiName: string) => {
			emojis.update(e => e.filter(emoji => emoji.name !== emojiName));
		});

		// ==================== OFFLINE MESSAGE EVENTS ====================

		sock.on('offline-messages', (data: { channelId: string; messages: Message[] }) => {
			console.log(`[SocketManager] ${data.messages.length} offline messages for ${data.channelId}`);

			channelMessages.update(msgs => {
				const existing = msgs[data.channelId] || [];
				const existingIds = new Set(existing.map(m => m.id));
				const newMessages = data.messages.filter(m => !existingIds.has(m.id));
				return { ...msgs, [data.channelId]: [...existing, ...newMessages] };
			});

			showNotification({
				title: 'Offline Messages',
				body: `You have ${data.messages.length} new message${data.messages.length > 1 ? 's' : ''}`
			} as unknown as Message, false, '');
		});

		sock.on('message-queued', (data: { messageId: string }) => {
			console.log(`[SocketManager] Message ${data.messageId} queued for offline`);
		});

		// ==================== WEBRTC/CALLING EVENTS ====================

		sock.on('call-incoming', (data: { userId: string; username: string; isVideoCall: boolean; channelId?: string; channelName?: string }) => {
			if (data.channelId) {
				const channel = get(channels).find((entry) => entry.id === data.channelId);
				if (channel?.type === 'voice') {
					console.log(`[SocketManager] Voice channel join signal from ${data.username} for ${data.channelName || data.channelId}`);
					return;
				}
				console.log(`[SocketManager] Incoming group call from ${data.username} for ${data.channelName || data.channelId}`);
				calling.incomingCall.set(data);
				return;
			}

			console.log(`[SocketManager] Incoming call from ${data.username}`);
			calling.incomingCall.set(data);
		});

		sock.on('call-accepted', (data: { userId: string; username: string; isVideoCall: boolean }) => {
			console.log(`[SocketManager] Call accepted by ${data.username}`);
			if (!calling.beginEstablishedDirectCall()) {
				console.warn('[SocketManager] Ignoring call-accepted because no outgoing call is pending');
				return;
			}
			calling.createCallOffer(sock, data.userId, data.username)
				.catch(err => console.error('[SocketManager] createCallOffer failed:', err));
		});

		sock.on('call-rejected', () => {
			console.log('[SocketManager] Call rejected');
			calling.endCall(sock);
		});

		sock.on('call-cancelled', (data: { userId: string; channelId?: string }) => {
			console.log(`[SocketManager] Call cancelled by ${data.userId}`);
			calling.handleIncomingCallCancelled(data.userId, data.channelId);
		});

		sock.on('call-error', (data: { code?: string; message?: string; targetUserId?: string | null }) => {
			console.warn(
				`[SocketManager] Call error${data?.code ? ` (${data.code})` : ''}: ${data?.message || 'unknown error'}`
			);
			calling.endCall(sock);
		});

		sock.on('call-ended', (data: { userId: string }) => {
			console.log(`[SocketManager] Call ended with ${data.userId}`);
			if (get(calling.callMode) === 'direct') {
				calling.handleRemoteDirectCallEnded(data.userId);
				return;
			}
			calling.removeCall(data.userId);
			calling.removeScreenShare(data.userId);
		});

		sock.on('call-recording-presence', (data: {
			scope: 'direct' | 'group' | 'channel';
			channelId?: string;
			participants: Array<{ userId: string; socketId?: string; username?: string; profilePicture?: string }>;
		}) => {
			setRecordingPresence(data.scope, data.participants || [], data.channelId);
		});

		sock.on('call-offer', (data: { offer: RTCSessionDescriptionInit; senderId: string; username: string; channelId?: string }) => {
			if (data.channelId && calling.isSfuMediaTransportActive()) {
				return;
			}
			console.log(`[SocketManager] Call offer from ${data.username}`);
			calling.handleCallOffer(sock, data.senderId, data.username, data.offer, data.channelId)
				.catch(err => console.error('[SocketManager] handleCallOffer failed:', err));
		});

		sock.on('call-answer-sdp', (data: { answer: RTCSessionDescriptionInit; senderId: string }) => {
			console.log(`[SocketManager] Call answer from ${data.senderId}`);
			calling.handleCallAnswer(data.senderId, data.answer)
				.catch(err => console.error('[SocketManager] handleCallAnswer failed:', err));
		});

		sock.on('call-ice-candidate', (data: { candidate: RTCIceCandidateInit; senderId: string }) => {
			calling.handleCallIceCandidate(data.senderId, data.candidate);
		});

		sock.on('group-call-participant-joined', (data: { channelId: string; channelName?: string; userId: string; username: string; stableUserId?: string }) => {
			const me = get(currentUser);
			if (me?.id === data.userId || sock.id === data.userId) {
				return;
			}
			console.log(`[SocketManager] Group call participant joined ${data.channelId}: ${data.username}`);
			calling.handleGroupCallParticipantJoined(sock, data)
				.catch(err => console.error('[SocketManager] handleGroupCallParticipantJoined failed:', err));
		});

		sock.on('group-call-participant-left', (data: { channelId: string; userId: string }) => {
			const me = get(currentUser);
			if (me?.id === data.userId || sock.id === data.userId) {
				return;
			}
			console.log(`[SocketManager] Group call participant left ${data.channelId}: ${data.userId}`);
			calling.handleGroupCallParticipantLeft(data);
		});

		sock.on('group-call-invite-cleared', (data: { channelId: string; stableUserId: string; reason?: string }) => {
			console.log(`[SocketManager] Group call invite cleared ${data.channelId}: ${data.stableUserId}${data.reason ? ` (${data.reason})` : ''}`);
			calling.handleGroupCallInviteCleared(data);
		});

		sock.on('voice-channel-user-joined', (data: { channelId: string; userId: string; socketId?: string; username?: string }) => {
			const me = get(currentUser);
			if (me?.id === data.userId || sock.id === data.socketId) {
				return;
			}
			if (!get(calling.listeningVoiceChannels).includes(data.channelId)) {
				return;
			}

			const targetId = data.socketId || data.userId;
			console.log(`[SocketManager] Voice participant joined ${data.channelId}: ${data.username || data.userId}`);
			calling.handleVoiceParticipantJoined(targetId, data.username || '');
			if (calling.isSfuMediaTransportActive()) {
				return;
			}
			calling.createCallOffer(sock, targetId, data.username || '', { channelId: data.channelId })
				.catch(err => console.error('[SocketManager] voice-channel createCallOffer failed:', err));
		});

		sock.on('voice-channel-user-left', (data: { channelId: string; userId: string; socketId?: string }) => {
			const me = get(currentUser);
			const targetId = data.socketId || data.userId;
			if (me?.id === data.userId || sock.id === data.socketId) {
				return;
			}
			if (!get(calling.listeningVoiceChannels).includes(data.channelId)) {
				return;
			}
			console.log(`[SocketManager] Voice participant left ${data.channelId}: ${targetId}`);
			calling.handleVoiceParticipantLeft(targetId);
			if (calling.isSfuMediaTransportActive()) {
				return;
			}
			calling.removeCall(targetId);
		});

		sock.on('screen-share-started', (data: { userId: string; username: string }) => {
			if (calling.isSfuMediaTransportActive()) {
				return;
			}
			console.log(`[SocketManager] ${data.username} started screen sharing`);
			sock.emit('request-screen-share', { sharerId: data.userId });
		});

		sock.on('screen-share-request', (data: { viewerId: string }) => {
			if (calling.isSfuMediaTransportActive()) {
				return;
			}
			console.log(`[SocketManager] Screen share request from ${data.viewerId}`);
			calling.createScreenShareOffer(sock, data.viewerId)
				.catch(err => console.error('[SocketManager] createScreenShareOffer failed:', err));
		});

		sock.on('screen-share-stopped', (data: { userId: string }) => {
			console.log(`[SocketManager] Screen share stopped: ${data.userId}`);
			calling.removeScreenShare(data.userId);
		});

		sock.on('webrtc-offer', (data: { offer: RTCSessionDescriptionInit; senderId: string; username: string }) => {
			if (calling.isSfuMediaTransportActive()) {
				return;
			}
			calling.handleScreenShareOffer(sock, data.senderId, data.username, data.offer)
				.catch(err => console.error('[SocketManager] handleScreenShareOffer failed:', err));
		});

		sock.on('webrtc-answer', (data: { answer: RTCSessionDescriptionInit; senderId: string }) => {
			if (calling.isSfuMediaTransportActive()) {
				return;
			}
			calling.handleScreenShareAnswer(data.senderId, data.answer)
				.catch(err => console.error('[SocketManager] handleScreenShareAnswer failed:', err));
		});

		sock.on('webrtc-ice-candidate', (data: { candidate: RTCIceCandidateInit; senderId: string }) => {
			if (calling.isSfuMediaTransportActive()) {
				return;
			}
			calling.handleScreenShareIceCandidate(data.senderId, data.candidate);
		});

		// P2P file transfer signaling
		sock.on('p2p-offer', (data: { transferId: string; senderId: string; senderUsername: string; offer: RTCSessionDescriptionInit; fileName: string; fileSize: number }) => {
			handleP2PIncomingOffer(data);
		});

		sock.on('p2p-answer', (data: { transferId: string; senderId: string; answer: RTCSessionDescriptionInit }) => {
			handleP2PAnswer(data).catch(err => console.error('[SocketManager] handleP2PAnswer failed:', err));
		});

		sock.on('p2p-ice-candidate', (data: { transferId: string; senderId: string; candidate: RTCIceCandidateInit }) => {
			handleP2PIceCandidate(data);
		});

		sock.on('payments:intent-updated', (data: {
			workspaceId: string;
			intentId: string;
			status: string;
			channelId: string | null;
			isDonation: boolean;
		}) => {
			emitPaymentRealtimeEvent('payments:intent-updated', data);
		});

		sock.on('payments:donations-updated', (data: {
			workspaceId: string;
			reason: string;
			intentId?: string | null;
			settlementId?: string | null;
			status?: string | null;
		}) => {
			emitPaymentRealtimeEvent('payments:donations-updated', data);
		});

		sock.on('payments:donations-admin-updated', (data: {
			workspaceId: string;
			reason: string;
			intentId?: string | null;
			settlementId?: string | null;
			status?: string | null;
		}) => {
			emitPaymentRealtimeEvent('payments:donations-admin-updated', data);
		});

		sock.on('manual-cash:updated', (data: {
			workspaceId: string;
			settlementId: string;
			channelId: string;
			status: string;
		}) => {
			emitPaymentRealtimeEvent('manual-cash:updated', data);
		});

		sock.on('payments:account-links-updated', (data: { workspaceId: string }) => {
			emitPaymentRealtimeEvent('payments:account-links-updated', data);
		});

		sock.on('payments:user-blocks-updated', (data: { workspaceId: string; userId?: number | null }) => {
			emitPaymentRealtimeEvent('payments:user-blocks-updated', data);
		});

		sock.on('payments:access-updated', (data: { workspaceId: string; userId?: number | null }) => {
			emitPaymentRealtimeEvent('payments:access-updated', data);
		});

		// Mark all listeners as bound
		this.boundListeners.add('all');
	}

	// ==================== PRIVATE: Error Classification ====================

	private classifyError(msg: string): { fatal: boolean; errorType: string; userMessage: string } {
		const msgLower = msg.toLowerCase();

		// Auth errors - fatal, don't retry
		if (msgLower.includes('session expired') || msgLower.includes('invalid token')) {
			return {
				fatal: true,
				errorType: 'auth_expired',
				userMessage: 'Your session has expired. Please log in again.'
			};
		}

		// CORS - fatal
		if (msgLower.includes('cors') || msgLower.includes('not allowed')) {
			return {
				fatal: true,
				errorType: 'cors_rejection',
				userMessage: 'Connection blocked by security policy.'
			};
		}

		// Network errors - recoverable
		if (msgLower.includes('xhr') || msgLower.includes('fetch') || msgLower.includes('networkerror')) {
			return {
				fatal: false,
				errorType: 'network',
				userMessage: 'Network error. Reconnecting...'
			};
		}

		// Transport errors - recoverable
		if (msgLower.includes('transport') || msgLower.includes('websocket')) {
			return {
				fatal: false,
				errorType: 'transport',
				userMessage: 'Connection interrupted. Reconnecting...'
			};
		}

		// Timeout - recoverable
		if (msgLower.includes('timeout')) {
			return {
				fatal: false,
				errorType: 'timeout',
				userMessage: 'Connection timed out. Reconnecting...'
			};
		}

		// Unknown - try to recover
		return {
			fatal: false,
			errorType: 'unknown',
			userMessage: `Connection error: ${msg}`
		};
	}

	// ==================== PRIVATE: Helpers ====================

	private safeLocalStorageGet(key: string): string | null {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}

	private safeLocalStorageSet(key: string, value: string): void {
		try {
			localStorage.setItem(key, value);
		} catch (e) {
			console.warn(`[SocketManager] Failed to save ${key}:`, e);
		}
	}

	private safeLocalStorageRemove(key: string): void {
		try {
			localStorage.removeItem(key);
		} catch (e) {
			console.warn(`[SocketManager] Failed to remove ${key}:`, e);
		}
	}

	private getStoredMessagePurgeVersion(): number {
		if (!browser) return 0;
		try {
			const raw = localStorage.getItem(MESSAGE_PURGE_VERSION_KEY);
			const parsed = raw ? Number.parseInt(raw, 10) : 0;
			return Number.isFinite(parsed) ? parsed : 0;
		} catch {
			return 0;
		}
	}

	private setStoredMessagePurgeVersion(version: number): void {
		if (!browser) return;
		try {
			localStorage.setItem(MESSAGE_PURGE_VERSION_KEY, String(version));
		} catch (e) {
			console.warn('[SocketManager] Failed to persist message purge version:', e);
		}
	}

	private async reconcileMessagePurgeVersion(serverVersion?: number): Promise<void> {
		if (!browser || typeof serverVersion !== 'number' || !Number.isFinite(serverVersion)) return;
		const localVersion = this.getStoredMessagePurgeVersion();
		if (localVersion >= serverVersion) return;

		try {
			await chatStorage.clearAllHistory();
		} catch (error) {
			console.warn('[SocketManager] Failed to clear IndexedDB during purge-version reconcile:', error);
		}

		channelMessages.set({ general: [] });
		channelAvailableArchives.set({});
		channelLoadedArchives.set({});
		channelHasMoreHistory.set({});
		channelOldestMessageId.set({});
		channelUnreadCounts.set({});
		unreadCount.set(0);
		lastReadMessageId.set(null);

		this.safeLocalStorageRemove('channelUnreadCounts');
		this.safeLocalStorageRemove('unreadCount');
		this.safeLocalStorageRemove('lastReadMessageId');
		this.setStoredMessagePurgeVersion(serverVersion);
	}

	private updatePinnedChannels(): void {
		const current = get(currentUser);
		const allChannels = get(channels);
		if (!current) return;

		const pinned = allChannels.filter(ch => ch.pinnedBy?.includes(current.id));
		pinnedChannels.set(pinned);
	}

	private async loadMessagesWithPagination(processedChannels: Channel[]): Promise<void> {
		const result = await chatStorage.loadAllMessages(processedChannels);

		if (Object.keys(result.messages).length > 0) {
			const deduped: Record<string, Message[]> = {};
			for (const [channelId, messages] of Object.entries(result.messages)) {
				const seen = new Set<string>();
				deduped[channelId] = messages.filter(msg => {
					if (seen.has(msg.id)) return false;
					seen.add(msg.id);
					return true;
				});
			}
			channelMessages.set(deduped);
		}

		const { serverUrl, serverName } = getFollowSnapshotServerInfo();
		for (const channel of processedChannels) {
			if (!isChannelFollowed(channel.id, serverUrl)) continue;
			const messages = get(channelMessages)[channel.id] || [];
			if (messages.length === 0) continue;
			syncFollowedChannelSnapshot(
				serverUrl,
				serverName,
				channel,
				messages,
				get(channelUnreadCounts)[channel.id] || 0
			);
		}

		const loadedArchives: Record<string, Set<string>> = {};
		for (const channelId of Object.keys(result.messages)) {
			const channelConfig = processedChannels.find(ch => ch.id === channelId);
			if (channelConfig?.persistMessages && result.availableArchives[channelId]) {
				loadedArchives[channelId] = new Set();
			}
		}

		channelLoadedArchives.set(loadedArchives);
		channelAvailableArchives.set(result.availableArchives);
	}

	private incrementUnreadCount(channelId: string, messageId: string): void {
		channelUnreadCounts.update(counts => {
			const newCounts = {
				...counts,
				[channelId]: (counts[channelId] || 0) + 1
			};
			this.safeLocalStorageSet('channelUnreadCounts', JSON.stringify(newCounts));
			return newCounts;
		});

		unreadCount.update(n => {
			if (n === 0) lastReadMessageId.set(messageId);
			return n + 1;
		});

		updateBrowserTitle();
	}
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const socketManager = new SocketManager();

// ============================================================================
// BROWSER CLEANUP - Handle page unload/navigation
// ============================================================================

if (browser) {
	// Clean disconnect on page unload
	window.addEventListener('beforeunload', () => {
		socketManager.disconnect();
	});

	// Handle visibility changes (optional: pause/resume)
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			// Page hidden - socket stays connected but we note it
			console.log('[SocketManager] Page hidden');
		} else {
			// Page visible - check connection health
			console.log('[SocketManager] Page visible');
			const state = socketManager.getState();
			if (state === 'disconnected' || state === 'failed') {
				// Could auto-reconnect here if desired
			}
		}
	});
}

// ============================================================================
// PUBLIC API FUNCTIONS (backwards-compatible)
// ============================================================================

export function getSocket(): Socket | null {
	return socketManager.getSocket();
}

export function initSocket(username: string, authToken?: string): Socket | null {
	return socketManager.connect(username, authToken);
}

export function disconnect(): void {
	socketManager.disconnect();
}

export function joinChannel(channelId: string): void {
	socketManager.emit('join-channel', channelId);
	currentChannel.set(channelId);
	// Ensure addon tabs (like full 3D viewport) relinquish focus when a channel is selected.
	mobileTabQueue.setActiveChannel(channelId);
	markChannelAsRead(channelId);
}

export function switchChannel(channelId: string): void {
	socketManager.emit('join-channel', channelId);
	currentChannel.set(channelId);
	mobileTabQueue.setActiveChannel(channelId);
	markChannelAsRead(channelId);
}

export async function joinVoiceChannel(channelId: string): Promise<void> {
	const sock = socketManager.getSocket();
	if (!sock) {
		throw new Error('Socket not connected');
	}
	const targetChannel = getChannelById(channelId);
	if (isFocusedAudioChannel(targetChannel)) {
		enforceFocusedAudioState(sock, channelId);
	}
	await calling.joinVoiceChannel(sock, channelId);
}

export async function leaveVoiceChannel(channelId: string): Promise<void> {
	const sock = socketManager.getSocket();
	if (!sock) {
		return;
	}
	await calling.leaveVoiceChannel(sock, channelId);
}

export function subscribeVoiceChannel(channelId: string): void {
	const sock = socketManager.getSocket();
	if (!sock) return;
	const targetChannel = getChannelById(channelId);
	const primaryChannel = getChannelById(getPrimaryCallingChannelId());
	if (isFocusedAudioChannel(primaryChannel) && primaryChannel?.id !== channelId) {
		alert(`${primaryChannel?.name || 'This voice channel'} is focused audio only. Leave it before listening elsewhere.`);
		return;
	}
	if (isFocusedAudioChannel(targetChannel) && getPrimaryCallingChannelId() !== channelId) {
		enforceFocusedAudioState(sock, channelId);
		void calling.joinVoiceChannel(sock, channelId).catch((error) => {
			console.error('Failed to switch into focused audio channel:', error);
		});
		return;
	}
	calling.addVoiceChannelListen(sock, channelId);
}

export function unsubscribeVoiceChannel(channelId: string): void {
	const sock = socketManager.getSocket();
	if (!sock) return;
	calling.removeVoiceChannelListen(sock, channelId);
}

export function setVoiceTransmitMode(mode: 'primary' | 'all-listening'): void {
	calling.setVoiceTransmitRoutingMode(mode);
}

export function createChannel(channelName: string, description?: string, channelType: 'text' | 'voice' = 'text'): void {
	socketManager.emit('create-channel', { name: channelName, description: description || '', channelType });
}

export function createBreakoutRooms(parentChannelId: string, roomCount = 2, autoAssign = true): void {
	socketManager.emit('create-breakout-rooms', { parentChannelId, roomCount, autoAssign });
}

export function closeBreakoutRooms(parentChannelId: string): void {
	socketManager.emit('close-breakout-rooms', { parentChannelId });
}

export function moveUserToBreakout(parentChannelId: string, targetUserId: string, toChannelId: string): void {
	socketManager.emit('move-user-to-breakout', { parentChannelId, targetUserId, toChannelId });
}

export function moveUserToVoiceChannel(targetUserId: string, toChannelId: string): void {
	socketManager.emit('move-user-to-voice-channel', { targetUserId, toChannelId });
}

export function createThread(parentChannelId: string, name: string, options?: {
	parentMessageId?: string;
	privateThread?: boolean;
	autoArchiveMinutes?: number;
}): void {
	socketManager.emit('thread:create', {
		parentChannelId,
		name,
		parentMessageId: options?.parentMessageId,
		privateThread: options?.privateThread || false,
		autoArchiveMinutes: options?.autoArchiveMinutes
	});
}

export function deleteChannel(channelId: string): void {
	socketManager.emit('delete-channel', channelId);
}

export async function sendMessage(channelId: string, text: string, type: 'text' | 'gif' | 'file' | 'emoji' | 'role_gate' = 'text', options?: {
	gifUrl?: string;
	emojiUrl?: string;
	emojiName?: string;
	fileUrl?: string;
	fileName?: string;
	fileSize?: number;
	files?: FileAttachment[];
	attachmentStorage?: {
		scheme: 'wabi-storage-v1';
		compressed: boolean;
		codec: 'identity' | 'gzip';
		originalSize: number;
		storedSize: number;
		atRestEncrypted: boolean;
	};
	attachmentEncryption?: {
		scheme: 'dm-e2ee-v1';
		iv: string;
		mimeType?: string;
		originalSize?: number;
	};
	replyTo?: string;
	isSpoiler?: boolean;
	roleGatePersist?: boolean;
	entities?: MessageEntity[];
}): Promise<void> {
	const payload: Record<string, any> = { channelId, text, type, ...options };
	const channel = get(channels).find(ch => ch.id === channelId);
	const isDM = channel?.type === 'dm';
	const dmPrivacyMode = isDM ? getDMPrivacyMode(channelId) : 'sealed';

	const confirmUnencryptedDmFallback = (): boolean => {
		if (!browser) return false;
		return window.confirm(
			'Encryption is unavailable for this DM right now. Send this message unencrypted (open mode) this time?'
		);
	};

	// DM text in sealed/private mode tries encryption first.
	// If encryption is unavailable/fails, require explicit user confirmation before plaintext fallback.
	if (type === 'text' && isDM && dmPrivacyMode !== 'open') {
		const otherDbUserId = channel ? resolveOtherDmDbUserId(channel) : null;
		if (!otherDbUserId || !isE2EAvailable()) {
			const allowPlaintext = confirmUnencryptedDmFallback();
			if (!allowPlaintext) return;
		}
		if (otherDbUserId && isE2EAvailable()) {
			const token = browser ? getAuthToken() : null;
			if (token) {
				const encrypted = await encryptDMMessage(text, otherDbUserId, token, options?.entities);
				if (encrypted) {
					payload.text = encrypted.text;
					payload.encrypted = encrypted.encrypted;
					payload.iv = encrypted.iv;
					delete payload.entities;
				} else {
					const allowPlaintext = confirmUnencryptedDmFallback();
					if (!allowPlaintext) return;
				}
			} else {
				const allowPlaintext = confirmUnencryptedDmFallback();
				if (!allowPlaintext) return;
			}
		}
	}

	// DM files in sealed/private mode must include attachment encryption metadata.
	if (type === 'file' && isDM && dmPrivacyMode !== 'open') {
		const singleEncrypted = !!options?.attachmentEncryption;
		const multiEncrypted = Array.isArray(options?.files) && options.files.length > 0
			? options.files.every((file) => !!file.attachmentEncryption)
			: false;
		if (!singleEncrypted && !multiEncrypted) {
			if (browser) {
				alert('This DM requires encrypted file upload (sealed/private mode). Upload was blocked.');
			}
			return;
		}
	}

	socketManager.emit('message', payload);
}

export function retryMessagePersistence(channelId: string, messageId: string): void {
	channelMessages.update(msgs => ({
		...msgs,
		[channelId]: (msgs[channelId] || []).map(msg =>
			msg.id === messageId
				? {
					...msg,
					persistenceState: 'retrying',
					persistenceError: undefined
				}
				: msg
		)
	}));
	socketManager.emit('retry-message-persist', { channelId, messageId });
}

export function editMessage(channelId: string, messageId: string, newText: string): void {
	socketManager.emit('edit-message', { channelId, messageId, newText });
}

export function deleteMessage(channelId: string, messageId: string): void {
	socketManager.emit('delete-message', { channelId, messageId });
}

export function togglePinMessage(channelId: string, messageId: string): void {
	socketManager.emit('toggle-pin-message', { channelId, messageId });
}

export function pinChannel(channelId: string): void {
	socketManager.emit('pin-channel', { channelId });
}

export function unpinChannel(channelId: string): void {
	socketManager.emit('unpin-channel', { channelId });
}

export function sendTyping(isTyping: boolean, channelId?: string): void {
	const chan = channelId || get(currentChannel);
	socketManager.emit('typing', { isTyping, channelId: chan });
}

export function updateProfile(
	status?: 'active' | 'away' | 'busy',
	profilePicture?: string,
	bannerUrl?: string,
	username?: string,
	callback?: (response: { success: boolean; error?: string }) => void
): void {
	socketManager.emit('update-profile', { status, profilePicture, bannerUrl, username }, callback);
}

export function markMessagesAsRead(): void {
	unreadCount.set(0);
	lastReadMessageId.set(null);
	updateBrowserTitle();
}

export function markChannelAsRead(channelId: string): void {
	channelUnreadCounts.update(counts => {
		const newCounts = { ...counts };
		const channelCount = newCounts[channelId] || 0;
		unreadCount.update(n => Math.max(0, n - channelCount));
		delete newCounts[channelId];
		return newCounts;
	});
	lastReadMessageId.set(null);

	if (browser) {
		try {
			const counts = get(channelUnreadCounts);
			localStorage.setItem('channelUnreadCounts', JSON.stringify(counts));
		} catch {
			// Ignore localStorage errors
		}
	}

	markFollowedChannelRead(getServerUrl(), channelId);
	updateBrowserTitle();
}

/**
 * Updates the browser tab title to reflect unread message count.
 * Single source of truth â€” called by both the SocketManager class and
 * the public helper functions (markMessagesAsRead, markChannelAsRead).
 */
function updateBrowserTitle(): void {
	if (!browser) return;
	const rawTotal = get(unreadCount);
	const total = Number.isFinite(rawTotal) && rawTotal > 0 ? Math.floor(rawTotal) : 0;

	if (total === 0) {
		document.title = APP_TITLE;
	} else if (total <= 10) {
		document.title = `(${total}) ${APP_TITLE}`;
	} else {
		document.title = `(10+) ${APP_TITLE}`;
	}
}

export async function loadOlderMessages(channelId: string): Promise<void> {
	if (!browser) return;

	channelLoadingOlder.update(state => ({ ...state, [channelId]: true }));

	try {
		const availableArchives = get(channelAvailableArchives)[channelId] || [];
		const loadedArchives = get(channelLoadedArchives)[channelId] || new Set();
		const nextArchive = availableArchives.find(archiveKey => !loadedArchives.has(archiveKey));

		if (!nextArchive) {
			console.log(`[SocketManager] No more archives for ${channelId}`);
			return;
		}

		const olderMessages = await chatStorage.loadArchiveForChannel(channelId, nextArchive);

		if (olderMessages.length > 0) {
			channelMessages.update(msgs => ({
				...msgs,
				[channelId]: [...olderMessages, ...(msgs[channelId] || [])]
			}));

			channelLoadedArchives.update(state => ({
				...state,
				[channelId]: new Set([...(state[channelId] || new Set()), nextArchive])
			}));
		}
	} catch (error) {
		console.error('[SocketManager] Failed to load older messages:', error);
	} finally {
		channelLoadingOlder.update(state => ({ ...state, [channelId]: false }));
	}
}

// Server-side history loading functions
export function loadHistory(channelId: string, options?: {
	beforeMessageId?: string;
	afterMessageId?: string;
	limit?: number;
}): void {
	if (!browser) return;

	channelHistoryLoading.update(s => ({ ...s, [channelId]: true }));
	socketManager.emit('load-history', { channelId, ...options });
}

export function loadOlderHistory(channelId: string): void {
	if (!browser) return;

	const oldestId = get(channelOldestMessageId)[channelId];
	const hasMore = get(channelHasMoreHistory)[channelId];
	const isLoading = get(channelHistoryLoading)[channelId];

	if (!hasMore || isLoading) {
		console.log(`[SocketManager] No more history or already loading for ${channelId}`);
		return;
	}

	loadHistory(channelId, { beforeMessageId: oldestId || undefined, limit: 50 });
}

export function syncNewerMessages(channelId: string): void {
	if (!browser) return;

	const msgs = get(channelMessages)[channelId];
	if (!msgs || msgs.length === 0) {
		// Load initial history
		loadHistory(channelId);
		return;
	}

	// Get the newest message and sync from there
	const newestMsg = msgs[msgs.length - 1];
	loadHistory(channelId, { afterMessageId: newestMsg.id, limit: 100 });
}

export function uploadEmote(name: string, imageData: string, type: 'static' | 'animated'): void {
	socketManager.emit('upload-emote', { name, imageData, type });
}

export function deleteEmote(emoteName: string): void {
	socketManager.emit('delete-emote', emoteName);
}

export function createDM(targetUserId: string): void {
	const me = get(currentUser);
	if (me) {
		const selfSocketId = me.id;
		const selfStableId = me.dbUserId ? `user-${me.dbUserId}` : null;
		if (targetUserId === selfSocketId || (selfStableId && targetUserId === selfStableId)) {
			console.warn('[SocketManager] Ignoring self-DM create request');
			return;
		}
	}
	socketManager.emit('create-dm', { targetUserId });
}

// Get the stable DM channel ID for a user pair.
// Uses dbUserId for registered users, socket.id for guests.
export function getDMChannelIdForUser(myUser: User | null, targetUser: User): string {
	const myStableId = myUser?.dbUserId ? `user-${myUser.dbUserId}` : myUser?.id || '';
	const targetStableId = targetUser.dbUserId ? `user-${targetUser.dbUserId}` : targetUser.id;
	const memberIds = [myStableId, targetStableId].sort();
	return `dm-${memberIds.join('-')}`;
}

export function deleteDM(channelId: string): void {
	socketManager.emit('delete-dm', { channelId });
}

export function assignRole(targetUserId: number, roleName: string): void {
	socketManager.emit('assign-role', { targetUserId, roleName });
}

export function removeUserRole(targetUserId: number, roleName: string): void {
	socketManager.emit('remove-role', { targetUserId, roleName });
}

export function banUser(targetUserId: number, reason?: string): void {
	socketManager.emit('ban-user', { targetUserId, reason: reason?.trim() || undefined });
}

export function createGroup(name: string, memberIds: string[]): void {
	socketManager.emit('create-group', { name, memberIds });
}

export function leaveGroup(channelId: string): void {
	socketManager.emit('leave-group', { channelId });
}

export function kickGroupMember(channelId: string, targetUserId: string): void {
	socketManager.emit('kick-group-member', { channelId, targetUserId });
}

export function addGroupMember(channelId: string, userId: string): void {
	socketManager.emit('add-group-member', { channelId, userId });
}

export function updateGroupAvatar(channelId: string, avatarUrl: string | null): void {
	socketManager.emit('update-group-avatar', { channelId, avatarUrl });
}

export function updateChannelSettings(channelId: string, settings: {
	autoDeleteAfter?: '5s' | '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
	persistMessages?: boolean;
	description?: string;
	watchQueueEnabled?: boolean;
	minRole?: string;
	name?: string;
	voiceSettings?: VoiceChannelSettings;
}): void {
	socketManager.emit('update-channel-settings', { channelId, ...settings });
}

export function addReaction(channelId: string, messageId: string, emojiId: string): void {
	socketManager.emit('add-reaction', { channelId, messageId, emojiId });
}

export function removeReaction(channelId: string, messageId: string, emojiId: string): void {
	socketManager.emit('remove-reaction', { channelId, messageId, emojiId });
}

export function uploadEmoji(
	name: string,
	url: string,
	category: string,
	options?: { displayName?: string; artist?: string; type?: 'emoji' | 'sticker' }
): void {
	socketManager.emit('upload-emoji', { name, url, category, ...options });
}

export function deleteEmoji(emojiName: string): void {
	socketManager.emit('delete-emoji', emojiName);
}

// Re-export types
export type { FileAttachment, Message, Emoji, User, Channel } from './socket-types';

