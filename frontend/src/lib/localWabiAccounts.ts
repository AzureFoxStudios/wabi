import { browser } from '$app/environment';
import type { User } from '$lib/socket';
import { derived, get, writable } from 'svelte/store';
import { normalizeServerUrl, resolveServerUrl } from './serverUrl';

const LOCAL_WABI_ACCOUNTS_STORAGE_KEY = 'wabi.localWabiAccounts.v1';

export interface LocalWabiAccountRecord {
	key: string;
	serverUrl: string;
	serverLabelSnapshot: string | null;
	dbUserId: number;
	usernameSnapshot: string | null;
	handleSnapshot: string | null;
	profilePictureSnapshot: string | null;
	bioSnapshot: string | null;
	colorSnapshot: string | null;
	discoveredAt: number;
	updatedAt: number;
}

interface LocalWabiAccountsState {
	accounts: Record<string, LocalWabiAccountRecord>;
	defaultAccountKey: string | null;
	importPromptHandledTargetKeys: string[];
}

type LocalWabiIdentityLike = Pick<User, 'dbUserId'> | null | undefined;
type LocalWabiSnapshotLike =
	| Pick<User, 'dbUserId' | 'username' | 'handle' | 'profilePicture' | 'bio' | 'color'>
	| null
	| undefined;

const DEFAULT_STATE: LocalWabiAccountsState = {
	accounts: {},
	defaultAccountKey: null,
	importPromptHandledTargetKeys: []
};

function sanitizeString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function sanitizeOptionalString(value: unknown): string | null {
	const normalized = sanitizeString(value);
	return normalized ? normalized : null;
}

function sanitizeDbUserId(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function resolveScopedServerUrl(serverUrl?: string | null): string {
	const normalized = normalizeServerUrl(serverUrl || '');
	if (normalized) return normalized;
	const resolved = normalizeServerUrl(resolveServerUrl().url);
	return resolved || resolveServerUrl().url;
}

export function getLocalWabiAccountKey(
	user: LocalWabiIdentityLike,
	serverUrl?: string | null
): string {
	const dbUserId = sanitizeDbUserId(user?.dbUserId);
	if (!dbUserId) return '';
	const scopedServerUrl = resolveScopedServerUrl(serverUrl);
	return `${encodeURIComponent(scopedServerUrl)}::${dbUserId}`;
}

function sanitizeLocalWabiAccountRecord(value: unknown): LocalWabiAccountRecord | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const dbUserId = sanitizeDbUserId(input.dbUserId);
	const serverUrl = resolveScopedServerUrl(sanitizeString(input.serverUrl));
	if (!dbUserId || !serverUrl) return null;
	const key = getLocalWabiAccountKey({ dbUserId }, serverUrl);
	const now = Date.now();
	return {
		key,
		serverUrl,
		serverLabelSnapshot: sanitizeOptionalString(input.serverLabelSnapshot),
		dbUserId,
		usernameSnapshot: sanitizeOptionalString(input.usernameSnapshot),
		handleSnapshot: sanitizeOptionalString(input.handleSnapshot),
		profilePictureSnapshot: sanitizeOptionalString(input.profilePictureSnapshot),
		bioSnapshot: sanitizeOptionalString(input.bioSnapshot),
		colorSnapshot: sanitizeOptionalString(input.colorSnapshot),
		discoveredAt:
			typeof input.discoveredAt === 'number' && Number.isFinite(input.discoveredAt)
				? input.discoveredAt
				: now,
		updatedAt:
			typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt)
				? input.updatedAt
				: now
	};
}

