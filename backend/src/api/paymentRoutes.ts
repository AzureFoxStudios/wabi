import { randomBytes } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { getAuthenticatedUserIdFromRequest } from '../auth/requestAuth.js';
import { getUserRoles } from '../auth/roleMiddleware.js';
import { DEFAULT_WORKSPACE_ID, MODERATOR_ROLES } from '../constants.js';
import {
  paymentRepository,
  type PaymentEventRow,
  type PaymentIntentStatus as RepositoryPaymentIntentStatus,
  type PaymentIntentView
} from '../db/repositories/paymentRepository.js';
import type { PluginLoader } from '../plugins/loader.js';
import type { PaymentCreateIntentInput, PaymentMethodCapability, PaymentPluginCapabilities } from '../plugins/types.js';

const MAX_PAYMENT_BODY_BYTES = Math.max(
  1024,
  Math.min(2 * 1024 * 1024, Number(process.env.PAYMENT_MAX_BODY_BYTES || 256 * 1024))
);

const TERMINAL_STATUSES = new Set<RepositoryPaymentIntentStatus>([
  'succeeded',
  'failed',
  'expired',
  'refunded',
  'disputed',
  'canceled'
]);

const KNOWN_STATUSES = new Set<RepositoryPaymentIntentStatus>([
  'draft',
  'pending',
  'succeeded',
  'failed',
  'expired',
  'refunded',
  'disputed',
  'canceled'
]);

function writeJson(res: ServerResponse, status: number, payload: Record<string, any>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function isPayloadTooLargeError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('payload_too_large:');
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof Error && error.message === 'invalid_json';
}

function isPluginNotLoadedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('payment_plugin_not_loaded:');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toUpperCode(value: unknown, expectedLen: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (normalized.length !== expectedLen || !/^[A-Z]+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function clampPositiveInteger(value: unknown, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.floor(parsed);
  if (rounded <= 0 || rounded > max) return null;
  return rounded;
}

function normalizeOptionalString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLen);
}

function normalizeIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (!key) return null;
  if (key.length < 8 || key.length > 180) {
    return null;
  }
  if (!/^[A-Za-z0-9:_\-./]+$/.test(key)) {
    return null;
  }
  return key;
}

function normalizeMetadata(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return value;
}

function isKnownPaymentStatus(value: unknown): value is RepositoryPaymentIntentStatus {
  return typeof value === 'string' && KNOWN_STATUSES.has(value as RepositoryPaymentIntentStatus);
}

function toIntentResponse(intent: PaymentIntentView): Record<string, unknown> {
  return {
    intentId: intent.intent_id,
    workspaceId: intent.workspace_id,
    createdByUserId: intent.created_by_user_id,
    channelId: intent.channel_id,
    pluginId: intent.plugin_id,
    providerName: intent.provider_name,
    providerIntentId: intent.provider_intent_id,
    amountMinor: intent.amount_minor,
    currency: intent.currency,
    countryCode: intent.country_code,
    status: intent.status,
    checkoutMode: intent.checkout_mode,
    customerRef: intent.customer_ref,
    description: intent.description,
    metadata: intent.metadata,
    presentation: intent.presentation,
    failureCode: intent.failure_code,
    failureMessage: intent.failure_message,
    expiresAt: intent.expires_at,
    completedAt: intent.completed_at,
    refundedAt: intent.refunded_at,
    createdAt: intent.created_at,
    updatedAt: intent.updated_at
  };
}

function toEventResponse(event: PaymentEventRow): Record<string, unknown> {
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(event.payload_json);
    payload = isRecord(parsed) ? parsed : null;
  } catch {
    payload = null;
  }

  return {
    eventId: event.event_id,
    eventType: event.event_type,
    status: event.status,
    source: event.source,
    payload,
    signatureValid: event.signature_valid == null ? null : event.signature_valid === 1,
    idempotencyKey: event.idempotency_key,
    createdAt: event.created_at
  };
}

