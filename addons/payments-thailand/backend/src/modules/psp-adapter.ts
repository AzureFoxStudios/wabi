import crypto from 'crypto';

const DEFAULT_ADAPTER_TIMEOUT_MS = 10_000;

function randomId(prefix: string): string {
	return `${prefix}${crypto.randomBytes(10).toString('hex')}`;
}

function getAdapterBaseUrl(): string {
	return String(process.env.TH_PAYMENTS_ADAPTER_BASE_URL || '').trim().replace(/\/+$/, '');
}

function getAdapterToken(): string {
	return String(process.env.TH_PAYMENTS_ADAPTER_TOKEN || '').trim();
}

function getAdapterSigningSecret(): string {
	return String(process.env.TH_PAYMENTS_ADAPTER_SIGNING_SECRET || '').trim();
}

function getAdapterTimeoutMs(): number {
	const parsed = Number(process.env.TH_PAYMENTS_ADAPTER_TIMEOUT_MS || DEFAULT_ADAPTER_TIMEOUT_MS);
	if (!Number.isFinite(parsed) || parsed < 1000) return DEFAULT_ADAPTER_TIMEOUT_MS;
	return Math.min(60_000, Math.floor(parsed));
}

export function isAdapterConfigured(): boolean {
	return Boolean(getAdapterBaseUrl());
}

function safeJsonParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function callAdapter(path: string, payload: unknown, idempotencyKey?: string): Promise<Record<string, unknown>> {
	const baseUrl = getAdapterBaseUrl();
	if (!baseUrl) {
		throw new Error('th_payments_adapter_not_configured');
	}

	const token = getAdapterToken();
	const body = JSON.stringify(payload || {});
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'x-wabi-provider': 'th-payments',
		...(token ? { authorization: `Bearer ${token}` } : {}),
		...(idempotencyKey ? { 'x-idempotency-key': String(idempotencyKey) } : {})
	};

	const signingSecret = getAdapterSigningSecret();
	if (signingSecret) {
		const timestamp = String(Date.now());
		const nonce = randomId('thnonce_');
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
			throw new Error(`th_payments_adapter_http_${response.status}:${detail}`);
		}
		if (!parsed || typeof parsed !== 'object') {
			throw new Error('th_payments_adapter_invalid_json');
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error('th_payments_adapter_timeout');
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export async function fetchAdapterStatus(providerIntentId: string): Promise<Record<string, unknown>> {
	return callAdapter('/v1/intents/status', { providerIntentId }) as Promise<Record<string, unknown>>;
}

export async function createAdapterIntent(input: Record<string, unknown>): Promise<Record<string, unknown>> {
	return callAdapter('/v1/intents/create', input, input?.idempotencyKey as string | undefined) as Promise<Record<string, unknown>>;
}

export async function createAdapterRefund(input: Record<string, unknown>): Promise<Record<string, unknown>> {
	return callAdapter('/v1/intents/refund', input, input?.idempotencyKey as string | undefined) as Promise<Record<string, unknown>>;
}