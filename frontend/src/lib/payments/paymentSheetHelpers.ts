import type {
	PaymentCheckoutMode,
	PaymentMethodCapability,
	PaymentProviderCapability
} from '$lib/api';

const euroPresetCountries = ['DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'AT', 'IE', 'PT', 'FI', 'LU'];

export type RoutePreset = {
	key: string;
	label: string;
	flag: string;
	providerId: string;
	methodId: string;
	countryCode: string;
	currency: string;
	defaultAmountInput?: string;
};

export function normalizeCheckoutMode(value: unknown): PaymentCheckoutMode | null {
	if (
		value === 'qr' ||
		value === 'payment_link' ||
		value === 'app_switch' ||
		value === 'redirect' ||
		value === 'tap_to_pay'
	) {
		return value;
	}
	return null;
}

export function normalizePrefillValue(value: string | null): string | null {
	if (typeof value !== 'string') return null;
	return value.trim();
}

export function normalizeProviderOptions(values: string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const value of values) {
		const upper = String(value || '').trim().toUpperCase();
		if (!upper || seen.has(upper)) continue;
		seen.add(upper);
		normalized.push(upper);
	}
	return normalized;
}

export function getPreferredMethodId(provider: PaymentProviderCapability): string {
	if (provider.pluginId === 'promptpay' || provider.pluginId === 'th-payments') {
		const promptPayMethod = provider.methods.find((method) => method.id === 'promptpay_qr');
		if (promptPayMethod) {
			return promptPayMethod.id;
		}
	}
	const cardMethod = provider.methods.find((method) => method.id === 'card_checkout');
	if (cardMethod) {
		return cardMethod.id;
	}
	return provider.methods[0]?.id || '';
}

export function buildRoutePresets(inputProviders: PaymentProviderCapability[]): RoutePreset[] {
	const presets: RoutePreset[] = [];
	const promptPayProvider = inputProviders.find(
		(provider) => provider.pluginId === 'promptpay' || provider.pluginId === 'th-payments'
	);
	if (promptPayProvider) {
		const methodId = getPreferredMethodId(promptPayProvider);
		if (methodId) {
			presets.push({ key: 'TH', label: 'Thailand', flag: '🇹🇭', providerId: promptPayProvider.pluginId, methodId, countryCode: 'TH', currency: 'THB', defaultAmountInput: '100.00' });
		}
	}

	const westernProvider = inputProviders.find((provider) => provider.pluginId === 'western-payments');
	if (westernProvider) {
		const methodId = getPreferredMethodId(westernProvider);
		if (methodId) {
			if (westernProvider.countries.includes('US') && westernProvider.currencies.includes('USD')) presets.push({ key: 'US', label: 'United States', flag: '🇺🇸', providerId: westernProvider.pluginId, methodId, countryCode: 'US', currency: 'USD', defaultAmountInput: '10.00' });
			if (westernProvider.countries.includes('CA') && westernProvider.currencies.includes('CAD')) presets.push({ key: 'CA', label: 'Canada', flag: '🇨🇦', providerId: westernProvider.pluginId, methodId, countryCode: 'CA', currency: 'CAD', defaultAmountInput: '10.00' });
			if (westernProvider.countries.includes('GB') && westernProvider.currencies.includes('GBP')) presets.push({ key: 'GB', label: 'United Kingdom', flag: '🇬🇧', providerId: westernProvider.pluginId, methodId, countryCode: 'GB', currency: 'GBP', defaultAmountInput: '10.00' });
			if (euroPresetCountries.some((country) => westernProvider.countries.includes(country)) && westernProvider.currencies.includes('EUR')) presets.push({ key: 'EU', label: 'Euro Area', flag: '🇪🇺', providerId: westernProvider.pluginId, methodId, countryCode: 'DE', currency: 'EUR', defaultAmountInput: '10.00' });
		}
	}

	const btcProvider = inputProviders.find((provider) => provider.pluginId === 'btc-payments');
	if (btcProvider) {
		const bitcoinMethod = btcProvider.methods.find((method) => method.id === 'bitcoin_qr');
		if (bitcoinMethod) presets.push({ key: 'BTC', label: 'Bitcoin', flag: '₿', providerId: btcProvider.pluginId, methodId: bitcoinMethod.id, countryCode: '', currency: 'BTC', defaultAmountInput: '0.001' });
		const lightningMethod = btcProvider.methods.find((method) => method.id === 'lightning_checkout');
		if (lightningMethod) presets.push({ key: 'LIGHTNING', label: 'Lightning', flag: '⚡', providerId: btcProvider.pluginId, methodId: lightningMethod.id, countryCode: '', currency: 'BTC', defaultAmountInput: '0.0001' });
	}

	const cryptoProvider = inputProviders.find((provider) => provider.pluginId === 'payments-crypto');
	if (cryptoProvider) {
		const cryptoPresets: Array<{ key: string; label: string; flag: string; methodId: string; currency: string; defaultAmountInput: string }> = [
			{ key: 'USDC', label: 'USDC on Base', flag: '💠', methodId: 'usdc_base', currency: 'USDC', defaultAmountInput: '10.00' },
			{ key: 'USDT', label: 'USDT on Tron', flag: '₮', methodId: 'usdt_tron', currency: 'USDT', defaultAmountInput: '10.00' },
			{ key: 'BTC', label: 'Bitcoin', flag: '₿', methodId: 'btc', currency: 'BTC', defaultAmountInput: '0.001' },
			{ key: 'LIGHTNING', label: 'Lightning', flag: '⚡', methodId: 'lightning', currency: 'BTC', defaultAmountInput: '0.0001' },
			{ key: 'XMR', label: 'Monero', flag: 'ɱ', methodId: 'monero', currency: 'XMR', defaultAmountInput: '0.01' }
		];
		for (const preset of cryptoPresets) {
			if (cryptoProvider.methods.some((method) => method.id === preset.methodId)) {
				presets.push({ key: preset.key, label: preset.label, flag: preset.flag, providerId: cryptoProvider.pluginId, methodId: preset.methodId, countryCode: '', currency: preset.currency, defaultAmountInput: preset.defaultAmountInput });
			}
		}
	}

	const euProvider = inputProviders.find((provider) => provider.pluginId === 'payments-eu');
	if (euProvider) {
		const epcMethod = euProvider.methods.find((method) => method.id === 'epc_qr');
		if (epcMethod) {
			presets.push({ key: 'EU', label: 'Euro Area', flag: '🇪🇺', providerId: euProvider.pluginId, methodId: epcMethod.id, countryCode: 'DE', currency: 'EUR', defaultAmountInput: '10.00' });
		}
	}

	const usProvider = inputProviders.find((provider) => provider.pluginId === 'payments-us');
	if (usProvider) {
		const cashAppMethod = usProvider.methods.find((method) => method.id === 'cashapp_pointer');
		if (cashAppMethod) {
			presets.push({ key: 'US', label: 'United States', flag: '🇺🇸', providerId: usProvider.pluginId, methodId: cashAppMethod.id, countryCode: 'US', currency: 'USD', defaultAmountInput: '10.00' });
		}
	}

	return presets;
}

