import { writable } from 'svelte/store';
import { getPaymentAccess, type PaymentAccessActorStatus, type PaymentAccessPolicy } from '$lib/api';
import { authSessionGeneration, getAuthToken, onAuthSessionCleared } from '$lib/authSession';
import { getServerUrl, normalizeServerUrl } from '../serverUrl';
import { paymentAccountKey } from './paymentAccessContract';

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
	// The current server computes the account gate. Missing actor information
	// cannot grant creation, and an inconsistent actor cannot defeat disable.
	const actorCanCreate = actor?.authenticated === true && actor.blocked === false && actor.canCreate === true;
	return {
		loaded: true,
		policyEnabled,
		canCreate: policyEnabled && policy.allowedRoleNames.length > 0 && Boolean(token) && actorCanCreate,
		canViewPaymentUi: policyEnabled
	};
}

let refreshInFlight: { context: string; promise: Promise<void> } | null = null;
let refreshGeneration = 0;

function accessContext(): string {
	const server = normalizeServerUrl(getServerUrl());
	return JSON.stringify([server, paymentAccountKey(getAuthToken()), authSessionGeneration(server)]);
}

onAuthSessionCleared(server => {
	if (normalizeServerUrl(server) !== normalizeServerUrl(getServerUrl())) return;
	refreshGeneration += 1;
	refreshInFlight = null;
	paymentAccessStore.set({ loaded: false, policyEnabled: false, canCreate: false, canViewPaymentUi: false });
});

export function refreshPaymentAccess(): Promise<void> {
	const context = accessContext();
	if (refreshInFlight?.context === context) return refreshInFlight.promise;
	const generation = ++refreshGeneration;
	paymentAccessStore.set({ loaded: false, policyEnabled: false, canCreate: false, canViewPaymentUi: false });
	const promise = (async () => {
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
		if (generation !== refreshGeneration || context !== accessContext()) return;
		paymentAccessStore.set(resolvePaymentAccessSnapshot(policy, token, actor));
		refreshInFlight = null;
	})();
	refreshInFlight = { context, promise };
	return promise;
}
