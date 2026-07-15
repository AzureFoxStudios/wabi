/**
 * socketConnectionCore.ts
 * SocketManager class: Socket connection lifecycle and state management
 */

import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { authStore } from './authStore';
import { getServerUrl, normalizeServerUrl } from './serverUrl';
import { getAuthToken, getGuestSessionId } from './authSession';
import { VALID_TRANSITIONS, type ConnectionState, socket, connected, connectionState } from './socketConnectionState';
import { SocketHeartbeat } from './socketConnectionHeartbeat';
import { SocketReconnectionManager } from './socketConnectionReconnect';
import type { Channel, Message, User } from './socket-types';
import { channels, currentChannel, joinChannel, _updatePinnedChannels } from './channelStore';
import { channelMessages, _updateOptimisticMessage, _removeOptimisticMessage } from './messageStore';
import { isRenderableMessage } from '$lib/displayEnhancements';
import {
	users,
	serverMembers,
	voiceChannelMembers,
	_setUsers,
	_setCurrentUser,
	_setServerMembers,
	_setRoleDefinitions,
	_setVoiceChannelMembers,
	_updateVoiceChannelMember,
	_removeVoiceChannelMember
} from './presenceStore';
import { _setTypingUsers, _clearTypingUsers } from './typingStore';
import { incomingCall, outgoingCall } from './callingStateStores';

function classifyError(errorMessage: string): { fatal: boolean; userMessage: string; errorType: string } {
	const lower = (errorMessage || '').toLowerCase();

	if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid token')) {
		return { fatal: true, userMessage: 'Invalid authentication', errorType: 'AUTH_FAILED' };
	}
	if (lower.includes('403') || lower.includes('forbidden')) {
		return { fatal: true, userMessage: 'Access denied', errorType: 'FORBIDDEN' };
	}
	if (lower.includes('404')) {
		return { fatal: true, userMessage: 'Server not found', errorType: 'NOT_FOUND' };
	}
	if (lower.includes('timeout')) {
		return { fatal: false, userMessage: 'Connection timeout', errorType: 'TIMEOUT' };
	}

	return { fatal: false, userMessage: 'Connection failed', errorType: 'NETWORK_ERROR' };
}

export class SocketManager {
	private socketInstance: Socket | null = null;
	private username: string = '';
	private authToken: string | null = null;
	private currentServerUrl: string | null = null;
	private shouldSyncAfterReconnect = false;
	private lastConnected = 0;

	private state: ConnectionState = 'disconnected';
	private heartbeat: SocketHeartbeat;
	private reconnect: SocketReconnectionManager;
	private connectTimeoutMs = 20000;
	private boundListeners: Set<string> = new Set();
	private typingClearTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private lastConnectStartedAt = 0;
	private fastReconnectCount = 0;

	constructor() {
		this.heartbeat = new SocketHeartbeat(() => this.socketInstance?.disconnect());
		this.reconnect = new SocketReconnectionManager();
	}

	// ==================== STATE MACHINE ====================

	private canTransition(to: ConnectionState): boolean {
		const valid = VALID_TRANSITIONS[this.state];
		return valid.includes(to);
	}

	private transition(to: ConnectionState): boolean {
		if (to === this.state) {
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
		return this.socketInstance;
	}

	getState(): ConnectionState {
		return this.state;
	}

	// ==================== CONFIGURATION ====================

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
			this.reconnect.setConfig({ baseDelay: 250, maxDelay: 5000, jitterMs: 120 });
			this.connectTimeoutMs = 8000;
			return;
		}

