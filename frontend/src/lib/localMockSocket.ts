import { browser } from '$app/environment';
import { socket, connected, connectionState } from './socketConnectionState';
import type { Channel, Message, User } from './socket-types';

type Listener = (...args: any[]) => void;

const LOCAL_MOCK_FLAG = 'VITE_WABI_LOCAL_MOCK';
const LOCAL_MOCK_STORAGE_KEY = 'wabi:local-mock:messages:v1';

function localMockAvatar(label: string, background: string): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="${background}"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Inter, Arial, sans-serif" font-size="44" font-weight="800" fill="#06111d">${label}</text></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function isLocalMockMode(): boolean {
	return import.meta.env[LOCAL_MOCK_FLAG] === '1' || import.meta.env[LOCAL_MOCK_FLAG] === 'true';
}

export class LocalMockSocket {
	id: string;
	connected = true;
	private listeners = new Map<string, Set<Listener>>();

	constructor(private username: string) {
		const safeName = username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'guest';
		this.id = `local-${safeName}`;
	}

	on(event: string, listener: Listener): this {
		const bucket = this.listeners.get(event) || new Set<Listener>();
		bucket.add(listener);
		this.listeners.set(event, bucket);
		return this;
	}

	off(event: string, listener?: Listener): this {
		if (!listener) {
			this.listeners.delete(event);
			return this;
		}
		this.listeners.get(event)?.delete(listener);
		return this;
	}

	emit(event: string, ...args: any[]): this {
		void handleLocalEmit(this, event, args);
		this.dispatch(event, ...args);
		return this;
	}

	removeAllListeners(event?: string): this {
		if (event) this.listeners.delete(event);
		else this.listeners.clear();
		return this;
	}

	disconnect(): void {
		this.connected = false;
		this.dispatch('disconnect', 'io client disconnect');
	}

	connect(): this {
		this.connected = true;
		this.dispatch('connect');
		return this;
	}

	dispatch(event: string, ...args: any[]): void {
		for (const listener of this.listeners.get(event) || []) {
			listener(...args);
		}
	}
}

export function createLocalMockSocket(username: string): LocalMockSocket {
	const mock = new LocalMockSocket(username);
	socket.set(mock as any);
	connected.set(true);
	connectionState.set('connected');
	void seedLocalMockState(mock, username);
	return mock;
}

export function disconnectLocalMockSocket(mock: LocalMockSocket | null): void {
	mock?.disconnect();
	socket.set(null);
	connected.set(false);
	connectionState.set('disconnected');
}

