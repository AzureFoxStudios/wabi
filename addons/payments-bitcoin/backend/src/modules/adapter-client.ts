import crypto from 'crypto';

const DEFAULT_ADAPTER_TIMEOUT_MS = 10_000;

function randomId(prefix: string): string {
	return `${prefix}${crypto.randomBytes(10).toString('hex')}`;
}

function getAdapterBaseUrl(): string {
	return String(process.env.BTC_PAYMENTS_ADAPTER_BASE_URL || '')
		.trim()
		.replace(/\/+$/, '');
}

export function isAdapterConfigured(): boolean {
	return Boolean(getAdapterBaseUrl());
}

function getAdapterToken(): string {
	return String(process.env.BTC_PAYMENTS_ADAPTER_TOKEN || '').trim();
}

function getAdapterSigningSecret(): string {
	return String(process.env.BTC_PAYMENTS_ADAPTER_SIGNING_SECRET || '').trim();
}

function getAdapterTimeoutMs(): number {
	const parsed = Number(process.env.BTC_PAYMENTS_ADAPTER_TIMEOUT_MS || DEFAULT_ADAPTER_TIMEOUT_MS);
	if (!Number.isFinite(parsed) || parsed < 1000) return DEFAULT_ADAPTER_TIMEOUT_MS;
	return Math.min(60_000, Math.floor(parsed));
}

function safeJsonParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

export interface AdapterRequest {
	providerIntentId: string;
	intentId?: string;
	workspaceId?: string;
	channelId?: string;
	amountMinor: number;
	currency: string;
	customerRef?: string;
	description?: string;
	metadata?: Record<string, unknown>;
	methodId?: string;
	idempotencyKey?: string;
}

export interface AdapterResponse {
	providerIntentId?: string;
	status?: string;
	presentation?: unknown;
	expiresAt?: number;
	metadata?: unknown;
}

async function callAdapter(path: string, payload: AdapterRequest, idempotencyKey?: string): Promise<AdapterResponse> {
	const baseUrl = getAdapterBaseUrl();
	if (!baseUrl) {
		throw new Error('btc_payments_adapter_not_configured');
	}

	const token = getAdapterToken();
	const body = JSON.stringify(payload || {});
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'x-wabi-provider': 'payments-bitcoin',
		...(token ? { authorization: `Bearer ${token}` } : {}),
		...(idempotencyKey ? { 'x-idempotency-key': String(idempotencyKey) } : {})
	};

	const signingSecret = getAdapterSigningSecret();
	if (signingSecret) {
		const timestamp = String(Date.now());
		const nonce = randomId('btcnonce_');
		const signatureBase = `${timestamp}.${nonce}.${body}`;
		const signature = crypto.createHmac('sha256', signingSecret).update(signatureBase).digest('hex');
		headers['x-wabi-adapter-timestamp'] = timestamp;
		headers['x-wabi-adapter-nonce'] = nonce;
		headers['x-wabi-adapter-signature'] = signature;
	}

	const timeoutMs = getAdapterTimeoutMs();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(`${baseUrl}${path}`, {
			method: 'POST',
			headers,
			body,
			signal: controller.signal
		});
		const text = await response.text();
		const parsed = safeJsonParse(text);
		if (!response.ok) {
			const detail = parsed && typeof parsed.error === 'string' ? parsed.error : `${response.status}`;
			throw new Error(`btc_payments_adapter_http_${response.status}:${detail}`);
		}
		if (!parsed || typeof parsed !== 'object') {
			throw new Error('btc_payments_adapter_invalid_json');
		}
		return parsed as AdapterResponse;
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error('btc_payments_adapter_timeout');
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export async function fetchAdapterStatus(providerIntentId: string): Promise<AdapterResponse> {
	return callAdapter('/v1/intents/status', { providerIntentId, amountMinor: 0, currency: 'BTC' });
}

export async function createAdapterIntent(input: AdapterRequest): Promise<AdapterResponse> {
	return callAdapter('/v1/intents/create', input, input?.idempotencyKey);
}

export function normalizeStatus(value?: string): string | null {
	const normalized = String(value || '').trim().toLowerCase();
	if (
		normalized === 'draft' ||
		normalized === 'pending' ||
		normalized === 'succeeded' ||
		normalized === 'failed' ||
		normalized === 'expired' ||
		normalized === 'refunded' ||
		normalized === 'disputed' ||
		normalized === 'canceled'
	) {
		return normalized;
	}
	return null;
}

export function normalizeCheckoutMode(value?: string): string | null {
	const normalized = String(value || '').trim().toLowerCase();
	if (
		normalized === 'qr' ||
		normalized === 'payment_link' ||
		normalized === 'redirect' ||
		normalized === 'app_switch' ||
		normalized === 'tap_to_pay'
	) {
		return normalized;
	}
	return null;
}

interface PresentationRecord {
	mode?: string;
	qrData?: string;
	qrFormat?: string;
	qrImageUrl?: string;
	deepLinkUrl?: string;
	url?: string;
	fallbackUrl?: string;
	universalLinkUrl?: string;
	packageName?: string;
	expiresAt?: number;
}

function toObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

export function normalizePresentation(value: unknown): PresentationRecord | null {
	const record = toObject(value);
	if (!record) return null;
	const mode = normalizeCheckoutMode(record.mode);
	if (!mode) return null;

	if (mode === 'qr') {
		const qrData = String(record.qrData || '').trim();
		if (!qrData) return null;
		return {
			mode,
			qrData,
			qrFormat: typeof record.qrFormat === 'string' ? record.qrFormat : undefined,
			qrImageUrl: typeof record.qrImageUrl === 'string' ? record.qrImageUrl : undefined,
			deepLinkUrl: typeof record.deepLinkUrl === 'string' ? record.deepLinkUrl : undefined,
			expiresAt: Number.isFinite(Number(record.expiresAt)) ? Math.floor(Number(record.expiresAt)) : undefined
		};
	}

	if (mode === 'payment_link' || mode === 'redirect') {
		const url = String(record.url || '').trim();
		if (!url) return null;
		return {
			mode,
			url,
			expiresAt: Number.isFinite(Number(record.expiresAt)) ? Math.floor(Number(record.expiresAt)) : undefined
		};
	}

	if (mode === 'app_switch') {
		const deepLinkUrl = String(record.deepLinkUrl || '').trim();
		if (!deepLinkUrl) return null;
		return {
			mode,
			deepLinkUrl,
			fallbackUrl: typeof record.fallbackUrl === 'string' ? record.fallbackUrl : undefined,
			universalLinkUrl: typeof record.universalLinkUrl === 'string' ? record.universalLinkUrl : undefined,
			packageName: typeof record.packageName === 'string' ? record.packageName : undefined,
			expiresAt: Number.isFinite(Number(record.expiresAt)) ? Math.floor(Number(record.expiresAt)) : undefined
		};
	}

	return null;
}