import { get, writable, type Readable } from 'svelte/store';
import { accountTokenSubject } from './apiRequest';
import { authSessionGeneration, getAuthToken, getStoredDbUserId, onAuthSessionCleared } from './authSession';
import { activeServerUrl } from './serverUrl';
import { currentUser, socket } from './socket';
import {
	acceptFriendRequest,
	dismissFriendRequest,
	listFriends,
	removeFriend,
	sendFriendRequest,
	type FriendsSnapshot
} from './api/friends';
import { getApiBase } from './api/utils';

export interface FriendshipState extends FriendsSnapshot {
	loading: boolean;
	ready: boolean;
	error: string | null;
}

const EMPTY_SNAPSHOT: FriendsSnapshot = { friends: [], incoming: [], outgoing: [] };
const EMPTY_STATE: FriendshipState = { ...EMPTY_SNAPSHOT, loading: false, ready: false, error: null };

const stateStore = writable<FriendshipState>(EMPTY_STATE);

// A surface may mount after logout or a server switch, when no live sync was
// watching the previous account. Fence its first render against old data.
export const friendships: Readable<FriendshipState> = {
	subscribe(run, invalidate) {
		alignScope();
		return stateStore.subscribe(run, invalidate);
	}
};

let activeScope = '';
let loadSequence = 0;
let syncUsers = 0;
let stopSync: (() => void) | null = null;

function scopeKey(): string {
	const server = getApiBase();
	const token = getAuthToken(server);
	const accountId = token ? accountTokenSubject(token) ?? getStoredDbUserId(server) ?? '' : '';
	return `${server}|${accountId}|${authSessionGeneration(server)}`;
}

function alignScope(): string {
	const scope = scopeKey();
	if (activeScope !== scope) {
		activeScope = scope;
		loadSequence += 1;
		stateStore.set(EMPTY_STATE);
	}
	return scope;
}

export async function refreshFriendships(): Promise<void> {
	const scope = alignScope();
	const sequence = ++loadSequence;
	if (!getAuthToken(getApiBase())) {
		stateStore.set(EMPTY_STATE);
		return;
	}
	stateStore.update((state) => ({ ...state, loading: true, error: null }));
	try {
		const snapshot = await listFriends();
		if (scope !== scopeKey() || sequence !== loadSequence) return;
		stateStore.set({ ...snapshot, loading: false, ready: true, error: null });
	} catch (error) {
		if (scope !== scopeKey() || sequence !== loadSequence) return;
		stateStore.update((state) => ({
			...state,
			loading: false,
			error: error instanceof Error ? error.message : 'Could not load friends.'
		}));
	}
}

async function mutate(action: () => Promise<void>): Promise<void> {
	alignScope();
	await action();
	await refreshFriendships();
}

export const requestFriendship = (userId: number) => mutate(() => sendFriendRequest(userId));
export const acceptFriendship = (requestId: string) => mutate(() => acceptFriendRequest(requestId));
export const dismissFriendship = (requestId: string) => mutate(() => dismissFriendRequest(requestId));
export const removeFriendship = (userId: number) => mutate(() => removeFriend(userId));

/** Start one shared live subscription while a friends surface or profile is visible. */
export function startFriendshipSync(): () => void {
	syncUsers += 1;
	if (syncUsers === 1) {
		let subscribedSocket: any = null;
		let observedScope = '';
		const onUpdate = () => { void refreshFriendships(); };
		const onScopeChange = () => {
			const scope = scopeKey();
			if (scope === observedScope) return;
			observedScope = scope;
			void refreshFriendships();
		};
		const onFocus = () => { void refreshFriendships(); };
		const onVisibility = () => {
			if (document.visibilityState === 'visible') void refreshFriendships();
		};
		const releaseSocket = () => {
			subscribedSocket?.off?.('friends-updated', onUpdate);
			subscribedSocket?.off?.('connect', onUpdate);
			subscribedSocket = null;
		};
		const unsubscribeSocket = socket.subscribe((nextSocket) => {
			if (nextSocket === subscribedSocket) return;
			releaseSocket();
			subscribedSocket = nextSocket;
			subscribedSocket?.on?.('friends-updated', onUpdate);
			subscribedSocket?.on?.('connect', onUpdate);
		});
		const unsubscribeServer = activeServerUrl.subscribe(onScopeChange);
		const unsubscribeUser = currentUser.subscribe(onScopeChange);
		const unsubscribeSession = onAuthSessionCleared(() => { void refreshFriendships(); });
		if (typeof window !== 'undefined') {
			window.addEventListener('focus', onFocus);
			document.addEventListener('visibilitychange', onVisibility);
		}
		stopSync = () => {
			releaseSocket();
			unsubscribeSocket();
			unsubscribeServer();
			unsubscribeUser();
			unsubscribeSession();
			if (typeof window !== 'undefined') {
				window.removeEventListener('focus', onFocus);
				document.removeEventListener('visibilitychange', onVisibility);
			}
		};
	}
	return () => {
		syncUsers -= 1;
		if (syncUsers === 0) {
			stopSync?.();
			stopSync = null;
		}
	};
}
