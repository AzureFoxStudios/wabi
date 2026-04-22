import type { FrontendAppMetadataPolicy } from '../../shared/adminPolicyContracts.js';

export type { FrontendAppMetadataPolicy } from '../../shared/adminPolicyContracts.js';

const DEFAULT_FRONTEND_APP_METADATA_POLICY: FrontendAppMetadataPolicy = {
	displayName: null,
	iconUrl: null,
	bannerUrl: null,
	accentColor: null,
	description: null,
	launchPageFallbackEnabled: true
};

function sanitizeNullableString(value: unknown, maxLength: number): string | null {
	if (typeof value !== 'string') return null;
	const cleaned = value.trim().slice(0, maxLength);
	return cleaned.length > 0 ? cleaned : null;
}

function sanitizeNullableUrl(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const cleaned = value.trim();
	if (!cleaned) return null;
	if (cleaned.startsWith('/')) return cleaned;
	try {
		const parsed = new URL(cleaned);
		if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
			return cleaned;
		}
	} catch {
		return null;
	}
	return null;
}

function sanitizeNullableHexColor(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const cleaned = value.trim();
	if (/^#[0-9a-fA-F]{6}$/.test(cleaned) || /^#[0-9a-fA-F]{8}$/.test(cleaned)) {
		return cleaned;
	}
	return null;
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

export function sanitizeFrontendAppMetadataPolicy(raw: unknown): FrontendAppMetadataPolicy {
	const input =
		raw && typeof raw === 'object' && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {};

	return {
		displayName: sanitizeNullableString(input.displayName, 80),
		iconUrl: sanitizeNullableUrl(input.iconUrl),
		bannerUrl: sanitizeNullableUrl(input.bannerUrl),
		accentColor: sanitizeNullableHexColor(input.accentColor),
		description: sanitizeNullableString(input.description, 280),
		launchPageFallbackEnabled: normalizeBool(
			input.launchPageFallbackEnabled,
			DEFAULT_FRONTEND_APP_METADATA_POLICY.launchPageFallbackEnabled
		)
	};
}

export function cloneDefaultFrontendAppMetadataPolicy(): FrontendAppMetadataPolicy {
	return { ...DEFAULT_FRONTEND_APP_METADATA_POLICY };
}