		this.reconnect.setConfig({ baseDelay: 1000, maxDelay: 30000, jitterMs: 1000 });
		this.connectTimeoutMs = 20000;
	}

	private getAuthCredentials(authToken?: string): { token: string | null; sessionId: string | null } {
		const token = authToken || getAuthToken() || null;
		if (token) return { token, sessionId: null };

		const sessionId = getGuestSessionId() || null;
		return { token: null, sessionId };
	}

	// ==================== RECONNECTION ====================

	private scheduleReconnect(): void {
		if (!this.canTransition('reconnecting')) return;
		if (!this.transition('reconnecting')) return;

		if (this.reconnect.hasExhaustedAttempts()) {
			console.error('[SocketManager] Max reconnect attempts reached');
			this.transition('failed');
			authStore.setAuthError('Connection lost after multiple attempts', 'connection_lost');
			return;
		}

		this.reconnect.incrementAttempt();
		let delay = this.reconnect.calculateBackoffDelay();

		// Circuit breaker: if we keep disconnecting immediately after connecting
		// (the classic "disconnect -> connecting loop after Init received"), back
		// off hard instead of hammering the server in a tight reconnect storm.
		const sinceConnected = this.lastConnected > 0 ? Date.now() - this.lastConnected : Number.POSITIVE_INFINITY;
		if (sinceConnected < 5000) {
			this.fastReconnectCount += 1;
		} else {
			this.fastReconnectCount = 0;
		}
		if (this.fastReconnectCount >= 3) {
			delay = Math.max(delay, 15000);
		}

		console.log(`[SocketManager] Scheduling reconnect (attempt ${this.reconnect.getAttemptCount()}/${this.reconnect.getMaxAttempts()}) in ${Math.round(delay)}ms`);

		this.reconnect.setReconnectTimer(
			setTimeout(() => {
				this.reconnect.setReconnectTimer(null);
				const currentUrl = normalizeServerUrl(this.currentServerUrl || getServerUrl());
				if (!currentUrl) {
					this.transition('failed');
					return;
				}

				const { rotated, nextUrl } = this.reconnect.rotateToNextFailoverCandidate(this.currentServerUrl);
				if (rotated && nextUrl) {
					this.currentServerUrl = nextUrl;
					this.reconnect.primeFailoverCandidates(nextUrl);
				}

				this.connect(this.username, this.authToken || undefined);
			}, delay)
		);
	}

	private destroySocket(): void {
		for (const timer of this.typingClearTimers.values()) {
			clearTimeout(timer);
		}
		this.typingClearTimers.clear();

		if (!this.socketInstance) return;
		try {
			this.socketInstance.removeAllListeners();
			this.socketInstance.disconnect();
		} catch (error) {
			console.warn('[SocketManager] Error destroying socket:', error);
		}
		this.socketInstance = null;
		this.boundListeners.clear();
		socket.set(null);
	}

	// ==================== CONNECTION ====================

	connect(username: string, authToken?: string): Socket | null {
		if (!browser) return null;
		const isReconnectAttempt = this.state === 'reconnecting' || this.reconnect.getAttemptCount() > 0;

		if (this.state === 'connecting') {
			console.log('[SocketManager] Connection in progress, returning existing socket');
			return this.socketInstance;
		}

		if (this.state === 'connected' && this.socketInstance && this.username === username) {
			console.log('[SocketManager] Already connected with same username');
			return this.socketInstance;
		}

		// Re-entry cooldown: a connect() invoked again within a few hundred ms of
		// starting a connection (e.g. overlapping bootstrap + login handlers, or
		// aggressive HMR remounts) must not spin up a second socket that the
		// server would then kick, triggering a disconnect/reconnect storm.
		if (this.socketInstance && Date.now() - this.lastConnectStartedAt < 500) {
			console.log('[SocketManager] Ignoring duplicate connect() within cooldown window');
			return this.socketInstance;
		}
		this.lastConnectStartedAt = Date.now();

		if (!this.canTransition('connecting')) {
			console.warn(`[SocketManager] Cannot connect from state: ${this.state}`);
			this.forceReset();
		}

		this.transition('connecting');
		this.username = username;
		this.authToken = authToken || null;
		if (isReconnectAttempt) {
			this.shouldSyncAfterReconnect = true;
		}

		this.destroySocket();

		let serverUrl = getServerUrl();
		this.currentServerUrl = normalizeServerUrl(serverUrl) || serverUrl;
		this.reconnect.primeFailoverCandidates(serverUrl);
		this.applyConnectionProfile(serverUrl);
		if (this.currentServerUrl) {
			void this.reconnect.refreshFailoverCandidates(this.currentServerUrl);
		}

		const { token, sessionId } = this.getAuthCredentials(authToken);

		console.log('[SocketManager] Connecting to:', serverUrl, token ? '(token)' : sessionId ? '(session)' : '(new)');

		this.socketInstance = io(serverUrl, {
			transports: ['websocket'],
			reconnection: false,
			timeout: this.connectTimeoutMs,
			withCredentials: true,
			auth: {
				token: token || undefined,
				sessionId: !token ? sessionId || undefined : undefined
			},
			forceNew: true
		});

		this.bindEventListeners();
		socket.set(this.socketInstance);

		return this.socketInstance;
	}

	disconnect(): void {
		if (this.state === 'connected' && Date.now() - this.lastConnected < 1500) {
			// Prevent rapid disconnect right after successful init (HMR/auth timing)
			return;
		}
		console.log('[SocketManager] Disconnect requested');
		this.reconnect.cancelReconnect();
		this.heartbeat.stop();
		this.destroySocket();
		this.username = '';
		this.authToken = null;
		this.reconnect.resetAttempts();
		this.currentServerUrl = null;
		this.shouldSyncAfterReconnect = false;
		this.transition('disconnected');
	}

	private forceReset(): void {
		console.warn('[SocketManager] Force resetting from state:', this.state);
		this.reconnect.cancelReconnect();
		this.heartbeat.stop();
		this.destroySocket();
		this.state = 'disconnected';
		this.reconnect.resetAttempts();
		connectionState.set('disconnected');
		connected.set(false);
	}

	// ==================== EVENT LISTENERS ====================

	private bindEventListeners(): void {
		if (!this.socketInstance) return;

		const sock = this.socketInstance;

		sock.removeAllListeners();
		this.boundListeners.clear();

		sock.on('connect', () => {
			console.log('[SocketManager] Connected, socket.id:', sock.id);

			this.transition('connected');
			this.lastConnected = Date.now();
			this.fastReconnectCount = 0;
			this.reconnect.resetAttempts();
			this.currentServerUrl = normalizeServerUrl(getServerUrl()) || this.currentServerUrl;
			if (this.currentServerUrl) {
				this.reconnect.primeFailoverCandidates(this.currentServerUrl);
				void this.reconnect.refreshFailoverCandidates(this.currentServerUrl);
			}
			this.heartbeat.start(sock);

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

			const errorInfo = classifyError(msg);

			if (errorInfo.fatal) {
				this.transition('failed');
				authStore.setAuthError(errorInfo.userMessage, errorInfo.errorType as any);
				return;
			}

			if (this.canTransition('reconnecting')) {
				this.scheduleReconnect();
			}
		});

		sock.on('disconnect', (reason, details) => {
			console.log('[SocketManager] Disconnected:', reason, details);

			this.heartbeat.stop();

			switch (reason) {
				case 'io server disconnect':
				case 'io client disconnect':
					this.transition('disconnected');
					break;

				case 'ping timeout':
				case 'transport close':
				case 'transport error':
					if (this.canTransition('reconnecting')) {
						this.scheduleReconnect();
					}
					break;

				default:
					console.warn('[SocketManager] Unknown disconnect reason:', reason);
					if (this.canTransition('reconnecting')) {
						this.scheduleReconnect();
					}
			}
		});

		if (sock.io?.engine) {
			sock.io.engine.on('upgrade', (transport) => {
				console.log('[SocketManager] Transport upgraded to:', transport.name);
			});

			sock.io.engine.on('packet', () => {
				this.heartbeat.recordPong();
			});
		}

		this.bindStateEventListeners(sock);
	}

	private bindStateEventListeners(sock: Socket): void {
		sock.on('init', (payload: {
			channels?: Channel[];
			users?: User[] | Record<string, User>;
			serverMembers?: User[] | Record<string, User>;
			roleDefinitions?: unknown[];
			voiceState?: Record<string, unknown>;
		}) => {
			const nextChannels = Array.isArray(payload?.channels) ? payload.channels : [];
			channels.set(nextChannels);
			_updatePinnedChannels();

			const activeChannel = get(currentChannel);
			if (nextChannels.length > 0 && !nextChannels.some((channel) => channel.id === activeChannel)) {
				const general = nextChannels.find((channel) => channel.id === 'general');
				const newChannel = (general || nextChannels[0]).id;
				currentChannel.set(newChannel);
				joinChannel(newChannel);
			} else if (nextChannels.length > 0) {
				joinChannel(activeChannel);
			}

			_setUsers(payload?.users || []);
			_setServerMembers(payload?.serverMembers || []);
			_setRoleDefinitions((payload?.roleDefinitions || []) as any[]);

			const allUsers = [
				...normalizeUserList(payload?.users),
				...normalizeUserList(payload?.serverMembers)
			];
			const normalizedUsername = this.username.trim().toLowerCase();
			const me = allUsers.find((user) => user.username?.trim().toLowerCase() === normalizedUsername) || null;
			_setCurrentUser(me);

			for (const [channelId, members] of Object.entries(payload?.voiceState || {})) {
				if (Array.isArray(members)) {
					_setVoiceChannelMembers(channelId, members as any[]);
				}
			}

			console.log('[SocketManager] Init received:', {
				channels: nextChannels.length,
				users: normalizeUserList(payload?.users).length,
				serverMembers: normalizeUserList(payload?.serverMembers).length
			});
		});

		const upsertChannel = (channel: Channel | undefined) => {
			if (!channel?.id) return;
			channels.update((current) => {
				const existingIndex = current.findIndex((candidate) => candidate.id === channel.id);
				if (existingIndex === -1) return [...current, channel];
				return current.map((candidate, index) => index === existingIndex ? { ...candidate, ...channel } : candidate);
			});
			_updatePinnedChannels();
		};

		sock.on('dm-created', (payload: { channel?: Channel; channelId?: string }) => {
			upsertChannel(payload?.channel);
		});

		sock.on('dm-channel-added', (payload: { channel?: Channel; channelId?: string }) => {
			upsertChannel(payload?.channel);
		});

		sock.on('group-created', (payload: { channel?: Channel; channelId?: string }) => {
			upsertChannel(payload?.channel);
		});

		sock.on('group-channel-added', (payload: { channel?: Channel; channelId?: string }) => {
			upsertChannel(payload?.channel);
		});

		sock.on('channel-messages', (payload: { channelId?: string; messages?: Message[] }) => {
			if (!payload?.channelId) return;
			const sanitized = Array.isArray(payload.messages)
				? payload.messages.filter((m) => isRenderableMessage(m))
				: [];
			channelMessages.update((state) => ({
				...state,
				[payload.channelId as string]: sanitized
			}));
		});

		sock.on('message', (payload: { channelId?: string; message?: Message }) => {
			if (!payload?.channelId || !payload.message) return;
			if (!isRenderableMessage(payload.message)) {
				console.warn('[socket] Dropping malformed message payload', payload.message);
				return;
			}
			const channelId = payload.channelId;
			const message = payload.message;
			channelMessages.update((state) => {
				const existing = state[channelId] || [];
				const duplicateIndex = existing.findIndex((candidate) =>
					candidate.id === message.id ||
					(Boolean(message.clientMessageId) && candidate.clientMessageId === message.clientMessageId)
				);
				const next = duplicateIndex >= 0
					? existing.map((candidate, index) => index === duplicateIndex ? { ...candidate, ...message, deliveryState: undefined, deliveryError: undefined } : candidate)
					: [...existing, message];
				return { ...state, [channelId]: next };
			});
		});

		sock.on('message-accepted', (payload: {
			channelId?: string;
			messageId?: string;
			clientMessageId?: string;
			timestamp?: number;
		}) => {
			if (!payload?.channelId || !payload.clientMessageId) return;
			_updateOptimisticMessage(
				payload.channelId,
				(message) => message.clientMessageId === payload.clientMessageId,
				{
					id: payload.messageId,
					timestamp: payload.timestamp,
					deliveryState: undefined,
					deliveryError: undefined
				}
			);
		});

		sock.on('message-deleted', (payload: { channelId?: string; messageId?: string }) => {
			if (!payload?.channelId || !payload.messageId) return;
			_removeOptimisticMessage(payload.channelId, payload.messageId);
		});

		sock.on('channel-messages-cleared', (payload: { channelId?: string }) => {
			if (!payload?.channelId) return;
			const channelId = payload.channelId;
			channelMessages.update((state) => ({
				...state,
				[channelId]: []
			}));
			import('$lib/storage').then(({ chatStorage }) => {
				chatStorage.clearChannelMessages(channelId).catch((e) =>
					console.warn('[socket] failed to clear local cache for', channelId, e)
				);
			});
		});

		sock.on('channel-updated', (payload: any) => {
			const id = payload?.channelId || payload?.id;
			if (!id) return;
			channels.update((list) =>
				list.map((ch) =>
					ch.id === id
						? {
								...ch,
								...(payload.name != null ? { name: payload.name } : {}),
								...(payload.description != null ? { description: payload.description } : {}),
								...('autoDeleteAfter' in (payload || {})
									? { autoDeleteAfter: payload.autoDeleteAfter ?? null }
									: {})
						  }
						: ch
				)
			);
		});

		sock.on('edit-error', (payload: { messageId?: string; error?: string }) => {
			console.warn('[socket] edit-error', payload?.messageId, payload?.error);
		});

		sock.on('delete-error', (payload: { messageId?: string; error?: string }) => {
			console.warn('[socket] delete-error', payload?.messageId, payload?.error);
		});

		sock.on('message-edited', (payload: { channelId?: string; messageId?: string; newText?: string }) => {
			if (!payload?.channelId || !payload.messageId || payload.newText === undefined) return;
			_updateOptimisticMessage(payload.channelId, (message) => message.id === payload.messageId, {
				text: payload.newText,
				isEdited: true
			});
		});

		sock.on('message-pinned', (payload: { channelId?: string; messageId?: string; isPinned?: boolean }) => {
			if (!payload?.channelId || !payload.messageId || payload.isPinned === undefined) return;
			_updateOptimisticMessage(payload.channelId, (message) => message.id === payload.messageId, {
				isPinned: payload.isPinned
			});
		});

		sock.on('pin-error', (payload: { messageId?: string; error?: string }) => {
			console.warn('[socket] pin-error', payload?.messageId, payload?.error);
		});

		sock.on('typing', (payload: { channelId?: string; usernames?: string[]; userIds?: string[] }) => {
			if (!payload?.channelId) return;
			const typingUsers = payload.userIds || payload.usernames || [];
			_setTypingUsers(payload.channelId, typingUsers);

			const previous = this.typingClearTimers.get(payload.channelId);
			if (previous) clearTimeout(previous);
			this.typingClearTimers.set(payload.channelId, setTimeout(() => {
				_clearTypingUsers(payload.channelId as string);
				this.typingClearTimers.delete(payload.channelId as string);
			}, 3500));
		});

		sock.on('user-joined', (user: User) => {
			if (!user?.id) return;
			upsertUser(users, user);
			upsertUser(serverMembers, user);
		});

		sock.on('user-left', (payload: { id?: string }) => {
			if (!payload?.id) return;
			users.update((current) => current.filter((user) => user.id !== payload.id));
			serverMembers.update((current) => current.map((user) =>
				user.id === payload.id ? { ...user, status: 'offline' } : user
			));
		});

		sock.on('voice-channel-state', (payload: { channelId?: string; members?: any[] }) => {
			if (!payload?.channelId) return;
			_setVoiceChannelMembers(payload.channelId, Array.isArray(payload.members) ? payload.members : []);
		});

		sock.on('voice-channel-joined', (payload: { channelId?: string; user?: any }) => {
			if (!payload?.channelId || !payload.user?.userId) return;
			_updateVoiceChannelMember(payload.channelId, payload.user.userId, payload.user);
		});

		sock.on('voice-transmit-mode-updated', (payload: { userId?: string; mode?: 'primary' | 'all-listening' }) => {
			if (!payload?.userId || !payload.mode) return;
			const mode = payload.mode;
			voiceChannelMembers.update((byChannel) => {
				const next = { ...byChannel };
				for (const [channelId, members] of Object.entries(next)) {
					next[channelId] = members.map((member) =>
						member.userId === payload.userId ? { ...member, transmitMode: mode } : member
					);
				}
				return next;
			});
		});

		sock.on('screen-share-targets', (payload: { targets?: Array<{ userId?: string; username?: string }> }) => {
			void import('./calling').then(({ createScreenShareOffer, isSharing }) => {
				if (!get(isSharing)) return;
				for (const target of payload?.targets ?? []) {
					if (target?.userId) void createScreenShareOffer(sock, target.userId);
				}
			}).catch((error) => console.warn('[Socket] Failed to create screen share offers:', error));
		});

		sock.on('webrtc-offer', (payload: { senderId?: string; username?: string; offer?: RTCSessionDescriptionInit }) => {
			if (!payload?.senderId || !payload.offer) return;
			void import('./calling').then(({ handleScreenShareOffer }) =>
				handleScreenShareOffer(sock, payload.senderId!, payload.username || 'Screen Share', payload.offer!)
			).catch((error) => console.warn('[Socket] Failed to handle screen share offer:', error));
		});

		sock.on('webrtc-answer', (payload: { senderId?: string; answer?: RTCSessionDescriptionInit }) => {
			if (!payload?.senderId || !payload.answer) return;
			void import('./calling').then(({ handleScreenShareAnswer }) =>
				handleScreenShareAnswer(payload.senderId!, payload.answer!)
			).catch((error) => console.warn('[Socket] Failed to handle screen share answer:', error));
		});

		sock.on('webrtc-ice-candidate', (payload: { senderId?: string; candidate?: RTCIceCandidateInit }) => {
			if (!payload?.senderId || !payload.candidate) return;
			void import('./calling').then(({ handleScreenShareIceCandidate }) =>
				handleScreenShareIceCandidate(payload.senderId!, payload.candidate!)
			).catch((error) => console.warn('[Socket] Failed to handle screen share ICE candidate:', error));
		});

		// =====================================================================
		// P2P / DM / Group call signaling
		// =====================================================================
		sock.on('call-incoming', (payload: { userId?: string; username?: string; isVideoCall?: boolean; channelId?: string; channelName?: string }) => {
			if (!payload?.userId) return;
			incomingCall.set({
				userId: payload.userId,
				username: payload.username || 'User',
				isVideoCall: Boolean(payload.isVideoCall),
				channelId: payload.channelId,
				channelName: payload.channelName
			});
		});

		sock.on('call-accepted', (payload: { userId?: string; username?: string; isVideoCall?: boolean }) => {
			if (!payload?.userId) return;
			const pending = get(outgoingCall);
			const targetId = pending?.targetUserId || payload.userId;
			void import('./calling').then(async ({ beginEstablishedDirectCall, createCallOffer }) => {
				if (!beginEstablishedDirectCall()) return;
				await createCallOffer(
					sock,
					targetId,
					payload.username || 'User',
					pending?.channelId ? { channelId: pending.channelId } : {}
				);
			}).catch((error) => console.warn('[Socket] Failed to create call offer:', error));
		});

		sock.on('call-offer', (payload: { offer?: RTCSessionDescriptionInit; senderId?: string; username?: string; channelId?: string }) => {
			if (!payload?.senderId || !payload.offer) return;
			void import('./calling').then(({ handleCallOffer }) =>
				handleCallOffer(sock, payload.senderId!, payload.username || 'User', payload.offer!, payload.channelId)
			).catch((error) => console.warn('[Socket] Failed to handle call offer:', error));
		});

		sock.on('call-answer-sdp', (payload: { answer?: RTCSessionDescriptionInit; senderId?: string }) => {
			if (!payload?.senderId || !payload.answer) return;
			void import('./calling').then(({ handleCallAnswer }) =>
				handleCallAnswer(payload.senderId!, payload.answer!)
			).catch((error) => console.warn('[Socket] Failed to handle call answer:', error));
		});

		sock.on('call-ice-candidate', (payload: { candidate?: RTCIceCandidateInit; senderId?: string }) => {
			if (!payload?.senderId || !payload.candidate) return;
			void import('./calling').then(({ handleCallIceCandidate }) =>
				handleCallIceCandidate(payload.senderId!, payload.candidate!)
			).catch((error) => console.warn('[Socket] Failed to handle call ICE candidate:', error));
		});

		sock.on('call-ended', (payload: { userId?: string }) => {
			const userId = payload?.userId;
			if (userId) void import('./calling').then(({ handleRemoteDirectCallEnded }) => handleRemoteDirectCallEnded(userId))
				.catch((error) => console.warn('[Socket] Failed to handle call ended:', error));
		});

		sock.on('call-cancelled', (payload: { userId?: string; callerId?: string }) => {
			const id = payload?.callerId || payload?.userId || '';
			void import('./calling').then(({ handleIncomingCallCancelled }) => handleIncomingCallCancelled(id))
				.catch((error) => console.warn('[Socket] Failed to handle call cancelled:', error));
		});

		sock.on('call-rejected', (payload: { userId?: string; callerId?: string }) => {
			const id = payload?.callerId || payload?.userId || '';
			void import('./calling').then(({ handleIncomingCallCancelled }) => handleIncomingCallCancelled(id))
				.catch((error) => console.warn('[Socket] Failed to handle call rejected:', error));
		});

		sock.on('call-error', (payload: { code?: string; message?: string; targetUserId?: string }) => {
			console.warn('[Socket] call-error:', payload?.code, payload?.message);
			if (payload?.targetUserId) {
				void import('./calling').then(({ handleIncomingCallCancelled }) => handleIncomingCallCancelled(payload.targetUserId!))
					.catch((error) => console.warn('[Socket] Failed to handle call error:', error));
			}
		});

		sock.on('group-call-participant-joined', (payload: { channelId?: string; channelName?: string; userId?: string; username?: string; stableUserId?: string }) => {
			if (!payload?.channelId || !payload?.userId) return;
			void import('./calling').then(({ handleGroupCallParticipantJoined }) =>
				handleGroupCallParticipantJoined(sock, {
					channelId: payload.channelId!,
					channelName: payload.channelName,
					userId: payload.userId!,
					username: payload.username || 'User',
					stableUserId: payload.stableUserId
				})
			).catch((error) => console.warn('[Socket] Failed to handle group participant joined:', error));
		});

		sock.on('group-call-participant-left', (payload: { channelId?: string; userId?: string }) => {
			if (!payload?.channelId || !payload?.userId) return;
			void import('./calling').then(({ handleGroupCallParticipantLeft }) =>
				handleGroupCallParticipantLeft({ channelId: payload.channelId!, userId: payload.userId! })
			).catch((error) => console.warn('[Socket] Failed to handle group participant left:', error));
		});

		sock.on('group-call-invite-cleared', (payload: { channelId?: string; stableUserId?: string }) => {
			if (!payload?.channelId || !payload?.stableUserId) return;
			void import('./calling').then(({ handleGroupCallInviteCleared }) =>
				handleGroupCallInviteCleared({ channelId: payload.channelId!, stableUserId: payload.stableUserId! })
			).catch((error) => console.warn('[Socket] Failed to handle group invite cleared:', error));
		});

		sock.on('p2p-offer', (payload: {
			transferId?: string;
			senderId?: string;
			senderUsername?: string;
			offer?: RTCSessionDescriptionInit;
			fileName?: string;
			fileSize?: number;
		}) => {
			if (!payload?.transferId || !payload.senderId || !payload.offer) return;
			void import('./p2pFileTransfer').then(({ handleP2PIncomingOffer }) =>
				handleP2PIncomingOffer({
					transferId: payload.transferId!,
					senderId: payload.senderId!,
					senderUsername: payload.senderUsername || 'User',
					offer: payload.offer!,
					fileName: payload.fileName || 'unknown',
					fileSize: payload.fileSize || 0
				})
			).catch((error) => console.warn('[Socket] Failed to handle P2P offer:', error));
		});

		sock.on('p2p-answer', (payload: { transferId?: string; senderId?: string; answer?: RTCSessionDescriptionInit }) => {
			if (!payload?.transferId || !payload.senderId || !payload.answer) return;
			void import('./p2pFileTransfer').then(({ handleP2PAnswer }) =>
				handleP2PAnswer({
					transferId: payload.transferId!,
					senderId: payload.senderId!,
					answer: payload.answer!
				})
			).catch((error) => console.warn('[Socket] Failed to handle P2P answer:', error));
		});

		sock.on('p2p-ice-candidate', (payload: { transferId?: string; senderId?: string; candidate?: RTCIceCandidateInit }) => {
			if (!payload?.transferId || !payload.senderId || !payload.candidate) return;
			void import('./p2pFileTransfer').then(({ handleP2PIceCandidate }) =>
				handleP2PIceCandidate({
					transferId: payload.transferId!,
					senderId: payload.senderId!,
					candidate: payload.candidate!
				})
			).catch((error) => console.warn('[Socket] Failed to handle P2P ICE candidate:', error));
		});

		sock.on('screen-share-stopped', (payload: { senderId?: string; userId?: string }) => {
			const userId = payload?.senderId || payload?.userId;
			if (!userId) return;
			void import('./calling').then(({ removeScreenShare }) => removeScreenShare(userId))
				.catch((error) => console.warn('[Socket] Failed to remove screen share:', error));
		});

		sock.on('voice-channel-user-joined', (payload: { channelId?: string; userId?: string; socketId?: string; username?: string }) => {
			if (!payload?.channelId || !payload.userId) return;
			_updateVoiceChannelMember(payload.channelId, payload.userId, {
				userId: payload.userId,
				socketId: payload.socketId,
				username: payload.username || '',
				isSpeaking: false,
				isMuted: false,
				isDeafened: false
			});
		});

		sock.on('voice-channel-left', (payload: { channelId?: string; userId?: string }) => {
			if (!payload?.channelId || !payload.userId) return;
			_removeVoiceChannelMember(payload.channelId, payload.userId);
		});

		sock.on('voice-channel-user-left', (payload: { channelId?: string; userId?: string }) => {
			if (!payload?.channelId || !payload.userId) return;
			_removeVoiceChannelMember(payload.channelId, payload.userId);
		});

		sock.on('role-definitions-updated', (payload: { roles?: any[] }) => {
			_setRoleDefinitions(Array.isArray(payload?.roles) ? payload.roles : []);
		});
	}
}

function normalizeUserList(value: unknown): User[] {
	if (Array.isArray(value)) return value as User[];
	if (value && typeof value === 'object') return Object.values(value as Record<string, User>);
	return [];
}

function upsertUser(store: typeof users, user: User): void {
	store.update((current) => {
		const existingIndex = current.findIndex((candidate) => candidate.id === user.id);
		if (existingIndex === -1) return [...current, user];
		return current.map((candidate, index) => index === existingIndex ? { ...candidate, ...user } : candidate);
	});
	}