function isPaymentModerator(userId: number): boolean {
  const roles = getUserRoles(userId, DEFAULT_WORKSPACE_ID);
  return roles.some((role) => MODERATOR_ROLES.includes(role as any));
}

function canAccessIntent(userId: number, intent: PaymentIntentView): boolean {
  if (intent.created_by_user_id === userId) return true;
  return isPaymentModerator(userId);
}

function isMethodEligible(
  method: PaymentMethodCapability,
  amountMinor: number,
  currency: string,
  countryCode: string | null
): boolean {
  if (typeof method.minAmountMinor === 'number' && amountMinor < method.minAmountMinor) {
    return false;
  }
  if (typeof method.maxAmountMinor === 'number' && amountMinor > method.maxAmountMinor) {
    return false;
  }
  if (Array.isArray(method.currencies) && method.currencies.length > 0) {
    const normalized = method.currencies.map((item) => item.toUpperCase());
    if (!normalized.includes(currency)) {
      return false;
    }
  }
  if (countryCode && Array.isArray(method.countries) && method.countries.length > 0) {
    const normalized = method.countries.map((item) => item.toUpperCase());
    if (!normalized.includes(countryCode)) {
      return false;
    }
  }
  return true;
}

function parseBooleanQueryValue(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function buildWebhookQuery(searchParams: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  const seen = new Set<string>();
  for (const [key] of searchParams.entries()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const values = searchParams.getAll(key);
    query[key] = values.length <= 1 ? (values[0] ?? '') : values;
  }
  return query;
}

async function readRequestBuffer(req: IncomingMessage, maxBytes: number = MAX_PAYMENT_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        settled = true;
        reject(new Error(`payload_too_large:${maxBytes}`));
        return;
      }
      chunks.push(buffer);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks));
    });

    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buffer = await readRequestBuffer(req);
  if (buffer.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    if (!isRecord(parsed)) {
      throw new Error('invalid_json');
    }
    return parsed;
  } catch {
    throw new Error('invalid_json');
  }
}

export async function handleListPaymentProviders(
  _req: IncomingMessage,
  res: ServerResponse,
  pluginLoader: PluginLoader,
  url: URL
): Promise<void> {
  try {
    const countryCode = toUpperCode(url.searchParams.get('country'), 2);
    const currency = toUpperCode(url.searchParams.get('currency'), 3);
    const amountMinor = clampPositiveInteger(url.searchParams.get('amountMinor'), 10_000_000_000);
    const providers = await pluginLoader.listPaymentCapabilities();

    const filtered = providers
      .map((provider) => {
        if (!currency && !countryCode && amountMinor == null) {
          return provider;
        }

        const methods = provider.methods.filter((method) =>
          isMethodEligible(
            method,
            amountMinor ?? (typeof method.minAmountMinor === 'number' ? method.minAmountMinor : 1),
            currency ?? (method.currencies?.[0]?.toUpperCase() || 'USD'),
            countryCode
          )
        );
        return { ...provider, methods };
      })
      .filter((provider) => provider.methods.length > 0);

    writeJson(res, 200, {
      success: true,
      providers: filtered
    });
  } catch (error) {
    console.error('[Payments] Failed to list providers:', error);
    writeJson(res, 500, { success: false, error: 'Failed to list payment providers' });
  }
}

