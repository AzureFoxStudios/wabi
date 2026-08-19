import type {
	PaymentCheckoutMode,
	PaymentIntentStatus,
	PaymentProviderCapability
} from '../../../../shared/paymentContracts';
import type { PaymentAccessPolicy } from '../../../../shared/adminPolicyContracts';
import { getApiBase, fetchWithTimeout, safeJsonParse } from './utils';
import { hasAddonCapability } from '../addonInventory';

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
 * Provider catalog (roadmap Phases 2-4). The server's payment routes expose no
 * provider-list endpoint, so the client advertises the rails statically and
 * filters them by the `/api/addons` capability list (`payments-crypto`,
 * `payments-eu`, `payments-us` — compiled in via the `payments-rails` cargo
 * feature). PromptPay is core and always advertised.
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

const CRYPTO_PROVIDER: PaymentProviderCapability = {
	pluginId: 'payments-crypto',
	providerName: 'Crypto (USDC/USDT/BTC/XMR)',
	countries: [],
	currencies: ['USDC', 'USDT', 'BTC', 'XMR'],
	methods: [
		{
			id: 'usdc_base',
			label: 'USDC on Base',
			checkoutModes: ['qr'],
			countries: [],
			currencies: ['USDC'],
			enabledByDefault: true,
			notes: 'Non-custodial wallet QR — the payer sends USDC to your wallet address on Base (chain id 8453). Confirmation is manual.'
		},
		{
			id: 'usdc_solana',
			label: 'USDC on Solana',
			checkoutModes: ['qr'],
			countries: [],
			currencies: ['USDC'],
			enabledByDefault: true,
			notes: 'Non-custodial wallet QR — the payer sends USDC to your Solana address. Confirmation is manual.'
		},
		{
			id: 'usdt_tron',
			label: 'USDT on Tron',
			checkoutModes: ['qr'],
			countries: [],
			currencies: ['USDT'],
			enabledByDefault: true,
			notes: 'Non-custodial wallet QR — the payer sends USDT (TRC-20) to your Tron address. Confirmation is manual.'
		},
		{
			id: 'btc',
			label: 'Bitcoin',
			checkoutModes: ['qr'],
			countries: [],
			currencies: ['BTC'],
			enabledByDefault: true,
			notes: 'Non-custodial wallet QR — the payer sends Bitcoin to your address. Confirmation is manual.'
		},
		{
			id: 'lightning',
			label: 'Lightning',
			checkoutModes: ['qr'],
			countries: [],
			currencies: ['BTC'],
			enabledByDefault: true,
			notes: 'Non-custodial Lightning QR — the payer sends sats to your address. Confirmation is manual.'
		},
		{
			id: 'monero',
			label: 'Monero',
			checkoutModes: ['qr'],
			countries: [],
			currencies: ['XMR'],
			enabledByDefault: true,
			notes: 'Non-custodial wallet QR — the payer sends XMR to your address. Confirmation is manual.'
		}
	],
	nonCustodialOnly: true,
	webhookSignatureRequired: false,
	supportsRefunds: false,
	supportsDisputes: false,
	notes: 'Built-in rail: wallet QR codes, money moves wallet-to-wallet, Wabi never touches it.'
};

