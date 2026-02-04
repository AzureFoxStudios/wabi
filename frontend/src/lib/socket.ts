/**
 * SocketManager - Centralized WebSocket connection management
 *
 * STABILITY RULES ENFORCED:
 * - Only ONE active socket per session
 * - Listeners registered once
 * - Clean teardown on page change
 * - No reconnect spam (exponential backoff)
 * - Graceful offline handling
 */

import { writable, get } from 'svelte/store';
import { io, Socket } from 'socket.io-client';
import { browser } from '$app/environment';
import { showNotification } from './notifications';
import { initEmotes, addEmote, removeEmote } from './markdown';
import { chatStorage } from './storage';
import * as calling from './calling';
import type { FileAttachment, Message, Emoji, User, Channel } from './socket-types';
import { emojis } from './emoji-store';
import { getServerUrl } from './serverUrl';
import { authStore } from './authStore';

// ============================================================================
// STORES - Single source of truth for all socket-related state
// ============================================================================

export const socket = writable<Socket | null>(null);
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
export { emojis };

// Pagination stores
export const channelLoadedArchives = writable<Record<string, Set<string>>>({});
export const channelAvailableArchives = writable<Record<string, string[]>>({});
export const channelLoadingOlder = writable<Record<string, boolean>>({});

// Connection state for UI feedback
export const connectionState = writable<'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed'>('disconnected');

// ============================================================================
// SOCKET MANAGER CLASS - Singleton pattern
// ============================================================================

class SocketManager {
	private socket: Socket | null = null;
	private username: string = '';
	private authToken: string | null = null;
	private isInitialized = false;
	private isConnecting = false;
	private reconnectAttempts = 0;
	private maxReconnectAttempts = 10;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private listenersBound = false;

	// Backoff configuration
	private baseDelay = 1000;
	private maxDelay = 30000;

	/**
	 * Get the current socket instance (for external modules that need direct access)
	 */
	getSocket(): Socket | null {
		return this.socket;
	}

	/**
	 * Initialize socket connection - safe to call multiple times
	 * Will only create one connection
	 */
	connect(username: string, authToken?: string): Socket | null {
		if (!browser) return null;

		// Guard: prevent duplicate initialization
		if (this.isConnecting) {
			console.log('[SocketManager] Connection already in progress, skipping');
			return this.socket;
		}

		// Guard: if already connected/connecting with same credentials, return existing socket
		if (this.socket && this.username === username && !this.socket.disconnected) {
			console.log('[SocketManager] Already connected with same username, reusing connection');
			return this.socket;
		}

		// Mark as connecting BEFORE any async operations
		this.isConnecting = true;
		this.username = username;
		this.authToken = authToken || null;
		connectionState.set('connecting');

		// If we have an existing socket, clean it up first
		if (this.socket) {
			console.log('[SocketManager] Cleaning up existing socket before reconnecting');
			this.cleanup();
		}

		// Determine server URL
		let serverUrl = getServerUrl();
		if (typeof window !== 'undefined' && window.location.origin.includes('tauri.localhost')) {
			const isDebug = import.meta.env.TAURI_DEBUG === 'true' || import.meta.env.DEV;
			if (!isDebug) {
				serverUrl = 'https://wabi.chat';
			}
		}

		// Get session/token for auth
		let sessionId: string | null = null;
		let token: string | null = null;

		try {
			token = authToken || localStorage.getItem('authToken');
			if (!token) {
				sessionId = localStorage.getItem('sessionId');
			}
		} catch (e) {
			console.error('[SocketManager] Failed to read auth from localStorage:', e);
		}

		console.log('[SocketManager] Connecting to:', serverUrl, token ? '(registered)' : sessionId ? '(session)' : '(new)');

		// Create socket with optimized settings
		this.socket = io(serverUrl, {
			reconnection: false, // We handle reconnection manually for better control
			timeout: 15000,
			withCredentials: true,
			transports: ['websocket', 'polling'],
			auth: {
				token: token || undefined,
				sessionId: !token ? sessionId || undefined : undefined
			}
		});

		// Bind event listeners ONCE
		this.bindEventListeners();

		// Store socket in writable store for reactive access
		socket.set(this.socket);
		this.isConnecting = false;
		this.isInitialized = true;

		return this.socket;
	}

