import type { PaymentAccessActorStatus, PaymentAccessStatusResponse } from '../api/paymentCheckout';

/** Missing actor data is not an authorization grant, even on older servers. */
export function parsePaymentAccessResponse(raw: unknown): PaymentAccessStatusResponse {
  const data = raw as Partial<PaymentAccessStatusResponse> | null;
  const policy = data?.policy;
  if (data?.success !== true || !policy || typeof policy.enabled !== 'boolean'
    || typeof policy.allowGuest !== 'boolean' || !Array.isArray(policy.allowedRoleNames)
    || !policy.allowedRoleNames.every(role => typeof role === 'string')) {
    throw new Error('Invalid payment access response');
  }
  const supplied = data.actor;
  const authenticated = supplied?.authenticated === true
    && typeof supplied.userId === 'number' && Number.isSafeInteger(supplied.userId) && supplied.userId > 0;
  const actor: PaymentAccessActorStatus = {
    authenticated,
    userId: authenticated ? supplied!.userId : null,
    roles: Array.isArray(supplied?.roles) ? supplied.roles.filter(role => typeof role === 'string') : [],
    blocked: supplied?.blocked === true,
    canCreate: policy.enabled && policy.allowedRoleNames.length > 0
      && authenticated && supplied?.blocked === false && supplied.canCreate === true,
    reasonCode: typeof supplied?.reasonCode === 'string' ? supplied.reasonCode : null,
    reason: typeof supplied?.reason === 'string' ? supplied.reason : null
  };
  if (!supplied) {
    actor.reasonCode = 'unavailable';
    actor.reason = 'Payment access could not be confirmed. Refresh before creating a payment.';
  }
  return { success: true, policy, actor };
}

/** Identity comparison only, never authentication. Token renewal keeps its
 * subject; logout/re-login is additionally fenced by authSessionGeneration. */
export function paymentAccountKey(token: string | null): string {
  if (!token) return 'anonymous';
  try {
    const body = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(body));
    if (typeof claims.sub === 'string' && claims.sub) {
      return JSON.stringify([claims.sub, claims.is_guest === true, claims.token_type || 'access', claims.stepup === true]);
    }
  } catch { /* Opaque/invalid credentials must not share an account fence. */ }
  return token;
}