export async function handleCreatePaymentIntent(
  req: IncomingMessage,
  res: ServerResponse,
  pluginLoader: PluginLoader
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch (error) {
    if (isPayloadTooLargeError(error)) {
      writeJson(res, 413, { success: false, error: 'Payload too large' });
      return;
    }
    if (isJsonParseError(error)) {
      writeJson(res, 400, { success: false, error: 'Invalid JSON' });
      return;
    }
    writeJson(res, 400, { success: false, error: 'Invalid request payload' });
    return;
  }

  const pluginId = normalizeOptionalString(body.pluginId, 96);
  const methodId = normalizeOptionalString(body.methodId, 96);
  const currency = toUpperCode(body.currency, 3);
  const countryCode = body.countryCode == null ? null : toUpperCode(body.countryCode, 2);
  const amountMinor = clampPositiveInteger(body.amountMinor, 10_000_000_000);
  const workspaceId = normalizeOptionalString(body.workspaceId, 120) || DEFAULT_WORKSPACE_ID;
  const channelId = normalizeOptionalString(body.channelId, 120);
  const description = normalizeOptionalString(body.description, 480);
  const customerRef = normalizeOptionalString(body.customerRef, 120);
  const metadata = normalizeMetadata(body.metadata);
  const idempotencyKey =
    normalizeIdempotencyKey(body.idempotencyKey) ||
    `wabi_pay_${userId}_${randomBytes(12).toString('hex')}`;

  if (!pluginId || !methodId || !currency || amountMinor == null) {
    writeJson(res, 400, {
      success: false,
      error: 'pluginId, methodId, amountMinor, and currency are required'
    });
    return;
  }

  const capabilities = await pluginLoader.getPaymentCapabilities(pluginId);
  if (!capabilities) {
    writeJson(res, 404, { success: false, error: `Payment plugin '${pluginId}' is not available` });
    return;
  }

  const selectedMethod = capabilities.methods.find((method) => method.id === methodId);
  if (!selectedMethod) {
    writeJson(res, 400, { success: false, error: `Method '${methodId}' is not supported by ${pluginId}` });
    return;
  }
  if (!isMethodEligible(selectedMethod, amountMinor, currency, countryCode)) {
    writeJson(res, 400, { success: false, error: `Method '${methodId}' is not eligible for this amount/currency/country` });
    return;
  }

  const existing = paymentRepository.findByIdempotencyKey(idempotencyKey);
  if (existing) {
    const existingView = paymentRepository.findViewByIntentId(existing.intent_id);
    if (!existingView) {
      writeJson(res, 409, { success: false, error: 'Idempotency key is already in use' });
      return;
    }
    if (!canAccessIntent(userId, existingView)) {
      writeJson(res, 409, { success: false, error: 'Idempotency key is already in use' });
      return;
    }

    writeJson(res, 200, {
      success: true,
      reused: true,
      idempotencyKey,
      intent: toIntentResponse(existingView),
      events: paymentRepository.listEvents(existingView.intent_id, 25).map(toEventResponse)
    });
    return;
  }

  const draftIntent = paymentRepository.createIntent({
    workspaceId,
    createdByUserId: userId,
    channelId,
    pluginId,
    providerName: capabilities.providerName || pluginId,
    amountMinor,
    currency,
    countryCode,
    status: 'draft',
    checkoutMode: 'payment_link',
    idempotencyKey,
    customerRef,
    description,
    metadata
  });

  const pluginInput: PaymentCreateIntentInput = {
    intentId: draftIntent.intent_id,
    workspaceId,
    channelId: channelId || undefined,
    createdByUserId: userId,
    amountMinor,
    currency,
    countryCode: countryCode || undefined,
    methodId,
    description: description || undefined,
    customerRef: customerRef || undefined,
    idempotencyKey,
    metadata: metadata || undefined
  };

  try {
    const created = await pluginLoader.createPaymentIntent(pluginId, pluginInput);
    if (typeof created.providerIntentId === 'string' && created.providerIntentId.trim().length > 0) {
      paymentRepository.setProviderIntentId(draftIntent.intent_id, created.providerIntentId.trim());
    }

    const presentation = isRecord(created.presentation) ? created.presentation : null;
    paymentRepository.updatePresentation(draftIntent.intent_id, created.checkoutMode, presentation);

    paymentRepository.setStatus(draftIntent.intent_id, created.status, {
      metadata: isRecord(created.metadata) ? created.metadata : metadata,
      expiresAt: Number.isFinite(created.expiresAt as number) ? Math.floor(created.expiresAt as number) : null
    });

    paymentRepository.addEvent(draftIntent.intent_id, {
      eventType: 'intent.created',
      status: created.status,
      source: 'plugin',
      payload: {
        pluginId,
        providerName: capabilities.providerName || pluginId,
        providerIntentId: created.providerIntentId,
        checkoutMode: created.checkoutMode,
        methodId
      },
      idempotencyKey
    });

    const finalIntent = paymentRepository.findViewByIntentId(draftIntent.intent_id);
    if (!finalIntent) {
      throw new Error('payment_intent_missing_after_create');
    }

    writeJson(res, 201, {
      success: true,
      reused: false,
      idempotencyKey,
      intent: toIntentResponse(finalIntent),
      events: paymentRepository.listEvents(finalIntent.intent_id, 25).map(toEventResponse)
    });
  } catch (error) {
    console.error(`[Payments] Plugin createIntent failed for ${pluginId}:`, error);
    paymentRepository.setStatus(draftIntent.intent_id, 'failed', {
      failureCode: 'provider_create_failed',
      failureMessage: 'Payment provider intent creation failed'
    });
    paymentRepository.addEvent(draftIntent.intent_id, {
      eventType: 'intent.create_failed',
      status: 'failed',
      source: 'core',
      payload: {
        pluginId,
        reason: error instanceof Error ? error.message : 'unknown'
      },
      idempotencyKey
    });

    const failedIntent = paymentRepository.findViewByIntentId(draftIntent.intent_id);
    writeJson(res, 502, {
      success: false,
      error: 'Payment provider intent creation failed',
      intent: failedIntent ? toIntentResponse(failedIntent) : null
    });
  }
}

