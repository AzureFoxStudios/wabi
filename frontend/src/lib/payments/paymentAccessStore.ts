import { writable } from 'svelte/store';
import { getPaymentAccess, type PaymentAccessActorStatus, type PaymentAccessPolicy } from '$lib/api';
import { getAuthToken } from '$lib/authSession';

export type PaymentAccessSnapshot = {
	loaded: boolean;
	policyEnabled: boolean;
	canCreate: boolean;
	canViewPaymentUi: boolean;
};

export const paymentAccessStore = writable<PaymentAccessSnapshot>({
	loaded: false,
	policyEnabled: false,
	canCreate: false,
	canViewPaymentUi: false
});

export const DISABLE_CONFIRM_PHRASE = 'DISABLE';

export function canConfirmDisable(acknowledged: boolean, phrase: string): boolean {
	return acknowledged && phrase.trim().toUpperCase() === DISABLE_CONFIRM_PHRASE;
}

export function resolvePaymentAccessSnapshot(
	policy: PaymentAccessPolicy | null,
	token: string | null | undefined,
	actor?: PaymentAccessActorStatus | null
): PaymentAccessSnapshot {
	if (!policy) {
		// 2026-08-27 owner directive: when we cannot CONFIRM payments are
		// enabled, every payment surface stays hidden ("payments disabled ⇒ all
		// payment settings/buttons omitted"). The old fail-open kept buttons
		// visible on servers that never opted in (wabi.chat report).
		return { loaded: true, policyEnabled: false, canCreate: false, canViewPaymentUi: false };
	}
	const policyEnabled = Boolean(policy.enabled);
	// WS-3: the server-computed actor (persisted policy + payment user blocks)
	// is authoritative; older servers without an actor field fall back to
	// policy-only gating.
	const actorCanCreate = actor?.canCreate ?? policyEnabled;
	return {
		loaded: true,
		policyEnabled,
		canCreate: Boolean(token) && actorCanCreate,
		canViewPaymentUi: policyEnabled || actorCanCreate
	};
}

let refreshInFlight: Promise<void> | null = null;

export function refreshPaymentAccess(): Promise<void> {
	if (refreshInFlight) return refreshInFlight;
	refreshInFlight = (async () => {
		const token = getAuthToken();
		let policy: PaymentAccessPolicy | null = null;
		let actor: PaymentAccessActorStatus | null = null;
		try {
			const response = await getPaymentAccess(token);
			policy = response.policy || null;
			actor = response.actor || null;
		} catch (error) {
			console.warn('[Payments] Failed to load payment access:', error);
		}
		paymentAccessStore.set(resolvePaymentAccessSnapshot(policy, token, actor));
		refreshInFlight = null;
	})();
	return refreshInFlight;
}