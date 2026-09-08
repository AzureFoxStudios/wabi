import type { PaymentAccessPolicy } from './api';

const supportedRoles = new Set(['owner', 'admin', 'mod', 'member', 'guest']);
const validSavedRole = (role: unknown): role is string => typeof role === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(role.trim());

/** A suggestion for an explicit edit, NEVER a normalization of saved access.
 * The current server matches stored names exactly; Moderator is not mod. */
export function canonicalAdminPaymentRole(role: string): string | null {
	const normalized = role.trim().toLowerCase();
	if (normalized === 'moderator') return 'mod';
	return supportedRoles.has(normalized) ? normalized : null;
}

/** Reject malformed responses instead of turning guessed defaults into an editable policy. */
export function readAdminPaymentPolicy(value: unknown): PaymentAccessPolicy {
	if (!value || typeof value !== 'object') throw new Error('The server returned an invalid payment policy.');
	const policy = value as Partial<PaymentAccessPolicy>;
	if (typeof policy.enabled !== 'boolean' || typeof policy.allowGuest !== 'boolean' || !Array.isArray(policy.allowedRoleNames)) {
		throw new Error('The server returned an invalid payment policy. Refresh before making changes.');
	}
	if (policy.allowedRoleNames.some((role) => !validSavedRole(role))) {
		throw new Error('The saved policy contains invalid role names. The server operator must repair allowedRoleNames through /api/admin/policies/payments_access before this editor can save it.');
	}
	// Preserve literal saved names. Lowercasing OWNER here would turn an
	// inactive stored name into an active owner grant without user consent.
	return { enabled: policy.enabled, allowGuest: policy.allowGuest, allowedRoleNames: [...new Set(policy.allowedRoleNames)] };
}

export function cloneAdminPaymentPolicy(policy: PaymentAccessPolicy): PaymentAccessPolicy {
	return { ...policy, allowedRoleNames: [...policy.allowedRoleNames] };
}

export function adminPaymentPoliciesMatch(left: PaymentAccessPolicy, right: PaymentAccessPolicy | null): boolean {
	if (!right || left.enabled !== right.enabled || left.allowGuest !== right.allowGuest) return false;
	const leftRoles = new Set(left.allowedRoleNames);
	const rightRoles = new Set(right.allowedRoleNames);
	return leftRoles.size === rightRoles.size && [...leftRoles].every((role) => rightRoles.has(role));
}

export function canSaveAdminPaymentPolicy(options: {
	loaded: boolean;
	loading: boolean;
	saving: boolean;
	draft: PaymentAccessPolicy;
	published: PaymentAccessPolicy | null;
}): boolean {
	return options.loaded && !options.loading && !options.saving && options.published !== null &&
		!adminPaymentRolesNeedReview(options.draft) && !adminPaymentPoliciesMatch(options.draft, options.published);
}

export function setAdminPaymentRole(policy: PaymentAccessPolicy, role: string, enabled: boolean): PaymentAccessPolicy {
	// A control action is explicit; accepting its display alias is safe. It
	// must not rewrite other saved strings as a side effect of this edit.
	const canonical = canonicalAdminPaymentRole(role);
	if (!canonical) return cloneAdminPaymentPolicy(policy);
	const roles = new Set(policy.allowedRoleNames);
	if (enabled) roles.add(canonical);
	else roles.delete(canonical);
	return { ...policy, allowedRoleNames: [...roles] };
}

/** One explicit guest choice controls both independent admission checks. */
export function setAdminPaymentGuestAccess(policy: PaymentAccessPolicy, enabled: boolean): PaymentAccessPolicy {
	return { ...setAdminPaymentRole(policy, 'guest', enabled), allowGuest: enabled };
}

export function effectiveAdminPaymentRoles(policy: PaymentAccessPolicy): string[] {
	if (!policy.enabled) return [];
	return [...new Set(policy.allowedRoleNames)].filter((role) => supportedRoles.has(role) && (role !== 'guest' || policy.allowGuest));
}

export function retainedAdminPaymentRoles(policy: PaymentAccessPolicy): string[] {
	return [...new Set(policy.allowedRoleNames)].filter((role) => !supportedRoles.has(role));
}

/** The server formats submitted names. Require explicit review rather than
 * allowing an unrelated master/guest toggle to silently change those names. */
export function adminPaymentRolesNeedReview(policy: PaymentAccessPolicy): boolean {
	return policy.allowedRoleNames.some((role) => !validSavedRole(role) || role !== role.trim().toLowerCase());
}

export function reviewAdminPaymentRole(
	policy: PaymentAccessPolicy, storedName: string, action: 'remove' | 'normalize' | 'use-built-in'
): PaymentAccessPolicy {
	if (!retainedAdminPaymentRoles(policy).includes(storedName)) return cloneAdminPaymentPolicy(policy);
	let replacement: string | null = null;
	if (action === 'normalize') {
		if (!validSavedRole(storedName)) return cloneAdminPaymentPolicy(policy);
		replacement = storedName.trim().toLowerCase();
	} else if (action === 'use-built-in') {
		replacement = canonicalAdminPaymentRole(storedName);
		if (!replacement) return cloneAdminPaymentPolicy(policy);
	}
	const roles = new Set(policy.allowedRoleNames);
	roles.delete(storedName);
	if (replacement) roles.add(replacement);
	return { ...policy, allowedRoleNames: [...roles] };
}
