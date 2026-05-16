import type { PaymentDonationConfig } from '../../../../shared/adminPolicyContracts';
import { getApiBase, fetchWithTimeout, safeJsonParse } from './utils';
import type { PaymentIntent, PaymentEvent } from './paymentCheckout';

export interface PaymentDonationTotal {
	currency: string;
	amountMinor: number;
	paymentCount: number;
}

export interface PaymentDonationLedgerEntry {
	intentId: string;
	donorLabel: string;
	amountMinor: number;
	currency: string;
	status: Extract<'succeeded' | 'refunded', 'succeeded' | 'refunded'>;
	createdAt: number;
	completedAt: number | null;
	refundedAt: number | null;
	updatedAt: number;
	canRefund: boolean;
}

export interface PaymentDonationSummaryResponse {
	success: boolean;
	config: PaymentDonationConfig;
	totals: PaymentDonationTotal[];
	recentDonations: PaymentDonationLedgerEntry[];
	offlineTotals: PaymentDonationTotal[];
	recentOfflineDonations: OfflineDonationLedgerEntry[];
}

export interface PaymentDonationAuditResponse {
	success: boolean;
	count: number;
	donations: PaymentDonationLedgerEntry[];
}

export interface OfflineDonationLedgerEntry {
	settlementId: string;
	donorLabel: string;
	amountMinor: number;
	currency: string;
	description: string | null;
	status: 'recorded' | 'voided';
	createdAt: number;
	completedAt: number | null;
	voidedAt: number | null;
	updatedAt: number;
	sourceType: 'offline_manual';
	canVoid: boolean;
	recordedByLabel: string | null;
}

export interface OfflineDonationAuditResponse {
	success: boolean;
	count: number;
	donations: OfflineDonationLedgerEntry[];
}

export async function getPaymentDonationSummary(): Promise<PaymentDonationSummaryResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/donations`, { method: 'GET' });
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load donation summary');
	}
	return {
		success: Boolean(data.success),
		config: data.config as PaymentDonationConfig,
		totals: Array.isArray(data.totals) ? (data.totals as PaymentDonationTotal[]) : [],
		recentDonations: Array.isArray(data.recentDonations) ? (data.recentDonations as PaymentDonationLedgerEntry[]) : [],
		offlineTotals: Array.isArray(data.offlineTotals) ? (data.offlineTotals as PaymentDonationTotal[]) : [],
		recentOfflineDonations: Array.isArray(data.recentOfflineDonations)
			? (data.recentOfflineDonations as OfflineDonationLedgerEntry[])
			: []
	};
}

export async function getAdminPaymentDonationConfig(token: string | null | undefined): Promise<PaymentDonationConfig> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/payments/donations`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load donation config');
	}
	return data.config as PaymentDonationConfig;
}

export async function saveAdminPaymentDonationConfig(
	token: string | null | undefined,
	payload: PaymentDonationConfig
): Promise<PaymentDonationConfig> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/payments/donations`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to save donation config');
	}
	return data.config as PaymentDonationConfig;
}

export async function listAdminPaymentDonationAudit(
	token: string | null | undefined,
	limit = 100
): Promise<PaymentDonationAuditResponse> {
	const query = new URLSearchParams();
	if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
		query.set('limit', String(Math.floor(limit)));
	}
	const suffix = query.size > 0 ? `?${query.toString()}` : '';
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/payments/donations/log${suffix}`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load donation audit trail');
	}
	return {
		success: Boolean(data.success),
		count: typeof data.count === 'number' ? data.count : 0,
		donations: Array.isArray(data.donations) ? (data.donations as PaymentDonationLedgerEntry[]) : []
	};
}

export async function refundAdminPaymentDonation(
	token: string | null | undefined,
	intentId: string,
	reason?: string
): Promise<{ intent: PaymentIntent; events: PaymentEvent[] }> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/payments/donations/${encodeURIComponent(intentId)}/refund`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ reason: reason || 'Refund issued by server admin' })
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to refund donation');
	}
	return {
		intent: data.intent as PaymentIntent,
		events: Array.isArray(data.events) ? (data.events as PaymentEvent[]) : []
	};
}

export async function listAdminOfflineDonations(
	token: string | null | undefined,
	limit = 100
): Promise<OfflineDonationAuditResponse> {
	const query = new URLSearchParams();
	if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
		query.set('limit', String(Math.floor(limit)));
	}
	const suffix = query.size > 0 ? `?${query.toString()}` : '';
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/payments/donations/offline${suffix}`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load offline donations');
	}
	return {
		success: Boolean(data.success),
		count: typeof data.count === 'number' ? data.count : 0,
		donations: Array.isArray(data.donations) ? (data.donations as OfflineDonationLedgerEntry[]) : []
	};
}

export async function createAdminOfflineDonation(
	token: string | null | undefined,
	payload: { amountMinor: number; currency: string; donorLabel?: string; description?: string; metadata?: Record<string, any> }
): Promise<OfflineDonationLedgerEntry> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/admin/payments/donations/offline`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to record offline donation');
	}
	return data.donation as OfflineDonationLedgerEntry;
}

export async function voidAdminOfflineDonation(
	token: string | null | undefined,
	settlementId: string,
	reason?: string
): Promise<OfflineDonationLedgerEntry> {
	const res = await fetchWithTimeout(
		`${getApiBase()}/api/admin/payments/donations/offline/${encodeURIComponent(settlementId)}/void`,
		{
			method: 'POST',
			headers: {
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(reason ? { reason } : {})
		}
	);
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to void offline donation');
	}
	return data.donation as OfflineDonationLedgerEntry;
}
