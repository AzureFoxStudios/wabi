import { browser } from '$app/environment';
import type { User } from '$lib/socket';
import { derived, get, writable } from 'svelte/store';
import { normalizeServerUrl, resolveServerUrl } from './serverUrl';

const PEOPLE_TRACKER_STORAGE_KEY = 'wabi.peopleTracker.v1';
const LEGACY_DISPLAY_ENHANCEMENT_SETTINGS_KEY = 'wabi.displayEnhancements.settings';
const LEGACY_FRIEND_ALERTS_MIGRATION_KEY = 'wabi.peopleTracker.legacyFriendAlertsMigrated.v1';

export interface TrackedPersonRecord {
	key: string;
	serverUrl: string;
	stableUserId: string;
	dbUserId: number;
	usernameSnapshot: string | null;
	handleSnapshot: string | null;
	profilePictureSnapshot: string | null;
	colorSnapshot: string | null;
	lastStatus: User['status'] | 'offline';
	discoveredAt: number;
	updatedAt: number;
	trackedForStatusAlerts: boolean;
}

export type PeopleTrackerState = Record<string, TrackedPersonRecord>;

type UserIdentityLike = Pick<User, 'id' | 'dbUserId'> | null | undefined;
type PersonSnapshotLike =
	| Pick<User, 'id' | 'dbUserId' | 'username' | 'handle' | 'profilePicture' | 'color' | 'status'>
	| null
	| undefined;

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

function sanitizeStatus(value: unknown): User['status'] | 'offline' {
	if (value === 'active' || value === 'away' || value === 'busy' || value === 'offline') {
		return value;
	}
	return 'offline';
}

function resolveTrackerServerUrl(serverUrl?: string | null): string {
	const normalized = normalizeServerUrl(serverUrl || '');
	if (normalized) return normalized;
	const resolved = normalizeServerUrl(resolveServerUrl().url);
	return resolved || resolveServerUrl().url;
}

function getStableUserId(user: UserIdentityLike): string {
	if (typeof user?.dbUserId === 'number' && Number.isFinite(user.dbUserId) && user.dbUserId > 0) {
		return `user-${user.dbUserId}`;
	}
	return sanitizeString(user?.id);
}

function buildScopedUserKey(serverUrl: string, stableUserId: string): string {
	const normalizedServerUrl = resolveTrackerServerUrl(serverUrl);
	const normalizedStableUserId = sanitizeString(stableUserId);
	if (!normalizedServerUrl || !normalizedStableUserId) return '';
	return `${encodeURIComponent(normalizedServerUrl)}::${encodeURIComponent(normalizedStableUserId)}`;
}

function buildPersonRecord(
	user: PersonSnapshotLike,
	serverUrl: string,
	existing?: TrackedPersonRecord | null,
	trackedForStatusAlerts = existing?.trackedForStatusAlerts === true
): TrackedPersonRecord | null {
	const dbUserId = sanitizeDbUserId(user?.dbUserId);
	if (!dbUserId) return null;
	const stableUserId = `user-${dbUserId}`;
	const key = buildScopedUserKey(serverUrl, stableUserId);
	if (!key) return null;
	const now = Date.now();
	return {
		key,
		serverUrl: resolveTrackerServerUrl(serverUrl),
		stableUserId,
		dbUserId,
		usernameSnapshot: sanitizeOptionalString(user?.username) || existing?.usernameSnapshot || null,
		handleSnapshot: sanitizeOptionalString(user?.handle) || existing?.handleSnapshot || null,
		profilePictureSnapshot:
			sanitizeOptionalString(user?.profilePicture) || existing?.profilePictureSnapshot || null,
		colorSnapshot: sanitizeOptionalString(user?.color) || existing?.colorSnapshot || null,
		lastStatus: sanitizeStatus(user?.status) || existing?.lastStatus || 'offline',
		discoveredAt: existing?.discoveredAt || now,
		updatedAt: now,
		trackedForStatusAlerts
	};
}

function sanitizeTrackedPersonRecord(value: unknown): TrackedPersonRecord | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const serverUrl = resolveTrackerServerUrl(sanitizeString(input.serverUrl));
	const stableUserId = sanitizeString(input.stableUserId);
	const key = buildScopedUserKey(serverUrl, stableUserId);
	const dbUserId = sanitizeDbUserId(input.dbUserId);
	if (!key || !dbUserId) return null;
	const now = Date.now();
	return {
		key,
		serverUrl,
		stableUserId,
		dbUserId,
		usernameSnapshot: sanitizeOptionalString(input.usernameSnapshot),
		handleSnapshot: sanitizeOptionalString(input.handleSnapshot),
		profilePictureSnapshot: sanitizeOptionalString(input.profilePictureSnapshot),
		colorSnapshot: sanitizeOptionalString(input.colorSnapshot),
		lastStatus: sanitizeStatus(input.lastStatus),
		discoveredAt:
			typeof input.discoveredAt === 'number' && Number.isFinite(input.discoveredAt)
				? input.discoveredAt
				: now,
		updatedAt:
			typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt)
				? input.updatedAt
				: now,
		trackedForStatusAlerts: input.trackedForStatusAlerts === true
	};
}

