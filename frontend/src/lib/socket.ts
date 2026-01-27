import { writable, get } from 'svelte/store';
import { io, Socket } from 'socket.io-client';
import { browser } from '$app/environment';
import { showNotification } from './notifications';
import { initEmotes, addEmote, removeEmote } from './markdown';
import { chatStorage } from './storage';
import * as calling from './calling';
import * as webrtc from './webrtc';
import type { FileAttachment, Message, Emoji, User, Channel } from './socket-types';
import { emojis } from './emoji-store';
import { getServerUrl } from './serverUrl';
import { authStore } from './authStore';

export type { FileAttachment, Message, Emoji, User, Channel } from './socket-types';

export const socket = writable<Socket | null>(null);
export const channels = writable<Channel[]>([]);
export const pinnedChannels = writable<Channel[]>([]);
export const currentChannel = writable<string>('general');
export const channelMessages = writable<Record<string, Message[]>>({ general: [] });
export const users = writable<User[]>([]);
export const typingUsers = writable<string[]>([]);
export const currentUser = writable<User | null>(null);
export const connected = writable(false);
export const unreadCount = writable(0);
export const lastReadMessageId = writable<string | null>(null);
// Per-channel unread counts: { channelId: count }
export const channelUnreadCounts = writable<Record<string, number>>({});
// DM panel state: signal to open DM panel with channel and user info
export const dmPanelSignal = writable<{ channelId: string; otherUser: User } | null>(null);
// Emojis store
export { emojis };

// PAGINATION STORES: Track which archives are loaded for each channel
export const channelLoadedArchives = writable<Record<string, Set<string>>>({});
export const channelAvailableArchives = writable<Record<string, string[]>>({});
export const channelLoadingOlder = writable<Record<string, boolean>>({});

let socketInstance: Socket | null = null;

export function getSocket(): Socket | null {
	return socketInstance;
}

function updatePinnedChannels() {
	const current = get(currentUser);
	const allChannels = get(channels);

	if (!current) return;

	const pinned = allChannels.filter(ch =>
		ch.pinnedBy && ch.pinnedBy.includes(current.id)
	);

	pinnedChannels.set(pinned);
}

