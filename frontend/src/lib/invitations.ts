/**
 * Browser-side invitations: the owner's "Invite someone" control in Settings › Admin.
 *
 * The server API (core/crates/wabi-server/src/api/invites.rs) is owner-only. It returns the
 * one-use token once, at creation; listing never returns it, so a lost link cannot be shown
 * again and the owner creates a new one.
 *
 * The link is built from the address the owner is using right now, through `makeInvitation`
 * (hostInvites.ts), which keeps its HTTPS rule. `inviteReach` says, before anything is created,
 * who could actually open a link from that address, so the page never hands out a link that
 * fails silently for the friend.
 */
import { makeInvitation, invitationServer } from './hostInvites';

/** Lifetimes the server accepts (1–168 hours). The first entry is the default. */
export const INVITE_LIFETIMES = [
	{ hours: 24, label: '1 day' },
	{ hours: 1, label: '1 hour' },
	{ hours: 168, label: '7 days' }
] as const;
export type InviteLifetimeHours = (typeof INVITE_LIFETIMES)[number]['hours'];
export const DEFAULT_INVITE_HOURS: InviteLifetimeHours = INVITE_LIFETIMES[0].hours;

export interface InviteRecord {
	id: string;
	/** Unix seconds. */
	expiresAt: number;
	consumed: boolean;
	revoked: boolean;
}
export interface CreatedInvite {
	id: string;
	token: string;
	/** Unix seconds. */
	expiresAt: number;
}

/**
 * Who can open a link made from this address:
 * - `anywhere`: an HTTPS address that is not private;
 * - `network`: a private address (LAN, VPN range, `.local`): only people on that network;
 * - `this-device`: localhost/loopback, which names the friend's own computer, not this one;
 * - `needs-https`: plain HTTP to a non-private address, which the join page refuses.
 */
export type InviteReach = 'anywhere' | 'network' | 'this-device' | 'needs-https';

function isLoopback(host: string): boolean {
	return host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '0.0.0.0'
		|| host === '[::1]' || host === '[::]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
}

function isPrivateHost(host: string): boolean {
	const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
			|| (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
	}
	if (host.startsWith('[')) return /^\[(f[cd]|fe[89ab])[0-9a-f]{0,2}:/.test(host);
	// A single-label name ("nas") or a local-only suffix resolves only inside that network.
	return !host.includes('.') || /\.(local|lan|home|home\.arpa|internal|intranet|corp)$/.test(host);
}

export function inviteReach(origin: string): InviteReach {
	let url: URL;
	try { url = new URL(origin); } catch { return 'needs-https'; }
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	if (isLoopback(host)) return 'this-device';
	try { invitationServer(url.origin); } catch { return 'needs-https'; }
	return isPrivateHost(host) ? 'network' : 'anywhere';
}

/** The link to send, or an error when this address cannot make one a friend can use. */
export function invitationLink(origin: string, token: string): string {
	return makeInvitation(new URL(origin).origin, token);
}

/** Invitations that can still admit someone, soonest expiry first. */
export function outstandingInvites(invites: InviteRecord[], nowSeconds: number): InviteRecord[] {
	return invites
		.filter((invite) => !invite.consumed && !invite.revoked && invite.expiresAt > nowSeconds)
		.sort((a, b) => a.expiresAt - b.expiresAt);
}

export function formatExpiry(expiresAt: number, locale?: string): string {
	return new Date(expiresAt * 1000).toLocaleString(locale, {
		weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
	});
}

/** "in 23 hours" / "in 45 minutes" / "in 6 days": rounded down, never "in 0 minutes". */
export function timeLeft(expiresAt: number, nowSeconds: number): string {
	const minutes = Math.max(1, Math.floor((expiresAt - nowSeconds) / 60));
	if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
	const days = Math.floor(hours / 24);
	return `in ${days} days`;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

async function call<T>(base: string, token: string, path: string, init: RequestInit, fetcher: Fetcher): Promise<T> {
	let response: Response;
	try {
		response = await fetcher(`${base}/api/invites${path}`, {
			...init,
			headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
			credentials: 'include',
			signal: AbortSignal.timeout(10000)
		});
	} catch {
		throw new Error("Couldn't reach the server. Check your connection and try again.");
	}
	const body = await response.json().catch(() => ({}));
	if (response.status === 403) throw new Error('Only the server owner can manage invitations.');
	if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'The server refused the request.');
	return body as T;
}

export async function listInvites(base: string, token: string, fetcher: Fetcher = fetch): Promise<InviteRecord[]> {
	const body = await call<{ invites?: InviteRecord[] }>(base, token, '', { method: 'GET' }, fetcher);
	return Array.isArray(body.invites) ? body.invites : [];
}

export async function createInvite(base: string, token: string, expiresInHours: number, fetcher: Fetcher = fetch): Promise<CreatedInvite> {
	const body = await call<CreatedInvite>(base, token, '', { method: 'POST', body: JSON.stringify({ expiresInHours }) }, fetcher);
	if (!body.id || !/^[a-f0-9]{64}$/.test(body.token ?? '') || typeof body.expiresAt !== 'number') {
		throw new Error('The server sent back an invitation this app cannot read.');
	}
	return body;
}

export async function revokeInvite(base: string, token: string, id: string, fetcher: Fetcher = fetch): Promise<void> {
	await call(base, token, `/${encodeURIComponent(id)}`, { method: 'DELETE' }, fetcher);
}
