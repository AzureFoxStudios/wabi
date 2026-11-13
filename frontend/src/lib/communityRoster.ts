/** Signed entry points for one authenticated community. This is not a leader election. */
import { normalizeServerUrl } from './serverUrl';
import { authSessionGeneration, getAuthToken, getStoredDbUserId } from './authSession';

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
	if (existing && existing.source === source &&
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

/** Cached roster remains useful when its original Authority cannot answer. */
export async function getPinnedCommunityRoster(sourceUrl: string, accountId: number): Promise<SignedCommunityRoster | null> {
	const source = normalizeServerUrl(sourceUrl);
	if (!source) return null;
	const pin = readPins()[pinScope(source, accountId)];
	// A pin written by another address's roster (before R1 was fixed) is not this address's answer.
	if (!pin || pin.source !== source || pin.publicKey !== pin.roster?.publicKey) return null;
	const roster = await verifyCommunityRoster(pin.roster);
	if (!roster || roster.body.version !== pin.version ||
		!roster.body.entries.some((entry) => entry.url === source)) return null;
	return roster;
}

/** Automatic credential reuse requires a signed exact URL and HTTPS. */
export function canCarrySessionTo(roster: SignedCommunityRoster, url: string): boolean {
	return url.startsWith('https://') && roster.body.entries.some((entry) => entry.url === url);
}
