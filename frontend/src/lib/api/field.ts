/** Short-lived, Authority-owned field sessions for a deliberate local pilot. */
import { getAuthToken } from '$lib/authSession';
import { fetchWithTimeout, getApiBase, parseApiJson } from './utils';

export interface FieldCheckin {
	id: string;
	status: 'okay' | 'help';
	x: number | null;
	y: number | null;
	source: 'manual' | null;
	observedAt: number;
	receivedAt: number;
	acknowledgedAt: number | null;
	acknowledgedByUserId: number | null;
}

export interface FieldPosition {
	x: number;
	y: number;
	source: 'manual';
	observedAt: number;
	receivedAt: number;
}

export interface FieldParticipant {
	userId: number;
	consented: boolean;
	lastCheckin: FieldCheckin | null;
	lastPosition: FieldPosition | null;
	pendingHelp: FieldCheckin | null;
	lastHelpAcknowledgement: { id: string; acknowledgedAt: number; acknowledgedByUserId: number } | null;
}

export interface FieldSession {
	id: string;
	title: string;
	leaderUserId: number;
	createdAt: number;
	expiresAt: number;
	mapImageUrl: string | null;
	isLeader: boolean;
	participants: FieldParticipant[];
}

export interface FieldInvitation {
	id: string;
	title: string;
	leaderUserId: number;
	expiresAt: number;
}

export interface FieldCheckinReceipt {
	checkinId: string;
	receivedAt: number;
	duplicate: boolean;
}

export class FieldApiError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = 'FieldApiError';
	}
}

/** A server that has not explicitly opted in does not expose the field UI. */
export async function getFieldCapability(signal?: AbortSignal): Promise<boolean> {
	const base = getApiBase();
	const token = getAuthToken(base);
	if (!token) return false;
	const response = await fetchWithTimeout(`${base}/api/field/capability`, {
		method: 'GET',
		signal,
		cache: 'no-store',
		headers: { Authorization: `Bearer ${token}` }
	});
	if (response.status === 404) return false;
	if (!response.ok) throw new FieldApiError(`Field capability check failed (${response.status}).`, response.status);
	const data = await parseApiJson(response);
	return Boolean(data && typeof data === 'object' && 'enabled' in data && data.enabled === true);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const base = getApiBase();
	const token = getAuthToken(base);
	if (!token) throw new FieldApiError('Sign in to use a field session.', 401);
	const response = await fetchWithTimeout(`${base}/api/field/sessions${path}`, {
		...init,
		cache: 'no-store',
		headers: {
			...init.headers,
			Authorization: `Bearer ${token}`,
			...(init.body ? { 'Content-Type': 'application/json' } : {})
		}
	});
	const data = await parseApiJson(response);
	if (!response.ok) {
		const detail = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
			? data.error
			: `Field session request failed (${response.status}).`;
		throw new FieldApiError(detail, response.status);
	}
	if (data === null) throw new FieldApiError('Field sessions are unavailable on this Wabi server.', response.status);
	return data as T;
}

const sessionPath = (id: string) => `/${encodeURIComponent(id)}`;

export function listFieldSessions(signal?: AbortSignal): Promise<{ sessions: FieldSession[]; invitations: FieldInvitation[] }> {
	return request('', { method: 'GET', signal });
}

export function getFieldSession(id: string, signal?: AbortSignal): Promise<{ session: FieldSession }> {
	return request(sessionPath(id), { method: 'GET', signal });
}

export function createFieldSession(input: { title: string; participantIds: number[]; durationMinutes: number }, signal?: AbortSignal): Promise<{ session: FieldSession }> {
	return request('', { method: 'POST', body: JSON.stringify(input), signal });
}

export function consentToFieldSession(id: string, signal?: AbortSignal): Promise<{ session: FieldSession }> {
	return request(`${sessionPath(id)}/consent`, { method: 'POST', body: '{}', signal });
}

export function sendFieldCheckin(
	id: string,
	input: { nonce: string; status: 'okay' | 'help'; x?: number; y?: number },
	signal?: AbortSignal
): Promise<{ session: FieldSession; receipt: FieldCheckinReceipt }> {
	return request(`${sessionPath(id)}/checkins`, { method: 'POST', body: JSON.stringify(input), signal });
}

export function acknowledgeFieldCheckin(id: string, checkinId: string, signal?: AbortSignal): Promise<{ session: FieldSession }> {
	return request(`${sessionPath(id)}/checkins/${encodeURIComponent(checkinId)}/ack`, { method: 'POST', body: '{}', signal });
}

export function leaveFieldSession(id: string, signal?: AbortSignal): Promise<{ ok: true }> {
	return request(`${sessionPath(id)}/leave`, { method: 'POST', body: '{}', signal });
}

export function endFieldSession(id: string, signal?: AbortSignal): Promise<{ ok: true }> {
	return request(`${sessionPath(id)}/end`, { method: 'POST', body: '{}', signal });
}

export function revokeFieldParticipant(id: string, userId: number, signal?: AbortSignal): Promise<{ session: FieldSession }> {
	return request(`${sessionPath(id)}/participants/${encodeURIComponent(String(userId))}/revoke`, { method: 'POST', body: '{}', signal });
}
