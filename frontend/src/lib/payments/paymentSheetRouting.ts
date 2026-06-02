import {
	getBrowserPreferredRouteKey,
	normalizePrefillValue,
	type RoutePreset
} from '$lib/payments/paymentSheetHelpers';
import type { PaymentAccountLink, PaymentProviderCapability } from '$lib/api';

export const PAYMENT_ROUTE_PREFERENCE_KEY = 'wabi.payment.preferred-route';

export function getCurrentPaymentRouteKey(
	routePresets: RoutePreset[],
	selectedProviderId: string,
	selectedMethodId: string,
	countryCode: string,
	currency: string
): string {
	const normalizedCountry = String(countryCode || '').trim().toUpperCase();
	const normalizedCurrency = String(currency || '').trim().toUpperCase();
	return (
		routePresets.find(
			(preset) =>
				preset.providerId === selectedProviderId &&
				preset.methodId === selectedMethodId &&
				preset.countryCode === normalizedCountry &&
				preset.currency === normalizedCurrency
		)?.key || ''
	);
}

export function readPreferredPaymentRouteKey(accountPreferredRouteKey: string): string {
	if (accountPreferredRouteKey) return accountPreferredRouteKey;
	if (typeof localStorage === 'undefined') return '';
	try {
		return String(localStorage.getItem(PAYMENT_ROUTE_PREFERENCE_KEY) || '').trim().toUpperCase();
	} catch {
		return '';
	}
}

export function writePreferredPaymentRouteKey(routeKey: string): string {
	const normalized = String(routeKey || '').trim().toUpperCase();
	if (typeof localStorage === 'undefined') return normalized;
	try {
		if (!normalized) {
			localStorage.removeItem(PAYMENT_ROUTE_PREFERENCE_KEY);
		} else {
			localStorage.setItem(PAYMENT_ROUTE_PREFERENCE_KEY, normalized);
		}
	} catch {
		// Ignore local preference persistence failures.
	}
	return normalized;
}

export function getPreferredPaymentProviderId(
	initialProviderId: string | null,
	providers: PaymentProviderCapability[],
	paymentAccountLinks: PaymentAccountLink[]
): string {
	const requestedProviderId = normalizePrefillValue(initialProviderId);
	if (requestedProviderId && providers.some((provider) => provider.pluginId === requestedProviderId)) {
		return requestedProviderId;
	}
	for (const link of paymentAccountLinks) {
		if (providers.some((provider) => provider.pluginId === link.pluginId)) return link.pluginId;
	}
	return providers[0]?.pluginId || '';
}

export function resolvePreferredPaymentRoutePreset(params: {
	nextRoutePresets: RoutePreset[];
	currentRouteKey: string;
	initialProviderId: string | null;
	initialCountryCode: string | null;
	initialCurrency: string | null;
	initialMethodId: string | null;
	preferredRouteKey: string;
	paymentAccountLinks: PaymentAccountLink[];
	selectedProviderId: string;
}): RoutePreset | null {
	const {
		nextRoutePresets,
		currentRouteKey,
		initialProviderId,
		initialCountryCode,
		initialCurrency,
		initialMethodId,
		preferredRouteKey,
		paymentAccountLinks,
		selectedProviderId
	} = params;
	if (nextRoutePresets.length === 0) return null;

	if (currentRouteKey) {
		const currentPreset = nextRoutePresets.find((preset) => preset.key === currentRouteKey);
		if (currentPreset) return currentPreset;
	}

	const requestedProviderId = normalizePrefillValue(initialProviderId);
	const requestedCountryCode = normalizePrefillValue(initialCountryCode)?.toUpperCase() || '';
	const requestedCurrency = normalizePrefillValue(initialCurrency)?.toUpperCase() || '';
	const requestedMethodId = normalizePrefillValue(initialMethodId);
	const explicitPreset = nextRoutePresets.find(
		(preset) =>
			(!requestedProviderId || preset.providerId === requestedProviderId) &&
			(!requestedMethodId || preset.methodId === requestedMethodId) &&
			(!requestedCountryCode || preset.countryCode === requestedCountryCode) &&
			(!requestedCurrency || preset.currency === requestedCurrency)
	);
	if (explicitPreset) return explicitPreset;

	const storedPreset = preferredRouteKey
		? nextRoutePresets.find((preset) => preset.key === preferredRouteKey)
		: null;
	if (storedPreset) return storedPreset;

	const browserPreferredRouteKey = getBrowserPreferredRouteKey();
	const browserPreset = browserPreferredRouteKey
		? nextRoutePresets.find((preset) => preset.key === browserPreferredRouteKey)
		: null;
	if (browserPreset) return browserPreset;

	const linkedProviderPreset = nextRoutePresets.find((preset) =>
		paymentAccountLinks.some((link) => link.pluginId === preset.providerId)
	);
	if (linkedProviderPreset) return linkedProviderPreset;

	return nextRoutePresets.find((preset) => preset.providerId === selectedProviderId) || nextRoutePresets[0] || null;
}
