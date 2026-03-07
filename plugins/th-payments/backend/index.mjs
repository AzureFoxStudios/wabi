import crypto from 'crypto';

const PROVIDER_NAME = 'Thailand PromptPay';
const DEFAULT_PROMPTPAY_COUNTRY = 'TH';
const DEFAULT_PROMPTPAY_CURRENCY = 'THB';
const DEFAULT_EXPIRES_MS = 15 * 60 * 1000;

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

  // Thai mobile format: 0XXXXXXXXX -> 0066XXXXXXXXX
  if (digits.length === 10 && digits.startsWith('0')) {
    return `0066${digits.slice(1)}`;
  }

  // Thai national ID (13 digits)
  if (digits.length === 13) {
    return digits;
  }

  // E-wallet style (15 digits)
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

function renderManualPaymentPage(record) {
  const amount = (record.amountMinor / 100).toFixed(2);
  const status = record.status;
  const escapedProviderIntentId = record.providerIntentId.replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Wabi Manual Payment</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f1117; color: #f3f5fa; margin: 0; }
    main { max-width: 560px; margin: 2rem auto; padding: 1.25rem; background: #1b1f2b; border-radius: 14px; border: 1px solid #2c3244; }
    h1 { margin-top: 0; font-size: 1.25rem; }
    .meta { color: #b5bfd6; font-size: 0.95rem; margin-bottom: 1rem; }
    .status { display: inline-block; padding: 0.2rem 0.55rem; border-radius: 999px; border: 1px solid #4b5574; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .row { display: flex; gap: 0.6rem; flex-wrap: wrap; margin-top: 1rem; }
    button { border: 1px solid #4b5574; background: #22293a; color: #f3f5fa; border-radius: 10px; padding: 0.55rem 0.8rem; cursor: pointer; }
    button:hover { background: #2b3449; }
    pre { background: #101521; border: 1px solid #27304a; border-radius: 10px; padding: 0.8rem; overflow: auto; }
  </style>
</head>
<body>
  <main>
    <h1>Manual Payment Fallback</h1>
    <p class="meta">Provider intent: <code>${record.providerIntentId}</code></p>
    <p class="meta">Wabi intent: <code>${record.wabiIntentId || 'n/a'}</code></p>
    <p class="meta">Amount: <strong>${amount} ${record.currency}</strong></p>
    <p class="meta">Status: <span class="status" id="status-value">${status}</span></p>
    <div class="row">
      <button data-status="pending">Mark Pending</button>
      <button data-status="succeeded">Mark Succeeded</button>
      <button data-status="failed">Mark Failed</button>
      <button data-status="expired">Mark Expired</button>
    </div>
    <pre id="result">Ready.</pre>
  </main>
  <script>
    const providerIntentId = "${escapedProviderIntentId}";
    const resultEl = document.getElementById('result');
    const statusEl = document.getElementById('status-value');
    async function setStatus(nextStatus) {
      const response = await fetch(window.location.pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerIntentId, status: nextStatus })
      });
      const payload = await response.json().catch(() => ({}));
      resultEl.textContent = JSON.stringify(payload, null, 2);
      if (response.ok && payload && payload.record && payload.record.status) {
        statusEl.textContent = payload.record.status;
      }
    }
    document.querySelectorAll('button[data-status]').forEach((button) => {
      button.addEventListener('click', () => setStatus(button.getAttribute('data-status')));
    });
  </script>
</body>
</html>`;
}

const plugin = {
  name: 'th-payments',

  async onLoad(ctx) {
    plugin._ctx = ctx;
    ctx.logger.info('th-payments plugin loaded', {
      provider: PROVIDER_NAME,
      promptPayConfigured: Boolean(process.env.TH_PAYMENTS_PROMPTPAY_PROXY_ID)
    });
  },

  routes: [
    {
      method: 'get',
      path: '/manual-pay',
      handler: async (req, res) => {
        const ctx = requireCtx(plugin._ctx);
        const providerIntentId = String(req.query.providerIntentId || '').trim();
        if (!providerIntentId) {
          res.status(400).json({ success: false, error: 'providerIntentId is required' });
          return;
        }
        const record = await getRecordByProviderIntentId(ctx, providerIntentId);
        if (!record) {
          res.status(404).json({ success: false, error: 'Intent not found' });
          return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderManualPaymentPage(record));
      }
    },
    {
      method: 'post',
      path: '/manual-pay',
      handler: async (req, res) => {
        const ctx = requireCtx(plugin._ctx);
        const body = await req.json().catch(() => ({}));
        const providerIntentId = String(body.providerIntentId || '').trim();
        const status = normalizeStatus(body.status);

        if (!providerIntentId || !status) {
          res.status(400).json({ success: false, error: 'providerIntentId and valid status are required' });
          return;
        }

        const record = await getRecordByProviderIntentId(ctx, providerIntentId);
        if (!record) {
          res.status(404).json({ success: false, error: 'Intent not found' });
          return;
        }

        record.status = status;
        record.updatedAt = Date.now();
        await saveIntentRecord(ctx, record);
        res.status(200).json({ success: true, record });
      }
    }
  ],

  payment: {
    async getCapabilities() {
      return {
        pluginId: 'th-payments',
        providerName: PROVIDER_NAME,
        countries: ['TH'],
        currencies: ['THB'],
        methods: [
          {
            id: 'promptpay_qr',
            label: 'PromptPay QR',
            checkoutModes: ['qr', 'app_switch'],
            countries: ['TH'],
            currencies: ['THB'],
            enabledByDefault: true,
            estimatedSharePercent: 82,
            notes: 'EMVCo payload for Thai PromptPay scan flows.'
          },
          {
            id: 'manual_link',
            label: 'Manual Link (Demo)',
            checkoutModes: ['payment_link'],
            countries: ['TH'],
            currencies: ['THB'],
            enabledByDefault: true,
            estimatedSharePercent: 18,
            notes: 'Local test fallback for operator verification.'
          }
        ],
        nonCustodialOnly: true,
        webhookSignatureRequired: true,
        supportsRefunds: true,
        supportsDisputes: false,
        notes:
          'Set TH_PAYMENTS_PROMPTPAY_PROXY_ID for production QR output. Manual link mode is intended for local/test only.'
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
      } else if (methodId === 'manual_link') {
        const base = getPublicBaseUrl();
        const url = `${base}/api/plugins/runtime/th-payments/manual-pay?providerIntentId=${encodeURIComponent(providerIntentId)}&intentId=${encodeURIComponent(input.intentId || '')}`;
        checkoutMode = 'payment_link';
        presentation = {
          mode: 'payment_link',
          url,
          expiresAt
        };
      } else {
        throw new Error(`th_payments_unsupported_method:${methodId}`);
      }

      const record = {
        providerIntentId,
        wabiIntentId: String(input.intentId || ''),
        idempotencyKey,
        amountMinor: toMinorAmount(input.amountMinor),
        currency: String(input.currency || DEFAULT_PROMPTPAY_CURRENCY).toUpperCase(),
        countryCode: String(input.countryCode || DEFAULT_PROMPTPAY_COUNTRY).toUpperCase(),
        status: 'pending',
        methodId,
        presentation,
        createdAt: now,
        updatedAt: now,
        expiresAt
      };

      await saveIntentRecord(ctx, record);
      return {
        providerIntentId,
        status: 'pending',
        checkoutMode,
        presentation,
        expiresAt,
        metadata: {
          provider: PROVIDER_NAME,
          methodId
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
