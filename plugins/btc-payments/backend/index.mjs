import crypto from 'crypto';

const PROVIDER_NAME = 'Bitcoin';
const DEFAULT_CURRENCY = 'BTC';
const DEFAULT_EXPIRES_MS = 15 * 60 * 1000;
const DEFAULT_ADAPTER_TIMEOUT_MS = 10_000;
const SATOSHIS_PER_BTC = 100_000_000;

function randomId(prefix) {
	return `${prefix}${crypto.randomBytes(10).toString('hex')}`;
}

function getWebhookSecret() {
	return (process.env.BTC_PAYMENTS_WEBHOOK_SECRET || 'btc-payments-dev-webhook-secret').trim();
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
	return envFlag(process.env.BTC_PAYMENTS_TEST_MODE);
}

function getAdapterBaseUrl() {
	return String(process.env.BTC_PAYMENTS_ADAPTER_BASE_URL || '')
		.trim()
		.replace(/\/+$/, '');
}

function getAdapterToken() {
	return String(process.env.BTC_PAYMENTS_ADAPTER_TOKEN || '').trim();
}

function getAdapterSigningSecret() {
	return String(process.env.BTC_PAYMENTS_ADAPTER_SIGNING_SECRET || '').trim();
}

function getAdapterTimeoutMs() {
	const parsed = Number(process.env.BTC_PAYMENTS_ADAPTER_TIMEOUT_MS || DEFAULT_ADAPTER_TIMEOUT_MS);
	if (!Number.isFinite(parsed) || parsed < 1000) return DEFAULT_ADAPTER_TIMEOUT_MS;
	return Math.min(60_000, Math.floor(parsed));
}

function isAdapterConfigured() {
	return Boolean(getAdapterBaseUrl());
}

function toSats(amountMinor) {
	const parsed = Number(amountMinor);
	if (!Number.isFinite(parsed)) return 0;
	return Math.max(0, Math.floor(parsed));
}

function satsToBtcString(amountMinor) {
	const sats = toSats(amountMinor);
	const whole = Math.floor(sats / SATOSHIS_PER_BTC);
	const fraction = String(sats % SATOSHIS_PER_BTC).padStart(8, '0').replace(/0+$/, '');
	return `${whole}${fraction ? `.${fraction}` : ''}`;
}

function formatSatsLabel(amountMinor) {
	return `${satsToBtcString(amountMinor)} BTC`;
}

function normalizeBitcoinAddress(raw) {
	let value = String(raw || '').trim();
	if (!value) return null;
	if (value.toLowerCase().startsWith('bitcoin:')) {
		value = value.slice('bitcoin:'.length);
	}
	const queryIndex = value.indexOf('?');
	if (queryIndex >= 0) {
		value = value.slice(0, queryIndex);
	}
	value = value.trim();
	if (!value) return null;
	if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,62}$/.test(value)) {
		return value;
	}
	if (/^(bc1|tb1|bcrt1)[ac-hj-np-z02-9]{11,87}$/i.test(value)) {
		return value.toLowerCase();
	}
	return null;
}

function buildBitcoinUri({ address, amountMinor, label, message }) {
	const normalizedAddress = normalizeBitcoinAddress(address);
	if (!normalizedAddress) {
		throw new Error('btc_payments_invalid_address');
	}
	const params = new URLSearchParams();
	const btcAmount = satsToBtcString(amountMinor);
	if (btcAmount && btcAmount !== '0') {
		params.set('amount', btcAmount);
	}
	const normalizedLabel = String(label || '').trim();
	if (normalizedLabel) {
		params.set('label', normalizedLabel.slice(0, 80));
	}
	const normalizedMessage = String(message || '').trim();
	if (normalizedMessage) {
		params.set('message', normalizedMessage.slice(0, 240));
	}
	const suffix = params.toString();
	return `bitcoin:${normalizedAddress}${suffix ? `?${suffix}` : ''}`;
}

function isServerDonationIntent(input) {
	return Boolean(input?.metadata && input.metadata.kind === 'server_donation');
}