async function seedLocalMockState(mock: LocalMockSocket, username: string): Promise<void> {
	if (!browser) return;
	const [channelStore, messageStore, presenceStore] = await Promise.all([
		import('./channelStore'),
		import('./messageStore'),
		import('./presenceStore')
	]);

	const now = Date.now();
	const me: User = {
		id: mock.id,
		username,
		color: '#98D8C8',
		status: 'active',
		highestRole: 'guest',
		profilePicture: localMockAvatar('H', '#98D8C8')
	};
	const artist: User = {
		id: 'local-mira',
		username: 'Mira',
		color: '#F6A6FF',
		status: 'active',
		bio: 'Local mock collaborator for frontend-only Wabi dev.',
		profilePicture: localMockAvatar('M', '#F6A6FF')
	};
	const sleepy: User = {
		id: 'local-taro',
		username: 'Taro',
		color: '#FFD166',
		status: 'away',
		profilePicture: localMockAvatar('T', '#FFD166')
	};

	const channels: Channel[] = [
		{
			id: 'general',
			name: 'general',
			type: 'text',
			description: 'Frontend-only local mock channel. No backend required.',
			createdAt: now - 86400000,
			minRole: 'guest'
		},
		{
			id: 'voice-lounge',
			name: 'Voice Lounge',
			type: 'voice',
			description: 'Mock voice channel for layout/state work.',
			createdAt: now - 7200000,
			minRole: 'guest'
		},
		{
			id: 'dm-local-mira',
			name: 'Mira',
			type: 'dm',
			createdAt: now - 3600000,
			members: [mock.id, artist.id],
			otherUser: artist,
			memberUsers: [me, artist]
		} as Channel
	];

	channelStore.channels.set(channels);
	channelStore.currentChannel.set('general');
	channelStore._updatePinnedChannels();
	presenceStore._setCurrentUser(me);
	presenceStore._setUsers([me, artist, sleepy]);
	presenceStore._setServerMembers([me, artist, sleepy]);
	presenceStore._setVoiceChannelMembers('voice-lounge', [
		{ userId: artist.id, socketId: 'mock-mira-socket', username: artist.username, isSpeaking: false, isMuted: false, isDeafened: false }
	]);
	presenceStore._setRoleDefinitions([
		{ roleName: 'owner', displayName: 'Owner', priority: 100, color: '#98D8C8' },
		{ roleName: 'admin', displayName: 'Admin', priority: 80, color: '#7dd3fc' },
		{ roleName: 'mod', displayName: 'Moderator', priority: 50, color: '#c4b5fd' },
		{ roleName: 'guest', displayName: 'Guest', priority: 0, color: null }
	]);

	const seeded = loadPersistedMessages() || createSeedMessages(now, username);
	messageStore.channelMessages.set(seeded);
	messageStore.channelUnreadCounts.set({ 'dm-local-mira': 1 });
	messageStore.unreadCount.set(1);

	mock.dispatch('connect');
	mock.dispatch('init', { channels, users: [me, artist, sleepy], serverMembers: [me, artist, sleepy] });
}

function createSeedMessages(now: number, username: string): Record<string, Message[]> {
	return {
		general: [
			{
				id: 'local-welcome-1',
				user: 'Wabi Local',
				userId: 'system',
				senderStableId: 'system',
				color: '#98D8C8',
				text: 'Local mock mode is running. You can work on the frontend without a real backend.',
				timestamp: now - 120000,
				type: 'text'
			},
			{
				id: 'local-welcome-2',
				user: username,
				userId: `local-${username.toLowerCase()}`,
				senderStableId: `local-${username.toLowerCase()}`,
				color: '#98D8C8',
				text: 'Messages you send here stay in browser localStorage for this mock session.',
				timestamp: now - 60000,
				type: 'text'
			}
		],
		'dm-local-mira': [
			{
				id: 'local-dm-1',
				user: 'Mira',
				userId: 'local-mira',
				senderStableId: 'local-mira',
				color: '#F6A6FF',
				text: 'This is a fake DM so DM polish can be inspected offline.',
				timestamp: now - 90000,
				type: 'text'
			}
		]
	};
}

async function handleLocalEmit(mock: LocalMockSocket, event: string, args: any[]): Promise<void> {
	if (!browser) return;
	if (event === 'message') {
		const payload = args[0] || {};
		const channelId = String(payload.channelId || 'general');
		const clientMessageId = payload.clientMessageId || `local:${Date.now()}`;
		const messageId = `local-msg-${Date.now()}`;
		const { channelMessages } = await import('./messageStore');
		channelMessages.update((state) => {
			const messages = state[channelId] || [];
			const next = messages.map((message) =>
				message.clientMessageId === clientMessageId
					? { ...message, id: messageId, deliveryState: undefined, deliveryError: undefined }
					: message
			);
			const updated = { ...state, [channelId]: next };
			persistMessages(updated);
			return updated;
		});
		mock.dispatch('message-accepted', { channelId, clientMessageId, messageId, timestamp: Date.now() });
	}
}

function loadPersistedMessages(): Record<string, Message[]> | null {
	try {
		const raw = localStorage.getItem(LOCAL_MOCK_STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}

function persistMessages(messages: Record<string, Message[]>): void {
	try {
		localStorage.setItem(LOCAL_MOCK_STORAGE_KEY, JSON.stringify(messages));
	} catch {
		// localStorage can be unavailable in restricted browser contexts.
	}
}
