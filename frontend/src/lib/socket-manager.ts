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
import * as calling from './calling';
import type { FileAttachment, Message, Emoji, User, Channel } from './socket-types';
import { emojis } from './emoji-store';
import { getServerUrl } from './serverUrl';
import { authStore } from './authStore';
import { encryptDMMessage, decryptDMMessage, isE2EAvailable } from './e2eManager';

/**
 * Decrypt an array of messages for a DM channel (in-place mutation of text field).
 * Skips non-encrypted messages. Requires channel to be a DM with a known otherUser.dbUserId.
 */
async function decryptMessagesForChannel(channelId: string, messages: Message[]): Promise<void> {
	if (!isE2EAvailable() || !browser) return;

	const token = localStorage.getItem('authToken');
	if (!token) return;

	const channelList = get(channels);
	const channel = channelList.find(ch => ch.id === channelId);
	if (!channel || channel.type !== 'dm' || !channel.otherUser?.dbUserId) return;

	const otherDbUserId = channel.otherUser.dbUserId;

	await Promise.all(
		messages.map(async (msg) => {
			if (msg.encrypted && msg.iv) {
				msg.text = await decryptDMMessage(msg, otherDbUserId, token);
			}
		})
	);
}

import { handleP2PIncomingOffer, handleP2PAnswer, handleP2PIceCandidate } from './p2pFileTransfer';

