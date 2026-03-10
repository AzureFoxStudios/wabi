import crypto from 'crypto';

const PROVIDER_NAME = 'Western Payments';
const DEFAULT_COUNTRY = 'US';
const DEFAULT_CURRENCY = 'USD';
const DEFAULT_EXPIRES_MS = 15 * 60 * 1000;
const DEFAULT_ADAPTER_TIMEOUT_MS = 10_000;

const SUPPORTED_COUNTRIES = [
	'US',
	'CA',
	'GB',
	'DE',
	'FR',
	'ES',
	'IT',
	'NL',
	'BE',
	'AT',
	'CH',
	'IE',
	'PT',
	'DK',
	'NO',
	'SE',
	'FI',
	'LU'
];

const SUPPORTED_CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP'];

function randomId(prefix) {
	return `${prefix}${crypto.randomBytes(10).toString('hex')}`;
}

function getWebhookSecret() {
	return (process.env.WEST_PAYMENTS_WEBHOOK_SECRET || 'west-payments-dev-webhook-secret').trim();
}

function getPublicBaseUrl() {
	const raw =
		process.env.WABI_PUBLIC_BASE_URL ||
		process.env.PUBLIC_URL ||
		`http://127.0.0.1:${process.env.PORT || '3000'}`;
	return raw.replace(/\/+$/, '');
}

function envFlag(value) {
	const normalized = String(value || '').trim().toLowerCase();
	return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isTestModeEnabled() {
	return envFlag(process.env.WEST_PAYMENTS_TEST_MODE);
}

function getAdapterBaseUrl() {
	return String(process.env.WEST_PAYMENTS_ADAPTER_BASE_URL || '')
		.trim()
		.replace(/\/+$/, '');
}

function getAdapterToken() {
	return String(process.env.WEST_PAYMENTS_ADAPTER_TOKEN || '').trim();
}

function getAdapterSigningSecret() {
	return String(process.env.WEST_PAYMENTS_ADAPTER_SIGNING_SECRET || '').trim();
}

function getAdapterTimeoutMs() {
	const parsed = Number(process.env.WEST_PAYMENTS_ADAPTER_TIMEOUT_MS || DEFAULT_ADAPTER_TIMEOUT_MS);
	if (!Number.isFinite(parsed) || parsed < 1000) return DEFAULT_ADAPTER_TIMEOUT_MS;
	return Math.min(60_000, Math.floor(parsed));
}

function isAdapterConfigured() {
	return Boolean(getAdapterBaseUrl());
}

function buildLocalTestCheckoutUrl(providerIntentId) {
	return `${getPublicBaseUrl()}/api/plugins/runtime/western-payments/test-checkout?providerIntentId=${encodeURIComponent(providerIntentId)}`;
}

function formatMinorAmount(amountMinor, currency) {
	const value = Number.isFinite(Number(amountMinor)) ? Number(amountMinor) / 100 : 0;
	try {
		return new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency: currency || DEFAULT_CURRENCY,
			maximumFractionDigits: 2
		}).format(value);
	} catch {
		return `${value.toFixed(2)} ${(currency || DEFAULT_CURRENCY).trim()}`.trim();
	}
}

function escapeHtml(value) {
	return String(value || '').replace(/[&<>"']/g, (char) => {
		switch (char) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			case '\'':
				return '&#39;';
			default:
				return char;
		}
	});
}

