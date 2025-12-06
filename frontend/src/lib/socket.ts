import { writable, get } from 'svelte/store';
import { io, Socket } from 'socket.io-client';
import { browser } from '$app/environment';
import { showNotification } from './notifications';
import { initEmotes, addEmote, removeEmote } from './markdown';
import { chatStorage } from './storage';

export interface FileAttachment {
	fileUrl: string;
	fileName: string;
	fileSize: number;
}

export interface Message {
	id: string;
	user: string;
	userId: string;
	text: string;
	timestamp: number;
	type: 'text' | 'gif' | 'file' | 'emoji';
	gifUrl?: string;
	emojiUrl?: string;
	emojiName?: string;
	fileUrl?: string;
	fileName?: string;
	fileSize?: number;
	files?: FileAttachment[]; // Multiple file attachments
	isPinned?: boolean;
	isEdited?: boolean;
	replyTo?: string;
	isSpoiler?: boolean; // Mark media as spoiler (requires click to reveal)
	reactions?: Record<string, string[]>; // emojiId -> array of userIds who reacted
}

export interface Emoji {
	id: string;
	name: string;
	url: string;
	category: string;
	isCustom: boolean;
}

export interface User {
	id: string;
	username: string;
	color: string;
	status: 'active' | 'away' | 'busy';
	profilePicture?: string;
}

export interface Channel {
	id: string;
	name: string;
	createdAt: number;
	type?: 'public' | 'dm' | 'group';
	members?: string[]; // User IDs for DMs and group chats
	otherUser?: User; // For DMs, the other user in the conversation

	autoDeleteAfter?: '1h' | '6h' | '12h' | '24h' | '3d' | '7d' | '14d' | '30d' | null;
	isTemporary?: boolean; // If true, channel is temporary and will be deleted after all users leave
	persistMessages?: boolean; // If true, messages are persisted to disk for recovery on server restart
}

export const socket = writable<Socket | null>(null);
export const channels = writable<Channel[]>([]);
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
export const emojis = writable<Emoji[]>([]);

let socketInstance: Socket | null = null;

export function getSocket(): Socket | null {
	return socketInstance;
}

export function initSocket(username: string) {
	if (!browser) return;

	// Auto-detect server URL: use window origin if not in dev mode, otherwise localhost
	let serverUrl = 'http://localhost:3000';
	if (import.meta.env.VITE_SOCKET_URL) {
		serverUrl = import.meta.env.VITE_SOCKET_URL;
	} else if (typeof window !== 'undefined') {
		const origin = window.location.origin;
		// Use same origin unless it's the dev server port
		if (!origin.includes(':5173')) {
			serverUrl = origin;
		}
	}

	console.log('[Socket] Connecting to:', serverUrl);
	socketInstance = io(serverUrl);

	socketInstance.on('connect', () => {
		console.log('[Socket] Connected successfully!', socketInstance.id);
	});

	socketInstance.on('connect_error', (error) => {
		console.error('[Socket] Connection error:', error);
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
	chatStorage.loadAllMessages().then(savedMessages => {
		if (Object.keys(savedMessages).length > 0) {
			// Deduplicate messages in each channel by ID
			const deduped: Record<string, Message[]> = {};
			for (const [channelId, messages] of Object.entries(savedMessages)) {
				const seen = new Set<string>();
				deduped[channelId] = messages.filter(msg => {
					if (seen.has(msg.id)) return false;
					seen.add(msg.id);
					return true;
				});
			}
			channelMessages.set(deduped);
		}
	});

	socketInstance.on('connect', () => {
		console.log('Connected to server');
		connected.set(true);
		socketInstance?.emit('join', username);
	});

	socketInstance.on('disconnect', () => {
		console.log('Disconnected from server');
		connected.set(false);
	});

	socketInstance.on('init', (data: { channels: Channel[]; users: User[]; excalidrawState: any; emotes: any[]; emojis: Emoji[] }) => {
		console.log('[INIT DEBUG] Received init data:', Object.keys(data));
		console.log('[INIT DEBUG] data.emojis value:', data.emojis);
		console.log('[INIT DEBUG] typeof data.emojis:', typeof data.emojis);
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
		const user = data.users.find(u => u.id === socketInstance?.id);
		if (user) {
			currentUser.set(user);
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

export function sendTyping(isTyping: boolean) {
	socketInstance?.emit('typing', isTyping);
}

export function updateProfile(status?: 'active' | 'away' | 'busy', profilePicture?: string) {
	socketInstance?.emit('update-profile', { status, profilePicture });
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
