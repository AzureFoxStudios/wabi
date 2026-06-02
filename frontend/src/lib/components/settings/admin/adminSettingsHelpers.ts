import {
	formatMinorAmount as formatPaymentMinorAmount,
	minorToMajorInput as minorAmountToInput,
	parseMajorAmountInput as parsePaymentMajorAmount
} from '$lib/payments/paymentAmounts';
import type {
	AdminRelayNode,
	OfflineDonationLedgerEntry,
	PaymentDonationLedgerEntry,
	PaymentMethodCapability,
	PaymentProviderCapability,
	UploadLimitConfig,
	UploadRoleTier
} from '$lib/api';

export const MB = 1024 * 1024;

export const uploadRoleOrder: UploadRoleTier[] = ['new', 'trusted', 'moderator', 'admin', 'owner'];

export const uploadRoleLabels: Record<UploadRoleTier, string> = {
	new: 'New',
	trusted: 'Trusted',
	moderator: 'Moderator',
	admin: 'Admin',
	owner: 'Owner'
};

export const fallbackRoleLabels: Record<string, string> = {
	owner: 'Owner',
	admin: 'Admin',
	mod: 'Moderator',
	member: 'Member',
	guest: 'Guest'
};

export function bytesToMbInput(bytes: number | null): string {
	if (bytes === null) return '';
	const mb = Math.floor(bytes / MB);
	return mb > 0 ? String(mb) : '1';
}

export function uploadLimitInputsFromConfig(config: UploadLimitConfig): Record<UploadRoleTier, string> {
	return {
		new: bytesToMbInput(config.perRoleBytes.new),
		trusted: bytesToMbInput(config.perRoleBytes.trusted),
		moderator: bytesToMbInput(config.perRoleBytes.moderator),
		admin: bytesToMbInput(config.perRoleBytes.admin),
		owner: bytesToMbInput(config.perRoleBytes.owner)
	};
}

export function parseMbInput(value: string): number | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const mb = Number(trimmed);
	if (!Number.isFinite(mb) || mb <= 0) {
		throw new Error('Limits must be positive MB values or blank for unlimited.');
	}
	return Math.floor(mb * MB);
}

export function userHasRole(user: { roles?: string[]; highestRole?: string }, role: 'admin' | 'mod' | 'owner'): boolean {
	return user.highestRole === role || (user.roles || []).includes(role);
}

export function isProtectedOwner(user: { highestRole?: string }): boolean {
	return user.highestRole === 'owner';
}

export function minorToMajorInput(amountMinor: number, currency = 'USD'): string {
	return minorAmountToInput(amountMinor, currency);
}

export function formatDonationAuditAmount(amountMinor: number, currency: string): string {
	return formatPaymentMinorAmount(amountMinor, currency);
}

export function formatDonationAuditWhen(entry: PaymentDonationLedgerEntry | OfflineDonationLedgerEntry): string {
	const timestamp = 'refundedAt' in entry
		? entry.refundedAt || entry.completedAt || entry.createdAt
		: entry.voidedAt || entry.completedAt || entry.createdAt;
	if (!timestamp || !Number.isFinite(timestamp)) return 'n/a';
	return new Date(timestamp).toLocaleString();
}

export function parseMajorAmountInput(value: string, currency = 'USD'): number {
	return parsePaymentMajorAmount(value, currency);
}

export function parseSuggestedAmountsInput(value: string, currency = 'USD'): number[] {
	return value
		.split(',')
		.map((entry) => parsePaymentMajorAmount(entry.trim(), currency))
		.filter((amount) => Number.isFinite(amount) && amount > 0);
}

export function normalizeDonationRouteOptionValues(values: string[]): string[] {
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

export function getDonationRouteOptions(providerValues: string[], methodValues: string[]): string[] {
	const providerOptions = normalizeDonationRouteOptionValues(providerValues);
	const methodOptions = normalizeDonationRouteOptionValues(methodValues);
	if (providerOptions.length === 0) return methodOptions;
	if (methodOptions.length === 0) return providerOptions;
	const intersection = providerOptions.filter((value) => methodOptions.includes(value));
	return intersection.length > 0 ? intersection : providerOptions;
}

export function reconcileDonationRouteSelection(
	config: {
		providerPluginId: string | null;
		methodId: string | null;
		currency: string;
		countryCode: string | null;
	},
	selectedProvider: PaymentProviderCapability | null,
	methods: PaymentMethodCapability[]
): typeof config {
	let nextConfig = config;
	if (!selectedProvider) {
		return config.methodId !== null ? { ...config, methodId: null } : config;
	}

	const nextMethodId = methods.some((method) => method.id === nextConfig.methodId)
		? nextConfig.methodId
		: (methods[0]?.id || null);
	if (nextMethodId !== nextConfig.methodId) {
		nextConfig = { ...nextConfig, methodId: nextMethodId };
	}

	const selectedMethod = methods.find((method) => method.id === nextConfig.methodId) || null;
	const nextCurrencyOptions = getDonationRouteOptions(selectedProvider.currencies, selectedMethod?.currencies || []);
	const normalizedCurrency = String(nextConfig.currency || '').trim().toUpperCase();
	const nextCurrency = nextCurrencyOptions.length > 0
		? (nextCurrencyOptions.includes(normalizedCurrency) ? normalizedCurrency : nextCurrencyOptions[0])
		: (normalizedCurrency || 'USD');
	if (nextCurrency !== nextConfig.currency) {
		nextConfig = { ...nextConfig, currency: nextCurrency };
	}

	const nextCountryOptions = getDonationRouteOptions(selectedProvider.countries, selectedMethod?.countries || []);
	const normalizedCountry = String(nextConfig.countryCode || '').trim().toUpperCase();
	const nextCountryCode = nextCountryOptions.length > 0
		? (nextCountryOptions.includes(normalizedCountry) ? normalizedCountry : nextCountryOptions[0])
		: (normalizedCountry || null);
	if (nextCountryCode !== nextConfig.countryCode) {
		nextConfig = { ...nextConfig, countryCode: nextCountryCode };
	}
	return nextConfig;
}

export function getAdminRelayKindLabel(relay: AdminRelayNode): string {
	const kind = relay.metadata?.kind;
	if (kind === 'booster-relay') return 'Booster Relay';
	if (kind === 'desktop-helper') return 'Desktop Helper';
	if (relay.metadata?.capabilities?.selfHosted) return 'Self-Hosted Node';
	return 'Relay Node';
}

export function getAdminRelayCapabilitiesSummary(relay: AdminRelayNode): string {
	const capabilities = relay.metadata?.capabilities;
	if (!capabilities) return 'No capabilities advertised';
	const labels: string[] = [];
	if (capabilities.fileRelay) labels.push('Files');
	if (capabilities.turn) labels.push('TURN');
	if (capabilities.sfu) labels.push('SFU');
	if (capabilities.gateway) labels.push('Gateway');
	return labels.length > 0 ? labels.join(' / ') : 'No capabilities advertised';
}

export function formatRelaySeenAt(unixSeconds: number | null): string {
	if (!unixSeconds) return 'Never';
	try {
		return new Date(unixSeconds * 1000).toLocaleString();
	} catch {
		return 'Unknown';
	}
}

export function getAdminRelayOwnerLabel(relay: AdminRelayNode): string | null {
	return relay.metadata?.ownerUsername ? 'Owner: ' + relay.metadata.ownerUsername : null;
}
