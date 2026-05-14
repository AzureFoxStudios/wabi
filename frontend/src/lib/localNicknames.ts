import { browser } from '$app/environment';
import type { User } from '$lib/socket';
import { get, writable } from 'svelte/store';

export const MAX_LOCAL_NICKNAME_LENGTH = 40;

const LOCAL_NICKNAMES_STORAGE_KEY = 'wabi.localNicknames.v1';

export type LocalNicknamesMap = Record<string, string>;

function sanitizeIdentityKey(value: unknown): string {
	if (typeof value !== 'string') return '';
	return value.trim();
}

function sanitizeNickname(rawValue: unknown): string {
	if (typeof rawValue !== 'string') return '';
	const trimmed = rawValue.trim();
	if (!trimmed) return '';
	if (trimmed.length <= MAX_LOCAL_NICKNAME_LENGTH) return trimmed;
	return trimmed.slice(0, MAX_LOCAL_NICKNAME_LENGTH).trim();
}

function sanitizeNicknamesMap(input: unknown): LocalNicknamesMap {
	if (!input || typeof input !== 'object') return {};
	const source = input as Record<string, unknown>;
	const next: LocalNicknamesMap = {};
	for (const [rawKey, rawValue] of Object.entries(source)) {
		const key = sanitizeIdentityKey(rawKey);
		const nickname = sanitizeNickname(rawValue);
		if (!key || !nickname) continue;
		next[key] = nickname;
	}
	return next;
}

function safeReadLocalNicknames(): LocalNicknamesMap {
	if (!browser) return {};
	try {
		const raw = localStorage.getItem(LOCAL_NICKNAMES_STORAGE_KEY);
		if (!raw) return {};
		return sanitizeNicknamesMap(JSON.parse(raw));
	} catch {
		return {};
	}
}

function safeWriteLocalNicknames(map: LocalNicknamesMap): void {
	if (!browser) return;
	try {
		localStorage.setItem(LOCAL_NICKNAMES_STORAGE_KEY, JSON.stringify(map));
	} catch {
		// best-effort persistence
	}
}

export const localNicknamesStore = writable<LocalNicknamesMap>(safeReadLocalNicknames());

if (browser) {
	localNicknamesStore.subscribe((map) => {
		safeWriteLocalNicknames(sanitizeNicknamesMap(map));
	});
}

export function getUserIdentityKey(
	user: Pick<User, 'id' | 'dbUserId'> | null | undefined
): string {
	if (!user) return '';
	if (typeof user.dbUserId === 'number' && Number.isFinite(user.dbUserId)) {
		return `user-${user.dbUserId}`;
	}
	return sanitizeIdentityKey(user.id);
}

export function getLocalNicknameByIdentityKey(identityKey: string | null | undefined): string {
	const normalizedKey = sanitizeIdentityKey(identityKey);
	if (!normalizedKey) return '';
	return get(localNicknamesStore)[normalizedKey] || '';
}

export function getLocalNicknameForUser(
	user: Pick<User, 'id' | 'dbUserId'> | null | undefined
): string {
	return getLocalNicknameByIdentityKey(getUserIdentityKey(user));
}

export function resolveUserDisplayName(
	user: Pick<User, 'id' | 'dbUserId' | 'username'> | null | undefined,
	fallback = 'Unknown User'
): string {
	const nickname = getLocalNicknameForUser(user);
	if (nickname) return nickname;
	return user?.username?.trim() || fallback;
}

export function setLocalNicknameForUser(
	user: Pick<User, 'id' | 'dbUserId'> | null | undefined,
	rawNickname: string
): string {
	const identityKey = getUserIdentityKey(user);
	if (!identityKey) return '';
	const nickname = sanitizeNickname(rawNickname);
	localNicknamesStore.update((current) => {
		const next = { ...current };
		if (nickname) {
			next[identityKey] = nickname;
		} else {
			delete next[identityKey];
		}
		return sanitizeNicknamesMap(next);
	});
	return nickname;
}

export function clearLocalNicknameForUser(
	user: Pick<User, 'id' | 'dbUserId'> | null | undefined
): void {
	const identityKey = getUserIdentityKey(user);
	if (!identityKey) return;
	localNicknamesStore.update((current) => {
		if (!(identityKey in current)) return current;
		const next = { ...current };
		delete next[identityKey];
		return sanitizeNicknamesMap(next);
	});
}

export function clearAllLocalNicknames(): void {
	localNicknamesStore.set({});
}