function safeJsonParse(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function extractHeaderValue(headers, key) {
	const raw = headers?.[key] ?? headers?.[key.toLowerCase()];
	if (Array.isArray(raw)) return raw[0] || '';
	if (typeof raw === 'string') return raw;
	return '';
}

function signWebhookPayload(rawBody) {
	return crypto.createHmac('sha256', getWebhookSecret()).update(rawBody).digest('hex');
}

function normalizeStatus(value) {
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

function normalizeCheckoutMode(value) {
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

function toObject(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value;
}

function normalizePresentation(value) {
	const record = toObject(value);
	if (!record) return null;
	const mode = normalizeCheckoutMode(record.mode);
	if (!mode) return null;

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

	if (mode === 'tap_to_pay') {
		const providerSessionId = String(record.providerSessionId || '').trim();
		if (!providerSessionId) return null;
		return {
			mode,
			providerSessionId,
			instructions: typeof record.instructions === 'string' ? record.instructions : undefined,
			expiresAt: Number.isFinite(Number(record.expiresAt)) ? Math.floor(Number(record.expiresAt)) : undefined
		};
	}

	return null;
}

async function getRecordByProviderIntentId(ctx, providerIntentId) {
	if (!providerIntentId) return null;
	return (await ctx.storage.get(`western-payments:intent:${providerIntentId}`)) || null;
}

async function getRecordByWabiIntentId(ctx, wabiIntentId) {
	if (!wabiIntentId) return null;
	const providerIntentId = await ctx.storage.get(`western-payments:wabi-intent:${wabiIntentId}`);
	if (!providerIntentId) return null;
	return getRecordByProviderIntentId(ctx, providerIntentId);
}

async function saveIntentRecord(ctx, record) {
	await ctx.storage.set(`western-payments:intent:${record.providerIntentId}`, record);
	if (record.wabiIntentId) {
		await ctx.storage.set(`western-payments:wabi-intent:${record.wabiIntentId}`, record.providerIntentId);
	}
	if (record.idempotencyKey) {
		await ctx.storage.set(`western-payments:idem:${record.idempotencyKey}`, record.providerIntentId);
	}
}

function createLocalTestCheckoutHtml(record) {
	const providerIntentId = escapeHtml(record.providerIntentId);
	const amountLabel = escapeHtml(formatMinorAmount(record.amountMinor, record.currency));
	const methodId = escapeHtml(record.methodId || 'card_checkout');
	const currentStatus = escapeHtml(record.status || 'pending');
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Western Payments Local Test</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      font-family: "Segoe UI", Arial, sans-serif;
      background: linear-gradient(135deg, #101624 0%, #182235 100%);
      color: #eef3ff;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      width: min(520px, 100%);
      background: rgba(14, 20, 32, 0.92);
      border: 1px solid rgba(126, 164, 255, 0.24);
      border-radius: 20px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
      padding: 24px;
    }
    h1 { margin: 0 0 8px; font-size: 1.35rem; }
    p { margin: 0 0 12px; color: #b8c6ea; line-height: 1.5; }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 10px 14px;
      margin: 20px 0;
    }
    dt { color: #8ca2d7; }
    dd { margin: 0; }
    .status {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 6px 12px;
      background: rgba(126, 164, 255, 0.18);
      border: 1px solid rgba(126, 164, 255, 0.28);
      color: #dfe8ff;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 0.75rem;
    }
    .actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-top: 18px;
    }
    button {
      border: 0;
      border-radius: 12px;
      padding: 12px 14px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      background: #2d5bff;
      color: white;
    }
    button.secondary { background: #364055; }
    .hint {
      margin-top: 16px;
      font-size: 0.9rem;
      color: #94a8d4;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Western Payments Local Test</h1>
    <p>This is a localhost-only checkout simulator. It does not move money and does not contact a PSP.</p>
    <dl>
      <dt>Intent</dt><dd><code>${providerIntentId}</code></dd>
      <dt>Amount</dt><dd>${amountLabel}</dd>
      <dt>Method</dt><dd>${methodId}</dd>
      <dt>Status</dt><dd><span class="status">${currentStatus}</span></dd>
    </dl>
    <div class="actions">
      <button type="button" onclick="setStatus('succeeded')">Simulate Success</button>
      <button type="button" class="secondary" onclick="setStatus('failed')">Simulate Failure</button>
      <button type="button" class="secondary" onclick="setStatus('canceled')">Simulate Cancel</button>
      <button type="button" class="secondary" onclick="setStatus('pending')">Reset Pending</button>
    </div>
    <p class="hint">After changing status here, go back to Wabi and refresh the payment intent.</p>
  </main>
  <script>
    async function setStatus(status) {
      const response = await fetch(window.location.pathname + window.location.search, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerIntentId: '${providerIntentId}', action: status })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        alert(payload.error || 'Failed to update local test intent');
        return;
      }
      window.location.reload();
    }
  </script>
</body>
</html>`;
}

async function callAdapter(path, payload, idempotencyKey) {
	const baseUrl = getAdapterBaseUrl();
	if (!baseUrl) {
		throw new Error('west_payments_adapter_not_configured');
	}

	const token = getAdapterToken();
	const body = JSON.stringify(payload || {});
	const headers = {
		'content-type': 'application/json',
		'x-wabi-provider': 'western-payments',
		...(token ? { authorization: `Bearer ${token}` } : {}),
		...(idempotencyKey ? { 'x-idempotency-key': String(idempotencyKey) } : {})
	};

	const signingSecret = getAdapterSigningSecret();
	if (signingSecret) {
		const timestamp = String(Date.now());
		const nonce = randomId('westnonce_');
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
			throw new Error(`west_payments_adapter_http_${response.status}:${detail}`);
		}
		if (!parsed || typeof parsed !== 'object') {
			throw new Error('west_payments_adapter_invalid_json');
		}
		return parsed;
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error('west_payments_adapter_timeout');
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchAdapterStatus(providerIntentId) {
	return callAdapter('/v1/intents/status', { providerIntentId });
}

async function createAdapterIntent(input) {
	return callAdapter('/v1/intents/create', input, input?.idempotencyKey);
}

async function createAdapterRefund(input) {
	return callAdapter('/v1/intents/refund', input, input?.idempotencyKey);
}

const plugin = {
	name: 'western-payments',

	async onLoad(ctx) {
		plugin._ctx = ctx;
		ctx.logger.info('western-payments plugin loaded', {
			provider: PROVIDER_NAME,
			adapterConfigured: isAdapterConfigured(),
			testModeEnabled: isTestModeEnabled()
		});
	},

	payment: {
		async getCapabilities() {
			const methods = [];
			const locallyTestable = isTestModeEnabled();
			if (isAdapterConfigured() || locallyTestable) {
				methods.push(
					{
						id: 'card_checkout',
						label: 'Card Checkout',
						checkoutModes: ['payment_link', 'redirect', 'app_switch'],
						countries: SUPPORTED_COUNTRIES,
						currencies: SUPPORTED_CURRENCIES,
						enabledByDefault: true,
						estimatedSharePercent: 52,
						notes: 'Standard card rails via contracted PSP.'
					},
					{
						id: 'wallet_checkout',
						label: 'Wallet Checkout',
						checkoutModes: ['payment_link', 'redirect', 'app_switch'],
						countries: SUPPORTED_COUNTRIES,
						currencies: SUPPORTED_CURRENCIES,
						enabledByDefault: true,
						estimatedSharePercent: 24,
						notes: 'Apple Pay / Google Pay / equivalent wallet support via PSP.'
					},
					{
						id: 'pay_by_bank',
						label: 'Pay by Bank (ACH/SEPA)',
						checkoutModes: ['payment_link', 'redirect'],
						countries: SUPPORTED_COUNTRIES,
						currencies: SUPPORTED_CURRENCIES,
						enabledByDefault: true,
						estimatedSharePercent: 18,
						notes: 'Bank-agnostic pay-by-bank rails (ACH/SEPA/Open Banking) via PSP.'
					},
					{
						id: 'paypal_checkout',
						label: 'PayPal',
						checkoutModes: ['payment_link', 'redirect'],
						countries: SUPPORTED_COUNTRIES,
						currencies: SUPPORTED_CURRENCIES,
						enabledByDefault: true,
						estimatedSharePercent: 6,
						notes: 'Optional PayPal checkout when enabled by PSP account configuration.'
					}
				);
			}

			return {
				pluginId: 'western-payments',
				providerName: PROVIDER_NAME,
				countries: SUPPORTED_COUNTRIES,
				currencies: SUPPORTED_CURRENCIES,
				methods,
				nonCustodialOnly: true,
				webhookSignatureRequired: true,
				supportsRefunds: true,
				supportsDisputes: true,
				notes:
					locallyTestable && !isAdapterConfigured()
						? 'Local test checkout is enabled. This is non-settling localhost simulation only.'
						: 'Configure WEST_PAYMENTS_ADAPTER_BASE_URL and WEST_PAYMENTS_ADAPTER_TOKEN to enable US/EU/CAN payment methods.'
			};
		},

		async createIntent(ctx, input) {
			plugin._ctx = ctx;
			if (!isAdapterConfigured() && !isTestModeEnabled()) {
				throw new Error('west_payments_adapter_not_configured');
			}

			const idempotencyKey = String(input.idempotencyKey || '').trim();
			if (idempotencyKey) {
				const existingProviderIntentId = await ctx.storage.get(`western-payments:idem:${idempotencyKey}`);
				if (existingProviderIntentId) {
					const existing = await getRecordByProviderIntentId(ctx, existingProviderIntentId);
					if (existing) {
						return {
							providerIntentId: existing.providerIntentId,
							status: existing.status,
							checkoutMode: existing.presentation.mode,
							presentation: existing.presentation,
							expiresAt: existing.expiresAt,
							metadata: {
								reused: true,
								providerIntentId: existing.providerIntentId
							}
						};
					}
				}
			}

			const providerIntentId = randomId('wspi_');
			const now = Date.now();
			const expiresAt = now + DEFAULT_EXPIRES_MS;
			const methodId = String(input.methodId || '').trim();

			if (!isAdapterConfigured() && isTestModeEnabled()) {
				const amountMinor = Number.isFinite(Number(input.amountMinor))
					? Math.max(0, Math.floor(Number(input.amountMinor)))
					: 0;
				const record = {
					providerIntentId,
					wabiIntentId: String(input.intentId || ''),
					idempotencyKey,
					amountMinor,
					currency: String(input.currency || DEFAULT_CURRENCY).toUpperCase(),
					countryCode: String(input.countryCode || DEFAULT_COUNTRY).toUpperCase(),
					status: 'pending',
					methodId,
					providerManaged: false,
					presentation: {
						mode: 'payment_link',
						url: buildLocalTestCheckoutUrl(providerIntentId),
						expiresAt
					},
					providerMetadata: {
						localTestMode: true
					},
					createdAt: now,
					updatedAt: now,
					expiresAt
				};

				await saveIntentRecord(ctx, record);
				return {
					providerIntentId,
					status: 'pending',
					checkoutMode: 'payment_link',
					presentation: record.presentation,
					expiresAt,
					metadata: {
						provider: PROVIDER_NAME,
						methodId,
						providerManaged: false,
						localTestMode: true
					}
				};
			}

			const adapterResponse = await createAdapterIntent({
				providerIntentId,
				intentId: input.intentId || '',
				workspaceId: input.workspaceId || '',
				channelId: input.channelId || '',
				amountMinor: Number.isFinite(Number(input.amountMinor)) ? Math.max(0, Math.floor(Number(input.amountMinor))) : 0,
				currency: String(input.currency || DEFAULT_CURRENCY).toUpperCase(),
				countryCode: String(input.countryCode || DEFAULT_COUNTRY).toUpperCase(),
				customerRef: String(input.customerRef || '').trim() || undefined,
				description: String(input.description || '').trim() || undefined,
				metadata: input.metadata || {},
				methodId,
				idempotencyKey
			});

			const adaptedProviderIntentId = String(adapterResponse.providerIntentId || providerIntentId).trim() || providerIntentId;
			const adaptedStatus = normalizeStatus(adapterResponse.status) || 'pending';
			const adaptedPresentation = normalizePresentation(adapterResponse.presentation);
			if (!adaptedPresentation) {
				throw new Error('west_payments_adapter_invalid_presentation');
			}

			const record = {
				providerIntentId: adaptedProviderIntentId,
				wabiIntentId: String(input.intentId || ''),
				idempotencyKey,
				amountMinor: Number.isFinite(Number(input.amountMinor)) ? Math.max(0, Math.floor(Number(input.amountMinor))) : 0,
				currency: String(input.currency || DEFAULT_CURRENCY).toUpperCase(),
				countryCode: String(input.countryCode || DEFAULT_COUNTRY).toUpperCase(),
				status: adaptedStatus,
				methodId,
				providerManaged: true,
				presentation: adaptedPresentation,
				providerMetadata: toObject(adapterResponse.metadata),
				createdAt: now,
				updatedAt: now,
				expiresAt: Number.isFinite(Number(adapterResponse.expiresAt))
					? Math.floor(Number(adapterResponse.expiresAt))
					: expiresAt
			};

			await saveIntentRecord(ctx, record);
			return {
				providerIntentId: adaptedProviderIntentId,
				status: adaptedStatus,
				checkoutMode: adaptedPresentation.mode,
				presentation: adaptedPresentation,
				expiresAt: record.expiresAt,
				metadata: {
					provider: PROVIDER_NAME,
					methodId,
					providerManaged: true,
					...(record.providerMetadata || {})
				}
			};
		},

		async verifyWebhook(ctx, input) {
			plugin._ctx = ctx;
			const providedSignature = extractHeaderValue(input.headers, 'x-west-payments-signature').trim();
			if (!providedSignature) {
				return { valid: false, reason: 'Missing x-west-payments-signature header' };
			}
			const expectedSignature = signWebhookPayload(input.rawBody);
			if (providedSignature !== expectedSignature) {
				return { valid: false, reason: 'Webhook signature mismatch' };
			}

			const parsed = safeJsonParse(input.rawBody);
			if (!parsed || typeof parsed !== 'object') {
				return { valid: false, reason: 'Invalid webhook JSON payload' };
			}

			const eventId = String(parsed.eventId || randomId('wsevt_')).trim();
			const providerIntentId = String(parsed.providerIntentId || '').trim();
			const intentId = String(parsed.intentId || '').trim();
			const status = normalizeStatus(parsed.status);
			const eventType = String(parsed.eventType || 'payment.status').trim();
			const occurredAt = Number(parsed.occurredAt || Date.now());

			if (!providerIntentId && !intentId) {
				return { valid: false, reason: 'Webhook must contain providerIntentId or intentId' };
			}
			if (!status) {
				return { valid: false, reason: 'Webhook status is invalid or missing' };
			}

			const record =
				(providerIntentId ? await getRecordByProviderIntentId(ctx, providerIntentId) : null) ||
				(intentId ? await getRecordByWabiIntentId(ctx, intentId) : null);
			if (record) {
				record.status = status;
				record.updatedAt = Date.now();
				await saveIntentRecord(ctx, record);
			}

			return {
				valid: true,
				event: {
					eventId,
					eventType,
					intentId: intentId || (record?.wabiIntentId || undefined),
					providerIntentId: providerIntentId || (record?.providerIntentId || undefined),
					status,
					amountMinor: record?.amountMinor,
					currency: record?.currency,
					occurredAt: Number.isFinite(occurredAt) ? Math.floor(occurredAt) : Date.now(),
					raw: parsed
				}
			};
		},

		async getIntentStatus(ctx, input) {
			plugin._ctx = ctx;
			const record =
				(input.providerIntentId ? await getRecordByProviderIntentId(ctx, input.providerIntentId) : null) ||
				(input.intentId ? await getRecordByWabiIntentId(ctx, input.intentId) : null);

			if (!record) {
				return {
					status: 'failed',
					metadata: { reason: 'intent_not_found' }
				};
			}

			if (record.status === 'pending' && Number(record.expiresAt || 0) > 0 && Date.now() > record.expiresAt) {
				record.status = 'expired';
				record.updatedAt = Date.now();
				await saveIntentRecord(ctx, record);
			}

			if (!record.providerManaged) {
				return {
					status: record.status,
					providerIntentId: record.providerIntentId,
					amountMinor: record.amountMinor,
					currency: record.currency,
					metadata: {
						methodId: record.methodId,
						expiresAt: record.expiresAt,
						localTestMode: true
					}
				};
			}

			try {
				const statusPayload = await fetchAdapterStatus(record.providerIntentId);
				const nextStatus = normalizeStatus(statusPayload.status);
				if (nextStatus) {
					record.status = nextStatus;
				}
				const nextPresentation = normalizePresentation(statusPayload.presentation);
				if (nextPresentation) {
					record.presentation = nextPresentation;
				}
				if (Number.isFinite(Number(statusPayload.expiresAt))) {
					record.expiresAt = Math.floor(Number(statusPayload.expiresAt));
				}
				record.providerMetadata = toObject(statusPayload.metadata) || record.providerMetadata || null;
				record.updatedAt = Date.now();
				await saveIntentRecord(ctx, record);
			} catch (error) {
				return {
					status: record.status || 'pending',
					providerIntentId: record.providerIntentId,
					amountMinor: record.amountMinor,
					currency: record.currency,
					metadata: {
						methodId: record.methodId,
						expiresAt: record.expiresAt,
						adapterError: error instanceof Error ? error.message : 'adapter_status_error'
					}
				};
			}

			return {
				status: record.status,
				providerIntentId: record.providerIntentId,
				amountMinor: record.amountMinor,
				currency: record.currency,
				metadata: {
					methodId: record.methodId,
					expiresAt: record.expiresAt
				}
			};
		},

		async refundIntent(ctx, input) {
			plugin._ctx = ctx;
			const record =
				(input.providerIntentId ? await getRecordByProviderIntentId(ctx, input.providerIntentId) : null) ||
				(input.intentId ? await getRecordByWabiIntentId(ctx, input.intentId) : null);
			if (!record) {
				return {
					status: 'failed',
					metadata: { reason: 'intent_not_found' }
				};
			}

			if (!record.providerManaged) {
				if (record.status !== 'succeeded' && record.status !== 'pending') {
					return {
						status: 'failed',
						metadata: {
							reason: 'test_intent_not_refundable',
							currentStatus: record.status
						}
					};
				}
				record.status = 'refunded';
				record.updatedAt = Date.now();
				await saveIntentRecord(ctx, record);
				return {
					status: 'refunded',
					providerRefundId: randomId('wsrf_'),
					metadata: {
						localTestMode: true
					}
				};
			}

			try {
				const refund = await createAdapterRefund({
					providerIntentId: record.providerIntentId,
					amountMinor: Number.isFinite(Number(input.amountMinor))
						? Math.max(0, Math.floor(Number(input.amountMinor)))
						: record.amountMinor,
					reason: String(input.reason || '').trim() || undefined,
					idempotencyKey: String(input.idempotencyKey || '').trim() || randomId('wsrefund_')
				});
				const status = normalizeStatus(refund.status);
				if (!status || (status !== 'refunded' && status !== 'pending' && status !== 'failed')) {
					return { status: 'failed', metadata: { reason: 'adapter_invalid_refund_status' } };
				}
				record.status = status;
				record.updatedAt = Date.now();
				await saveIntentRecord(ctx, record);
				return {
					status,
					providerRefundId:
						typeof refund.providerRefundId === 'string'
							? refund.providerRefundId
							: randomId('wsrf_'),
					metadata: toObject(refund.metadata) || null
				};
			} catch (error) {
				return {
					status: 'failed',
					metadata: {
						reason: 'adapter_refund_failed',
						detail: error instanceof Error ? error.message : 'unknown'
					}
				};
			}
		}
	},

	routes: [
		{
			method: 'get',
			path: '/test-checkout',
			handler: async (req, res) => {
				const ctx = plugin._ctx;
				if (!ctx) {
					res.status(503).json({ success: false, error: 'Plugin context is not ready' });
					return;
				}
				const providerIntentId = String(req.query?.providerIntentId || '').trim();
				if (!providerIntentId) {
					res.status(400).json({ success: false, error: 'providerIntentId is required' });
					return;
				}
				const record = await getRecordByProviderIntentId(ctx, providerIntentId);
				if (!record) {
					res.status(404).json({ success: false, error: 'Payment intent not found' });
					return;
				}
				res.setHeader('Content-Type', 'text/html; charset=utf-8').send(createLocalTestCheckoutHtml(record));
			}
		},
		{
			method: 'post',
			path: '/test-checkout',
			handler: async (req, res) => {
				const ctx = plugin._ctx;
				if (!ctx) {
					res.status(503).json({ success: false, error: 'Plugin context is not ready' });
					return;
				}
				const body = await req.json().catch(() => ({}));
				const providerIntentId = String(body.providerIntentId || '').trim();
				const action = String(body.action || '').trim().toLowerCase();
				const allowedStatuses = new Set(['pending', 'succeeded', 'failed', 'canceled', 'expired', 'refunded']);
				if (!providerIntentId || !allowedStatuses.has(action)) {
					res.status(400).json({ success: false, error: 'providerIntentId and a valid action are required' });
					return;
				}
				const record = await getRecordByProviderIntentId(ctx, providerIntentId);
				if (!record) {
					res.status(404).json({ success: false, error: 'Payment intent not found' });
					return;
				}
				record.status = action;
				record.updatedAt = Date.now();
				await saveIntentRecord(ctx, record);
				res.json({ success: true, status: record.status });
			}
		}
	],

	_ctx: null
};

export default plugin;