export async function handleGetPaymentIntent(
  req: IncomingMessage,
  res: ServerResponse,
  pluginLoader: PluginLoader,
  intentId: string,
  url: URL
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  let intent = paymentRepository.findViewByIntentId(intentId);
  if (!intent) {
    writeJson(res, 404, { success: false, error: 'Payment intent not found' });
    return;
  }
  if (!canAccessIntent(userId, intent)) {
    writeJson(res, 403, { success: false, error: 'Forbidden' });
    return;
  }

  let providerRefreshError: string | null = null;
  const shouldRefresh = parseBooleanQueryValue(url.searchParams.get('refresh'));
  if (shouldRefresh && !TERMINAL_STATUSES.has(intent.status)) {
    try {
      const providerStatus = await pluginLoader.getPaymentIntentStatus(intent.plugin_id, {
        intentId: intent.intent_id,
        providerIntentId: intent.provider_intent_id || undefined
      });
      if (providerStatus) {
        if (providerStatus.providerIntentId && providerStatus.providerIntentId !== intent.provider_intent_id) {
          paymentRepository.setProviderIntentId(intent.intent_id, providerStatus.providerIntentId);
        }
        paymentRepository.setStatus(intent.intent_id, providerStatus.status, {
          metadata: isRecord(providerStatus.metadata) ? providerStatus.metadata : null
        });
        paymentRepository.addEvent(intent.intent_id, {
          eventType: 'intent.status_polled',
          status: providerStatus.status,
          source: 'plugin',
          payload: {
            pluginId: intent.plugin_id,
            providerIntentId: providerStatus.providerIntentId || intent.provider_intent_id || null
          }
        });
      }
    } catch (error) {
      providerRefreshError = error instanceof Error ? error.message : 'provider_status_poll_failed';
      console.warn(`[Payments] Provider status poll failed for ${intent.intent_id}:`, error);
    }
  }

  intent = paymentRepository.findViewByIntentId(intentId);
  if (!intent) {
    writeJson(res, 404, { success: false, error: 'Payment intent not found' });
    return;
  }

  const includeEvents = !['0', 'false', 'no', 'off'].includes(
    (url.searchParams.get('includeEvents') || '').trim().toLowerCase()
  );
  const eventLimitRaw = Number(url.searchParams.get('eventLimit') || '25');
  const eventLimit = Number.isFinite(eventLimitRaw) ? Math.max(1, Math.min(100, Math.floor(eventLimitRaw))) : 25;
  const events = includeEvents ? paymentRepository.listEvents(intent.intent_id, eventLimit).map(toEventResponse) : [];

  writeJson(res, 200, {
    success: true,
    intent: toIntentResponse(intent),
    events,
    providerRefreshError
  });
}

