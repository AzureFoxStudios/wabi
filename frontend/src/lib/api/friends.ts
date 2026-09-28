import { getAuthToken } from '$lib/authSession';
import { fetchWithTimeout, getApiBase, parseApiJson } from './utils';

export interface FriendPerson {
	user_id: number;
	username: string;
	handle: string | null;
	profile_picture: string | null;
	color: string;
	status: string | null;
}

export interface FriendRequest extends FriendPerson {
	id: string;
	created_at: number;
}

export interface FriendsSnapshot {
	friends: FriendPerson[];
	incoming: FriendRequest[];
	outgoing: FriendRequest[];
}

async function friendRequest<T>(path: string, method = 'GET', body?: object): Promise<T> {
	const base = getApiBase();
	const token = getAuthToken(base);
	if (!token) throw new Error('Sign in to manage friends.');
	const response = await fetchWithTimeout(`${base}/api/friends${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...(body ? { 'Content-Type': 'application/json' } : {})
		},
		...(body ? { body: JSON.stringify(body) } : {})
	});
	const data = await parseApiJson(response);
	if (!response.ok) {
		const error = data && typeof data === 'object' && 'error' in data ? String(data.error) : `Friend request failed (${response.status}).`;
		throw new Error(error);
	}
	if (!data || typeof data !== 'object') throw new Error('Friend service returned an invalid response.');
	return data as T;
}

export async function listFriends(): Promise<FriendsSnapshot> {
	const response = await friendRequest<FriendsSnapshot>('');
	if (!Array.isArray(response.friends) || !Array.isArray(response.incoming) || !Array.isArray(response.outgoing)) {
		throw new Error('Friend service returned an invalid list.');
	}
	return response;
}

export async function sendFriendRequest(userId: number): Promise<void> {
	await friendRequest('/requests', 'POST', { user_id: userId });
}

export async function acceptFriendRequest(requestId: string): Promise<void> {
	await friendRequest(`/requests/${encodeURIComponent(requestId)}/accept`, 'POST');
}

export async function dismissFriendRequest(requestId: string): Promise<void> {
	await friendRequest(`/requests/${encodeURIComponent(requestId)}`, 'DELETE');
}

export async function removeFriend(userId: number): Promise<void> {
	await friendRequest(`/${encodeURIComponent(String(userId))}`, 'DELETE');
}
