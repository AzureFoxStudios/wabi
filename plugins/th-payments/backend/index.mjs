import crypto from 'crypto';

const PROVIDER_NAME = 'Thailand PromptPay';
const DEFAULT_PROMPTPAY_COUNTRY = 'TH';
const DEFAULT_PROMPTPAY_CURRENCY = 'THB';
const DEFAULT_EXPIRES_MS = 15 * 60 * 1000;
const DEFAULT_ADAPTER_TIMEOUT_MS = 10_000;

function randomId(prefix) {
  return `${prefix}${crypto.randomBytes(10).toString('hex')}`;
}

function getWebhookSecret() {
  return (process.env.TH_PAYMENTS_WEBHOOK_SECRET || 'th-payments-dev-webhook-secret').trim();
}

function getPublicBaseUrl() {
  const raw =
    process.env.WABI_PUBLIC_BASE_URL ||
    process.env.PUBLIC_URL ||
    `http://127.0.0.1:${process.env.PORT || '3000'}`;
  return raw.replace(/\/+$/, '');
}

function getAdapterBaseUrl() {
  return String(process.env.TH_PAYMENTS_ADAPTER_BASE_URL || '').trim().replace(/\/+$/, '');
}

function getAdapterToken() {
  return String(process.env.TH_PAYMENTS_ADAPTER_TOKEN || '').trim();
}

function getAdapterSigningSecret() {
  return String(process.env.TH_PAYMENTS_ADAPTER_SIGNING_SECRET || '').trim();
}

function getAdapterTimeoutMs() {
  const parsed = Number(process.env.TH_PAYMENTS_ADAPTER_TIMEOUT_MS || DEFAULT_ADAPTER_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed < 1000) return DEFAULT_ADAPTER_TIMEOUT_MS;
  return Math.min(60_000, Math.floor(parsed));
}

function isAdapterConfigured() {
  return Boolean(getAdapterBaseUrl());
}