export function initSocket(username: string, authToken?: string) {
	if (!browser) return;

	// Close existing socket if any (prevents zombie connections)
	if (socketInstance) {
		console.log('[Socket] Closing existing connection before reconnecting');
		socketInstance.disconnect();
		socketInstance = null;
	}

	// Special handling for Tauri production hardcoded domain
	let serverUrl = getServerUrl();
	if (typeof window !== 'undefined' && window.location.origin.includes('tauri.localhost')) {
		const isDebug = import.meta.env.TAURI_DEBUG === 'true' || import.meta.env.DEV;
		if (!isDebug) {
			console.log('[Socket] Detected Tauri production environment, connecting to wabi.chat');
			serverUrl = 'https://wabi.chat';
		} else {
			console.log('[Socket] Using centralized server URL detection for Tauri dev');
		}
	} else {
		console.log('[Socket] Using centralized server URL detection');
	}

	// Check for existing session or token
	let sessionId: string | null = null;
	let token: string | null = null;

	if (browser) {
		try {
			token = authToken || localStorage.getItem('authToken');
			if (!token) {
				sessionId = localStorage.getItem('sessionId');
			}
		} catch (e) {
			console.error('Failed to read auth from localStorage:', e);
		}
	}

	const isRegistered = !!token;
	console.log('[Socket] Connecting to:', serverUrl, isRegistered ? '(registered user)' : sessionId ? '(with existing session)' : '(new connection)');

	socketInstance = io(serverUrl, {
		reconnectionDelay: 1000,
		reconnectionDelayMax: 5000,
		reconnectionAttempts: 10,
		timeout: 10000,
		withCredentials: true,
		transports: ['websocket', 'polling'],
		auth: {
			token: token || undefined,
			sessionId: !token ? sessionId || undefined : undefined
		}
	});

	socketInstance.on('connect', () => {
		console.log('[Socket] Connected successfully!', socketInstance!.id);
		connected.set(true);
	});

	socketInstance.on('connect_error', (error) => {
		const msg = error?.message || '';
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

		console.error(`[Socket] Connection error [${errorType}]:`, userMessage);
		console.error('[Socket] Raw error:', { message: msg, type: (error as any)?.type, data: (error as any)?.data });
		connected.set(false);

		// Surface actionable errors to user via AuthErrorBanner
		if (errorType === 'auth_expired' || errorType === 'auth_invalid') {
			authStore.setAuthError(userMessage, 'session_expired');
		} else if (errorType === 'cors_rejection') {
			authStore.setAuthError(userMessage, 'auth_failed');
		} else if (errorType === 'network_unreachable' || errorType === 'timeout') {
			authStore.setAuthError(userMessage, 'connection_lost');
		}
		// upgrade_failed and unknown: don't show banner (Socket.io retries automatically)
	});

	socketInstance.on('reconnect_failed', () => {
		console.error('[Socket] Failed to reconnect after 10 attempts - giving up');
		connected.set(false);
		authStore.setAuthError('Could not reconnect to server. Please refresh the page.', 'connection_lost');
	});

	socket.set(socketInstance);

	// Load unread counts from localStorage
	if (browser) {
		try {
			const saved = localStorage.getItem('channelUnreadCounts');
			if (saved) {
				const counts = JSON.parse(saved);
				channelUnreadCounts.set(counts);
				// Calculate total unread
				const total = Object.values(counts).reduce((sum: number, count) => sum + (count as number), 0);
				unreadCount.set(total);
				updateBrowserTitle();
			}
		} catch (e) {
			console.error('Failed to load unread counts from localStorage:', e);
		}
	}

	// Load saved messages from IndexedDB if enabled
	// This is called before we know channel config, so we'll load archives again after 'init'
	chatStorage.loadAllMessages().then(result => {
		if (Object.keys(result.messages).length > 0) {
			// Deduplicate messages in each channel by ID
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

		// Initialize pagination tracking for all channels
		const initialLoaded: Record<string, Set<string>> = {};
		const initialAvailable = result.availableArchives;
		for (const channelId of Object.keys(result.messages)) {
			initialLoaded[channelId] = new Set(); // Will be populated after 'init' event
		}
		channelLoadedArchives.set(initialLoaded);
		channelAvailableArchives.set(initialAvailable);
	});

	socketInstance.on('connect', () => {
		connected.set(true);
		if (sessionId) {
			console.log('[Socket] Connected to server - sending rejoin event with sessionId');
			socketInstance?.emit('rejoin', sessionId);
		} else {
			console.log('[Socket] Connected to server - sending join event with username:', username);
			socketInstance?.emit('join', username);
		}
	});

	socketInstance.on('disconnect', () => {
		console.log('Disconnected from server');
		connected.set(false);
	});

	// Handle rejoin failure - fall back to join with username
	socketInstance.on('rejoin-failed', (data: { reason: string }) => {
		console.log('[Socket] Rejoin failed:', data.reason, '- falling back to join with username');
		// Clear invalid session
		if (browser) {
			try {
				localStorage.removeItem('sessionId');
			} catch (e) {
				console.error('Failed to clear sessionId from localStorage:', e);
			}
		}
		// Fallback to regular join
		socketInstance?.emit('join', username);
	});

	socketInstance.on('init', (data: { channels: Channel[]; users: User[]; excalidrawState: any; emotes: any[]; emojis: Emoji[]; sessionId?: string }) => {
		console.log('[Socket] Received init event', data);
		console.log('[INIT DEBUG] Received init data:', Object.keys(data));
		console.log('[INIT DEBUG] data.emojis value:', data.emojis);
		console.log('[INIT DEBUG] typeof data.emojis:', typeof data.emojis);

		// Save session ID for persistence across page reloads
		if (data.sessionId && browser) {
			try {
				localStorage.setItem('sessionId', data.sessionId);
				console.log('[Socket] Session ID saved to localStorage');
			} catch (e) {
				console.error('Failed to save sessionId to localStorage:', e);
			}
		}

		users.set(data.users);

		// Process channels to fix DM names
		const processedChannels = data.channels.map(channel => {
			if (channel.type === 'dm' && channel.members) {
				// Find the other user in the DM
				const otherUserId = channel.members.find(id => id !== socketInstance?.id);
				const otherUser = data.users.find(u => u.id === otherUserId);

				if (otherUser) {
					return {
						...channel,
						name: otherUser.username,
						otherUser: otherUser
					};
				}
			}
			return channel;
		});

		channels.set(processedChannels);

	// PAGINATION: Now that we have channels, re-load with channel context for proper pagination setup
	chatStorage.loadAllMessages(processedChannels).then(result => {
		// Update pagination state
		const loadedArchives: Record<string, Set<string>> = {};

		// For each channel, determine which archives are currently loaded
		for (const channelId of Object.keys(result.messages)) {
			const channelConfig = processedChannels.find(ch => ch.id === channelId);
			const shouldPersist = channelConfig?.persistMessages === true;

			if (shouldPersist && result.availableArchives[channelId]) {
				// For persistent channels, the most recent archives are loaded
				loadedArchives[channelId] = new Set(); // Start empty, will be populated as user loads more
			}
		}

		channelLoadedArchives.set(loadedArchives);
		channelAvailableArchives.set(result.availableArchives);
	});

	// Initialize emotes
	if (data.emotes) {
		initEmotes(data.emotes);
	}

		// Initialize emojis
		if (data.emojis) {
			console.log('Received emojis from server:', data.emojis.length, data.emojis);
			emojis.set(data.emojis);
		} else {
			console.log('No emojis received from server!');
		}

		// Find current user
		console.log('[Socket] Looking for current user. Socket ID:', socketInstance?.id);
		console.log('[Socket] Available users:', data.users);
		const user = data.users.find(u => u.id === socketInstance!.id);
		if (user) {
			console.log('[Socket] ✅ Found current user:', user);
			currentUser.set(user);
			// Update pinned channels now that we have the current user
			updatePinnedChannels();
		} else {
			console.error('[Socket] ❌ Could not find current user in users list!');
		}

		// Join the general channel by default
		socketInstance?.emit('join-channel', 'general');
	});

	socketInstance.on('channel-messages', (data: { channelId: string; messages: Message[] }) => {
		channelMessages.update(msgs => {
			// Merge server messages with local messages, deduplicating by ID
			const existingMessages = msgs[data.channelId] || [];
			const existingIds = new Set(existingMessages.map(m => m.id));
			const newMessages = data.messages.filter(m => !existingIds.has(m.id));

			return {
				...msgs,
				[data.channelId]: [...existingMessages, ...newMessages]
			};
		});
	});

	socketInstance.on('message', (data: { channelId: string; message: Message }) => {
		channelMessages.update(msgs => {
			const channelMsgs = msgs[data.channelId] || [];
			// Check if message already exists (prevent duplicates)
			if (channelMsgs.some(m => m.id === data.message.id)) {
				return msgs;
			}
			return {
				...msgs,
				[data.channelId]: [...channelMsgs, data.message]
			};
		});

		// Save to local storage if channel has persistMessages enabled
		channels.subscribe(chs => {
			const channel = chs.find(ch => ch.id === data.channelId);
			if (channel?.persistMessages) {
				chatStorage.saveMessage(data.channelId, data.message);
			}
		})();

		// Show notification for messages from other users with channel context
		const isCurrentUser = data.message.userId === socketInstance?.id;
		const currentChannels = get(channels);
		const currentChannelId = get(currentChannel);

		const channel = currentChannels.find(ch => ch.id === data.channelId);
		const channelName = channel?.name;
		const isCurrentChannelActive = currentChannelId === data.channelId;

		showNotification(data.message, isCurrentUser, channelName);

		// Increment per-channel unread count if not from current user and either:
		// - user is NOT viewing the current channel OR
		// - page is hidden
		if (!isCurrentUser && (!isCurrentChannelActive || document.hidden)) {
			channelUnreadCounts.update(counts => {
				const newCounts = {
					...counts,
					[data.channelId]: (counts[data.channelId] || 0) + 1
				};

				// Save to localStorage
				if (browser) {
					localStorage.setItem('channelUnreadCounts', JSON.stringify(newCounts));
				}

				return newCounts;
			});

			// Also increment global unread count
			unreadCount.update(n => {
				if (n === 0) {
					lastReadMessageId.set(data.message.id);
				}
				return n + 1;
			});

			// Update browser tab title
			updateBrowserTitle();
		}
	});

	socketInstance.on('user-joined', (user: User) => {
		users.update(u => [...u, user]);
	});

	socketInstance.on('user-left', (data: { id: string; username: string }) => {
		users.update(u => u.filter(user => user.id !== data.id));
	});

	socketInstance.on('typing', (usernames: string[]) => {
		typingUsers.set(usernames);
	});

	socketInstance.on('profile-updated', (user: User) => {
		users.update(u => u.map(existingUser =>
			existingUser.id === user.id ? user : existingUser
		));
		// Update current user if it's them
		currentUser.update(cu => cu && cu.id === user.id ? user : cu);
	});

	socketInstance.on('message-edited', (data: { channelId: string; messageId: string; newText: string }) => {
		channelMessages.update(msgs => ({
			...msgs,
			[data.channelId]: (msgs[data.channelId] || []).map(msg =>
				msg.id === data.messageId ? { ...msg, text: data.newText, isEdited: true } : msg
			)
		}));
	});

	socketInstance.on('message-deleted', (data: { channelId: string; messageId: string }) => {
		channelMessages.update(msgs => ({
			...msgs,
			[data.channelId]: (msgs[data.channelId] || []).filter(msg => msg.id !== data.messageId)
		}));
	});

	socketInstance.on('message-pin-toggled', (data: { channelId: string; messageId: string; isPinned: boolean }) => {
		channelMessages.update(msgs => ({
			...msgs,
			[data.channelId]: (msgs[data.channelId] || []).map(msg =>
				msg.id === data.messageId ? { ...msg, isPinned: data.isPinned } : msg
			)
		}));
	});

	// Channel events
	socketInstance.on('channel-created', (channel: Channel) => {
		let processedChannel = channel;

		// Fix DM name if needed
		if (channel.type === 'dm' && channel.members) {
			users.subscribe(usersList => {
				const otherUserId = channel.members!.find(id => id !== socketInstance?.id);
				const otherUser = usersList.find(u => u.id === otherUserId);

				if (otherUser) {
					processedChannel = {
						...channel,
						name: otherUser.username,
						otherUser: otherUser
					};
				}
			})();
		}

		channels.update(chs => [...chs, processedChannel]);
		channelMessages.update(msgs => ({ ...msgs, [processedChannel.id]: [] }));
	});

	socketInstance.on('channel-deleted', (channelId: string) => {
		channels.update(chs => chs.filter(ch => ch.id !== channelId));
		channelMessages.update(msgs => {
			const newMsgs = { ...msgs };
			delete newMsgs[channelId];
			return newMsgs;
		});
		// If current channel was deleted, switch to general
		currentChannel.update(ch => ch === channelId ? 'general' : ch);
	});

	socketInstance.on('channel-pinned', (data: { channelId: string; channel: Channel }) => {
		// Update the channel in the channels store to include the user in pinnedBy
		channels.update(chs =>
			chs.map(ch => ch.id === data.channelId ? data.channel : ch)
		);
		// Update pinned channels store
		updatePinnedChannels();
	});

	socketInstance.on('channel-unpinned', (data: { channelId: string; channel: Channel }) => {
		// Update the channel in the channels store to remove the user from pinnedBy
		channels.update(chs =>
			chs.map(ch => ch.id === data.channelId ? data.channel : ch)
		);
		// Update pinned channels store
		updatePinnedChannels();
	});

	socketInstance.on('channel-error', (error: string) => {
		console.error('Channel error:', error);
		alert(error);
	});

	// DM events
	socketInstance.on('dm-created', (data: { channelId: string; otherUser: User }) => {
		const dmChannel: Channel = {
			id: data.channelId,
			name: data.otherUser.username,
			createdAt: Date.now(),
			type: 'dm',
			otherUser: data.otherUser
		};

		channels.update(chs => {
			// Check if DM already exists in list
			if (chs.some(ch => ch.id === data.channelId)) {
				return chs;
			}
			return [...chs, dmChannel];
		});

		channelMessages.update(msgs => ({
			...msgs,
			[data.channelId]: msgs[data.channelId] || []
		}));

		// Signal to open the DM panel (not switch main chat)
		dmPanelSignal.set({ channelId: data.channelId, otherUser: data.otherUser });
	});

	// Group events
	socketInstance.on('group-created', (group: Channel) => {
		channels.update(chs => {
			if (chs.some(ch => ch.id === group.id)) {
				return chs;
			}
			return [...chs, group];
		});

		channelMessages.update(msgs => ({
			...msgs,
			[group.id]: msgs[group.id] || []
		}));
	});

	// Emote events
	socketInstance.on('emote-added', (emote: any) => {
		addEmote(emote);
	});

	socketInstance.on('emote-deleted', (emoteName: string) => {
		removeEmote(emoteName);
	});

	socketInstance.on('emote-error', (error: string) => {
		console.error('Emote error:', error);
		alert(error);
	});

	// Emoji and reaction events
	socketInstance.on('reaction-added', (data: {
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

	socketInstance.on('reaction-removed', (data: {
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

	socketInstance.on('emoji-added', (emoji: Emoji) => {
		emojis.update(e => [...e, emoji]);
	});

	socketInstance.on('emoji-deleted', (emojiName: string) => {
		emojis.update(e => e.filter(emoji => emoji.name !== emojiName));
	});

	// Offline message events for registered users
	socketInstance.on('offline-messages', (data: { channelId: string; messages: Message[] }) => {
		console.log(`[Socket] Received ${data.messages.length} offline messages for channel ${data.channelId}`);

		// Add offline messages to the channel
		channelMessages.update(msgs => {
			const existing = msgs[data.channelId] || [];
			// Merge without duplicates
			const existingIds = new Set(existing.map(m => m.id));
			const newMessages = data.messages.filter(m => !existingIds.has(m.id));

			return {
				...msgs,
				[data.channelId]: [...existing, ...newMessages]
			};
		});

		// Show notification
		showNotification({
			title: '📬 Offline Messages',
			body: `You have ${data.messages.length} new message${data.messages.length > 1 ? 's' : ''} in chat`
		} as Message, false, '');
	});

	// Confirmation that message was queued for offline delivery
	socketInstance.on('message-queued', (data: { messageId: string }) => {
		console.log(`[Socket] Message ${data.messageId} queued for offline delivery`);
		// Optional: Update UI to show "queued" status on the message
		// Could be used for visual feedback like "⏱️ Queued for offline delivery"
	});

	// Channel settings events
	socketInstance.on('channel-settings-updated', (data: {
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

	// WebRTC Signaling Events for Voice/Video Calls and Screen Sharing
	socketInstance.on('call-incoming', (data: { userId: string, username: string, isVideoCall: boolean }) => {
		console.log(`[WebRTC] Incoming call from ${data.username}`);
		calling.incomingCall.set(data);
	});

	socketInstance.on('call-rejected', () => {
		console.log('[WebRTC] Call rejected');
		calling.endCall(socketInstance!);
	});

	socketInstance.on('call-ended', (data: { userId: string }) => {
		console.log(`[WebRTC] Call ended with ${data.userId}`);
		calling.removeCall(data.userId);
		webrtc.removeScreenShare(data.userId);
	});

	socketInstance.on('call-offer', (data: { offer: RTCSessionDescriptionInit, senderId: string, username: string }) => {
		console.log(`[WebRTC] Received call offer from ${data.username}`);
		calling.handleCallOffer(socketInstance!, data.senderId, data.username, data.offer);
	});

	socketInstance.on('call-answer-sdp', (data: { answer: RTCSessionDescriptionInit, senderId: string }) => {
		console.log(`[WebRTC] Received call answer from ${data.senderId}`);
		calling.handleCallAnswer(data.senderId, data.answer);
	});

	socketInstance.on('call-ice-candidate', (data: { candidate: RTCIceCandidateInit, senderId: string }) => {
		console.log(`[WebRTC] Received ICE candidate for call from ${data.senderId}`);
		calling.handleCallIceCandidate(data.senderId, data.candidate);
	});

	// Screenshare specific
	socketInstance.on('screen-share-started', (data: { userId: string, username: string }) => {
		console.log(`[WebRTC] ${data.username} started screen sharing`);
		// We need to initiate a WebRTC connection to receive the stream
		webrtc.createOffer(socketInstance!, data.userId);
	});

	socketInstance.on('screen-share-stopped', (data: { userId: string }) => {
		console.log(`[WebRTC] Screen share stopped for ${data.userId}`);
		webrtc.removeScreenShare(data.userId);
	});

	socketInstance.on('webrtc-offer', (data: { offer: RTCSessionDescriptionInit, senderId: string, username: string }) => {
		console.log(`[WebRTC] Received webrtc offer from ${data.username}`);
		webrtc.handleOffer(socketInstance!, data.senderId, data.username, data.offer);
	});

	socketInstance.on('webrtc-answer', (data: { answer: RTCSessionDescriptionInit, senderId: string }) => {
		console.log(`[WebRTC] Received webrtc answer from ${data.senderId}`);
		webrtc.handleAnswer(data.senderId, data.answer);
	});

	socketInstance.on('webrtc-ice-candidate', (data: { candidate: RTCIceCandidateInit, senderId: string }) => {
		console.log(`[WebRTC] Received ICE candidate for webrtc from ${data.senderId}`);
		webrtc.handleIceCandidate(data.senderId, data.candidate);
	});


	return socketInstance;
}

export function joinChannel(channelId: string) {
	// Prevent DM channels from being opened in the main chat area
	// DMs should only be opened via the DM panel (dmPanelSignal)
	const channel = get(channels).find(ch => ch.id === channelId);
	if (channel && channel.type === 'dm') {
		console.warn('Cannot join DM channel via joinChannel - use DM panel instead');

		// If someone tries to join a DM channel, redirect them to the DM panel
		if (channel.otherUser) {
			dmPanelSignal.set({ channelId, otherUser: channel.otherUser });
		}
		return;
	}

	socketInstance?.emit('join-channel', channelId);
	currentChannel.set(channelId);
	// Mark channel as read when joining
	markChannelAsRead(channelId);
}

/**
 * Internal function to notify server of channel switch without UI changes.
 * Used by DM panel to track user's active channel for typing indicators.
 */
export function switchChannel(channelId: string) {
	socketInstance?.emit('join-channel', channelId);
	// Don't set currentChannel - that's only for main chat area
	// Don't call markChannelAsRead - DM panel handles its own read state
}

export function createChannel(channelName: string) {
	socketInstance?.emit('create-channel', channelName);
}

export function deleteChannel(channelId: string) {
	socketInstance?.emit('delete-channel', channelId);
}

export function sendMessage(channelId: string, text: string, type: 'text' | 'gif' | 'file' = 'text', options?: {
	gifUrl?: string;
	fileUrl?: string;
	fileName?: string;
	fileSize?: number;
	replyTo?: string;
	isSpoiler?: boolean;
}) {
	socketInstance?.emit('message', { channelId, text, type, ...options });
}

export function editMessage(channelId: string, messageId: string, newText: string) {
	socketInstance?.emit('edit-message', { channelId, messageId, newText });
}

export function deleteMessage(channelId: string, messageId: string) {
	socketInstance?.emit('delete-message', { channelId, messageId });
}

export function togglePinMessage(channelId: string, messageId: string) {
	socketInstance?.emit('toggle-pin-message', { channelId, messageId });
}

export function pinChannel(channelId: string) {
	socketInstance?.emit('pin-channel', { channelId });
}

export function unpinChannel(channelId: string) {
	socketInstance?.emit('unpin-channel', { channelId });
}

export function sendTyping(isTyping: boolean) {
	socketInstance?.emit('typing', isTyping);
}

export function updateProfile(status?: 'active' | 'away' | 'busy', profilePicture?: string, bannerUrl?: string) {
	socketInstance?.emit('update-profile', { status, profilePicture, bannerUrl });
}

export function disconnect() {
	socketInstance?.disconnect();
	socket.set(null);
	socketInstance = null;
}

export function markMessagesAsRead() {
	unreadCount.set(0);
	lastReadMessageId.set(null);
	updateBrowserTitle();
}

export function markChannelAsRead(channelId: string) {
	channelUnreadCounts.update(counts => {
		const newCounts = { ...counts };
		const channelCount = newCounts[channelId] || 0;

		// Subtract channel count from global unread count
		unreadCount.update(n => Math.max(0, n - channelCount));

		// Clear channel unread count
		delete newCounts[channelId];
		return newCounts;
	});

	// Save to localStorage
	if (browser) {
		channelUnreadCounts.subscribe(counts => {
			localStorage.setItem('channelUnreadCounts', JSON.stringify(counts));
		})();
	}

	updateBrowserTitle();
}

function updateBrowserTitle() {
	if (!browser) return;

	let totalUnread = 0;
	unreadCount.subscribe(n => totalUnread = n)();

	if (totalUnread === 0) {
		document.title = 'Wabi Chat';
	} else if (totalUnread <= 10) {
		document.title = `(${totalUnread}) Wabi Chat`;
	} else {
		document.title = '(•) Wabi Chat';
	}
}

// PAGINATION: Load older messages for a channel
// Called when user clicks "Load More" button
export async function loadOlderMessages(channelId: string): Promise<void> {
	if (!browser) return;

	// Set loading state
	channelLoadingOlder.update(state => ({ ...state, [channelId]: true }));

	try {
		// Get current state
		const availableArchives = get(channelAvailableArchives)[channelId] || [];
		const loadedArchives = get(channelLoadedArchives)[channelId] || new Set();

		// Find next unloaded archive (oldest first)
		const nextArchive = availableArchives.find(archiveKey => !loadedArchives.has(archiveKey));

		if (!nextArchive) {
			console.log(`[Pagination] No more archives for ${channelId}`);
			channelLoadingOlder.update(state => ({ ...state, [channelId]: false }));
			return;
		}

		console.log(`[Pagination] Loading archive ${nextArchive} for ${channelId}`);

		// Load the archive from IndexedDB
		const olderMessages = await chatStorage.loadArchiveForChannel(channelId, nextArchive);

		if (olderMessages.length === 0) {
			console.log(`[Pagination] Archive ${nextArchive} is empty for ${channelId}`);
			channelLoadingOlder.update(state => ({ ...state, [channelId]: false }));
			return;
		}

		// Merge into channel messages (insert at beginning to maintain chronological order)
		channelMessages.update(msgs => ({
			...msgs,
			[channelId]: [...olderMessages, ...(msgs[channelId] || [])]
		}));

		// Mark this archive as loaded
		channelLoadedArchives.update(state => ({
			...state,
			[channelId]: new Set([...(state[channelId] || new Set()), nextArchive])
		}));

		console.log(`[Pagination] ✅ Loaded ${olderMessages.length} messages from ${nextArchive}`);
	} catch (error) {
		console.error(`[Pagination] Failed to load older messages for ${channelId}:`, error);
	} finally {
		channelLoadingOlder.update(state => ({ ...state, [channelId]: false }));
	}
}

export function uploadEmote(name: string, imageData: string, type: 'static' | 'animated') {
	socketInstance?.emit('upload-emote', { name, imageData, type });
}

export function deleteEmote(emoteName: string) {
	socketInstance?.emit('delete-emote', emoteName);
}

export function createDM(targetUserId: string) {
	socketInstance?.emit('create-dm', { targetUserId });
}

export function createGroup(name: string, memberIds: string[]) {
	socketInstance?.emit('create-group', { name, memberIds });
}

export function updateChannelSettings(channelId: string, settings: {
	autoDeleteAfter?: '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
	persistMessages?: boolean;
}) {
	socketInstance?.emit('update-channel-settings', { channelId, ...settings });
}

export function addReaction(channelId: string, messageId: string, emojiId: string) {
	socketInstance?.emit('add-reaction', { channelId, messageId, emojiId });
}

export function removeReaction(channelId: string, messageId: string, emojiId: string) {
	socketInstance?.emit('remove-reaction', { channelId, messageId, emojiId });
}

export function uploadEmoji(name: string, url: string, category: string) {
	socketInstance?.emit('upload-emoji', { name, url, category });
}

export function deleteEmoji(emojiName: string) {
	socketInstance?.emit('delete-emoji', emojiName);
}