function sanitizeState(input: unknown): LocalWabiAccountsState {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...DEFAULT_STATE };
	const source = input as Record<string, unknown>;
	const rawAccounts =
		source.accounts && typeof source.accounts === 'object' && !Array.isArray(source.accounts)
			? (source.accounts as Record<string, unknown>)
			: {};

	const accounts: Record<string, LocalWabiAccountRecord> = {};
	for (const rawValue of Object.values(rawAccounts)) {
		const record = sanitizeLocalWabiAccountRecord(rawValue);
		if (!record) continue;
		accounts[record.key] = record;
	}

	const defaultAccountKey = sanitizeString(source.defaultAccountKey);
	const importPromptHandledTargetKeys = Array.isArray(source.importPromptHandledTargetKeys)
		? source.importPromptHandledTargetKeys
				.map((value) => sanitizeString(value))
				.filter(Boolean)
				.filter((value, index, array) => array.indexOf(value) === index)
		: [];

	return {
		accounts,
		defaultAccountKey: defaultAccountKey && accounts[defaultAccountKey] ? defaultAccountKey : null,
		importPromptHandledTargetKeys
	};
}

function safeReadState(): LocalWabiAccountsState {
	if (!browser) return { ...DEFAULT_STATE };
	try {
		const raw = localStorage.getItem(LOCAL_WABI_ACCOUNTS_STORAGE_KEY);
		if (!raw) return { ...DEFAULT_STATE };
		return sanitizeState(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_STATE };
	}
}

function safeWriteState(state: LocalWabiAccountsState): void {
	if (!browser) return;
	try {
		localStorage.setItem(LOCAL_WABI_ACCOUNTS_STORAGE_KEY, JSON.stringify(state));
	} catch {
		// best-effort persistence
	}
}

function buildRecord(
	user: LocalWabiSnapshotLike,
	serverUrl: string,
	serverLabel?: string | null,
	existing?: LocalWabiAccountRecord | null
): LocalWabiAccountRecord | null {
	const dbUserId = sanitizeDbUserId(user?.dbUserId);
	if (!dbUserId) return null;
	const key = getLocalWabiAccountKey({ dbUserId }, serverUrl);
	if (!key) return null;
	const now = Date.now();
	return {
		key,
		serverUrl: resolveScopedServerUrl(serverUrl),
		serverLabelSnapshot:
			sanitizeOptionalString(serverLabel) || existing?.serverLabelSnapshot || null,
		dbUserId,
		usernameSnapshot: sanitizeOptionalString(user?.username) || existing?.usernameSnapshot || null,
		handleSnapshot: sanitizeOptionalString(user?.handle) || existing?.handleSnapshot || null,
		profilePictureSnapshot:
			sanitizeOptionalString(user?.profilePicture) || existing?.profilePictureSnapshot || null,
		bioSnapshot: sanitizeOptionalString(user?.bio) || existing?.bioSnapshot || null,
		colorSnapshot: sanitizeOptionalString(user?.color) || existing?.colorSnapshot || null,
		discoveredAt: existing?.discoveredAt || now,
		updatedAt: now
	};
}

function hasRecordChanged(
	existing: LocalWabiAccountRecord | null | undefined,
	next: LocalWabiAccountRecord
): boolean {
	if (!existing) return true;
	return (
		existing.serverUrl !== next.serverUrl ||
		existing.serverLabelSnapshot !== next.serverLabelSnapshot ||
		existing.dbUserId !== next.dbUserId ||
		existing.usernameSnapshot !== next.usernameSnapshot ||
		existing.handleSnapshot !== next.handleSnapshot ||
		existing.profilePictureSnapshot !== next.profilePictureSnapshot ||
		existing.bioSnapshot !== next.bioSnapshot ||
		existing.colorSnapshot !== next.colorSnapshot
	);
}

export const localWabiAccountsStore = writable<LocalWabiAccountsState>(safeReadState());

if (browser) {
	localWabiAccountsStore.subscribe((state) => {
		safeWriteState(sanitizeState(state));
	});
}

export const localWabiAccountListStore = derived(localWabiAccountsStore, ($state) =>
	Object.values($state.accounts).sort((a, b) => b.updatedAt - a.updatedAt)
);

export const defaultLocalWabiAccountStore = derived(localWabiAccountsStore, ($state) =>
	$state.defaultAccountKey ? $state.accounts[$state.defaultAccountKey] || null : null
);