function sanitizePeopleTrackerState(input: unknown): PeopleTrackerState {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
	const source = input as Record<string, unknown>;
	const next: PeopleTrackerState = {};
	for (const rawValue of Object.values(source)) {
		const record = sanitizeTrackedPersonRecord(rawValue);
		if (!record) continue;
		next[record.key] = record;
	}
	return next;
}

function safeReadPeopleTrackerState(): PeopleTrackerState {
	if (!browser) return {};
	try {
		const raw = localStorage.getItem(PEOPLE_TRACKER_STORAGE_KEY);
		if (!raw) return {};
		return sanitizePeopleTrackerState(JSON.parse(raw));
	} catch {
		return {};
	}
}

function safeWritePeopleTrackerState(state: PeopleTrackerState): void {
	if (!browser) return;
	try {
		localStorage.setItem(PEOPLE_TRACKER_STORAGE_KEY, JSON.stringify(state));
	} catch {
		// best-effort persistence
	}
}

function migrateLegacyFriendAlertTracking(state: PeopleTrackerState): PeopleTrackerState {
	if (!browser) return state;
	try {
		if (localStorage.getItem(LEGACY_FRIEND_ALERTS_MIGRATION_KEY) === 'true') {
			return state;
		}

		const raw = localStorage.getItem(LEGACY_DISPLAY_ENHANCEMENT_SETTINGS_KEY);
		if (!raw) {
			localStorage.setItem(LEGACY_FRIEND_ALERTS_MIGRATION_KEY, 'true');
			return state;
		}

		const parsed = JSON.parse(raw) as {
			friendNotificationTrackedUserIds?: unknown;
		};
		const legacyTrackedIds = Array.isArray(parsed.friendNotificationTrackedUserIds)
			? parsed.friendNotificationTrackedUserIds
					.map((value) => sanitizeString(value))
					.filter((value) => /^user-\d+$/.test(value))
			: [];

		if (legacyTrackedIds.length === 0) {
			localStorage.setItem(LEGACY_FRIEND_ALERTS_MIGRATION_KEY, 'true');
			return state;
		}

		const serverUrl = resolveTrackerServerUrl();
		let next = state;
		for (const stableUserId of legacyTrackedIds) {
			const dbUserId = Number.parseInt(stableUserId.slice(5), 10);
			if (!Number.isFinite(dbUserId) || dbUserId <= 0) continue;
			const key = buildScopedUserKey(serverUrl, stableUserId);
			if (!key) continue;
			const existing = next[key] || null;
			const migratedRecord = buildPersonRecord(
				{
					id: stableUserId,
					dbUserId,
					username: '',
					handle: '',
					profilePicture: '',
					color: '',
					status: 'offline'
				},
				serverUrl,
				existing,
				true
			);
			if (!migratedRecord) continue;
			if (existing && existing.trackedForStatusAlerts) continue;
			next = {
				...next,
				[key]: migratedRecord
			};
		}

		localStorage.setItem(
			LEGACY_DISPLAY_ENHANCEMENT_SETTINGS_KEY,
			JSON.stringify({
				...parsed,
				friendNotificationTrackedUserIds: []
			})
		);
		localStorage.setItem(LEGACY_FRIEND_ALERTS_MIGRATION_KEY, 'true');
		return sanitizePeopleTrackerState(next);
	} catch {
		return state;
	}
}

function hasRecordSnapshotChanged(
	existing: TrackedPersonRecord,
	next: TrackedPersonRecord
): boolean {
	return (
		existing.serverUrl !== next.serverUrl ||
		existing.stableUserId !== next.stableUserId ||
		existing.dbUserId !== next.dbUserId ||
		existing.usernameSnapshot !== next.usernameSnapshot ||
		existing.handleSnapshot !== next.handleSnapshot ||
		existing.profilePictureSnapshot !== next.profilePictureSnapshot ||
		existing.colorSnapshot !== next.colorSnapshot ||
		existing.lastStatus !== next.lastStatus ||
		existing.trackedForStatusAlerts !== next.trackedForStatusAlerts
	);
}

const initialPeopleTrackerState = browser
	? migrateLegacyFriendAlertTracking(safeReadPeopleTrackerState())
	: {};