export async function handleCancelPaymentIntent(
  req: IncomingMessage,
  res: ServerResponse,
  pluginLoader: PluginLoader,
  intentId: string
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  const intent = paymentRepository.findViewByIntentId(intentId);
  if (!intent) {
    writeJson(res, 404, { success: false, error: 'Payment intent not found' });
    return;
  }
  if (!canAccessIntent(userId, intent)) {
    writeJson(res, 403, { success: false, error: 'Forbidden' });
    return;
  }

  let reason = 'Canceled by user';
  try {
    const body = await parseJsonBody(req);
    const parsedReason = normalizeOptionalString(body.reason, 280);
    if (parsedReason) {
      reason = parsedReason;
    }
  } catch (error) {
    if (isPayloadTooLargeError(error)) {
      writeJson(res, 413, { success: false, error: 'Payload too large' });
      return;
    }
    if (!isJsonParseError(error)) {
      writeJson(res, 400, { success: false, error: 'Invalid cancellation payload' });
      return;
    }
  }

  if (intent.status === 'canceled' || intent.status === 'refunded') {
    writeJson(res, 200, {
      success: true,
      intent: toIntentResponse(intent),
      alreadyTerminal: true
    });
    return;
  }

  if (intent.status === 'succeeded') {
    try {
      const refundResult = await pluginLoader.refundPaymentIntent(intent.plugin_id, {
        intentId: intent.intent_id,
        providerIntentId: intent.provider_intent_id || undefined,
        amountMinor: intent.amount_minor,
        reason,
        idempotencyKey: `refund_cancel_${intent.intent_id}`
      });
      if (!refundResult) {
        writeJson(res, 409, { success: false, error: 'Settled payment cannot be canceled by this provider' });
        return;
      }

      paymentRepository.setStatus(intent.intent_id, refundResult.status, {
        metadata: isRecord(refundResult.metadata) ? refundResult.metadata : null,
        failureCode: refundResult.status === 'failed' ? 'refund_failed' : null,
        failureMessage: refundResult.status === 'failed' ? 'Refund request failed' : null
      });
      paymentRepository.addEvent(intent.intent_id, {
        eventType: 'intent.cancel_refund',
        status: refundResult.status,
        source: 'plugin',
        payload: {
          pluginId: intent.plugin_id,
          reason,
          providerRefundId: refundResult.providerRefundId || null
        },
        idempotencyKey: `refund_cancel_${intent.intent_id}`
      });
    } catch (error) {
      console.error(`[Payments] Refund on cancel failed for ${intent.intent_id}:`, error);
      writeJson(res, 502, { success: false, error: 'Payment provider refund failed during cancel' });
      return;
    }
  } else {
    if (TERMINAL_STATUSES.has(intent.status)) {
      writeJson(res, 409, { success: false, error: `Payment intent is already terminal (${intent.status})` });
      return;
    }
    paymentRepository.setStatus(intent.intent_id, 'canceled', {
      failureCode: 'canceled_by_user',
      failureMessage: reason
    });
    paymentRepository.addEvent(intent.intent_id, {
      eventType: 'intent.canceled',
      status: 'canceled',
      source: 'core',
      payload: {
        canceledByUserId: userId,
        reason
      }
    });
  }

  const updated = paymentRepository.findViewByIntentId(intent.intent_id);
  if (!updated) {
    writeJson(res, 500, { success: false, error: 'Payment intent missing after cancel' });
    return;
  }

  writeJson(res, 200, {
    success: true,
    intent: toIntentResponse(updated),
    events: paymentRepository.listEvents(updated.intent_id, 25).map(toEventResponse)
  });
}

