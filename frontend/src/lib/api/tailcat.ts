/**
 * Tailcat private-access addon API client.
 * Contract: docs/plans/2026-09-01-tailcat-private-access.md
 * The pipe is transport-only; Wabi auth always gates membership.
 */

import { getApiBase, fetchWithTimeout, safeJsonParse } from './utils';

export interface TailcatMemberKey {
	id: string;
	userId: number;
	publicKey: string;
	label: string | null;
	createdAt: string;
}

export interface TailcatStatus {
	enabled: boolean;
	running: boolean;
	address: string | null;
	pipePort: number;
	serverPort: number;
	binaryPath: string;
	binaryVersion: string | null;
	keys: TailcatMemberKey[];
	lastError: string | null;
	startedAt: string | null;
}

export interface TailcatAuditEntry {
	ts: string;
	actor: number;
	action: string;
	details: string | null;
}

export interface TailcatConnectInfo {
	enabled: boolean;
	registered: boolean;
	address: string | null;
	/** Port clients dial through the pipe (forwarder port, not the public port). */
	pipePort: number;
}

async function request<T>(
	token: string | null | undefined,
	path: string,
	init?: RequestInit
): Promise<T> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/addons/tailcat${path}`, {
		...init,
		headers: {
			...(init?.headers ?? {}),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(init?.body ? { 'Content-Type': 'application/json' } : {})
		}
	});
	if (!res.ok) {
		const error = (await safeJsonParse(res)) as Record<string, any>;
		throw new Error(error.error || `Tailcat API ${path} failed (${res.status})`);
	}
	return (await res.json()) as T;
}

export function getTailcatStatus(token: string | null | undefined): Promise<TailcatStatus> {
	return request<TailcatStatus>(token, '/status');
}

export function getTailcatAudit(
	token: string | null | undefined,
	limit = 50
): Promise<{ entries: TailcatAuditEntry[] }> {
	return request<{ entries: TailcatAuditEntry[] }>(token, `/audit?limit=${limit}`);
}

/** Enable requires explicit confirmation (cognitive-friction contract). */
export function enableTailcat(token: string | null | undefined): Promise<TailcatStatus> {
	return request<TailcatStatus>(token, '/enable', {
		method: 'POST',
		body: JSON.stringify({ confirm: true })
	});
}

/** Disable is the instant kill-switch — no ceremony. */
export function disableTailcat(token: string | null | undefined): Promise<TailcatStatus> {
	return request<TailcatStatus>(token, '/disable', { method: 'POST' });
}

export function listTailcatKeys(
	token: string | null | undefined
): Promise<{ keys: TailcatMemberKey[] }> {
	return request<{ keys: TailcatMemberKey[] }>(token, '/keys');
}

/** A member registers their own client key (self-service). */
export function registerTailcatKey(
	token: string | null | undefined,
	publicKey: string,
	label?: string
): Promise<TailcatMemberKey> {
	return request<TailcatMemberKey>(token, '/keys', {
		method: 'POST',
		body: JSON.stringify({ publicKey, label })
	});
}

export function revokeTailcatKey(
	token: string | null | undefined,
	keyId: string
): Promise<{ revoked: string }> {
	return request<{ revoked: string }>(token, `/keys/${encodeURIComponent(keyId)}`, {
		method: 'DELETE'
	});
}

export function getTailcatConnectInfo(
	token: string | null | undefined
): Promise<TailcatConnectInfo> {
	return request<TailcatConnectInfo>(token, '/connect');
}