export const peopleTrackerStore = writable<PeopleTrackerState>(initialPeopleTrackerState);

if (browser) {
	peopleTrackerStore.subscribe((state) => {
		safeWritePeopleTrackerState(sanitizePeopleTrackerState(state));
	});
}

export const trackedStatusAlertPersonCountStore = derived(peopleTrackerStore, ($peopleTrackerStore) =>
	Object.values($peopleTrackerStore).filter((record) => record.trackedForStatusAlerts).length
);

export function getServerScopedUserKey(
	user: UserIdentityLike,
	serverUrl?: string | null
): string {
	const stableUserId = getStableUserId(user);
	if (!stableUserId) return '';
	return buildScopedUserKey(resolveTrackerServerUrl(serverUrl), stableUserId);
}

export function getTrackedPersonKeyForUser(
	user: UserIdentityLike,
	serverUrl?: string | null
): string {
	if (!sanitizeDbUserId(user?.dbUserId)) return '';
	return getServerScopedUserKey(user, serverUrl);
}

export function rememberPerson(user: PersonSnapshotLike, serverUrl?: string | null): string {
	const resolvedServerUrl = resolveTrackerServerUrl(serverUrl);
	const key = getTrackedPersonKeyForUser(user, resolvedServerUrl);
	if (!key) return '';
	peopleTrackerStore.update((current) => {
		const existing = current[key] || null;
		const nextRecord = buildPersonRecord(user, resolvedServerUrl, existing);
		if (!nextRecord) return current;
		if (existing && !hasRecordSnapshotChanged(existing, nextRecord)) {
			return current;
		}
		return {
			...current,
			[key]: nextRecord
		};
	});
	return key;
}

export function rememberPeople(
	users: Array<PersonSnapshotLike> | null | undefined,
	serverUrl?: string | null
): void {
	if (!Array.isArray(users) || users.length === 0) return;
	const resolvedServerUrl = resolveTrackerServerUrl(serverUrl);
	peopleTrackerStore.update((current) => {
		let next = current;
		for (const user of users) {
			const key = getTrackedPersonKeyForUser(user, resolvedServerUrl);
			if (!key) continue;
			const existing = next[key] || null;
			const nextRecord = buildPersonRecord(user, resolvedServerUrl, existing);
			if (!nextRecord) continue;
			if (existing && !hasRecordSnapshotChanged(existing, nextRecord)) continue;
			next = {
				...next,
				[key]: nextRecord
			};
		}
		return next;
	});
}

export function isTrackedPersonStatusAlertsEnabled(
	user: UserIdentityLike,
	serverUrl?: string | null
): boolean {
	const key = getTrackedPersonKeyForUser(user, serverUrl);
	if (!key) return false;
	return get(peopleTrackerStore)[key]?.trackedForStatusAlerts === true;
}

export function isTrackedPersonStatusAlertsKeyEnabled(key: string | null | undefined): boolean {
	const normalizedKey = sanitizeString(key);
	if (!normalizedKey) return false;
	return get(peopleTrackerStore)[normalizedKey]?.trackedForStatusAlerts === true;
}

export function setTrackedPersonStatusAlertsEnabled(
	user: PersonSnapshotLike,
	enabled: boolean,
	serverUrl?: string | null
): boolean {
	const resolvedServerUrl = resolveTrackerServerUrl(serverUrl);
	const key = getTrackedPersonKeyForUser(user, resolvedServerUrl);
	if (!key) return false;
	peopleTrackerStore.update((current) => {
		const existing = current[key] || null;
		const nextRecord = buildPersonRecord(
			user,
			resolvedServerUrl,
			existing,
			enabled
		);
		if (!nextRecord) return current;
		if (existing && !hasRecordSnapshotChanged(existing, nextRecord)) {
			return current;
		}
		return {
			...current,
			[key]: nextRecord
		};
	});
	return enabled;
}

export function toggleTrackedPersonStatusAlerts(
	user: PersonSnapshotLike,
	serverUrl?: string | null
): boolean {
	const nextEnabled = !isTrackedPersonStatusAlertsEnabled(user, serverUrl);
	return setTrackedPersonStatusAlertsEnabled(user, nextEnabled, serverUrl);
}

export function clearAllTrackedPersonStatusAlerts(): void {
	peopleTrackerStore.update((current) => {
		let next = current;
		for (const [key, record] of Object.entries(current)) {
			if (!record.trackedForStatusAlerts) continue;
			next = {
				...next,
				[key]: {
					...record,
					trackedForStatusAlerts: false,
					updatedAt: Date.now()
				}
			};
		}
		return next;
	});
}
