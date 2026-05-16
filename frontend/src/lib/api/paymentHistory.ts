import type { PaymentAccountLink } from '../../../../shared/adminPolicyContracts';
import { getApiBase, fetchWithTimeout, safeJsonParse } from './utils';
import type { PaymentIntent, PaymentEvent } from './paymentCheckout';

export interface PaymentHistoryResponse {
	success: boolean;
	count: number;
	intents: PaymentIntent[];
}

export async function listPaymentAccountLinks(token: string | null | undefined): Promise<PaymentAccountLink[]> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/account-links`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load payment account links');
	}
	return Array.isArray(data.links) ? (data.links as PaymentAccountLink[]) : [];
}

export async function listPaymentHistory(
	token: string | null | undefined,
	limit = 200
): Promise<PaymentHistoryResponse> {
	const query = new URLSearchParams();
	if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
		query.set('limit', String(Math.floor(limit)));
	}
	const suffix = query.size > 0 ? `?${query.toString()}` : '';
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/history${suffix}`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load payment history');
	}
	return {
		success: Boolean(data.success),
		count: typeof data.count === 'number' ? data.count : 0,
		intents: Array.isArray(data.intents) ? (data.intents as PaymentIntent[]) : []
	};
}

export async function upsertPaymentAccountLink(
	token: string | null | undefined,
	payload: { pluginId: string; providerAccountRef: string; displayLabel?: string; metadata?: Record<string, any> }
): Promise<PaymentAccountLink> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/account-links`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to save payment account link');
	}
	return data.link as PaymentAccountLink;
}

export async function deletePaymentAccountLink(token: string | null | undefined, pluginId: string): Promise<boolean> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/account-links/${encodeURIComponent(pluginId)}`, {
		method: 'DELETE',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to clear payment account link');
	}
	return Boolean(data.cleared);
}
