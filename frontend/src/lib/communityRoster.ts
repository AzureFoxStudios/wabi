/** Signed entry points for one authenticated community. This is not a leader election. */
import { normalizeServerUrl } from './serverUrl';
import { authSessionGeneration, getAuthToken, getStoredDbUserId, getStoredUsername } from './authSession';
import { loadState } from './savedServerStore';

const PIN_KEY = 'wabi.communityRosterPins.v1';

export interface CommunityEntry {
	nodeId: string;
	role: 'authority' | 'anchor';
	url: string;
}

export interface CommunityRosterBody {
	schemaVersion: number;
	communityId: string;
	version: number;
	issuedAt: number;
	expiresAt: number;
	entries: CommunityEntry[];
}

export interface SignedCommunityRoster {
	body: CommunityRosterBody;
	publicKey: string;
	signature: string;
}

interface Pin {
	/** The address this roster was fetched from. Only that address's own answer is pinned. */
	source?: string;
	/** Set when a session was carried here from another address of the same community. */
	carriedFrom?: string;
	/** SHA-256 of the token that was carried; the pin is valid only while that session is here. */
	carriedTokenHash?: string;
	publicKey: string;
	version: number;
	roster: SignedCommunityRoster;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	try {
		const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
		const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(decoded.length);
		for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
		return bytes;
	} catch {
		return null;
	}
}

export function validCommunityEntryUrl(value: string): boolean {
	if (normalizeServerUrl(value) !== value) return false;
	try {
		const url = new URL(value);
		if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return false;
		if (url.protocol === 'https:') return true;
		if (url.protocol !== 'http:') return false;
		const host = url.hostname.toLowerCase();
		if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
		if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
			const octets = host.split('.').map(Number);
			return octets[0] === 10 || octets[0] === 192 && octets[1] === 168 ||
				octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 ||
				octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
		}
		return host.startsWith('[fd') || host.startsWith('[fc');
	} catch {
		return false;
	}
}

export async function verifyCommunityRoster(value: unknown): Promise<SignedCommunityRoster | null> {
	if (!value || typeof value !== 'object') return null;
	const roster = value as SignedCommunityRoster;
	const body = roster.body;
	if (!body || body.schemaVersion !== 1 || typeof body.communityId !== 'string' ||
		!/^[a-f0-9]{64}$/.test(body.communityId) ||
		![body.version, body.issuedAt, body.expiresAt].every(Number.isSafeInteger) ||
		body.version < 1 || body.issuedAt > Date.now() / 1000 + 300 ||
		body.expiresAt <= Date.now() / 1000 || body.expiresAt - body.issuedAt > 7 * 24 * 60 * 60 ||
		!Array.isArray(body.entries) || body.entries.length < 1 || body.entries.length > 64) return null;
	const ids = new Set<string>();
	const urls = new Set<string>();
	let authorities = 0;
	for (const entry of body.entries) {
		if (!entry || typeof entry.nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.nodeId) ||
			ids.has(entry.nodeId) || typeof entry.url !== 'string' || !validCommunityEntryUrl(entry.url) || urls.has(entry.url) ||
			!['authority', 'anchor'].includes(entry.role)) return null;
		ids.add(entry.nodeId);
		urls.add(entry.url);
		if (entry.role === 'authority') authorities++;
	}
	if (authorities !== 1 || body.entries.some((entry, index) => index > 0 && body.entries[index - 1].nodeId >= entry.nodeId)) return null;
	const publicKey = typeof roster.publicKey === 'string' ? decodeBase64Url(roster.publicKey) : null;
	const signature = typeof roster.signature === 'string' ? decodeBase64Url(roster.signature) : null;
	if (!publicKey || publicKey.length !== 65 || publicKey[0] !== 4 || !signature || signature.length !== 64 || !globalThis.crypto?.subtle) return null;
	try {
		const digest = await crypto.subtle.digest('SHA-256', publicKey);
		const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
		if (id !== body.communityId) return null;
		const key = await crypto.subtle.importKey('raw', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
		// Match the Rust struct's serialized property order exactly. All signed
		// strings are ASCII, so JSON string escaping is identical on both sides.
		const payload = JSON.stringify({
			schemaVersion: body.schemaVersion, communityId: body.communityId,
			version: body.version, issuedAt: body.issuedAt, expiresAt: body.expiresAt,
			entries: body.entries.map(({ nodeId, role, url }) => ({ nodeId, role, url }))
		});
		const bytes = new TextEncoder().encode(payload);
		return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, bytes) ? roster : null;
	} catch {
		return null;
	}
}