export function rememberLocalWabiAccount(
	user: LocalWabiSnapshotLike,
	serverUrl?: string | null,
	serverLabel?: string | null
): string {
	const scopedServerUrl = resolveScopedServerUrl(serverUrl);
	const key = getLocalWabiAccountKey(user, scopedServerUrl);
	if (!key) return '';
	localWabiAccountsStore.update((current) => {
		const existing = current.accounts[key] || null;
		const nextRecord = buildRecord(user, scopedServerUrl, serverLabel, existing);
		if (!nextRecord) return current;
		if (!hasRecordChanged(existing, nextRecord) && current.defaultAccountKey) {
			return current;
		}
		return sanitizeState({
			accounts: {
				...current.accounts,
				[key]: nextRecord
			},
			defaultAccountKey:
				current.defaultAccountKey && current.accounts[current.defaultAccountKey]
					? current.defaultAccountKey
					: key,
			importPromptHandledTargetKeys: current.importPromptHandledTargetKeys
		});
	});
	return key;
}

export function setDefaultLocalWabiAccount(accountKey: string | null | undefined): void {
	const normalizedKey = sanitizeString(accountKey);
	localWabiAccountsStore.update((current) => ({
		...current,
		defaultAccountKey: normalizedKey && current.accounts[normalizedKey] ? normalizedKey : current.defaultAccountKey
	}));
}

export function isDefaultLocalWabiAccount(accountKey: string | null | undefined): boolean {
	const normalizedKey = sanitizeString(accountKey);
	if (!normalizedKey) return false;
	return get(localWabiAccountsStore).defaultAccountKey === normalizedKey;
}

export function hasHandledLocalWabiImportPrompt(targetKey: string | null | undefined): boolean {
	const normalizedKey = sanitizeString(targetKey);
	if (!normalizedKey) return false;
	return get(localWabiAccountsStore).importPromptHandledTargetKeys.includes(normalizedKey);
}

export function markLocalWabiImportPromptHandled(targetKey: string | null | undefined): void {
	const normalizedKey = sanitizeString(targetKey);
	if (!normalizedKey) return;
	localWabiAccountsStore.update((current) => {
		if (current.importPromptHandledTargetKeys.includes(normalizedKey)) return current;
		return {
			...current,
			importPromptHandledTargetKeys: [...current.importPromptHandledTargetKeys, normalizedKey]
		};
	});
}

export function getLocalWabiAccountByKey(
	accountKey: string | null | undefined
): LocalWabiAccountRecord | null {
	const normalizedKey = sanitizeString(accountKey);
	if (!normalizedKey) return null;
	return get(localWabiAccountsStore).accounts[normalizedKey] || null;
}

export function getLocalWabiImportSourceAccounts(
	targetAccountKey: string | null | undefined
): LocalWabiAccountRecord[] {
	const normalizedTargetKey = sanitizeString(targetAccountKey);
	const state = get(localWabiAccountsStore);
	const accounts = Object.values(state.accounts).filter((account) => account.key !== normalizedTargetKey);
	return accounts.sort((a, b) => {
		const aIsDefault = state.defaultAccountKey === a.key ? 1 : 0;
		const bIsDefault = state.defaultAccountKey === b.key ? 1 : 0;
		if (aIsDefault !== bIsDefault) return bIsDefault - aIsDefault;
		return b.updatedAt - a.updatedAt;
	});
}

export function getSuggestedLocalWabiImportSourceAccount(
	targetAccountKey: string | null | undefined
): LocalWabiAccountRecord | null {
	return getLocalWabiImportSourceAccounts(targetAccountKey)[0] || null;
}

export function getLocalWabiAccountDisplayLabel(account: LocalWabiAccountRecord | null | undefined): string {
	if (!account) return 'Unknown account';
	const username = account.usernameSnapshot || `user-${account.dbUserId}`;
	const serverName = account.serverLabelSnapshot || account.serverUrl;
	return `${username} on ${serverName}`;
}