function toMinorAmount(amountMinor) {
  const parsed = Number(amountMinor);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function tlv(tag, value) {
  const len = String(value.length).padStart(2, '0');
  return `${tag}${len}${value}`;
}

function normalizePromptPayProxyId(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;

  if (digits.length === 10 && digits.startsWith('0')) {
    return `0066${digits.slice(1)}`;
  }

  if (digits.length === 13) {
    return digits;
  }

  if (digits.length === 15) {
    return digits;
  }

  return null;
}

function crc16Ccitt(input) {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i += 1) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function buildPromptPayQrPayload({ proxyId, amountMinor, intentId }) {
  const normalizedProxy = normalizePromptPayProxyId(proxyId);
  if (!normalizedProxy) {
    throw new Error('th_payments_invalid_promptpay_proxy_id');
  }

  const isMobileProxy = normalizedProxy.startsWith('0066');
  const merchantInfo =
    tlv('00', 'A000000677010111') +
    tlv(isMobileProxy ? '01' : '02', normalizedProxy);

  let payload = '';
  payload += tlv('00', '01');
  payload += tlv('01', '12');
  payload += tlv('29', merchantInfo);
  payload += tlv('53', '764');

  const amount = (toMinorAmount(amountMinor) / 100).toFixed(2);
  payload += tlv('54', amount);
  payload += tlv('58', DEFAULT_PROMPTPAY_COUNTRY);
  payload += tlv('59', (process.env.TH_PAYMENTS_MERCHANT_NAME || 'WABI').slice(0, 25).toUpperCase());
  payload += tlv('60', (process.env.TH_PAYMENTS_MERCHANT_CITY || 'BANGKOK').slice(0, 15).toUpperCase());

  const reference = String(intentId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25);
  if (reference) {
    payload += tlv('62', tlv('05', reference));
  }

  const bodyForCrc = `${payload}6304`;
  const crc = crc16Ccitt(bodyForCrc);
  return `${bodyForCrc}${crc}`;
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

function requireCtx(ctx) {
  if (!ctx) {
    throw new Error('th_payments_context_not_ready');
  }
  return ctx;
}

async function getRecordByProviderIntentId(ctx, providerIntentId) {
  if (!providerIntentId) return null;
  return (await ctx.storage.get(`th-payments:intent:${providerIntentId}`)) || null;
}

async function getRecordByWabiIntentId(ctx, wabiIntentId) {
  if (!wabiIntentId) return null;
  const providerIntentId = await ctx.storage.get(`th-payments:wabi-intent:${wabiIntentId}`);
  if (!providerIntentId) return null;
  return getRecordByProviderIntentId(ctx, providerIntentId);
}

async function saveIntentRecord(ctx, record) {
  await ctx.storage.set(`th-payments:intent:${record.providerIntentId}`, record);
  if (record.wabiIntentId) {
    await ctx.storage.set(`th-payments:wabi-intent:${record.wabiIntentId}`, record.providerIntentId);
  }
  if (record.idempotencyKey) {
    await ctx.storage.set(`th-payments:idem:${record.idempotencyKey}`, record.providerIntentId);
  }
}

async function callAdapter(path, payload, idempotencyKey) {
  const baseUrl = getAdapterBaseUrl();
  if (!baseUrl) {
    throw new Error('th_payments_adapter_not_configured');
  }

  const token = getAdapterToken();
  const body = JSON.stringify(payload || {});
  const headers = {
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
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('th_payments_adapter_timeout');
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
  name: 'th-payments',

  async onLoad(ctx) {
    plugin._ctx = ctx;
    ctx.logger.info('th-payments plugin loaded', {
      provider: PROVIDER_NAME,
      promptPayConfigured: Boolean(process.env.TH_PAYMENTS_PROMPTPAY_PROXY_ID),
      adapterConfigured: isAdapterConfigured()
    });
  },

  payment: {
    async getCapabilities() {
      const methods = [];
      if (process.env.TH_PAYMENTS_PROMPTPAY_PROXY_ID) {
        methods.push({
          id: 'promptpay_qr',
          label: 'PromptPay QR',
          checkoutModes: ['qr', 'app_switch'],
          countries: ['TH'],
          currencies: ['THB'],
          enabledByDefault: true,
          estimatedSharePercent: 80,
          notes: 'EMVCo payload for Thai PromptPay scan flows.'
        });
      }

      if (isAdapterConfigured()) {
        methods.push({
          id: 'psp_checkout',
          label: 'Contracted PSP Checkout',
          checkoutModes: ['payment_link', 'redirect', 'app_switch'],
          countries: ['TH'],
          currencies: ['THB'],
          enabledByDefault: true,
          estimatedSharePercent: 20,
          notes: 'Hosted checkout from contracted processor adapter.'
        });
      }

      return {
        pluginId: 'th-payments',
        providerName: PROVIDER_NAME,
        countries: ['TH'],
        currencies: ['THB'],
        methods,
        nonCustodialOnly: true,
        webhookSignatureRequired: true,
        supportsRefunds: true,
        supportsDisputes: true,
        notes:
          'Configure PromptPay proxy for QR and TH_PAYMENTS_ADAPTER_BASE_URL for contracted PSP checkout/refunds.'
      };
    },

    async createIntent(ctx, input) {
      plugin._ctx = ctx;

      const idempotencyKey = String(input.idempotencyKey || '').trim();
      if (idempotencyKey) {
        const existingProviderIntentId = await ctx.storage.get(`th-payments:idem:${idempotencyKey}`);
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

      const providerIntentId = randomId('thpi_');
      const now = Date.now();
      const expiresAt = now + DEFAULT_EXPIRES_MS;
      const methodId = String(input.methodId || '').trim();
      let presentation;
      let checkoutMode = 'payment_link';
      let status = 'pending';
      let providerManaged = false;
      let providerMetadata = null;

      if (methodId === 'promptpay_qr') {
        const promptPayProxyId = process.env.TH_PAYMENTS_PROMPTPAY_PROXY_ID || '';
        const qrData = buildPromptPayQrPayload({
          proxyId: promptPayProxyId,
          amountMinor: input.amountMinor,
          intentId: input.intentId || providerIntentId
        });
        checkoutMode = 'qr';
        presentation = {
          mode: 'qr',
          qrData,
          qrFormat: 'emvco',
          deepLinkUrl: `promptpay://pay?amount=${(toMinorAmount(input.amountMinor) / 100).toFixed(2)}`,
          expiresAt
        };
      } else if (methodId === 'psp_checkout') {
        const adapterResponse = await createAdapterIntent({
          providerIntentId,
          intentId: input.intentId || '',
          workspaceId: input.workspaceId || '',
          channelId: input.channelId || '',
          amountMinor: toMinorAmount(input.amountMinor),
          currency: String(input.currency || DEFAULT_PROMPTPAY_CURRENCY).toUpperCase(),
          countryCode: String(input.countryCode || DEFAULT_PROMPTPAY_COUNTRY).toUpperCase(),
          customerRef: String(input.customerRef || '').trim() || undefined,
          description: String(input.description || '').trim() || undefined,
          metadata: input.metadata || {},
          idempotencyKey
        });

        const adaptedProviderIntentId = String(adapterResponse.providerIntentId || providerIntentId).trim();
        const adaptedStatus = normalizeStatus(adapterResponse.status) || 'pending';
        const adaptedPresentation = normalizePresentation(adapterResponse.presentation);
        if (!adaptedPresentation) {
          throw new Error('th_payments_adapter_invalid_presentation');
        }

        providerManaged = true;
        status = adaptedStatus;
        checkoutMode = adaptedPresentation.mode;
        presentation = adaptedPresentation;
        providerMetadata = toObject(adapterResponse.metadata);

        if (adaptedProviderIntentId && adaptedProviderIntentId !== providerIntentId) {
          await ctx.storage.set(`th-payments:provider-map:${providerIntentId}`, adaptedProviderIntentId);
        }
      } else {
        throw new Error(`th_payments_unsupported_method:${methodId}`);
      }

      const mappedProviderIntentId = (await ctx.storage.get(`th-payments:provider-map:${providerIntentId}`)) || providerIntentId;
      const record = {
        providerIntentId: mappedProviderIntentId,
        wabiIntentId: String(input.intentId || ''),
        idempotencyKey,
        amountMinor: toMinorAmount(input.amountMinor),
        currency: String(input.currency || DEFAULT_PROMPTPAY_CURRENCY).toUpperCase(),
        countryCode: String(input.countryCode || DEFAULT_PROMPTPAY_COUNTRY).toUpperCase(),
        status,
        methodId,
        providerManaged,
        presentation,
        providerMetadata,
        createdAt: now,
        updatedAt: now,
        expiresAt
      };

      await saveIntentRecord(ctx, record);
      return {
        providerIntentId: mappedProviderIntentId,
        status,
        checkoutMode,
        presentation,
        expiresAt,
        metadata: {
          provider: PROVIDER_NAME,
          methodId,
          providerManaged,
          ...(providerMetadata || {})
        }
      };
    },

    async verifyWebhook(ctx, input) {
      plugin._ctx = ctx;
      const providedSignature = extractHeaderValue(input.headers, 'x-th-payments-signature').trim();
      if (!providedSignature) {
        return { valid: false, reason: 'Missing x-th-payments-signature header' };
      }
      const expectedSignature = signWebhookPayload(input.rawBody);
      if (providedSignature !== expectedSignature) {
        return { valid: false, reason: 'Webhook signature mismatch' };
      }

      const parsed = safeJsonParse(input.rawBody);
      if (!parsed || typeof parsed !== 'object') {
        return { valid: false, reason: 'Invalid webhook JSON payload' };
      }

      const eventId = String(parsed.eventId || randomId('thevt_')).trim();
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

      if (record.providerManaged) {
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

      if (record.providerManaged) {
        try {
          const refund = await createAdapterRefund({
            providerIntentId: record.providerIntentId,
            amountMinor: Number.isFinite(Number(input.amountMinor)) ? Math.floor(Number(input.amountMinor)) : record.amountMinor,
            reason: String(input.reason || '').trim() || undefined,
            idempotencyKey: String(input.idempotencyKey || '').trim() || randomId('threfund_')
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
            providerRefundId: typeof refund.providerRefundId === 'string' ? refund.providerRefundId : randomId('thrf_'),
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

      if (record.status !== 'succeeded' && record.status !== 'pending') {
        return {
          status: 'failed',
          metadata: { reason: `cannot_refund_status_${record.status}` }
        };
      }

      record.status = 'refunded';
      record.updatedAt = Date.now();
      await saveIntentRecord(ctx, record);

      return {
        status: 'refunded',
        providerRefundId: randomId('thrf_'),
        metadata: {
          providerIntentId: record.providerIntentId,
          refundedAt: record.updatedAt
        }
      };
    }
  },

  _ctx: null
};

export default plugin;
