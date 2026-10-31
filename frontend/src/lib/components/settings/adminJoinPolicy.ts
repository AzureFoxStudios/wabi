/**
 * Settings › Admin › "Who can join" (design contract §8.9): the same `auth_policy` the first-run
 * wizard writes. The control must say what the server will actually do, so it reads the policy
 * the way wabi-server's auth routes do (core/crates/wabi-server/src/api/auth.rs):
 *
 * - registration is refused when `allowRegister` is false or `mode` is "closed", and that check
 *   runs before invites are looked at, so Closed also stops invite links;
 * - `mode: "invite"` lets someone register only with an invite;
 * - guests are refused when `allowGuest` is false or `mode` is "invite" or "closed".
 */

export interface AuthPolicy {
	mode?: string;
	allowRegister?: boolean;
	allowGuest?: boolean;
	emailVerifyRequired?: boolean;
	[key: string]: unknown;
}

export type JoinMode = 'open' | 'invite' | 'closed';

export function joinModeOf(policy: AuthPolicy | null | undefined): JoinMode {
	if (!policy) return 'open';
	if (policy.allowRegister === false || policy.mode === 'closed') return 'closed';
	if (policy.mode === 'invite') return 'invite';
	return 'open';
}

/** The policy to save for a chosen mode; other fields (guest access, email checks) are kept. */
export function policyForJoinMode(policy: AuthPolicy, mode: JoinMode): AuthPolicy {
	if (mode === 'closed') return { ...policy, mode: 'open', allowRegister: false };
	return { ...policy, mode, allowRegister: true };
}

/** Whether guests can actually join under this policy. */
export function guestsAllowed(policy: AuthPolicy | null | undefined): boolean {
	if (!policy) return false;
	return policy.allowGuest !== false && policy.mode !== 'invite' && policy.mode !== 'closed';
}

/** Guest access can be switched only where the mode does not already refuse guests. */
export function guestSwitchAvailable(policy: AuthPolicy | null | undefined): boolean {
	return Boolean(policy) && policy?.mode !== 'invite' && policy?.mode !== 'closed';
}
