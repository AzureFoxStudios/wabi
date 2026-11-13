/**
 * Plain words for the friend's side of an invitation (/join#invite=…).
 *
 * The server deliberately gives one answer for an invitation that is expired, cancelled or
 * already used (api/invites.rs), so the page cannot tell those apart and says all three. It never
 * says "invalid token" or "403" to someone who was only sent a link.
 */
import { inviteReach } from './invitations';

export const USED_OR_EXPIRED =
	"This invitation can't be used any more. Each link works once and only for a limited time, so it has expired, been cancelled, or someone has already used it. Ask the person who invited you for a new link.";
export const SERVER_CLOSED =
	"This server isn't taking new accounts right now, not even with an invitation. Ask the person who invited you to open it to invitations, then try the same link again.";

/** Why a link could not even be read, in words for the person who received it. */
export function explainLinkProblem(href: string): string {
	let url: URL | null = null;
	try { url = new URL(href); } catch { /* fall through */ }
	if (!url || url.pathname !== '/join' || !/(^|[#&])invite=[a-f0-9]{64}$/.test(url.hash.slice(1))) {
		return 'This invitation link is incomplete. Copy the whole link you were sent, including everything after "#invite=", and open it again.';
	}
	const reach = inviteReach(url.origin);
	if (reach === 'this-device') {
		return `This link points to "${url.hostname}", which always means the device you are using, so it can't reach the server that made it. Ask the person who invited you to make the link again while they use the server's network or internet address.`;
	}
	if (reach === 'needs-https') {
		return 'This link would send your new password over plain HTTP to an internet address, so Wabi will not open it. Ask the person who invited you for an HTTPS link.';
	}
	return 'This invitation link could not be read. Ask the person who invited you to send it again.';
}

/** The server's refusal of a registration, in words for the friend. */
export function explainJoinRefusal(status: number, serverMessage: string | undefined): string {
	const message = serverMessage ?? '';
	if (/invalid, expired, revoked or already used/i.test(message)) return USED_OR_EXPIRED;
	if (/registration is closed|invite is required|require an invitation/i.test(message)) return SERVER_CLOSED;
	if (/username already taken/i.test(message)) return 'Someone on this server already has that username. Choose another one; your invitation has not been used.';
	if (/too many registration attempts|registration is busy/i.test(message)) return 'Too many accounts were tried from this network recently. Wait an hour, then open the same link again.';
	if (/password/i.test(message) && status === 400) return message;
	if (status >= 500) return "The server couldn't create your account. Try again in a minute; if it keeps happening, tell the person who invited you.";
	return message || USED_OR_EXPIRED;
}
