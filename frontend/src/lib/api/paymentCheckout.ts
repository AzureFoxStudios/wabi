import type {
	PaymentCheckoutMode,
	PaymentIntentStatus,
	PaymentProviderCapability
} from '../../../../shared/paymentContracts';
import type { PaymentAccessPolicy } from '../../../../shared/adminPolicyContracts';
import { getApiBase, fetchWithTimeout, safeJsonParse } from './utils';

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

/**
 * v1 provider catalog. The Rust server's payment routes are PromptPay-only and
 * expose no provider-list endpoint (`/api/payments/providers` does not exist),
 * so the client advertises the built-in rail statically. When the payments
 * projection lands (roadmap Phase 1) this becomes a real GET to the server.
 */
const PROMPTPAY_PROVIDER: PaymentProviderCapability = {
	pluginId: 'promptpay',
	providerName: 'PromptPay',
	countries: ['TH'],
	currencies: ['THB'],
	methods: [
		{
			id: 'promptpay_qr',
			label: 'PromptPay QR',
			checkoutModes: ['qr'],
			countries: ['TH'],
			currencies: ['THB'],
			enabledByDefault: true,
			notes: 'Non-custodial Thai bank QR — paid straight to your PromptPay account. Confirmation is manual.'
		}
	],
	nonCustodialOnly: true,
	webhookSignatureRequired: false,
	supportsRefunds: false,
	supportsDisputes: false,
	notes: 'Built-in rail: the QR is generated locally, money moves bank-to-bank, Wabi never touches it.'
};

export const V1_PROVIDER_CATALOG: PaymentProviderCapability[] = [PROMPTPAY_PROVIDER];

/**
 * Map a stored intent (Rust `api/payments/intents.rs` shape, camelCase JSONL)
 * onto the frontend PaymentIntent contract.
 */
function mapIntent(raw: Record<string, any>): PaymentIntent {
	const qrPayload = typeof raw.promptpayQrPayload === 'string' ? raw.promptpayQrPayload : '';
	return {
		intentId: String(raw.id || ''),
		workspaceId: String(raw.workspaceId || 'default-workspace'),
		createdByUserId: typeof raw.userId === 'number' ? raw.userId : null,
		channelId: null,
		pluginId: 'promptpay',
		providerName: 'PromptPay',
		providerIntentId: null,
		amountMinor: Number(raw.amountMinor || 0),
		currency: String(raw.currency || 'THB').toUpperCase(),
		countryCode: 'TH',
		status: mapIntentStatus(String(raw.status || 'pending')),
		checkoutMode: 'qr',
		customerRef: typeof raw.promptpayProxyId === 'string' ? raw.promptpayProxyId : null,
		description: typeof raw.note === 'string' ? raw.note : null,
		metadata: null,
		presentation: qrPayload ? { mode: 'qr', qrData: qrPayload } : null,
		failureCode: null,
		failureMessage: null,
		expiresAt: null,
		completedAt: null,
		refundedAt: null,
		createdAt: Number(raw.createdAt || 0),
		updatedAt: Number(raw.updatedAt || 0)
	};
}

function mapIntentStatus(status: string): PaymentIntentStatus {
	switch (status) {
		case 'completed':
			return 'succeeded';
		case 'rejected':
			return 'failed';
		case 'expired':
			return 'expired';
		case 'pending':
		default:
			return 'pending';
	}
}

export async function listPaymentProviders(filters?: {
	countryCode?: string;
	currency?: string;
	amountMinor?: number;
}): Promise<PaymentProviderCapability[]> {
	// Static v1 catalog — see PROMPTPAY_PROVIDER comment. Filters stay advisory
	// until the server can answer them.
	void filters;
	return V1_PROVIDER_CATALOG;
}

export async function createPaymentIntent(
	token: string | null | undefined,
	payload: CreatePaymentIntentPayload
): Promise<CreatePaymentIntentResponse> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/intents`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			provider: 'promptpay',
			amountMinor: payload.amountMinor,
			currency: payload.currency,
			promptpayProxyId: payload.customerRef?.trim() || undefined,
			note: payload.description?.trim() || undefined
		})
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to create payment intent');
	}
	return {
		success: Boolean(data.success),
		reused: false,
		idempotencyKey: '',
		intent: mapIntent(data.intent || {}),
		events: []
	};
}

export async function getPaymentIntent(
	token: string | null | undefined,
	intentId: string,
	options?: { refresh?: boolean; includeEvents?: boolean; eventLimit?: number }
): Promise<{ intent: PaymentIntent; events: PaymentEvent[]; providerRefreshError?: string | null }> {
	void options;
	if (!token) throw new Error('You must be logged in to view payment status.');
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/intents`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` }
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to load payment intent');
	}
	const raw = Array.isArray(data.intents) ? data.intents.find((item) => item && item.id === intentId) : null;
	if (!raw) throw new Error('Payment intent not found');
	return { intent: mapIntent(raw), events: [], providerRefreshError: null };
}

/**
 * Admin-only: mark a pending intent as paid after checking the bank statement.
 * This is the manual-confirm half of the non-custodial handshake.
 */
export async function confirmPaymentIntent(
	token: string | null | undefined,
	intentId: string,
	options?: { actualAmountMinor?: number; referenceNote?: string }
): Promise<PaymentIntent> {
	const res = await fetchWithTimeout(
		`${getApiBase()}/api/payments/intents/${encodeURIComponent(intentId)}/confirm`,
		{
			method: 'POST',
			headers: {
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				actualAmountMinor: options?.actualAmountMinor,
				referenceNote: options?.referenceNote
			})
		}
	);
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to confirm payment intent');
	}
	return mapIntent(data.intent || {});
}

/** Admin-only: reject a pending intent (payment never arrived / wrong amount). */
export async function rejectPaymentIntent(
	token: string | null | undefined,
	intentId: string,
	referenceNote?: string
): Promise<PaymentIntent> {
	const res = await fetchWithTimeout(
		`${getApiBase()}/api/payments/intents/${encodeURIComponent(intentId)}/reject`,
		{
			method: 'POST',
			headers: {
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ referenceNote })
		}
	);
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to reject payment intent');
	}
	return mapIntent(data.intent || {});
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
		// The Rust v1 routes enforce authentication only (no policy projection
		// yet), so the actor is derived client-side from the session. The real
		// actor gate lands with the WabiDB payment projection (Phase 1).
		actor: {
			authenticated: Boolean(token),
			userId: null,
			roles: [],
			blocked: false,
			canCreate: Boolean(token),
			reasonCode: null,
			reason: null
		}
	};
}
