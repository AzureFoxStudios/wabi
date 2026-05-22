import { writable } from 'svelte/store';
import { getPaymentAccess } from '$lib/api';
import { getAuthToken } from '$lib/authSession';

type PaymentAccessSnapshot = {
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

let refreshInFlight: Promise<void> | null = null;

export function refreshPaymentAccess(): Promise<void> {
	if (refreshInFlight) return refreshInFlight;
	refreshInFlight = (async () => {
		const token = getAuthToken();
		try {
			const access = await getPaymentAccess(token);
			const policyEnabled = Boolean(access.policy?.enabled);
			paymentAccessStore.set({
				loaded: true,
				policyEnabled,
				canCreate: Boolean(policyEnabled && access.actor?.canCreate),
				canViewPaymentUi: policyEnabled
			});
		} catch (error) {
			console.warn('[Payments] Failed to load payment access:', error);
			paymentAccessStore.set({
				loaded: true,
				policyEnabled: false,
				canCreate: false,
				canViewPaymentUi: false
			});
		} finally {
			refreshInFlight = null;
		}
	})();
	return refreshInFlight;
}