export async function handlePaymentWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  pluginLoader: PluginLoader,
  pluginId: string,
  url: URL
): Promise<void> {
  if (!pluginId || pluginId.length > 96) {
    writeJson(res, 400, { success: false, error: 'Invalid payment plugin id' });
    return;
  }

  let rawBody: string;
  try {
    rawBody = (await readRequestBuffer(req)).toString('utf8');
  } catch (error) {
    if (isPayloadTooLargeError(error)) {
      writeJson(res, 413, { success: false, error: 'Payload too large' });
      return;
    }
    writeJson(res, 400, { success: false, error: 'Invalid webhook payload' });
    return;
  }

  let verification: Awaited<ReturnType<PluginLoader['verifyPaymentWebhook']>>;
  try {
    verification = await pluginLoader.verifyPaymentWebhook(pluginId, {
      headers: req.headers,
      rawBody,
      query: buildWebhookQuery(url.searchParams)
    });
  } catch (error) {
    if (isPluginNotLoadedError(error)) {
      writeJson(res, 404, { success: false, error: `Payment plugin '${pluginId}' is not available` });
      return;
    }
    console.error(`[Payments] Webhook verification crashed for ${pluginId}:`, error);
    writeJson(res, 502, { success: false, error: 'Webhook verification failed' });
    return;
  }

  if (!verification.valid) {
    writeJson(res, 400, {
      success: false,
      error: verification.reason || 'Invalid webhook signature'
    });
    return;
  }

  if (!verification.event) {
    writeJson(res, 202, { success: true, accepted: true, ignored: true, reason: 'No event payload returned' });
    return;
  }

  const normalizedEventId = normalizeOptionalString(verification.event.eventId, 180) || `evt_${Date.now()}_${randomBytes(8).toString('hex')}`;
  const duplicate = paymentRepository.findEventByEventId(normalizedEventId);
  if (duplicate) {
    writeJson(res, 200, { success: true, duplicate: true });
    return;
  }

  let intent: PaymentIntentView | null = null;
  const eventIntentId = normalizeOptionalString(verification.event.intentId, 128);
  const providerIntentId = normalizeOptionalString(verification.event.providerIntentId, 160);

  if (eventIntentId) {
    intent = paymentRepository.findViewByIntentId(eventIntentId);
  }
  if (!intent && providerIntentId) {
    const byProvider = paymentRepository.findByProviderIntentId(pluginId, providerIntentId);
    intent = byProvider ? paymentRepository.findViewByIntentId(byProvider.intent_id) : null;
  }

  if (!intent) {
    writeJson(res, 202, {
      success: true,
      accepted: true,
      matchedIntent: false,
      eventId: normalizedEventId
    });
    return;
  }

  if (providerIntentId && providerIntentId !== intent.provider_intent_id) {
    paymentRepository.setProviderIntentId(intent.intent_id, providerIntentId);
  }

  const normalizedStatus = isKnownPaymentStatus(verification.event.status)
    ? verification.event.status
    : null;
  if (normalizedStatus) {
    paymentRepository.setStatus(intent.intent_id, normalizedStatus, {
      metadata: isRecord(verification.event.raw) ? verification.event.raw : null
    });
  }

  paymentRepository.addEvent(intent.intent_id, {
    eventId: normalizedEventId,
    eventType: normalizeOptionalString(verification.event.eventType, 160) || 'provider.event',
    status: normalizedStatus,
    source: 'webhook',
    payload: isRecord(verification.event.raw) ? verification.event.raw : {},
    signatureValid: true,
    idempotencyKey: normalizeOptionalString(verification.event.idempotencyKey, 180)
  });

  const updated = paymentRepository.findViewByIntentId(intent.intent_id);
  writeJson(res, 200, {
    success: true,
    matchedIntent: true,
    eventId: normalizedEventId,
    intent: updated ? toIntentResponse(updated) : null
  });
}