const EU_PROVIDER: PaymentProviderCapability = {
	pluginId: 'payments-eu',
	providerName: 'SEPA Instant',
	countries: ['DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'AT', 'IE', 'PT', 'FI', 'LU'],
	currencies: ['EUR'],
	methods: [
		{
			id: 'epc_qr',
			label: 'EPC QR (SEPA Instant)',
			checkoutModes: ['qr'],
			countries: ['DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'AT', 'IE', 'PT', 'FI', 'LU'],
			currencies: ['EUR'],
			enabledByDefault: true,
			notes: 'EPC069-12 v3.1 QR — any EU banking app scans it and the money lands in seconds. Confirmation is manual.'
		}
	],
	nonCustodialOnly: true,
	webhookSignatureRequired: false,
	supportsRefunds: false,
	supportsDisputes: false,
	notes: 'Built-in rail: the QR is generated locally, money moves bank-to-bank (instant), Wabi never touches it.'
};

const US_PROVIDER: PaymentProviderCapability = {
	pluginId: 'payments-us',
	providerName: 'US Instant Apps',
	countries: ['US'],
	currencies: ['USD'],
	methods: [
		{
			id: 'cashapp_pointer',
			label: 'Cash App',
			checkoutModes: ['app_switch'],
			countries: ['US'],
			currencies: ['USD'],
			enabledByDefault: true,
			notes: 'Payer opens Cash App and sends to your $Cashtag. Confirmation is manual.'
		},
		{
			id: 'venmo_handle',
			label: 'Venmo',
			checkoutModes: ['app_switch'],
			countries: ['US'],
			currencies: ['USD'],
			enabledByDefault: true,
			notes: 'Payer opens Venmo and sends to your @handle. Confirmation is manual.'
		},
		{
			id: 'zelle_pointer',
			label: 'Zelle',
			checkoutModes: ['app_switch'],
			countries: ['US'],
			currencies: ['USD'],
			enabledByDefault: true,
			notes: 'Payer opens their banking app and sends via Zelle to your email or US mobile number. Confirmation is manual.'
		},
		{
			id: 'ach_details',
			label: 'ACH (routing/account)',
			checkoutModes: ['app_switch'],
			countries: ['US'],
			currencies: ['USD'],
			enabledByDefault: true,
			notes: 'Payer initiates a bank ACH transfer to your routing/account numbers. Confirmation is manual.'
		}
	],
	nonCustodialOnly: true,
	webhookSignatureRequired: false,
	supportsRefunds: false,
	supportsDisputes: false,
	notes: 'Built-in rail: app-to-app handles, money moves P2P, Wabi never touches it.'
};

const RAIL_PROVIDERS: Record<string, PaymentProviderCapability> = {
	'payments-crypto': CRYPTO_PROVIDER,
	'payments-eu': EU_PROVIDER,
	'payments-us': US_PROVIDER
};

export const V1_PROVIDER_CATALOG: PaymentProviderCapability[] = [PROMPTPAY_PROVIDER];

const PROVIDER_NAMES: Record<string, string> = {
	promptpay: 'PromptPay',
	'payments-crypto': 'Crypto (USDC/USDT/BTC/XMR)',
	'payments-eu': 'SEPA Instant',
	'payments-us': 'US Instant Apps'
};

function normalizeCheckoutMode(value: unknown): PaymentCheckoutMode {
	if (
		value === 'payment_link' ||
		value === 'app_switch' ||
		value === 'redirect' ||
		value === 'tap_to_pay' ||
		value === 'qr'
	) {
		return value;
	}
	return 'qr';
}

/**
 * Map a stored intent (Rust `api/payments/intents.rs` shape, camelCase JSONL)
 * onto the frontend PaymentIntent contract.
 */
export function mapIntent(raw: Record<string, any>): PaymentIntent {
	const provider = String(raw.provider || 'promptpay');
	const isPromptPay = provider === 'promptpay' || provider === 'th-payments';
	let presentation: Record<string, any> | null = null;
	const presentationJson = typeof raw.presentationJson === 'string' ? raw.presentationJson : '';
	if (presentationJson) {
		try {
			presentation = JSON.parse(presentationJson);
		} catch {
			presentation = null;
		}
	}
	const qrPayload = typeof raw.promptpayQrPayload === 'string' ? raw.promptpayQrPayload : '';
	if (!presentation && qrPayload) presentation = { mode: 'qr', qrData: qrPayload };
	const mode = normalizeCheckoutMode(presentation?.mode);
	const methodId = typeof raw.methodId === 'string' ? raw.methodId : mode === 'qr' ? 'promptpay_qr' : '';
	const countryCode = typeof raw.countryCode === 'string' ? raw.countryCode : isPromptPay ? 'TH' : null;
	return {
		intentId: String(raw.id || ''),
		workspaceId: String(raw.workspaceId || 'default-workspace'),
		createdByUserId: typeof raw.userId === 'number' ? raw.userId : null,
		channelId: null,
		pluginId: provider,
		providerName: PROVIDER_NAMES[provider] || 'Payment rail',
		providerIntentId: null,
		amountMinor: Number(raw.amountMinor || 0),
		currency: String(raw.currency || 'USD').toUpperCase(),
		countryCode,
		status: mapIntentStatus(String(raw.status || 'pending')),
		checkoutMode: mode,
		customerRef: isPromptPay
			? typeof raw.promptpayProxyId === 'string'
				? raw.promptpayProxyId
				: null
			: typeof raw.providerRef === 'string'
				? raw.providerRef
				: null,
		description: typeof raw.note === 'string' ? raw.note : null,
		metadata: {
			methodId,
			countryCode,
			providerRef: typeof raw.providerRef === 'string' ? raw.providerRef : null
		},
		presentation,
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
	// Static catalog filtered by server capability — see the catalog comment.
	// Filters stay advisory until the server can answer them.
	void filters;
	const rails = await Promise.all(
		Object.keys(RAIL_PROVIDERS).map((id) => hasAddonCapability(id).then((ok) => ({ id, ok })))
	);
	const catalog = [...V1_PROVIDER_CATALOG];
	for (const rail of rails) {
		if (rail.ok) catalog.push(RAIL_PROVIDERS[rail.id]);
	}
	return catalog;
}

export async function createPaymentIntent(
	token: string | null | undefined,
	payload: CreatePaymentIntentPayload
): Promise<CreatePaymentIntentResponse> {
	const isPromptPay = payload.pluginId === 'promptpay' || payload.pluginId === 'th-payments';
	const customerRef = payload.customerRef?.trim() || undefined;
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/intents`, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			provider: payload.pluginId,
			methodId: payload.methodId || (isPromptPay ? 'promptpay_qr' : undefined),
			countryCode: payload.countryCode || undefined,
			providerRef: isPromptPay ? undefined : customerRef,
			promptpayProxyId: isPromptPay ? customerRef : undefined,
			amountMinor: payload.amountMinor,
			currency: payload.currency,
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

export async function savePaymentAccess(
	token: string,
	policy: PaymentAccessPolicy
): Promise<PaymentAccessPolicy> {
	const res = await fetchWithTimeout(`${getApiBase()}/api/payments/access`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ policy })
	});
	const data = (await safeJsonParse(res)) as Record<string, any>;
	if (!res.ok) {
		throw new Error(data.error || 'Failed to save payment access policy');
	}
	return (data.policy || policy) as PaymentAccessPolicy;
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
		// The actor gate is derived client-side from the session; the WabiDB
		// payment projection (Phase 1) serves the persisted access policy.
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