	/**
	 * Disconnect and cleanup everything
	 */
	disconnect(): void {
		console.log('[SocketManager] Disconnecting...');
		this.cleanup();
		this.username = '';
		this.authToken = null;
		this.isInitialized = false;
		connectionState.set('disconnected');
	}

	/**
	 * Internal cleanup - removes all listeners and closes socket
	 */
	private cleanup(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		if (this.socket) {
			// Socket.IO's disconnect() handles cleanup automatically
			// Do NOT call removeAllListeners() - it breaks internal socket state
			this.socket.disconnect();
			this.socket = null;
		}

		socket.set(null);
		connected.set(false);
		this.listenersBound = false;
		this.reconnectAttempts = 0;
	}

	/**
	 * Manual reconnect with exponential backoff
	 */
	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			console.error('[SocketManager] Max reconnection attempts reached');
			connectionState.set('failed');
			authStore.setAuthError('Could not reconnect to server. Please refresh the page.', 'connection_lost');
			return;
		}

		// Exponential backoff with jitter
		const delay = Math.min(
			this.baseDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000,
			this.maxDelay
		);

		this.reconnectAttempts++;
		console.log(`[SocketManager] Scheduling reconnect attempt ${this.reconnectAttempts} in ${Math.round(delay)}ms`);
		connectionState.set('reconnecting');

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.username) {
				console.log('[SocketManager] Attempting reconnect...');
				this.connect(this.username, this.authToken || undefined);
			}
		}, delay);
	}

	/**
	 * Bind all event listeners - called ONCE per socket instance
	 */
	private bindEventListeners(): void {
		if (!this.socket || this.listenersBound) return;
		this.listenersBound = true;

		const sock = this.socket;

		// ==================== CONNECTION EVENTS ====================
		sock.on('connect', () => {
			console.log('[SocketManager] Connected!', sock.id);
			connected.set(true);
			connectionState.set('connected');
			this.reconnectAttempts = 0;

			// Send join/rejoin event
			const sessionId = browser ? localStorage.getItem('sessionId') : null;
			if (sessionId && !this.authToken) {
				console.log('[SocketManager] Sending rejoin with sessionId');
				sock.emit('rejoin', sessionId);
			} else {
				console.log('[SocketManager] Sending join with username:', this.username);
				sock.emit('join', this.username);
			}
		});

		sock.on('connect_error', (error) => {
			const msg = error?.message || '';
			console.error('[SocketManager] Connection error:', msg);
			connected.set(false);

			// Classify error for user feedback
			let errorType = 'unknown';
			let userMessage = `Connection error: ${msg}`;

			if (msg.includes('CORS') || msg.includes('cors') || msg.includes('Not allowed')) {
				errorType = 'cors_rejection';
				userMessage = 'Connection blocked by server security policy (CORS).';
			} else if (msg.includes('Session expired') || msg.includes('session expired')) {
				errorType = 'auth_expired';
				userMessage = 'Your session has expired. Please log in again.';
			} else if (msg.includes('Invalid token') || msg.includes('invalid token')) {
				errorType = 'auth_invalid';
				userMessage = 'Authentication failed. Please log in again.';
			} else if (msg.includes('websocket error') || msg.includes('transport close')) {
				errorType = 'upgrade_failed';
				userMessage = 'WebSocket upgrade failed. Retrying...';
			} else if (msg.includes('xhr poll error') || msg.includes('fetch') || msg.includes('NetworkError')) {
				errorType = 'network_unreachable';
				userMessage = 'Cannot reach server. Check your internet connection.';
			} else if (msg.includes('timeout')) {
				errorType = 'timeout';
				userMessage = 'Connection timed out.';
			}

			// Handle auth errors - don't retry
			if (errorType === 'auth_expired' || errorType === 'auth_invalid') {
				authStore.setAuthError(userMessage, 'session_expired');
				connectionState.set('failed');
				return;
			}

			if (errorType === 'cors_rejection') {
				authStore.setAuthError(userMessage, 'auth_failed');
				connectionState.set('failed');
				return;
			}

			// For recoverable errors, schedule reconnect
			this.scheduleReconnect();
		});

		sock.on('disconnect', (reason) => {
			console.log('[SocketManager] Disconnected:', reason);
			connected.set(false);

			// Only auto-reconnect for certain disconnect reasons
			if (reason === 'io server disconnect') {
				// Server kicked us - don't auto-reconnect
				connectionState.set('disconnected');
			} else if (reason === 'io client disconnect') {
				// We initiated disconnect - don't reconnect
				connectionState.set('disconnected');
			} else {
				// Transport close, ping timeout, etc. - try to reconnect
				this.scheduleReconnect();
			}
		});

		// ==================== SESSION EVENTS ====================
		sock.on('rejoin-failed', (data: { reason: string }) => {
			console.log('[SocketManager] Rejoin failed:', data.reason);
			if (browser) {
				try {
					localStorage.removeItem('sessionId');
				} catch (e) {
					console.error('Failed to clear sessionId:', e);
				}
			}
			sock.emit('join', this.username);
		});

		sock.on('init', (data: {
			channels: Channel[];
			users: User[];
			excalidrawState: any;
			emotes: any[];
			emojis: Emoji[];
			sessionId?: string
		}) => {
			console.log('[SocketManager] Received init');

			// Save session ID
			if (data.sessionId && browser) {
				try {
					localStorage.setItem('sessionId', data.sessionId);
				} catch (e) {
					console.error('Failed to save sessionId:', e);
				}
			}

			users.set(data.users);

			// Process channels (fix DM names)
			const processedChannels = data.channels.map(channel => {
				if (channel.type === 'dm' && channel.members) {
					const otherUserId = channel.members.find(id => id !== sock.id);
					const otherUser = data.users.find(u => u.id === otherUserId);
					if (otherUser) {
						return { ...channel, name: otherUser.username, otherUser };
					}
				}
				return channel;
			});

			channels.set(processedChannels);
			this.loadMessagesWithPagination(processedChannels);

			// Initialize emotes/emojis
			if (data.emotes) initEmotes(data.emotes);
			if (data.emojis) emojis.set(data.emojis);

			// Find and set current user
			const user = data.users.find(u => u.id === sock.id);
			if (user) {
				currentUser.set(user);
				this.updatePinnedChannels();
			}

			// Join general channel by default
			sock.emit('join-channel', 'general');
		});

		// ==================== MESSAGE EVENTS ====================
		sock.on('channel-messages', (data: { channelId: string; messages: Message[] }) => {
			channelMessages.update(msgs => {
				const existing = msgs[data.channelId] || [];
				const existingIds = new Set(existing.map(m => m.id));
				const newMsgs = data.messages.filter(m => !existingIds.has(m.id));
				return { ...msgs, [data.channelId]: [...existing, ...newMsgs] };
			});
		});

		sock.on('message', (data: { channelId: string; message: Message }) => {
			channelMessages.update(msgs => {
				const channelMsgs = msgs[data.channelId] || [];
				// Prevent duplicates
				if (channelMsgs.some(m => m.id === data.message.id)) return msgs;
				return { ...msgs, [data.channelId]: [...channelMsgs, data.message] };
			});

			// Save to storage if persistent
			const channelList = get(channels);
			const channel = channelList.find(ch => ch.id === data.channelId);
			if (channel?.persistMessages) {
				chatStorage.saveMessage(data.channelId, data.message);
			}

			// Handle notifications and unread counts
			const isCurrentUser = data.message.userId === sock.id;
			const currentChannelId = get(currentChannel);
			const isCurrentChannelActive = currentChannelId === data.channelId;

			showNotification(data.message, isCurrentUser, channel?.name);

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
			typingUsers.update(users => ({
				...users,
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
			if (channel.type === 'dm' && channel.members) {
				const userList = get(users);
				const otherUserId = channel.members.find(id => id !== sock.id);
				const otherUser = userList.find(u => u.id === otherUserId);
				if (otherUser) {
					processedChannel = { ...channel, name: otherUser.username, otherUser };
				}
			}
			channels.update(chs => [...chs, processedChannel]);
			channelMessages.update(msgs => ({ ...msgs, [processedChannel.id]: [] }));
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
		}) => {
			channels.update(chs => chs.map(ch =>
				ch.id === data.channelId
					? { ...ch, autoDeleteAfter: data.autoDeleteAfter, persistMessages: data.persistMessages }
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
			reactions: Record<string, string[]>
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
			reactions: Record<string, string[]>
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
			console.log(`[SocketManager] Received ${data.messages.length} offline messages for ${data.channelId}`);

			channelMessages.update(msgs => {
				const existing = msgs[data.channelId] || [];
				const existingIds = new Set(existing.map(m => m.id));
				const newMessages = data.messages.filter(m => !existingIds.has(m.id));
				return { ...msgs, [data.channelId]: [...existing, ...newMessages] };
			});

			showNotification({
				title: 'Offline Messages',
				body: `You have ${data.messages.length} new message${data.messages.length > 1 ? 's' : ''} in chat`
			} as unknown as Message, false, '');
		});

		sock.on('message-queued', (data: { messageId: string }) => {
			console.log(`[SocketManager] Message ${data.messageId} queued for offline delivery`);
		});

		// ==================== WEBRTC/CALLING EVENTS ====================
		sock.on('call-incoming', (data: { userId: string, username: string, isVideoCall: boolean }) => {
			console.log(`[SocketManager] Incoming call from ${data.username}`);
			calling.incomingCall.set(data);
		});

		sock.on('call-accepted', (data: { userId: string, username: string, isVideoCall: boolean }) => {
			console.log(`[SocketManager] Call accepted by ${data.username}`);
			// Create the WebRTC offer now that the call is accepted
			calling.createCallOffer(sock, data.userId, data.username);
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

		sock.on('call-offer', (data: { offer: RTCSessionDescriptionInit, senderId: string, username: string }) => {
			console.log(`[SocketManager] Received call offer from ${data.username}`);
			calling.handleCallOffer(sock, data.senderId, data.username, data.offer);
		});

		sock.on('call-answer-sdp', (data: { answer: RTCSessionDescriptionInit, senderId: string }) => {
			console.log(`[SocketManager] Received call answer from ${data.senderId}`);
			calling.handleCallAnswer(data.senderId, data.answer);
		});

		sock.on('call-ice-candidate', (data: { candidate: RTCIceCandidateInit, senderId: string }) => {
			calling.handleCallIceCandidate(data.senderId, data.candidate);
		});

		sock.on('screen-share-started', (data: { userId: string, username: string }) => {
			console.log(`[SocketManager] ${data.username} started screen sharing`);
			// Request the screen share from the sharer
			// The sharer will create an offer and send it to us
			sock.emit('request-screen-share', { sharerId: data.userId });
		});

		sock.on('screen-share-request', (data: { viewerId: string }) => {
			console.log(`[SocketManager] User ${data.viewerId} requested our screen share`);
			// Someone wants to view our screen share - create offer for them
			calling.createScreenShareOffer(sock, data.viewerId);
		});

		sock.on('screen-share-stopped', (data: { userId: string }) => {
			console.log(`[SocketManager] Screen share stopped for ${data.userId}`);
			calling.removeScreenShare(data.userId);
		});

		sock.on('webrtc-offer', (data: { offer: RTCSessionDescriptionInit, senderId: string, username: string }) => {
			calling.handleScreenShareOffer(sock, data.senderId, data.username, data.offer);
		});

		sock.on('webrtc-answer', (data: { answer: RTCSessionDescriptionInit, senderId: string }) => {
			calling.handleScreenShareAnswer(data.senderId, data.answer);
		});

		sock.on('webrtc-ice-candidate', (data: { candidate: RTCIceCandidateInit, senderId: string }) => {
			calling.handleScreenShareIceCandidate(data.senderId, data.candidate);
		});
	}

	// ==================== HELPER METHODS ====================

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
			if (browser) {
				localStorage.setItem('channelUnreadCounts', JSON.stringify(newCounts));
			}
			return newCounts;
		});

		unreadCount.update(n => {
			if (n === 0) lastReadMessageId.set(messageId);
			return n + 1;
		});

		this.updateBrowserTitle();
	}

	private updateBrowserTitle(): void {
		if (!browser) return;
		const totalUnread = get(unreadCount);

		if (totalUnread === 0) {
			document.title = 'Wabi Chat';
		} else if (totalUnread <= 10) {
			document.title = `(${totalUnread}) Wabi Chat`;
		} else {
			document.title = '(•) Wabi Chat';
		}
	}

	// ==================== PUBLIC EMIT METHODS ====================

	emit(event: string, ...args: any[]): void {
		if (this.socket?.connected) {
			this.socket.emit(event, ...args);
		} else {
			console.warn(`[SocketManager] Cannot emit '${event}' - not connected`);
		}
	}
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const socketManager = new SocketManager();

// ============================================================================
// PUBLIC API FUNCTIONS (backwards-compatible with old socket.ts)
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
	const channel = get(channels).find(ch => ch.id === channelId);

	// GUARD: DMs should ONLY be accessed via right panel, never main chat
	if (channel?.type === 'dm') {
		console.warn('[socket] Blocked attempt to join DM channel in main chat:', channelId);
		if (channel.otherUser) {
			// Open in right panel instead
			dmPanelSignal.set({ channelId, otherUser: channel.otherUser });
		}
		return; // EXIT - do not join DM in main chat
	}

	socketManager.emit('join-channel', channelId);
	currentChannel.set(channelId);
	markChannelAsRead(channelId);
}

export function switchChannel(channelId: string): void {
	socketManager.emit('join-channel', channelId);
	currentChannel.set(channelId);
	markChannelAsRead(channelId);
}

export function createChannel(channelName: string): void {
	socketManager.emit('create-channel', channelName);
}

export function deleteChannel(channelId: string): void {
	socketManager.emit('delete-channel', channelId);
}

export function sendMessage(channelId: string, text: string, type: 'text' | 'gif' | 'file' = 'text', options?: {
	gifUrl?: string;
	fileUrl?: string;
	fileName?: string;
	fileSize?: number;
	replyTo?: string;
	isSpoiler?: boolean;
}): void {
	socketManager.emit('message', { channelId, text, type, ...options });
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
	const currentChannelId = channelId || get(currentChannel);
	socketManager.emit('typing', { isTyping, channelId: currentChannelId });
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
		const counts = get(channelUnreadCounts);
		localStorage.setItem('channelUnreadCounts', JSON.stringify(counts));
	}

	updateBrowserTitle();
}

function updateBrowserTitle(): void {
	if (!browser) return;
	const totalUnread = get(unreadCount);

	if (totalUnread === 0) {
		document.title = 'Wabi Chat';
	} else if (totalUnread <= 10) {
		document.title = `(${totalUnread}) Wabi Chat`;
	} else {
		document.title = '(•) Wabi Chat';
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
		console.error(`[SocketManager] Failed to load older messages:`, error);
	} finally {
		channelLoadingOlder.update(state => ({ ...state, [channelId]: false }));
	}
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

export function createGroup(name: string, memberIds: string[]): void {
	socketManager.emit('create-group', { name, memberIds });
}

export function updateChannelSettings(channelId: string, settings: {
	autoDeleteAfter?: '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
	persistMessages?: boolean;
}): void {
	socketManager.emit('update-channel-settings', { channelId, ...settings });
}

export function addReaction(channelId: string, messageId: string, emojiId: string): void {
	socketManager.emit('add-reaction', { channelId, messageId, emojiId });
}

export function removeReaction(channelId: string, messageId: string, emojiId: string): void {
	socketManager.emit('remove-reaction', { channelId, messageId, emojiId });
}

export function uploadEmoji(name: string, url: string, category: string): void {
	socketManager.emit('upload-emoji', { name, url, category });
}

export function deleteEmoji(emojiName: string): void {
	socketManager.emit('delete-emoji', emojiName);
}

// Re-export types
export type { FileAttachment, Message, Emoji, User, Channel } from './socket-types';
