import { writable } from 'svelte/store';
import { io, Socket } from 'socket.io-client';
import { browser } from '$app/environment';
import { showNotification } from './notifications';
import { initEmotes, addEmote, removeEmote } from './markdown';
import { chatStorage } from './storage';

export interface Message {
	id: string;
	user: string;
	userId: string;
	text: string;
	timestamp: number;
	type: 'text' | 'gif' | 'file';
	gifUrl?: string;
	fileUrl?: string;
	fileName?: string;
	fileSize?: number;
	isPinned?: boolean;
	isEdited?: boolean;
	replyTo?: string;
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

let socketInstance: Socket | null = null;

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

	socketInstance = io(serverUrl);
	socket.set(socketInstance);

	// Load saved messages from IndexedDB if enabled
	chatStorage.loadAllMessages().then(savedMessages => {
		if (Object.keys(savedMessages).length > 0) {
			channelMessages.set(savedMessages);
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

	socketInstance.on('init', (data: { channels: Channel[]; users: User[]; excalidrawState: any; emotes: any[] }) => {
		channels.set(data.channels);
		users.set(data.users);

		// Initialize emotes
		if (data.emotes) {
			initEmotes(data.emotes);
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
		channelMessages.update(msgs => ({
			...msgs,
			[data.channelId]: data.messages
		}));
	});

	socketInstance.on('message', (data: { channelId: string; message: Message }) => {
		channelMessages.update(msgs => ({
			...msgs,
			[data.channelId]: [...(msgs[data.channelId] || []), data.message]
		}));

		// Save to local storage if enabled
		chatStorage.saveMessage(data.channelId, data.message);

		// Show notification for messages from other users
		const isCurrentUser = data.message.userId === socketInstance?.id;
		showNotification(data.message, isCurrentUser);

		// Increment unread count and track first unread if not from current user and page is hidden
		if (!isCurrentUser && document.hidden) {
			unreadCount.update(n => {
				// Set first unread message ID if this is the first unread
				if (n === 0) {
					lastReadMessageId.set(data.message.id);
				}
				return n + 1;
			});
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
		channels.update(chs => [...chs, channel]);
		channelMessages.update(msgs => ({ ...msgs, [channel.id]: [] }));
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

	return socketInstance;
}

export function joinChannel(channelId: string) {
	socketInstance?.emit('join-channel', channelId);
	currentChannel.set(channelId);
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
}

export function uploadEmote(name: string, imageData: string, type: 'static' | 'animated') {
	socketInstance?.emit('upload-emote', { name, imageData, type });
}

export function deleteEmote(emoteName: string) {
	socketInstance?.emit('delete-emote', emoteName);
}
