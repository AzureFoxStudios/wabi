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
import { tryRefresh } from './api/authRefresh';
import { VALID_TRANSITIONS, type ConnectionState, socket, connected, connectionState } from './socketConnectionState';
import { SocketHeartbeat } from './socketConnectionHeartbeat';
import { SocketReconnectionManager } from './socketConnectionReconnect';
import { drainOutboundQueue } from '$lib/wabidb/drain';
import { getWabiDB } from '$lib/wabidb';
import type { Channel, Message, User } from './socket-types';
import { channels, currentChannel, joinChannel, descendantIds, _updatePinnedChannels, readLastChannel, persistLastChannel } from './channelStore';
import { upsertBreakoutRooms, removeBreakoutRooms } from './breakoutChannels';
import { channelMessages, _updateOptimisticMessage, _removeOptimisticMessage } from './messageStore';
import { isRenderableMessage } from '$lib/displayEnhancements';
import { mergeServerEmotes, removeServerEmote, type ServerEmote } from './emoji-store';
import { recordSuccessfulServerConnection } from './savedServerActions';


/** Stable identity for message list rows. Prefer server id once accepted. */
function messageRowKey(message: Message, index = 0): string {
	const id = String(message?.id ?? '').trim();
	if (id && !id.startsWith('optimistic:')) return id;
	const cmid = String(message?.clientMessageId ?? message?.clientNonce ?? '').trim();
	if (cmid) return cmid;
	if (id) return id;
	return `__missing_${index}`;
}

function isSameMessageRow(candidate: Message, incoming: Message): boolean {
	if (
		candidate.clientMessageId &&
		incoming.clientMessageId &&
		candidate.clientMessageId === incoming.clientMessageId
	) {
		return true;
	}
	if (candidate.id && incoming.id && candidate.id === incoming.id) {
		if (
			candidate.clientMessageId &&
			incoming.clientMessageId &&
			candidate.clientMessageId !== incoming.clientMessageId
		) {
			return false;
		}
		return true;
	}
	return false;
}

function mergeMessageRow(candidate: Message, incoming: Message): Message {
	return {
		...candidate,
		...incoming,
		clientMessageId: incoming.clientMessageId || candidate.clientMessageId,
		id: incoming.id || candidate.id,
		deliveryState: undefined,
		deliveryError: undefined
	};
}

function dedupeMessagesKeepOrder(items: Message[]): Message[] {
	const byKey = new Map<string, Message>();
	items.forEach((m, i) => {
		if (!isRenderableMessage(m)) return;
		byKey.set(messageRowKey(m, i), m);
	});
	const seen = new Set<string>();
	const out: Message[] = [];
	items.forEach((m, i) => {
		if (!isRenderableMessage(m)) return;
		const key = messageRowKey(m, i);
		if (seen.has(key)) return;
		seen.add(key);
		out.push(byKey.get(key) || m);
	});
	return out;
}

/** Collapse list items that would crash Svelte keyed {#each} blocks. */
function dedupeByIdKey<T extends { id?: string | null }>(items: T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		const key = String(item?.id ?? '').trim();
		if (!key) continue;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}


import {
	users,
	serverMembers,
	currentUser,
	voiceChannelMembers,
	_setUsers,
	_setCurrentUser,
	_setServerMembers,
	_setRoleDefinitions,
	_setBadgeCatalog,
	_setUserBadges,
	_setVoiceChannelMembers,
	_updateVoiceChannelMember,
	_removeVoiceChannelMember,
	_mergeCurrentUserProfile
} from './presenceStore';
import { _setTypingUsers, _clearTypingUsers } from './typingStore';
import { restorePresence } from './presenceControl';
import { incomingCall, outgoingCall } from './callingStateStores';

/**
 * L2: normalize wire channel payloads so Chat routes to LoreChannel.
 * Server may send `type`, `channel_type`, and/or `asset_storage`.
 */