export function getBrowserPreferredRouteKey(): string {
	if (typeof navigator === 'undefined') return '';
	const localeCandidates = [...(navigator.languages || []), navigator.language]
		.map((value) => String(value || '').trim())
		.filter(Boolean);
	for (const locale of localeCandidates) {
		const match = locale.match(/[-_](TH|US|CA|GB|DE|FR|ES|IT|NL|BE|AT|IE|PT|FI|LU)\b/i);
		if (!match) continue;
		const region = match[1].toUpperCase();
		if (region === 'TH' || region === 'US' || region === 'CA' || region === 'GB') return region;
		if (euroPresetCountries.includes(region)) return 'EU';
	}
	return '';
}

export function reconcileProviderOption(currentValue: string, options: string[]): string {
	const normalizedCurrent = String(currentValue || '').trim().toUpperCase();
	if (options.length === 0) return normalizedCurrent;
	if (normalizedCurrent && options.includes(normalizedCurrent)) return normalizedCurrent;
	return options[0] || '';
}

export function isMethodEligibleForDraft(
	method: PaymentMethodCapability,
	amountMinor: number,
	draftCurrency: string,
	draftCountryCode: string
): boolean {
	const normalizedCurrency = String(draftCurrency || '').trim().toUpperCase();
	const normalizedCountry = String(draftCountryCode || '').trim().toUpperCase();
	const methodCurrencies = normalizeProviderOptions(method.currencies || []);
	const methodCountries = normalizeProviderOptions(method.countries || []);
	if (amountMinor > 0 && typeof method.minAmountMinor === 'number' && amountMinor < method.minAmountMinor) return false;
	if (amountMinor > 0 && typeof method.maxAmountMinor === 'number' && amountMinor > method.maxAmountMinor) return false;
	if (methodCurrencies.length > 0 && normalizedCurrency && !methodCurrencies.includes(normalizedCurrency)) return false;
	if (methodCountries.length > 0 && normalizedCountry && !methodCountries.includes(normalizedCountry)) return false;
	return true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function maskReference(reference: string): string {
	const trimmed = reference.trim();
	if (trimmed.length <= 8) return trimmed;
	return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export function formatExpiryTimestamp(value: number | null | undefined): string | null {
	if (!value) return null;
	try {
		return new Date(value).toLocaleString();
	} catch {
		return null;
	}
}
