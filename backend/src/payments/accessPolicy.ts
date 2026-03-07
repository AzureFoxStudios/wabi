import { appPolicyRepository } from '../db/repositories/appPolicyRepository.js';

export interface PaymentAccessPolicy {
	enabled: boolean;
	allowGuest: boolean;
	allowedRoleNames: string[];
}

const PAYMENT_ACCESS_POLICY_STORAGE_KEY = 'policy:payments_access';
const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

export const DEFAULT_PAYMENT_ACCESS_POLICY: PaymentAccessPolicy = {
	enabled: false,
	allowGuest: false,
	allowedRoleNames: ['owner', 'admin', 'mod', 'member']
};

function normalizeRoleName(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase();
	if (!normalized || !ROLE_NAME_PATTERN.test(normalized)) {
		return null;
	}
	return normalized;
}

function uniqueRoleNames(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	const dedupe = new Set<string>();
	for (const value of values) {
		const normalized = normalizeRoleName(value);
		if (normalized) {
			dedupe.add(normalized);
		}
	}
	return [...dedupe];
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

export function sanitizePaymentAccessPolicy(raw: unknown): PaymentAccessPolicy {
	const fallback = { ...DEFAULT_PAYMENT_ACCESS_POLICY };
	if (!raw || typeof raw !== 'object') return fallback;

	const input = raw as Partial<PaymentAccessPolicy>;
	const hasAllowedRoleNames = Object.prototype.hasOwnProperty.call(input, 'allowedRoleNames');
	const nextAllowedRoles = uniqueRoleNames(input.allowedRoleNames);

	return {
		enabled: normalizeBool(input.enabled, fallback.enabled),
		allowGuest: normalizeBool(input.allowGuest, fallback.allowGuest),
		allowedRoleNames: hasAllowedRoleNames ? nextAllowedRoles : [...fallback.allowedRoleNames]
	};
}

export function getPaymentAccessPolicy(): PaymentAccessPolicy {
	const raw = appPolicyRepository.getRaw(PAYMENT_ACCESS_POLICY_STORAGE_KEY);
	if (!raw) {
		return { ...DEFAULT_PAYMENT_ACCESS_POLICY };
	}
	try {
		return sanitizePaymentAccessPolicy(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_PAYMENT_ACCESS_POLICY };
	}
}

export function savePaymentAccessPolicy(raw: unknown): PaymentAccessPolicy {
	const sanitized = sanitizePaymentAccessPolicy(raw);
	appPolicyRepository.setRaw(PAYMENT_ACCESS_POLICY_STORAGE_KEY, JSON.stringify(sanitized));
	return sanitized;
}

function normalizeUserRoles(userRoles: string[] | null | undefined): string[] {
	if (!Array.isArray(userRoles) || userRoles.length === 0) {
		return ['member'];
	}
	const dedupe = new Set<string>();
	for (const role of userRoles) {
		const normalized = normalizeRoleName(role);
		if (normalized) {
			dedupe.add(normalized);
		}
	}
	if (dedupe.size === 0) {
		return ['member'];
	}
	return [...dedupe];
}

export function isRoleAllowedToCreatePayment(
	policy: PaymentAccessPolicy,
	userRoles: string[] | null | undefined
): boolean {
	if (!policy.enabled) return false;
	const roles = normalizeUserRoles(userRoles);
	const isGuestOnly = roles.length === 1 && roles[0] === 'guest';
	if (isGuestOnly) {
		return policy.allowGuest;
	}
	if (!policy.allowedRoleNames.length) return false;
	const allowed = new Set(policy.allowedRoleNames.map((role) => role.toLowerCase()));
	return roles.some((role) => allowed.has(role));
}