/** The base browser tab title. Update this constant if the app is renamed. */
const APP_TITLE = 'Wabi Chat';


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

	// State machine
	private state: ConnectionState = 'disconnected';

	// Reconnection configuration
	private reconnectAttempts = 0;
	private readonly maxReconnectAttempts = 10;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly baseDelay = 1000;
	private readonly maxDelay = 30000;

	// Heartbeat/keepalive (for Firefox stability)
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private lastPong: number = 0;
	private readonly heartbeatIntervalMs = 25000;
	private readonly heartbeatTimeoutMs = 35000;

	// Listener tracking for clean rebinding
	private boundListeners: Set<string> = new Set();

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

	// ==================== STATE MACHINE ====================

	private canTransition(to: ConnectionState): boolean {
		const valid = VALID_TRANSITIONS[this.state];
		return valid.includes(to);
	}

	private transition(to: ConnectionState): boolean {
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
			timeout: 20000,

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
			token = providedToken || localStorage.getItem('authToken');
			if (!token) {
				sessionId = localStorage.getItem('sessionId');
			}
		} catch (e) {
			// localStorage blocked (Firefox ETP, private mode, etc.)
			console.warn('[SocketManager] localStorage unavailable:', e);
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
			this.baseDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000,
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
			this.safeLocalStorageRemove('sessionId');
			sock.emit('join', this.username);
		});

		sock.on('init', (data: {
			channels: Channel[];
			users: User[];
			excalidrawState: any;
			emotes: any[];
			emojis: Emoji[];
			roleDefinitions?: RoleDefinition[];
			voiceState?: Record<string, VoiceChannelParticipant[]>;
			sessionId?: string;
		}) => {
			console.log('[SocketManager] Init received');

			// Save session ID
			if (data.sessionId) {
				this.safeLocalStorageSet('sessionId', data.sessionId);
			}

			users.set(data.users);

			// Process channels - server now enriches DM channels with otherUser
			const processedChannels = data.channels.map(channel => {
				if (channel.type === 'dm') {
					// Server provides otherUser; use it if available
					if (channel.otherUser) {
						return { ...channel, name: channel.otherUser.username };
					}
					// Fallback: try to resolve from online users list
					if (channel.members) {
						const otherUserId = channel.members.find(id => id !== sock.id);
						const otherUser = data.users.find(u => u.id === otherUserId);
						if (otherUser) {
							return { ...channel, name: otherUser.username, otherUser };
						}
					}
				}
				return channel;
			});

			channels.set(processedChannels);
			this.loadMessagesWithPagination(processedChannels);

			if (data.emotes) initEmotes(data.emotes);
			if (data.emojis) emojis.set(data.emojis);
			if (data.roleDefinitions) roleDefinitions.set(data.roleDefinitions);
			this.applyVoiceState(data.voiceState);

			const user = data.users.find(u => u.id === sock.id);
			if (user) {
				currentUser.set(user);
				this.updatePinnedChannels();
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

			sock.emit('join-channel', 'general');
			sock.emit('get-role-definitions');
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
				const existingIds = new Set(existing.map(m => m.id));
				const newMsgs = data.messages.filter(m => !existingIds.has(m.id));
				return { ...msgs, [data.channelId]: [...existing, ...newMsgs] };
			});

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

			channelMessages.update(msgs => {
				const channelMsgs = msgs[data.channelId] || [];
				if (channelMsgs.some(m => m.id === data.message.id)) return msgs;
				return { ...msgs, [data.channelId]: [...channelMsgs, data.message] };
			});

			const channelList = get(channels);
			const channel = channelList.find(ch => ch.id === data.channelId);
			if (channel?.persistMessages) {
				chatStorage.saveMessage(data.channelId, data.message);
			}

			const isCurrentUser = data.message.userId === sock.id;
			const currentChannelId = get(currentChannel);
			const isCurrentChannelActive = currentChannelId === data.channelId;
			const myUsername = get(currentUser)?.username || null;
			const isMention = messageMentionsUser(data.message, myUsername);

			showNotification(data.message, isCurrentUser, channel?.name, {
				isMention,
				isCurrentChannelActive
			});

			if (!isCurrentUser && (!isCurrentChannelActive || document.hidden)) {
				this.incrementUnreadCount(data.channelId, data.message.id);
			}
		});

		sock.on('message-edited', (data: { channelId: string; messageId: string; newText: string }) => {
			channelMessages.update(msgs => ({
				...msgs,
				[data.channelId]: (msgs[data.channelId] || []).map(msg =>
					msg.id === data.messageId ? { ...msg, text: data.newText, isEdited: true } : msg
				)
			}));
		});

		sock.on('message-deleted', (data: { channelId: string; messageId: string }) => {
			channelMessages.update(msgs => ({
				...msgs,
				[data.channelId]: (msgs[data.channelId] || []).filter(msg => msg.id !== data.messageId)
			}));
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
			users.update(u => [...u, user]);
		});

		sock.on('user-left', (data: { id: string; username: string }) => {
			users.update(u => u.filter(user => user.id !== data.id));
		});

		sock.on('typing', (data: { channelId: string; usernames: string[] }) => {
			typingUsers.update(u => ({
				...u,
				[data.channelId]: data.usernames || []
			}));
		});

		sock.on('profile-updated', (user: User) => {
			users.update(u => u.map(existing => existing.id === user.id ? user : existing));
			currentUser.update(cu => cu && cu.id === user.id ? user : cu);
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
					const otherUserId = channel.members.find(id => id !== sock.id);
					const otherUser = userList.find(u => u.id === otherUserId);
					if (otherUser) {
						processedChannel = { ...channel, name: otherUser.username, otherUser };
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
			autoDeleteAfter?: '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
			persistMessages?: boolean;
			description?: string;
			minRole?: string;
		}) => {
			channels.update(chs => chs.map(ch =>
				ch.id === data.channelId
					? {
						...ch,
						autoDeleteAfter: data.autoDeleteAfter,
						persistMessages: data.persistMessages,
						...(data.minRole !== undefined ? { minRole: data.minRole } : {}),
						...(data.description !== undefined ? { description: data.description } : {})
					}
					: ch
			));
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
				existing.id === data.userId
					? { ...existing, roles: data.roles, highestRole: data.highestRole, roleColor: data.roleColor }
					: existing
			));
			currentUser.update(cu =>
				cu && cu.id === data.userId
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

		sock.on('group-member-added', (data: { channelId: string; user: any }) => {
			channels.update(chs => chs.map(ch => {
				if (ch.id !== data.channelId) return ch;
				const stableId = data.user?.dbUserId ? `user-${data.user.dbUserId}` : data.user?.id;
				return {
					...ch,
					members: ch.members ? [...ch.members, stableId] : [stableId],
					memberUsers: ch.memberUsers ? [...ch.memberUsers, data.user] : [data.user]
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
				console.log(`[SocketManager] Voice channel join signal from ${data.username} for ${data.channelName || data.channelId}`);
				return;
			}

			console.log(`[SocketManager] Incoming call from ${data.username}`);
			calling.incomingCall.set(data);
		});

		sock.on('call-accepted', (data: { userId: string; username: string; isVideoCall: boolean }) => {
			console.log(`[SocketManager] Call accepted by ${data.username}`);
			calling.createCallOffer(sock, data.userId, data.username)
				.catch(err => console.error('[SocketManager] createCallOffer failed:', err));
		});

		sock.on('call-rejected', () => {
			console.log('[SocketManager] Call rejected');
			calling.endCall(sock);
		});

		sock.on('call-ended', (data: { userId: string }) => {
			console.log(`[SocketManager] Call ended with ${data.userId}`);
			calling.removeCall(data.userId);
			calling.removeScreenShare(data.userId);
		});

		sock.on('call-offer', (data: { offer: RTCSessionDescriptionInit; senderId: string; username: string; channelId?: string }) => {
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
			calling.createCallOffer(sock, targetId, data.username || '', { channelId: data.channelId })
				.catch(err => console.error('[SocketManager] voice-channel createCallOffer failed:', err));
		});

		sock.on('voice-channel-user-left', (data: { channelId: string; userId: string; socketId?: string }) => {
			const targetId = data.socketId || data.userId;
			console.log(`[SocketManager] Voice participant left ${data.channelId}: ${targetId}`);
			calling.removeCall(targetId);
		});

		sock.on('screen-share-started', (data: { userId: string; username: string }) => {
			console.log(`[SocketManager] ${data.username} started screen sharing`);
			sock.emit('request-screen-share', { sharerId: data.userId });
		});

		sock.on('screen-share-request', (data: { viewerId: string }) => {
			console.log(`[SocketManager] Screen share request from ${data.viewerId}`);
			calling.createScreenShareOffer(sock, data.viewerId)
				.catch(err => console.error('[SocketManager] createScreenShareOffer failed:', err));
		});

		sock.on('screen-share-stopped', (data: { userId: string }) => {
			console.log(`[SocketManager] Screen share stopped: ${data.userId}`);
			calling.removeScreenShare(data.userId);
		});

		sock.on('webrtc-offer', (data: { offer: RTCSessionDescriptionInit; senderId: string; username: string }) => {
			calling.handleScreenShareOffer(sock, data.senderId, data.username, data.offer)
				.catch(err => console.error('[SocketManager] handleScreenShareOffer failed:', err));
		});

		sock.on('webrtc-answer', (data: { answer: RTCSessionDescriptionInit; senderId: string }) => {
			calling.handleScreenShareAnswer(data.senderId, data.answer)
				.catch(err => console.error('[SocketManager] handleScreenShareAnswer failed:', err));
		});

		sock.on('webrtc-ice-candidate', (data: { candidate: RTCIceCandidateInit; senderId: string }) => {
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
	markChannelAsRead(channelId);
}

export function switchChannel(channelId: string): void {
	socketManager.emit('join-channel', channelId);
	currentChannel.set(channelId);
	markChannelAsRead(channelId);
}

export async function joinVoiceChannel(channelId: string): Promise<void> {
	const sock = socketManager.getSocket();
	if (!sock) {
		throw new Error('Socket not connected');
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
	attachmentEncryption?: {
		scheme: 'dm-e2ee-v1';
		iv: string;
		mimeType?: string;
		originalSize?: number;
	};
	replyTo?: string;
	isSpoiler?: boolean;
	roleGatePersist?: boolean;
}): Promise<void> {
	const payload: Record<string, any> = { channelId, text, type, ...options };

	// Attempt E2E encryption for text DMs
	if (type === 'text' && isE2EAvailable()) {
		const channelList = get(channels);
		const channel = channelList.find(ch => ch.id === channelId);
		if (channel?.type === 'dm' && channel.otherUser?.dbUserId) {
			const token = browser ? localStorage.getItem('authToken') : null;
			if (token) {
				const encrypted = await encryptDMMessage(text, channel.otherUser.dbUserId, token);
				if (encrypted) {
					payload.text = encrypted.text;
					payload.encrypted = encrypted.encrypted;
					payload.iv = encrypted.iv;
				}
			}
		}
	}

	socketManager.emit('message', payload);
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

export function updateProfile(status?: 'active' | 'away' | 'busy', profilePicture?: string, bannerUrl?: string): void {
	socketManager.emit('update-profile', { status, profilePicture, bannerUrl });
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

	if (browser) {
		try {
			const counts = get(channelUnreadCounts);
			localStorage.setItem('channelUnreadCounts', JSON.stringify(counts));
		} catch {
			// Ignore localStorage errors
		}
	}

	updateBrowserTitle();
}

/**
 * Updates the browser tab title to reflect unread message count.
 * Single source of truth — called by both the SocketManager class and
 * the public helper functions (markMessagesAsRead, markChannelAsRead).
 */
function updateBrowserTitle(): void {
	if (!browser) return;
	const total = get(unreadCount);

	if (total === 0) {
		document.title = APP_TITLE;
	} else if (total <= 10) {
		document.title = `(${total}) ${APP_TITLE}`;
	} else {
		document.title = `(•) ${APP_TITLE}`;
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
	autoDeleteAfter?: '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
	persistMessages?: boolean;
	description?: string;
	minRole?: string;
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
