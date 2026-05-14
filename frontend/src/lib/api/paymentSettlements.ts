import { getApiBase, fetchWithTimeout, safeJsonParse } from './utils';
import type { PaymentIntent, PaymentEvent } from './paymentCheckout';

export type ManualCashSettlementStatus = 'pending' | 'confirmed_by_creator' | 'confirmed_by_counterparty' | 'completed' | 'canceled' | 'disputed';

export interface ManualCashSettlement {
	settlementId: string;
	channelId: string | null;
	amountMinor: number;
	currency: string;
	description: string | null;
	status: ManualCashSettlementStatus;
	createdByUserId: number;
	counterpartyUserId: number | null;
	creatorLabel: string;
	counterpartyLabel: string;
	creatorConfirmedAt: number | null;
	counterpartyConfirmedAt: number | null;
	completedAt: number | null;
	createdAt: number;
	updatedAt: number;
	viewerRole: 'creator' | 'counterparty' | 'observer';
	canConfirm: boolean;
	canCancel: boolean;
	canDispute: boolean;
}

export interface ManualCashSettlementListResponse {
	success: boolean;
	count: number;
	items: ManualCashSettlement[];
}

async function postManualCashAction(
	token: string | null | undefined,
	settlementId: string,
	action: 'confirm' | 'cancel' | 'dispute',
	reason?: string
): Promise<ManualCashSettlement> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/manual-cash/${encodeURIComponent(settlementId)}/${action}`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(reason ? { reason } : {})
	});
	const data = (await safeJsonParse(res)) as Record<string, unknown>;
	if (!res.ok) {
		throw new Error(data.error || `Failed to ${action} manual cash trade`);
	}
	return data.settlement as ManualCashSettlement;
}

export async function listManualCashSettlements(
	token: string | null | undefined,
	channelId: string,
	limit = 100
): Promise<ManualCashSettlementListResponse> {
	const query = new URLSearchParams();
	if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
		query.set('limit', String(Math.floor(limit)));
	}
	const suffix = query.size > 0 ? `?${query.toString()}` : '';
	const res = await fetchWithTimeout(`${getApiBase()}/api/manual-cash/${encodeURIComponent(channelId)}${suffix}`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	const data = (await safeJsonParse(res)) as Record<string, unknown>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load manual cash trades');
	}
	return {
		success: Boolean(data.success),
		count: typeof data.count === 'number' ? data.count : 0,
		items: Array.isArray(data.items) ? (data.items as ManualCashSettlement[]) : []
	};
}

export async function createManualCashSettlement(
	token: string | null | undefined,
	payload: {
		channelId: string;
		amountMinor: number;
		currency: string;
		description?: string;
		metadata?: Record<string, unknown>;
	}
): Promise<ManualCashSettlement> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/manual-cash`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});
	const data = (await safeJsonParse(res)) as Record<string, unknown>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to create manual cash trade');
	}
	return data.settlement as ManualCashSettlement;
}

export async function confirmManualCashSettlement(token: string | null | undefined, settlementId: string): Promise<ManualCashSettlement> {
	return await postManualCashAction(token, settlementId, 'confirm');
}

export async function cancelManualCashSettlement(
	token: string | null | undefined,
	settlementId: string,
	reason?: string
): Promise<ManualCashSettlement> {
	return await postManualCashAction(token, settlementId, 'cancel', reason);
}

export async function disputeManualCashSettlement(
	token: string | null | undefined,
	settlementId: string,
	reason?: string
): Promise<ManualCashSettlement> {
	return await postManualCashAction(token, settlementId, 'dispute', reason);
}