function resolveBitcoinDestination(input) {
	const savedOrOneOffRef = String(input?.customerRef || '').trim();
	if (isServerDonationIntent(input)) {
		const serverDonationAddress = normalizeBitcoinAddress(process.env.BTC_PAYMENTS_DONATION_ADDRESS || '');
		if (!serverDonationAddress) {
			throw new Error('btc_payments_server_address_not_configured');
		}
		return {
			address: serverDonationAddress,
			source: 'server'
		};
	}

	const userAddress = normalizeBitcoinAddress(savedOrOneOffRef);
	if (!userAddress) {
		throw new Error('btc_payments_address_required');
	}
	return {
		address: userAddress,
		source: 'user'
	};
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

async function getRecordByProviderIntentId(ctx, providerIntentId) {
	if (!providerIntentId) return null;
	return (await ctx.storage.get(`btc-payments:intent:${providerIntentId}`)) || null;
}

async function getRecordByWabiIntentId(ctx, wabiIntentId) {
	if (!wabiIntentId) return null;
	const providerIntentId = await ctx.storage.get(`btc-payments:wabi-intent:${wabiIntentId}`);
	if (!providerIntentId) return null;
	return getRecordByProviderIntentId(ctx, providerIntentId);
}

async function saveIntentRecord(ctx, record) {
	await ctx.storage.set(`btc-payments:intent:${record.providerIntentId}`, record);
	if (record.wabiIntentId) {
		await ctx.storage.set(`btc-payments:wabi-intent:${record.wabiIntentId}`, record.providerIntentId);
	}
	if (record.idempotencyKey) {
		await ctx.storage.set(`btc-payments:idem:${record.idempotencyKey}`, record.providerIntentId);
	}
}

function buildLocalTestLightningUrl(providerIntentId) {
	return `${getPublicBaseUrl()}/api/plugins/runtime/btc-payments/lightning-test?providerIntentId=${encodeURIComponent(providerIntentId)}`;
}

function createLocalTestLightningHtml(record) {
	const providerIntentId = String(record.providerIntentId || '');
	const amountLabel = formatSatsLabel(record.amountMinor);
	const currentStatus = String(record.status || 'pending');
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bitcoin Lightning Local Test</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      font-family: "Segoe UI", Arial, sans-serif;
      background: linear-gradient(145deg, #120d05 0%, #211508 100%);
      color: #fff6e5;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .card {
      width: min(520px, 100%);
      background: rgba(24, 16, 7, 0.94);
      border: 1px solid rgba(255, 166, 51, 0.26);
      border-radius: 20px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
      padding: 24px;
    }
    h1 { margin: 0 0 8px; font-size: 1.35rem; }
    p { margin: 0 0 12px; color: #efc78d; line-height: 1.5; }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 10px 14px;
      margin: 20px 0;
    }
    dt { color: #e4aa5d; }
    dd { margin: 0; }
    .status {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 6px 12px;
      background: rgba(255, 166, 51, 0.18);
      border: 1px solid rgba(255, 166, 51, 0.28);
      color: #ffe0b4;
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
      background: #ff8b2d;
      color: #15110b;
    }
    button.secondary { background: #5a4938; color: #fff2df; }
    .hint {
      margin-top: 16px;
      font-size: 0.9rem;
      color: #efc78d;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Lightning Local Test</h1>
    <p>This is localhost-only Lightning simulation. It does not create a real invoice and does not move money.</p>
    <dl>
      <dt>Intent</dt><dd><code>${providerIntentId}</code></dd>
      <dt>Amount</dt><dd>${amountLabel}</dd>
      <dt>Status</dt><dd><span class="status">${currentStatus}</span></dd>
    </dl>
    <div class="actions">
      <button type="button" onclick="setStatus('succeeded')">Simulate Paid</button>
      <button type="button" class="secondary" onclick="setStatus('failed')">Simulate Failure</button>
      <button type="button" class="secondary" onclick="setStatus('canceled')">Simulate Cancel</button>
      <button type="button" class="secondary" onclick="setStatus('pending')">Reset Pending</button>
    </div>
    <p class="hint">After changing status here, go back to Wabi and refresh the request.</p>
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
        alert(payload.error || 'Failed to update local test Lightning intent');
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
		throw new Error('btc_payments_adapter_not_configured');
	}

	const token = getAdapterToken();
	const body = JSON.stringify(payload || {});
	const headers = {
		'content-type': 'application/json',
		'x-wabi-provider': 'btc-payments',
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
		return parsed;
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error('btc_payments_adapter_timeout');
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

const plugin = {
	name: 'btc-payments',

	async onLoad(ctx) {
		plugin._ctx = ctx;
		ctx.logger.info('btc-payments plugin loaded', {
			provider: PROVIDER_NAME,
			donationAddressConfigured: Boolean(normalizeBitcoinAddress(process.env.BTC_PAYMENTS_DONATION_ADDRESS || '')),
			adapterConfigured: isAdapterConfigured(),
			testModeEnabled: isTestModeEnabled()
		});
	},

	payment: {
		async getCapabilities() {
			const methods = [
				{
					id: 'bitcoin_qr',
					label: 'Bitcoin QR',
					checkoutModes: ['qr', 'app_switch'],
					currencies: [DEFAULT_CURRENCY],
					enabledByDefault: true,
					estimatedSharePercent: 100,
					notes: normalizeBitcoinAddress(process.env.BTC_PAYMENTS_DONATION_ADDRESS || '')
						? "Personal requests use the sender's saved Bitcoin address. Server donations use the server Bitcoin address."
						: "Personal requests use the sender's saved Bitcoin address. Server donations need BTC_PAYMENTS_DONATION_ADDRESS."
				}
			];

			if (isAdapterConfigured() || isTestModeEnabled()) {
				methods.push({
					id: 'lightning_checkout',
					label: 'Lightning',
					checkoutModes: ['payment_link', 'redirect', 'app_switch'],
					currencies: [DEFAULT_CURRENCY],
					enabledByDefault: true,
					estimatedSharePercent: 15,
					notes: isTestModeEnabled() && !isAdapterConfigured()
						? 'Local test mode only. This simulates Lightning settlement without moving money.'
						: 'Lightning checkout through a configured non-custodial adapter.'
				});
			}

			return {
				pluginId: 'btc-payments',
				providerName: PROVIDER_NAME,
				countries: [],
				currencies: [DEFAULT_CURRENCY],
				methods,
				nonCustodialOnly: true,
				webhookSignatureRequired: true,
				supportsRefunds: false,
				supportsDisputes: false,
				notes:
					isAdapterConfigured() || isTestModeEnabled()
						? 'Bitcoin QR uses saved addresses for personal requests. Lightning appears only when adapter or local test mode is enabled.'
						: 'Bitcoin QR uses saved addresses for personal requests. Configure BTC_PAYMENTS_ADAPTER_BASE_URL to enable Lightning.'
			};
		},

		async createIntent(ctx, input) {
			plugin._ctx = ctx;

			const idempotencyKey = String(input.idempotencyKey || '').trim();
			if (idempotencyKey) {
				const existingProviderIntentId = await ctx.storage.get(`btc-payments:idem:${idempotencyKey}`);
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

			const providerIntentId = randomId('btcpi_');
			const now = Date.now();
			const expiresAt = now + DEFAULT_EXPIRES_MS;
			const methodId = String(input.methodId || '').trim();

			if (methodId === 'bitcoin_qr') {
				const destination = resolveBitcoinDestination(input);
				const uri = buildBitcoinUri({
					address: destination.address,
					amountMinor: input.amountMinor,
					label: process.env.BTC_PAYMENTS_LABEL || 'Wabi',
					message: input.description || ''
				});
				const presentation = {
					mode: 'qr',
					qrData: uri,
					qrFormat: 'raw',
					deepLinkUrl: uri,
					expiresAt
				};
				const record = {
					providerIntentId,
					wabiIntentId: String(input.intentId || ''),
					idempotencyKey,
					amountMinor: toSats(input.amountMinor),
					currency: DEFAULT_CURRENCY,
					countryCode: null,
					status: 'pending',
					methodId,
					providerManaged: false,
					presentation,
					providerMetadata: {
						destinationSource: destination.source
					},
					createdAt: now,
					updatedAt: now,
					expiresAt
				};
				await saveIntentRecord(ctx, record);
				return {
					providerIntentId,
					status: 'pending',
					checkoutMode: 'qr',
					presentation,
					expiresAt,
					metadata: {
						provider: PROVIDER_NAME,
						methodId,
						providerManaged: false,
						cryptoAsset: 'BTC',
						network: 'bitcoin',
						destinationSource: destination.source
					}
				};
			}

			if (methodId !== 'lightning_checkout') {
				throw new Error(`btc_payments_unsupported_method:${methodId}`);
			}
			if (!isAdapterConfigured() && !isTestModeEnabled()) {
				throw new Error('btc_payments_adapter_not_configured');
			}

			if (!isAdapterConfigured() && isTestModeEnabled()) {
				const record = {
					providerIntentId,
					wabiIntentId: String(input.intentId || ''),
					idempotencyKey,
					amountMinor: toSats(input.amountMinor),
					currency: DEFAULT_CURRENCY,
					countryCode: null,
					status: 'pending',
					methodId,
					providerManaged: false,
					presentation: {
						mode: 'payment_link',
						url: buildLocalTestLightningUrl(providerIntentId),
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
						localTestMode: true,
						cryptoAsset: 'BTC',
						network: 'lightning'
					}
				};
			}

			const adapterResponse = await createAdapterIntent({
				providerIntentId,
				intentId: input.intentId || '',
				workspaceId: input.workspaceId || '',
				channelId: input.channelId || '',
				amountMinor: toSats(input.amountMinor),
				currency: DEFAULT_CURRENCY,
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
				throw new Error('btc_payments_adapter_invalid_presentation');
			}

			const record = {
				providerIntentId: adaptedProviderIntentId,
				wabiIntentId: String(input.intentId || ''),
				idempotencyKey,
				amountMinor: toSats(input.amountMinor),
				currency: DEFAULT_CURRENCY,
				countryCode: null,
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
					cryptoAsset: 'BTC',
					network: 'lightning',
					...(record.providerMetadata || {})
				}
			};
		},

		async verifyWebhook(ctx, input) {
			plugin._ctx = ctx;
			const providedSignature = extractHeaderValue(input.headers, 'x-btc-payments-signature').trim();
			if (!providedSignature) {
				return { valid: false, reason: 'Missing x-btc-payments-signature header' };
			}
			const expectedSignature = signWebhookPayload(input.rawBody);
			if (providedSignature !== expectedSignature) {
				return { valid: false, reason: 'Webhook signature mismatch' };
			}

			const parsed = safeJsonParse(input.rawBody);
			if (!parsed || typeof parsed !== 'object') {
				return { valid: false, reason: 'Invalid webhook JSON payload' };
			}

			const eventId = String(parsed.eventId || randomId('btcevt_')).trim();
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
						localTestMode: record.providerMetadata?.localTestMode === true
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

		async refundIntent() {
			return {
				status: 'failed',
				metadata: {
					reason: 'refunds_not_supported'
				}
			};
		}
	},

	routes: [
		{
			method: 'get',
			path: '/lightning-test',
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
				res.setHeader('Content-Type', 'text/html; charset=utf-8').send(createLocalTestLightningHtml(record));
			}
		},
		{
			method: 'post',
			path: '/lightning-test',
			handler: async (req, res) => {
				const ctx = plugin._ctx;
				if (!ctx) {
					res.status(503).json({ success: false, error: 'Plugin context is not ready' });
					return;
				}
				const body = await req.json().catch(() => ({}));
				const providerIntentId = String(body.providerIntentId || '').trim();
				const action = String(body.action || '').trim().toLowerCase();
				const allowedStatuses = new Set(['pending', 'succeeded', 'failed', 'canceled', 'expired']);
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
