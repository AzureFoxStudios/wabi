/**
 * Settings › Admin › "Who can join" (design contract §8.9): the same `auth_policy` the first-run
 * wizard writes. The control must say what the server will actually do, so it reads the policy
 * the way wabi-server's auth routes do (core/crates/wabi-server/src/api/auth.rs):
 *
 * - registration is refused when `allowRegister` is false or `mode` is "closed", and that check
 *   runs before invites are looked at, so Closed also stops invite links;
 * - `mode: "invite"` lets someone register only with an invite;
 * - guests are refused when `allowGuest` is false or `mode` is "invite" or "closed";
 * - `mode: "verified"` or `emailVerifyRequired: true` asks for email checks the server does not
 *   have, so `load_auth_policy` refuses every registration and every guest, and the admin save
 *   route rejects the policy (400). That reads as "unsupported", never as Open.
 *
 * A mode change never widens guest access: the guest state people saw is written back
 * explicitly, so leaving Invite only or a stored "closed" mode (both refuse guests) cannot quietly
 * re-admit guests through a stale stored `allowGuest: true`. Choosing Invite only stores guests
 * off, which is what that mode already does.
 */

export interface AuthPolicy {
	mode?: string;
	allowRegister?: boolean;
	allowGuest?: boolean;
	emailVerifyRequired?: boolean;
	[key: string]: unknown;
}

export type JoinMode = 'open' | 'invite' | 'closed';
/** What the control shows: a mode, or a stored policy the server cannot run (no option selected). */
export type JoinModeState = JoinMode | 'unsupported';

/** Email checks are not implemented, so the server refuses everyone under such a policy. */
export function needsEmailCheck(policy: AuthPolicy | null | undefined): boolean {
	return Boolean(policy) && (policy?.mode === 'verified' || policy?.emailVerifyRequired === true);
}

export function joinModeOf(policy: AuthPolicy | null | undefined): JoinModeState {
	if (!policy) return 'open';
	if (needsEmailCheck(policy)) return 'unsupported';
	if (policy.allowRegister === false || policy.mode === 'closed') return 'closed';
	if (policy.mode === 'invite') return 'invite';
	return 'open';
}

/** Whether guests can actually join under this policy. */
export function guestsAllowed(policy: AuthPolicy | null | undefined): boolean {
	if (!policy || needsEmailCheck(policy)) return false;
	return policy.allowGuest !== false && policy.mode !== 'invite' && policy.mode !== 'closed';
}

/**
 * The policy to save for a chosen mode. Guest access is carried forward as people saw it (and is
 * off under Invite only, which refuses guests), email checks are cleared because the server
 * cannot run them, and other fields are kept.
 */
export function policyForJoinMode(policy: AuthPolicy, mode: JoinMode): AuthPolicy {
	const repaired: AuthPolicy = { ...policy, emailVerifyRequired: false };
	if (mode === 'closed') return { ...repaired, mode: 'open', allowRegister: false, allowGuest: guestsAllowed(policy) };
	if (mode === 'invite') return { ...repaired, mode, allowRegister: true, allowGuest: false };
	return { ...repaired, mode, allowRegister: true, allowGuest: guestsAllowed(policy) };
}

/** Guest access can be switched only where the mode does not already refuse guests. */
export function guestSwitchAvailable(policy: AuthPolicy | null | undefined): boolean {
	return Boolean(policy) && !needsEmailCheck(policy) && policy?.mode !== 'invite' && policy?.mode !== 'closed';
}