function pinScope(url: string, accountId: number): string {
	return `${encodeURIComponent(url)}|${accountId}`;
}

function readPins(): Record<string, Pin> {
	try {
		const value = JSON.parse(localStorage.getItem(PIN_KEY) || '{}');
		return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

/**
 * Pin a roster under the address it was fetched from, and nowhere else.
 *
 * A roster is signed by a key the serving community chooses, so it only proves what that
 * community says about itself. It used to be pinned under every URL it listed: a hostile server A
 * could list another saved server B (and an attacker host), plant a pin under B's address for the
 * same numeric account id, and B's next failover would carry B's bearer token to the attacker host
 * (docs/audits/2026-11-hostile-server-audit.md, finding R1). Now only the source's own answer is
 * pinned, so a failover from B can only follow a roster B itself served.
 */
export function pinCommunityRoster(roster: SignedCommunityRoster, sourceUrl: string, accountId: number): boolean {
	const source = normalizeServerUrl(sourceUrl);
	if (!source || !roster.body.entries.some((entry) => entry.url === source)) return false;
	const pins = readPins();
	const scope = pinScope(source, accountId);
	const existing = pins[scope];
	// A carried pin never blocks the address's own answer.
	if (existing && existing.source === source && !existing.carriedFrom &&
		(existing.publicKey !== roster.publicKey || existing.version > roster.body.version)) return false;
	pins[scope] = { source, publicKey: roster.publicKey, version: roster.body.version, roster };
	try {
		localStorage.setItem(PIN_KEY, JSON.stringify(pins));
		return true;
	} catch {
		return false;
	}
}

/** Fetch only from the currently authenticated address and keep its session fixed across awaits. */
export async function refreshCommunityRoster(sourceUrl: string): Promise<SignedCommunityRoster | null> {
	const source = normalizeServerUrl(sourceUrl);
	const accountId = source ? getStoredDbUserId(source) : null;
	const token = source ? getAuthToken(source) : null;
	if (!source || !accountId || !token) return null;
	const generation = authSessionGeneration(source);
	try {
		const response = await fetch(`${source}/api/community/roster`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(5000)
		});
		if (!response.ok) return null;
		const roster = await verifyCommunityRoster(await response.json());
		if (!roster || !roster.body.entries.some((entry) => entry.url === source) ||
			getAuthToken(source) !== token || getStoredDbUserId(source) !== accountId ||
			authSessionGeneration(source) !== generation) return null;
		return pinCommunityRoster(roster, source, accountId) ? roster : null;
	} catch {
		return null;
	}
}

/** What session carry needs to know about the addresses involved (injectable for tests). */
export type CarryEnvironment = {
	getAuthToken: (url: string) => string | null;
	getStoredDbUserId: (url: string) => number | null;
	getStoredUsername: (url: string) => string | null;
	isSavedServer: (url: string) => boolean;
};

export const defaultCarryEnvironment: CarryEnvironment = {
	getAuthToken: (url) => getAuthToken(url),
	getStoredDbUserId: (url) => getStoredDbUserId(url),
	getStoredUsername: (url) => getStoredUsername(url),
	isSavedServer: (url) => loadState().entries.some((entry) => normalizeServerUrl(entry.url) === url)
};

async function tokenHash(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Cached roster remains useful when its original Authority cannot answer. */
export async function getPinnedCommunityRoster(
	sourceUrl: string,
	accountId: number,
	env: CarryEnvironment = defaultCarryEnvironment
): Promise<SignedCommunityRoster | null> {
	const source = normalizeServerUrl(sourceUrl);
	if (!source) return null;
	const pin = readPins()[pinScope(source, accountId)];
	// A pin written by another address's roster (before R1 was fixed) is not this address's answer.
	if (!pin || pin.source !== source || pin.publicKey !== pin.roster?.publicKey) return null;
	if (pin.carriedFrom) {
		// A carried pin speaks only for the exact session that was carried here.
		const token = env.getAuthToken(source);
		if (!token || !pin.carriedTokenHash || pin.carriedTokenHash !== await tokenHash(token)) return null;
	}
	const roster = await verifyCommunityRoster(pin.roster);
	if (!roster || roster.body.version !== pin.version ||
		!roster.body.entries.some((entry) => entry.url === source)) return null;
	return roster;
}

/** Automatic credential reuse requires a signed exact URL and HTTPS. */
export function canCarrySessionTo(roster: SignedCommunityRoster, url: string): boolean {
	return url.startsWith('https://') && roster.body.entries.some((entry) => entry.url === url);
}

/**
 * Decide whether the session at `fromUrl` may be carried to `toUrl` (failover or a switch inside
 * one community), and if so carry the roster pin with it so the next hop works offline
 * (review finding F3). Refused when the destination:
 * - is not a signed HTTPS entry of the roster the source pinned;
 * - holds a different token, or (with no token, e.g. after a desktop restart) has an identity of
 *   its own: a stored account id or username (finding R2);
 * - is saved as a separate server, unless it already holds this very session;
 * where an identity or saved entry there came from an earlier carry of the same community and
 * account (the carried pin records it), it is not counted as the destination's own.
 * The carried pin is bound to the carried token, so a later, different login there ignores it.
 */
export async function prepareSessionCarry(
	roster: SignedCommunityRoster,
	fromUrl: string,
	toUrl: string,
	accountId: number,
	token: string,
	env: CarryEnvironment = defaultCarryEnvironment
): Promise<boolean> {
	const from = normalizeServerUrl(fromUrl);
	const to = normalizeServerUrl(toUrl);
	if (!from || !to || from === to || !canCarrySessionTo(roster, to)) return false;
	const existingToken = env.getAuthToken(to);
	const sameSession = existingToken === token;
	if (existingToken && !sameSession) return false;
	const pins = readPins();
	const scope = pinScope(to, accountId);
	const existing = pins[scope];
	// An identity or "saved" mark at the destination is its own, unless an earlier carry from this
	// same community (same roster key) for this same account put it there: after a restart the
	// carried session-only token is gone but its username/account id and saved entry remain
	// (review finding N1). The provenance is the carried pin in localStorage; another server's
	// roster has another key and cannot have written one here (a carry onto an address with its
	// own identity is refused).
	const storedAccount = env.getStoredDbUserId(to);
	const carriedHere = Boolean(existing && existing.source === to && existing.carriedFrom &&
		existing.publicKey === roster.publicKey && (storedAccount === null || storedAccount === accountId));
	if (!sameSession && !carriedHere && (storedAccount !== null || env.getStoredUsername(to) !== null)) return false;
	if (!sameSession && !carriedHere && env.isSavedServer(to)) return false;
	if (existing && existing.source === to && !existing.carriedFrom &&
		(existing.publicKey !== roster.publicKey || existing.version > roster.body.version)) return false;
	if (!existing || existing.carriedFrom || existing.version < roster.body.version) {
		pins[scope] = {
			source: to, carriedFrom: from, carriedTokenHash: await tokenHash(token),
			publicKey: roster.publicKey, version: roster.body.version, roster
		};
		try {
			localStorage.setItem(PIN_KEY, JSON.stringify(pins));
		} catch {
			return false;
		}
	}
	return true;
}