function normalizeChannel(raw: Channel | Record<string, unknown> | null | undefined): Channel | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const id = r.id ?? r.channel_id;
	if (typeof id !== 'string' || !id) return null;

	const wireType =
		(typeof r.type === 'string' && r.type) ||
		(typeof r.channel_type === 'string' && r.channel_type) ||
		'text';
	const assetStorage = r.asset_storage === true || r.assetStorage === true;
	const type =
		wireType === 'lore' || wireType === 'asset_storage' || assetStorage ? 'lore' : wireType;

	return {
		...(raw as Channel),
		id,
		type: type as Channel['type'],
		// Folder nesting (category parent) — accept camel or snake.
		parentId:
			(typeof r.parentId === 'string' && r.parentId) ||
			(typeof r.parent_id === 'string' && r.parent_id) ||
			undefined,
		// Threads / breakouts — separate from category parentId.
		parentChannelId:
			(typeof r.parentChannelId === 'string' && r.parentChannelId) ||
			(typeof r.parent_channel_id === 'string' && r.parent_channel_id) ||
			undefined,
		position:
			typeof r.position === 'number'
				? r.position
				: typeof r.position === 'string' && r.position.trim() !== ''
					? Number(r.position)
					: (raw as Channel).position,
		// keep a stable flag for sidebar filters even if protocol omits it
		...(type === 'lore' || assetStorage ? { asset_storage: true } : {})
	} as Channel;
}

