import type {
	PaymentCheckoutMode,
	PaymentIntentStatus,
	PaymentProviderCapability
} from '../../../../shared/paymentContracts';
import type { PaymentAccessPolicy } from '../../../../shared/adminPolicyContracts';
import { getApiBase, fetchWithTimeout, safeJsonParse, toQueryParam } from './utils';

export interface PaymentIntent {
	intentId: string;
	workspaceId: string;
	createdByUserId: number | null;
	channelId: string | null;
	pluginId: string;
	providerName: string;
	providerIntentId: string | null;
	amountMinor: number;
	currency: string;
	countryCode: string | null;
	status: PaymentIntentStatus;
	checkoutMode: PaymentCheckoutMode;
	customerRef: string | null;
	description: string | null;
	metadata: Record<string, any> | null;
	presentation: Record<string, any> | null;
	failureCode: string | null;
	failureMessage: string | null;
	expiresAt: number | null;
	completedAt: number | null;
	refundedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface PaymentEvent {
	eventId: string;
	eventType: string;
	status: PaymentIntentStatus | null;
	source: 'core' | 'plugin' | 'webhook' | 'manual';
	payload: Record<string, any> | null;
	signatureValid: boolean | null;
	idempotencyKey: string | null;
	createdAt: number;
}

export interface PaymentAccessActorStatus {
	authenticated: boolean;
	userId: number | null;
	roles: string[];
	blocked: boolean;
	canCreate: boolean;
	reasonCode: string | null;
	reason: string | null;
}

export interface PaymentAccessStatusResponse {
	success: boolean;
	policy: PaymentAccessPolicy;
	actor: PaymentAccessActorStatus;
}

export interface CreatePaymentIntentPayload {
	pluginId: string;
	methodId: string;
	amountMinor: number;
	currency: string;
	countryCode?: string;
	channelId?: string;
	description?: string;
	customerRef?: string;
	idempotencyKey?: string;
	metadata?: Record<string, any>;
}

export interface CreatePaymentIntentResponse {
	success: boolean;
	reused: boolean;
	idempotencyKey: string;
	intent: PaymentIntent;
	events: PaymentEvent[];
}

export async function listPaymentProviders(filters?: {
	countryCode?: string;
	currency?: string;
	amountMinor?: number;
}): Promise<PaymentProviderCapability[]> {
	const query = new URLSearchParams();
	if (filters?.countryCode) query.set('country', filters.countryCode);
	if (filters?.currency) query.set('currency', filters.currency);
	const amountParam = toQueryParam(filters?.amountMinor);
	if (amountParam) query.set('amountMinor', amountParam);

	const suffix = query.size > 0 ? `?${query.toString()}` : '';
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/providers${suffix}`, { method: 'GET' });
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error((data.error as string) || 'Failed to list payment providers');
	}
	return Array.isArray(data.providers) ? (data.providers as PaymentProviderCapability[]) : [];
}

export async function createPaymentIntent(
	token: string | null | undefined,
	payload: CreatePaymentIntentPayload
): Promise<CreatePaymentIntentResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/create`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to create payment intent');
	}
	return {
		success: Boolean(data.success),
		reused: Boolean(data.reused),
		idempotencyKey: typeof data.idempotencyKey === 'string' ? data.idempotencyKey : '',
		intent: data.intent as PaymentIntent,
		events: Array.isArray(data.events) ? (data.events as PaymentEvent[]) : []
	};
}

export async function getPaymentIntent(
	token: string | null | undefined,
	intentId: string,
	options?: { refresh?: boolean; includeEvents?: boolean; eventLimit?: number }
): Promise<{ intent: PaymentIntent; events: PaymentEvent[]; providerRefreshError?: string | null }> {
	const query = new URLSearchParams();
	if (options?.refresh) query.set('refresh', 'true');
	if (options?.includeEvents === false) query.set('includeEvents', 'false');
	if (typeof options?.eventLimit === 'number' && Number.isFinite(options.eventLimit) && options.eventLimit > 0) {
		query.set('eventLimit', String(Math.floor(options.eventLimit)));
	}
	const suffix = query.size > 0 ? `?${query.toString()}` : '';
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/${encodeURIComponent(intentId)}${suffix}`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load payment intent');
	}
	return {
		intent: data.intent as PaymentIntent,
		events: Array.isArray(data.events) ? (data.events as PaymentEvent[]) : [],
		providerRefreshError:
			typeof data.providerRefreshError === 'string' || data.providerRefreshError === null
				? data.providerRefreshError
				: undefined
	};
}

export async function cancelPaymentIntent(
	token: string | null | undefined,
	intentId: string,
	reason?: string
): Promise<{ intent: PaymentIntent; events: PaymentEvent[] }> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/${encodeURIComponent(intentId)}/cancel`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ reason: reason || 'Canceled by user' })
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to cancel payment intent');
	}
	return {
		intent: data.intent as PaymentIntent,
		events: Array.isArray(data.events) ? (data.events as PaymentEvent[]) : []
	};
}

export async function getPaymentAccess(token: string | null | undefined): Promise<PaymentAccessStatusResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/access`, {
		method: 'GET',
		headers: token ? { Authorization: `Bearer ${token}` } : undefined
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load payment access status');
	}
	return {
		success: Boolean(data.success),
		policy: (data.policy || {
			enabled: false,
			allowGuest: false,
			allowedRoleNames: ['owner', 'admin', 'mod', 'member']
		}) as PaymentAccessPolicy,
		actor: (data.actor || {
			authenticated: false,
			userId: null,
			roles: ['guest'],
			blocked: false,
			canCreate: false,
			reasonCode: 'unknown',
			reason: 'Unavailable'
		}) as PaymentAccessActorStatus
	};
}
