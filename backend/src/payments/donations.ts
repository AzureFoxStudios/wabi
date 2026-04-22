import { appPolicyRepository } from '../db/repositories/appPolicyRepository.js';
import { stdbPaymentIngest, stdbPaymentRows, stdbPaymentsEnabled, parseStdbRowJson } from './stdbRuntime.js';
import { escapeSqlLiteral } from '../state-plane/stdbSyncClient.js';
import type { PaymentDonationConfig } from '../../../shared/adminPolicyContracts.js';

export type { PaymentDonationConfig } from '../../../shared/adminPolicyContracts.js';

const PAYMENT_DONATION_STORAGE_KEY = 'policy:payments_donations';
const DEFAULT_SUGGESTED_AMOUNTS_MINOR = [500, 1000, 2500];

export const DEFAULT_PAYMENT_DONATION_CONFIG: PaymentDonationConfig = {
	enabled: false,
	providerPluginId: null,
	methodId: null,
	currency: 'USD',
	countryCode: null,
	suggestedAmountsMinor: DEFAULT_SUGGESTED_AMOUNTS_MINOR,
	headline: 'Support This Server',
	description: 'Contribute to server hosting and maintenance.'
};

function getStdbPaymentDonationConfig(): PaymentDonationConfig | null {
	const rows = stdbPaymentRows(
		'payment_policy.payments_donations.read',
		`SELECT row_json FROM state_payment_policy WHERE policy_key = ${escapeSqlLiteral(PAYMENT_DONATION_STORAGE_KEY)} LIMIT 1`
	);
	if (!rows || rows.length === 0) return null;
	return sanitizePaymentDonationConfig(parseStdbRowJson<PaymentDonationConfig>(rows[0]));
}

function saveStdbPaymentDonationConfig(config: PaymentDonationConfig): void {
	stdbPaymentIngest('payment_policy.payments_donations.write', 'upsert_policy', {
		policyKey: PAYMENT_DONATION_STORAGE_KEY,
		updatedAt: Date.now(),
		row: config
	});
}

function normalizeOptionalString(value: unknown, maxLen: number): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim();
	if (!normalized) return null;
	return normalized.slice(0, maxLen);
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value !== 0;
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
		if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	}
	return fallback;
}

function normalizeCurrency(value: unknown, fallback: string): string {
	if (typeof value !== 'string') return fallback;
	const normalized = value.trim().toUpperCase();
	return /^[A-Z]{3}$/.test(normalized) ? normalized : fallback;
}

function normalizeCountryCode(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toUpperCase();
	return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function normalizeSuggestedAmounts(value: unknown): number[] {
	if (!Array.isArray(value)) return [...DEFAULT_SUGGESTED_AMOUNTS_MINOR];
	const unique = new Set<number>();
	for (const entry of value) {
		const parsed = Number(entry);
		if (!Number.isFinite(parsed)) continue;
		const rounded = Math.floor(parsed);
		if (rounded <= 0 || rounded > 1_000_000_000) continue;
		unique.add(rounded);
	}
	const amounts = [...unique].sort((left, right) => left - right);
	return amounts.length > 0 ? amounts.slice(0, 8) : [...DEFAULT_SUGGESTED_AMOUNTS_MINOR];
}

export function sanitizePaymentDonationConfig(raw: unknown): PaymentDonationConfig {
	const fallback = { ...DEFAULT_PAYMENT_DONATION_CONFIG };
	if (!raw || typeof raw !== 'object') {
		return fallback;
	}

	const input = raw as Partial<PaymentDonationConfig>;
	return {
		enabled: normalizeBool(input.enabled, fallback.enabled),
		providerPluginId: normalizeOptionalString(input.providerPluginId, 96),
		methodId: normalizeOptionalString(input.methodId, 96),
		currency: normalizeCurrency(input.currency, fallback.currency),
		countryCode: normalizeCountryCode(input.countryCode),
		suggestedAmountsMinor: normalizeSuggestedAmounts(input.suggestedAmountsMinor),
		headline: normalizeOptionalString(input.headline, 120) || fallback.headline,
		description: normalizeOptionalString(input.description, 500) || fallback.description
	};
}

export function getPaymentDonationConfig(): PaymentDonationConfig {
	if (stdbPaymentsEnabled()) {
		const shadow = getStdbPaymentDonationConfig();
		if (shadow) return shadow;
	}
	const raw = appPolicyRepository.getRaw(PAYMENT_DONATION_STORAGE_KEY);
	if (!raw) {
		return { ...DEFAULT_PAYMENT_DONATION_CONFIG };
	}
	try {
		const config = sanitizePaymentDonationConfig(JSON.parse(raw));
		if (stdbPaymentsEnabled()) {
			saveStdbPaymentDonationConfig(config);
		}
		return config;
	} catch {
		return { ...DEFAULT_PAYMENT_DONATION_CONFIG };
	}
}

export function savePaymentDonationConfig(raw: unknown): PaymentDonationConfig {
	const sanitized = sanitizePaymentDonationConfig(raw);
	if (stdbPaymentsEnabled()) {
		saveStdbPaymentDonationConfig(sanitized);
	}
	appPolicyRepository.setRaw(PAYMENT_DONATION_STORAGE_KEY, JSON.stringify(sanitized));
	return sanitized;
}