function normalizeChannelList(list: unknown): Channel[] {
	if (!Array.isArray(list)) return [];
	const out: Channel[] = [];
	for (const item of list) {
		const n = normalizeChannel(item as Channel);
		if (n) out.push(n);
	}
	return out;
}

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
	private lastRecordedServerUrl: string | null = null;
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

				// Token freshness: the captured authToken may predate a silent
				// refresh (15-minute access tokens). Prefer whatever authSession
				// holds NOW; fall back to the captured value (also covers guests
				// whose credentials are sessionId-based).
				const liveToken = getAuthToken() || undefined;
				this.authToken = liveToken || this.authToken;

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
			// Prefer WebSocket, but fall back to long-polling. Cloudflare/cloudflared
			// can strip the WS Upgrade header on some tunnel configs, and without a
			// polling fallback the client would never connect. socket.io negotiates
			// polling first, then upgrades to WS when the transport is available.
			transports: ['websocket', 'polling'],
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
			// Drain any queued outbound actions now that we're connected.
			drainOutboundQueue();
			const connectedUrl = normalizeServerUrl(getServerUrl()) || this.currentServerUrl;
			this.currentServerUrl = connectedUrl;
			if (this.currentServerUrl) {
				this.reconnect.primeFailoverCandidates(this.currentServerUrl);
				void this.reconnect.refreshFailoverCandidates(this.currentServerUrl);
				if (this.currentServerUrl !== this.lastRecordedServerUrl) {
					this.lastRecordedServerUrl = this.currentServerUrl;
					recordSuccessfulServerConnection({
						url: this.currentServerUrl,
						username: this.username
					});
				}
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

			// Fetch server-side custom emotes (merged into the picker store).
			sock.emit('get-emojis');
			// Fetch the assignable badge catalog (falls back to the client
			// mirror until this arrives).
			sock.emit('get-badge-catalog');
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

		// Server-side auth rejections. `auth-failed` arrives at handshake
		// (invalid/expired/refresh-class token); `auth-revoked` mid-session
		// (revoked jti / user floor). Both mean the socket token is dead even
		// if the TCP layer is fine: try one silent refresh (which rotates the
		// access token), then reconnect with the fresh credential. If refresh
		// fails there is no valid session left — surface session-expired so
		// the app routes to login instead of retry-looping.
		const handleAuthRejection = async (event: string, payload?: { reason?: string } | null) => {
			console.warn(`[SocketManager] ${event}:`, payload?.reason || 'unknown reason');
			try { sock.disconnect(); } catch { /* already down */ }
			const refreshed = await tryRefresh();
			if (refreshed) {
				this.authToken = getAuthToken() || this.authToken;
				if (this.canTransition('reconnecting')) this.scheduleReconnect();
			} else if (!getAuthToken()) {
				authStore.setAuthError('Your session has expired. Please log in again.', 'session_expired');
			}
		};
		void handleAuthRejection; // bound below per-event

		sock.on('auth-failed', (payload?: { reason?: string }) => void handleAuthRejection('auth-failed', payload));
		sock.on('auth-revoked', (payload?: { reason?: string }) => void handleAuthRejection('auth-revoked', payload));

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
			const nextChannels = dedupeByIdKey(normalizeChannelList(payload?.channels));
			channels.set(nextChannels);
			_updatePinnedChannels();

			const activeChannel = get(currentChannel);
			const savedChannelId = readLastChannel();
			const savedChannel = savedChannelId
				? nextChannels.find((channel) => channel.id === savedChannelId)
				: undefined;
			const activeChannelStillExists = nextChannels.some((channel) => channel.id === activeChannel);
			if (nextChannels.length > 0 && savedChannel) {
				currentChannel.set(savedChannel.id);
				joinChannel(savedChannel.id);
			} else if (nextChannels.length > 0 && !activeChannelStillExists) {
				const general = nextChannels.find((channel) => channel.id === 'general');
				const newChannel = (general || nextChannels[0]).id;
				currentChannel.set(newChannel);
				persistLastChannel(newChannel);
				joinChannel(newChannel);
			} else if (nextChannels.length > 0) {
				persistLastChannel(activeChannel);
				joinChannel(activeChannel);
			}

			_setUsers(payload?.users || []);
			_setServerMembers(payload?.serverMembers || []);
			_setRoleDefinitions((payload?.roleDefinitions || []) as any[]);

			// Re-assert the locally stored presence choice (away/busy/invisible
			// survive reloads and reconnects; active is the server default).
			restorePresence();

			const allUsers = [
				...normalizeUserList(payload?.users),
				...normalizeUserList(payload?.serverMembers)
			];
			// R8: resolve self by username; if init roster lags (common for guests),
			// synthesize a provisional currentUser so BL ProfileCard never shows blank/Unknown.
			const joinName = this.username.trim();
			const normalizedUsername = joinName.toLowerCase();
			let me =
				allUsers.find((user) => user.username?.trim().toLowerCase() === normalizedUsername) || null;
			if (!me && joinName) {
				const sockId = typeof sock.id === 'string' && sock.id ? sock.id : `guest-${Date.now()}`;
				me = {
					id: sockId,
					username: joinName,
					handle: joinName,
					color: '#98D8C8',
					status: 'active',
					highestRole: 'guest'
				};
				upsertUser(users, me);
				upsertUser(serverMembers, me);
			}
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
			const normalized = normalizeChannel(channel);
			if (!normalized?.id) return;
			channels.update((current) => {
				const existingIndex = current.findIndex((candidate) => candidate.id === normalized.id);
				if (existingIndex === -1) return [...current, normalized];
				return current.map((candidate, index) =>
					index === existingIndex ? { ...candidate, ...normalized } : candidate
				);
			});
			_updatePinnedChannels();
		};

		sock.on('dm-created', (payload: { channel?: Channel; channelId?: string }) => {
			upsertChannel(payload?.channel);
			const cid = payload?.channel?.id ?? payload?.channelId;
			if (cid) joinChannel(cid);
		});

		sock.on('dm-channel-added', (payload: { channel?: Channel; channelId?: string }) => {
			upsertChannel(payload?.channel);
			const cid = payload?.channel?.id ?? payload?.channelId;
			if (cid) joinChannel(cid);
		});

		sock.on('group-created', (payload: { channel?: Channel; channelId?: string }) => {
			upsertChannel(payload?.channel);
			const cid = payload?.channel?.id ?? payload?.channelId;
			if (cid) joinChannel(cid);
		});

		sock.on('group-channel-added', (payload: { channel?: Channel; channelId?: string }) => {
			upsertChannel(payload?.channel);
			const cid = payload?.channel?.id ?? payload?.channelId;
			if (cid) joinChannel(cid);
		});

		sock.on('channel-messages', (payload: { channelId?: string; messages?: Message[] }) => {
			if (!payload?.channelId) return;
			const raw = Array.isArray(payload.messages) ? payload.messages : [];
			const sanitized = dedupeMessagesKeepOrder(raw);
			channelMessages.update((state) => {
				const channelId = payload.channelId as string;
				const previous = state[channelId] || [];
				const serverIds = new Set(sanitized.map((m) => String(m.id || '').trim()).filter(Boolean));
				const serverClientIds = new Set(
					sanitized
						.map((m) => m.clientMessageId)
						.filter((id): id is string => Boolean(id && String(id).trim()))
				);
				const pendingLocal = previous.filter((m) => {
					if (m.deliveryState !== 'sending' && m.deliveryState !== 'failed') return false;
					const mid = String(m.id || '').trim();
					if (mid && serverIds.has(mid)) return false;
					if (m.clientMessageId && serverClientIds.has(m.clientMessageId)) return false;
					return true;
				});
				const merged =
					pendingLocal.length > 0
						? dedupeMessagesKeepOrder([...sanitized, ...pendingLocal])
						: sanitized;
				return { ...state, [channelId]: merged };
			});
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
					isSameMessageRow(candidate, message)
				);
				const next =
					duplicateIndex >= 0
						? existing.map((candidate, index) =>
								index === duplicateIndex ? mergeMessageRow(candidate, message) : candidate
							)
						: [...existing, message];
				return { ...state, [channelId]: dedupeMessagesKeepOrder(next) };
			});
		});

		sock.on('message-accepted', (payload: {
			channelId?: string;
			messageId?: string;
			clientMessageId?: string;
			timestamp?: number;
		}) => {
			if (!payload?.channelId || !payload.clientMessageId) return;
			const patch: Partial<Message> = {
				deliveryState: undefined,
				deliveryError: undefined
			};
			if (payload.messageId) patch.id = payload.messageId;
			if (typeof payload.timestamp === 'number' && Number.isFinite(payload.timestamp)) {
				patch.timestamp = payload.timestamp;
			}
			_updateOptimisticMessage(
				payload.channelId,
				(message) => message.clientMessageId === payload.clientMessageId,
				patch
			);
			const db = getWabiDB();
			if (db && payload.clientMessageId) {
				db.markSyncedByClientId(payload.clientMessageId).catch(() => {});
			}
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
								...(payload.forceSpoiler != null ? { forceSpoiler: payload.forceSpoiler } : {}),
								...('autoDeleteAfter' in (payload || {})
									? { autoDeleteAfter: payload.autoDeleteAfter ?? null }
									: {})
						  }
						: ch
				)
			);
		});

		sock.on('channel-deleted', (payload: { channelId?: string; channelIds?: string[] }) => {
			const deletedId = payload?.channelId;
			if (!deletedId) return;
			const all = get(channels);
			const removed = descendantIds(all, deletedId);
			for (const id of payload.channelIds || []) removed.add(id);
			removed.add(deletedId);
			channels.update((list) => list.filter((c) => !removed.has(c.id)));
			_updatePinnedChannels();
			const active = get(currentChannel);
			if (removed.has(active)) {
				const remaining = get(channels);
				const general = remaining.find((c) => c.id === 'general');
				const next = (general || remaining[0])?.id || '';
				currentChannel.set(next);
				if (next) joinChannel(next);
			}
		});

		sock.on('channels-reordered', (payload: { channels?: { id: string; position?: number; parentId?: string | null }[] }) => {
			const reorderList = payload?.channels;
			if (!Array.isArray(reorderList) || reorderList.length === 0) return;
			channels.update((list) =>
				list.map((ch) => {
					const update = reorderList.find((r) => r.id === ch.id);
					if (!update) return ch;
					const next: Channel = { ...ch };
					if (update.position != null) next.position = update.position;
					// null parentId = leave folder (must clear, not leave stale)
					if ('parentId' in update) {
						next.parentId = update.parentId ?? undefined;
					}
					return next;
				})
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

		// Backend rejection surfaces — avoid silent no-ops for channel/moderation ops.
		const surfaceSocketError = (event: string, payload: { error?: string } | undefined) => {
			const msg = payload?.error || event;
			console.warn(`[socket] ${event}`, msg);
			if (typeof window !== 'undefined') {
				// Lightweight user-facing signal without a toast dependency.
				window.dispatchEvent(
					new CustomEvent('wabi-socket-error', { detail: { event, message: msg } })
				);
			}
		};
		for (const evt of [
			'create-thread-error',
			'pin-channel-error',
			'unpin-channel-error',
			'ban-error',
			'kick-error',
			'wiki-error',
			'forum-error',
			'incident-error'
		] as const) {
			sock.on(evt, (payload: { error?: string }) => surfaceSocketError(evt, payload));
		}

		// Server-side custom emote list (upload/delete broadcast) -> picker store.
		sock.on('emojis-list', (serverEmotes: ServerEmote[]) => {
			mergeServerEmotes(Array.isArray(serverEmotes) ? serverEmotes : []);
		});

		sock.on('delete-emoji-success', (payload: { name?: string }) => {
			if (payload?.name) removeServerEmote(payload.name);
		});

		sock.on('emoji-reaction-added', (payload: { channelId?: string; messageId?: string; userId?: number; emojiId?: string }) => {
			if (!payload?.channelId || !payload.messageId || !payload.emojiId) return;
			const userIdStr = String(payload.userId);
			channelMessages.update((state) => {
				const messages = state[payload.channelId!];
				if (!messages) return state;
				const next = messages.map((msg) => {
					if (msg.id !== payload.messageId) return msg;
					const reactions = { ...(msg.reactions || {}) };
					const users = reactions[payload.emojiId!] || [];
					if (!users.includes(userIdStr)) {
						reactions[payload.emojiId!] = [...users, userIdStr];
					}
					return { ...msg, reactions };
				});
				return { ...state, [payload.channelId!]: next };
			});
		});

		sock.on('emoji-reaction-removed', (payload: { channelId?: string; messageId?: string; userId?: number; emojiId?: string }) => {
			if (!payload?.channelId || !payload.messageId || !payload.emojiId) return;
			const userIdStr = String(payload.userId);
			channelMessages.update((state) => {
				const messages = state[payload.channelId!];
				if (!messages) return state;
				const next = messages.map((msg) => {
					if (msg.id !== payload.messageId) return msg;
					const reactions = { ...(msg.reactions || {}) };
					const users = reactions[payload.emojiId!];
					if (!users) return { ...msg, reactions };
					const filtered = users.filter((uid) => uid !== userIdStr);
					if (filtered.length === 0) {
						delete reactions[payload.emojiId!];
					} else {
						reactions[payload.emojiId!] = filtered;
					}
					return { ...msg, reactions };
				});
				return { ...state, [payload.channelId!]: next };
			});
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
			// R8: when self finally arrives (or re-joins), promote to currentUser so
			// guest name / id / roles replace any provisional hydrate.
			const joinName = this.username.trim().toLowerCase();
			const isSelfByName =
				Boolean(joinName) && user.username?.trim().toLowerCase() === joinName;
			const isSelfBySocket = Boolean(sock.id) && user.id === sock.id;
			if (isSelfByName || isSelfBySocket) {
				_setCurrentUser(user);
			}
		});

		sock.on('user-updated', (user: User) => {
			if (!user?.id) return;
			upsertUser(users, user);
			upsertUser(serverMembers, user);
			_mergeCurrentUserProfile({
				profilePicture: user.profilePicture,
				bannerUrl: user.bannerUrl,
				overlayUrl: user.overlayUrl,
				usernameFont: user.usernameFont,
				bio: user.bio
			});
		});

		// Self-selected presence broadcasts (namespace-wide, already masked:
		// invisible arrives as "offline"). Match by dbUserId when present —
		// the sender's socket id differs from roster ids.
		sock.on('presence-changed', (payload: { id?: string; dbUserId?: number; status?: string }) => {
			if (!payload?.status) return;
			const matches = (u: { id: string; dbUserId?: number | null }): boolean =>
				(payload.dbUserId != null && u.dbUserId === payload.dbUserId) ||
				(payload.id != null && u.id === payload.id);
			const applyStatus = (u: User & { dbUserId?: number | null }): User =>
				matches(u) ? { ...u, status: payload.status as User['status'] } : u;
			users.update((list) => list.map(applyStatus));
			serverMembers.update((list) => list.map(applyStatus));
			const me = get(currentUser);
			if (me && matches(me)) currentUser.set({ ...me, status: payload.status as User['status'] });
		});

		sock.on('profile-updated', (user: User) => {
			if (!user?.id) return;
			upsertUser(users, user);
			upsertUser(serverMembers, user);
			_mergeCurrentUserProfile({
				profilePicture: user.profilePicture,
				bannerUrl: user.bannerUrl,
				overlayUrl: user.overlayUrl,
				usernameFont: user.usernameFont,
				bio: user.bio
			});
		});

		sock.on('user-left', (payload: { id?: string }) => {
			if (!payload?.id) return;
			users.update((current) => current.filter((user) => user.id !== payload.id));
			serverMembers.update((current) => current.map((user) =>
				user.id === payload.id ? { ...user, status: 'offline' } : user
			));
		});

		sock.on('voice-channel-state', (payload: { channelId?: string; members?: any[] }) => {
			console.log('[voice-channel-state] received:', JSON.stringify(payload));
			if (!payload?.channelId) return;
			_setVoiceChannelMembers(payload.channelId, Array.isArray(payload.members) ? payload.members : []);
			console.log('[voice-channel-state] set members for', payload.channelId, 'count:', Array.isArray(payload.members) ? payload.members.length : 0);
		});

		// The server moved this socket's voice presence (breakout move, moderator
		// drag, breakout close). Re-tune the local media session — the roster
		// move alone would leave the wabidb relay on the old channel's session.
		sock.on('voice-self-moved', (payload: { fromChannelId?: string; toChannelId?: string }) => {
			if (!payload?.fromChannelId || !payload?.toChannelId) return;
			void import('./calling').then(({ handleForcedVoiceMove }) =>
				handleForcedVoiceMove(sock, payload.fromChannelId!, payload.toChannelId!)
			).catch((error) => console.warn('[Socket] Failed to handle voice move:', error));
		});

		sock.on('voice-self-kicked', (payload: { channelId?: string; userId?: string }) => {
			if (!payload?.channelId) return;
			void import('./calling').then(({ handleForcedVoiceLeave }) =>
				handleForcedVoiceLeave(sock, payload.channelId!)
			).catch((error) => console.warn('[Socket] Failed to handle voice kick:', error));
		});

		sock.on('breakout-rooms-created', (payload: {
			parentChannelId?: string;
			rooms?: Array<{ id?: string; name?: string; parentChannelId?: string; breakoutIndex?: number }>;
		}) => {
			channels.update((list) => upsertBreakoutRooms(list, payload));
		});

		sock.on('breakout-rooms-closed', (payload: { rooms?: Array<{ id?: string }> }) => {
			channels.update((list) => removeBreakoutRooms(list, payload?.rooms));
		});

		sock.on('voice-channel-joined', (payload: { channelId?: string; user?: any }) => {
			if (!payload?.channelId || !payload.user?.userId) return;
			_updateVoiceChannelMember(payload.channelId, payload.user.userId, payload.user);
			// Phase 2: attributed join sound + session roster update, but only
			// for channels WE are connected to (silent for everyone else).
			void import('./calling').then((m) => {
				m.handleVoiceParticipantJoined(payload.user.userId, payload.user.username, payload.channelId);
			}).catch(() => undefined);
		});

		sock.on('voice-channel-error', (payload: { channelId?: string; error?: string }) => {
			if (!payload?.channelId || !payload.error) return;
			console.warn('[voice-channel-error]', payload.channelId, payload.error);
		});

		sock.on('voice-user-muted', (payload: { channelId?: string; userId?: string }) => {
			if (!payload?.channelId || !payload.userId) return;
			_updateVoiceChannelMember(payload.channelId, payload.userId, { isMuted: true });
		});

		sock.on('voice-user-deafened', (payload: { channelId?: string; userId?: string }) => {
			if (!payload?.channelId || !payload.userId) return;
			_updateVoiceChannelMember(payload.channelId, payload.userId, { isDeafened: true });
		});

		sock.on('voice-user-undeafened', (payload: { channelId?: string; userId?: string }) => {
			if (!payload?.channelId || !payload.userId) return;
			_updateVoiceChannelMember(payload.channelId, payload.userId, { isDeafened: false });
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

		sock.on('voice-channel-user-joined', (payload: { channelId?: string; userId?: string; socketId?: string; username?: string; profilePicture?: string }) => {
			if (!payload?.channelId || !payload.userId) return;
			_updateVoiceChannelMember(payload.channelId, payload.userId, {
				userId: payload.userId,
				socketId: payload.socketId,
				username: payload.username || '',
				profilePicture: payload.profilePicture,
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
			// Phase 2: attributed leave sound for channels we are connected to.
			void import('./calling').then((m) => {
				m.handleVoiceParticipantLeft(payload.userId, payload.channelId);
			}).catch(() => undefined);
		});

		sock.on('role-definitions-updated', (payload: { roles?: any[] }) => {
			_setRoleDefinitions(Array.isArray(payload?.roles) ? payload.roles : []);
		});

		sock.on('badge-catalog', (payload: { catalog?: unknown } | unknown[]) => {
			const list = Array.isArray(payload) ? payload : (payload as any)?.catalog;
			if (Array.isArray(list)) _setBadgeCatalog(list as any);
		});

		sock.on(
			'user-badges-updated',
			(payload: { dbUserId?: number; badges?: any[] } & { userId?: string }) => {
				if (!payload || typeof payload.dbUserId !== 'number') return;
				_setUserBadges(payload.dbUserId, Array.isArray(payload.badges) ? payload.badges : []);
			}
		);

		sock.on('emoji-reaction-added', (payload: { messageId?: string; userId?: number; emojiId?: string }) => {
			if (!payload?.messageId || !payload.userId || !payload.emojiId) return;
			const userIdStr = `user-${payload.userId}`;
			channelMessages.update((state) => {
				const next = { ...state };
				for (const channelId of Object.keys(next)) {
					const messages = next[channelId];
					const idx = messages.findIndex((m) => m.id === payload.messageId);
					if (idx === -1) continue;
					const message = messages[idx];
					const reactions = { ...(message.reactions || {}) };
					const existing = reactions[payload.emojiId] ? [...reactions[payload.emojiId]] : [];
					if (!existing.includes(userIdStr)) {
						existing.push(userIdStr);
					}
					reactions[payload.emojiId] = existing;
					const updated = [...messages];
					updated[idx] = { ...message, reactions };
					next[channelId] = updated;
				}
				return next;
			});
		});

		sock.on('emoji-reaction-removed', (payload: { messageId?: string; userId?: number; emojiId?: string }) => {
			if (!payload?.messageId || !payload.userId || !payload.emojiId) return;
			const userIdStr = `user-${payload.userId}`;
			channelMessages.update((state) => {
				const next = { ...state };
				for (const channelId of Object.keys(next)) {
					const messages = next[channelId];
					const idx = messages.findIndex((m) => m.id === payload.messageId);
					if (idx === -1) continue;
					const message = messages[idx];
					const reactions = { ...(message.reactions || {}) };
					const existing = reactions[payload.emojiId] ? [...reactions[payload.emojiId]] : [];
					const filtered = existing.filter((id) => id !== userIdStr);
					if (filtered.length > 0) {
						reactions[payload.emojiId] = filtered;
					} else {
						delete reactions[payload.emojiId];
					}
					const updated = [...messages];
					updated[idx] = { ...message, reactions };
					next[channelId] = updated;
				}
				return next;
			});
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
