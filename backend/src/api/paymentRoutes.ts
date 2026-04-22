import { randomBytes } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { getAuthenticatedUserIdFromRequest } from '../auth/requestAuth.js';
import { getUserRoles } from '../auth/roleMiddleware.js';
import { DEFAULT_WORKSPACE_ID, PRIVILEGED_ROLES } from '../constants.js';
import {
  paymentRepository,
  type PaymentDonationLedgerRow,
  type PaymentEventInput,
  type PaymentEventRow,
  type PaymentIntentStatus as RepositoryPaymentIntentStatus,
  type PaymentIntentView
} from '../db/repositories/paymentRepository.js';
import {
  manualSettlementRepository,
  type OfflineDonationRecordRow
} from '../db/repositories/manualSettlementRepository.js';
import type { PluginLoader } from '../plugins/loader.js';
import type { PaymentCreateIntentInput, PaymentMethodCapability, PaymentPluginCapabilities } from '../plugins/types.js';
import {
  getPaymentAccessPolicy,
  isRoleAllowedToCreatePayment,
  savePaymentAccessPolicy,
  type PaymentAccessPolicy
} from '../payments/accessPolicy.js';
import {
  getPaymentDonationConfig,
  savePaymentDonationConfig
} from '../payments/donations.js';
import {
  clearPaymentUserBlock,
  getActivePaymentUserBlock,
  listPaymentUserBlocks,
  upsertPaymentUserBlock
} from '../payments/userBlocks.js';
import {
  deletePaymentAccountLink,
  getPaymentAccountLink,
  listPaymentAccountLinks,
  upsertPaymentAccountLink
} from '../payments/accountLinks.js';
import {
  notifyDonationUpdated,
  notifyPaymentAccessUpdated,
  notifyPaymentAccountLinksUpdated,
  notifyPaymentIntentUpdated,
  notifyPaymentUserBlocksUpdated
} from '../payments/realtime.js';
import {
  isInvalidJsonBodyError as isJsonParseError,
  isRequestBodyTooLargeError as isPayloadTooLargeError,
  readJsonObjectBody,
  readRequestBuffer
} from '../utils/requestBodies.js';

const MAX_PAYMENT_BODY_BYTES = Math.max(
  1024,
  Math.min(2 * 1024 * 1024, Number(process.env.PAYMENT_MAX_BODY_BYTES || 256 * 1024))
);
const PAYMENT_CREATE_WINDOW_MS = Math.max(
  10_000,
  Math.min(30 * 60 * 1000, Number(process.env.PAYMENT_CREATE_WINDOW_MS || 5 * 60 * 1000))
);
const PAYMENT_CREATE_MAX_PER_WINDOW = Math.max(
  1,
  Math.min(100, Number(process.env.PAYMENT_CREATE_MAX_PER_WINDOW || 12))
);
const PAYMENT_MAX_OPEN_REQUESTS_PER_USER = Math.max(
  1,
  Math.min(100, Number(process.env.PAYMENT_MAX_OPEN_REQUESTS_PER_USER || 8))
);
const paymentCreateRateLimitMap = new Map<number, { count: number; resetTime: number }>();

// Periodic cleanup of expired payment rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of paymentCreateRateLimitMap) {
    if (now > entry.resetTime) paymentCreateRateLimitMap.delete(key);
  }
}, 5 * 60 * 1000).unref();

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

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
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

function normalizePluginId(value: unknown): string | null {
  return normalizeOptionalString(value, 96);
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

interface NormalizedCreatePaymentIntentRequest {
  pluginId: string;
  methodId: string;
  currency: string;
  countryCode: string | null;
  amountMinor: number;
  workspaceId: string;
  channelId: string | null;
  description: string | null;
  customerRef: string | null;
  metadata: Record<string, unknown> | null;
  idempotencyKey: string;
}

interface NormalizedPaymentAccountLinkRequest {
  pluginId: string;
  providerAccountRef: string;
  displayLabel: string | null;
  metadata: Record<string, unknown> | null;
}

function parseCreatePaymentIntentRequest(
  body: Record<string, unknown>,
  userId: number
): NormalizedCreatePaymentIntentRequest | null {
  const pluginId = normalizePluginId(body.pluginId);
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
    return null;
  }

  return {
    pluginId,
    methodId,
    currency,
    countryCode,
    amountMinor,
    workspaceId,
    channelId,
    description,
    customerRef,
    metadata,
    idempotencyKey
  };
}

function parsePaymentAccountLinkRequest(body: Record<string, unknown>): NormalizedPaymentAccountLinkRequest | null {
  const pluginId = normalizePluginId(body.pluginId);
  const providerAccountRef = normalizeOptionalString(body.providerAccountRef, 240);
  const displayLabel = normalizeOptionalString(body.displayLabel, 160);
  const metadata = normalizeMetadata(body.metadata);

  if (!pluginId || !providerAccountRef) {
    return null;
  }

  return {
    pluginId,
    providerAccountRef,
    displayLabel,
    metadata
  };
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

function getEffectiveUserRoles(userId: number): string[] {
  const roles = getUserRoles(userId, DEFAULT_WORKSPACE_ID)
    .map((role) => String(role || '').trim().toLowerCase())
    .filter((role) => role.length > 0);

  if (roles.length === 0) {
    return ['member'];
  }
  return [...new Set(roles)];
}

function getHighestRolePriority(roles: string[]): number {
  let highest = 0;
  for (const role of roles) {
    if (role === 'owner') highest = Math.max(highest, 100);
    else if (role === 'admin') highest = Math.max(highest, 90);
    else if (role === 'mod') highest = Math.max(highest, 70);
    else if (role === 'member') highest = Math.max(highest, 10);
    else if (role === 'guest') highest = Math.max(highest, 0);
  }
  return highest;
}

function isPaymentAdmin(userId: number): boolean {
  const roles = getEffectiveUserRoles(userId);
  return roles.some((role) => PRIVILEGED_ROLES.includes(role as any));
}

function canManagePaymentUserBlock(actorUserId: number, targetUserId: number): { allowed: boolean; error?: string } {
  if (actorUserId === targetUserId) {
    return { allowed: false, error: 'You cannot modify your own payment block state' };
  }

  const actorRoles = getEffectiveUserRoles(actorUserId);
  const targetRoles = getEffectiveUserRoles(targetUserId);
  const actorPriority = getHighestRolePriority(actorRoles);
  const targetPriority = getHighestRolePriority(targetRoles);

  if (actorPriority <= targetPriority) {
    return { allowed: false, error: 'Cannot modify payment access for equal or higher role user' };
  }
  return { allowed: true };
}

type CreatePaymentAccessCheckResult = {
  allowed: boolean;
  status: number;
  code: string;
  error: string;
  policy: PaymentAccessPolicy;
  roles: string[];
  blocked: boolean;
};

function evaluateCreatePaymentAccess(userId: number): CreatePaymentAccessCheckResult {
  const policy = getPaymentAccessPolicy();
  const roles = getEffectiveUserRoles(userId);
  const blockedEntry = getActivePaymentUserBlock(userId, DEFAULT_WORKSPACE_ID);

  if (!policy.enabled) {
    return {
      allowed: false,
      status: 403,
      code: 'payments_disabled',
      error: 'Payments are disabled by server policy',
      policy,
      roles,
      blocked: false
    };
  }

  if (blockedEntry) {
    return {
      allowed: false,
      status: 403,
      code: 'payments_user_blocked',
      error: blockedEntry.reason || 'Your account is blocked from creating payments on this server',
      policy,
      roles,
      blocked: true
    };
  }

  if (!isRoleAllowedToCreatePayment(policy, roles)) {
    return {
      allowed: false,
      status: 403,
      code: 'payments_role_not_allowed',
      error: 'Your role is not allowed to create payments on this server',
      policy,
      roles,
      blocked: false
    };
  }

  return {
    allowed: true,
    status: 200,
    code: 'ok',
    error: '',
    policy,
    roles,
    blocked: false
  };
}

function checkPaymentCreateRateLimit(userId: number): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const existing = paymentCreateRateLimitMap.get(userId);
  if (!existing || now > existing.resetTime) {
    paymentCreateRateLimitMap.set(userId, {
      count: 1,
      resetTime: now + PAYMENT_CREATE_WINDOW_MS
    });
    return { allowed: true };
  }

  if (existing.count >= PAYMENT_CREATE_MAX_PER_WINDOW) {
    return {
      allowed: false,
      retryAfterMs: Math.max(1_000, existing.resetTime - now)
    };
  }

  existing.count += 1;
  return { allowed: true };
}

function countOpenPaymentRequests(userId: number): number {
  const now = Date.now();
  return paymentRepository
    .listByCreator(userId, DEFAULT_WORKSPACE_ID, 200)
    .filter((intent) => {
      if (intent.status !== 'draft' && intent.status !== 'pending') {
        return false;
      }
      if (typeof intent.expires_at === 'number' && intent.expires_at > 0 && intent.expires_at <= now) {
        return false;
      }
      return true;
    }).length;
}

function canAccessIntent(userId: number, intent: PaymentIntentView): boolean {
  return intent.created_by_user_id === userId;
}

function isServerDonationIntent(intent: PaymentIntentView | null | undefined): boolean {
  return Boolean(intent?.metadata && intent.metadata.kind === 'server_donation');
}

function isServerDonationMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  return Boolean(metadata && metadata.kind === 'server_donation');
}

function normalizeThaiPromptPayReference(raw: string | null | undefined): string | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10 && digits.startsWith('0')) return digits;
  if (digits.length === 13) return digits;
  if (digits.length === 15) return digits;
  return null;
}

function normalizeBitcoinAddressReference(raw: string | null | undefined): string | null {
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

function mapCreateIntentPluginError(error: unknown): { failureCode: string; failureMessage: string } {
  const message = error instanceof Error ? error.message : 'unknown';
  switch (message) {
    case 'th_payments_server_promptpay_not_configured':
      return {
        failureCode: 'provider_misconfigured',
        failureMessage: 'Server PromptPay donations are not configured yet.'
      };
    case 'btc_payments_server_address_not_configured':
      return {
        failureCode: 'provider_misconfigured',
        failureMessage: 'Server Bitcoin donations are not configured yet.'
      };
    case 'btc_payments_invalid_address':
      return {
        failureCode: 'invalid_payment_reference',
        failureMessage: 'Bitcoin address is invalid.'
      };
    case 'btc_payments_address_required':
      return {
        failureCode: 'missing_payment_reference',
        failureMessage: 'Bitcoin QR requests need a Bitcoin address.'
      };
    default:
      return {
        failureCode: 'provider_create_failed',
        failureMessage: 'Payment provider intent creation failed'
      };
  }
}

function emitIntentRealtimeUpdate(
  intent: PaymentIntentView | null | undefined,
  reason: 'intent' | 'refund' = 'intent'
): void {
  if (!intent) return;
  notifyPaymentIntentUpdated({
    workspaceId: intent.workspace_id,
    intentId: intent.intent_id,
    createdByUserId: intent.created_by_user_id,
    channelId: intent.channel_id,
    status: intent.status,
    isDonation: isServerDonationIntent(intent)
  });
  if (isServerDonationIntent(intent)) {
    notifyDonationUpdated({
      workspaceId: intent.workspace_id,
      reason,
      intentId: intent.intent_id,
      status: intent.status
    });
  }
}

function maskDonationDonorLabel(username: string | null, userId: number | null): string {
  const normalized = typeof username === 'string' ? username.trim() : '';
  if (!normalized) {
    if (typeof userId === 'number' && Number.isFinite(userId)) {
      return `Donor ${String(Math.abs(Math.floor(userId))).slice(-4).padStart(4, '0')}`;
    }
    return 'Anonymous';
  }

  const collapsed = normalized.replace(/\s+/g, ' ');
  const parts = collapsed.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0].slice(0, 4);
    const firstSuffix = parts[0].length > 4 ? '…' : '';
    const secondInitial = parts[1].charAt(0).toUpperCase();
    return `${first}${firstSuffix} ${secondInitial}.`;
  }

  if (collapsed.length <= 4) {
    return collapsed;
  }
  return `${collapsed.slice(0, 4)}…`;
}

function toDonationLedgerResponse(row: PaymentDonationLedgerRow): Record<string, unknown> {
  return {
    intentId: row.intent_id,
    donorLabel: maskDonationDonorLabel(row.donor_username, row.created_by_user_id),
    amountMinor: Number(row.amount_minor || 0),
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    refundedAt: row.refunded_at,
    updatedAt: row.updated_at,
    canRefund: row.status === 'succeeded'
  };
}

function maskOfflineDonationLabel(rawLabel: string | null): string {
  const normalized = typeof rawLabel === 'string' ? rawLabel.trim() : '';
  if (!normalized) return 'Anonymous';
  const collapsed = normalized.replace(/\s+/g, ' ');
  const parts = collapsed.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0].slice(0, 4);
    const firstSuffix = parts[0].length > 4 ? '...' : '';
    const secondInitial = parts[1].charAt(0).toUpperCase();
    return `${first}${firstSuffix} ${secondInitial}.`;
  }
  if (collapsed.length <= 4) return collapsed;
  return `${collapsed.slice(0, 4)}...`;
}

function toOfflineDonationResponse(
  row: OfflineDonationRecordRow,
  options: { adminView?: boolean } = {}
): Record<string, unknown> {
  return {
    settlementId: row.settlement_id,
    donorLabel: maskOfflineDonationLabel(row.donor_label),
    amountMinor: Number(row.amount_minor || 0),
    currency: row.currency,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    voidedAt: row.voided_at,
    updatedAt: row.updated_at,
    sourceType: 'offline_manual',
    canVoid: options.adminView ? row.status === 'recorded' : false,
    recordedByLabel: options.adminView ? row.recorded_by_username || null : null
  };
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

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return await readJsonObjectBody(req, MAX_PAYMENT_BODY_BYTES);
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

export async function handleListPaymentHistory(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const limit = clampPositiveInteger(url.searchParams.get('limit'), 1000) ?? 200;
    const intents = paymentRepository.listByCreator(userId, DEFAULT_WORKSPACE_ID, limit);
    writeJson(res, 200, {
      success: true,
      intents: intents.map(toIntentResponse),
      count: intents.length
    });
  } catch (error) {
    console.error('[Payments] Failed to list payment history:', error);
    writeJson(res, 500, { success: false, error: 'Failed to list payment history' });
  }
}

export async function handleGetPaymentDonationSummary(
  _req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const config = getPaymentDonationConfig();
    const totals = paymentRepository.summarizeServerDonations(DEFAULT_WORKSPACE_ID).map((row) => ({
      currency: row.currency,
      amountMinor: Number(row.amount_minor || 0),
      paymentCount: Number(row.payment_count || 0)
    }));
    const offlineTotals = manualSettlementRepository.summarizeOfflineDonations(DEFAULT_WORKSPACE_ID).map((row) => ({
      currency: row.currency,
      amountMinor: Number(row.amount_minor || 0),
      paymentCount: Number(row.payment_count || 0)
    }));
    const recentDonations = paymentRepository
      .listServerDonationActivity(DEFAULT_WORKSPACE_ID, 20)
      .map(toDonationLedgerResponse);
    const recentOfflineDonations = manualSettlementRepository
      .listOfflineDonations(DEFAULT_WORKSPACE_ID, 20)
      .map((row) => toOfflineDonationResponse(row));
    writeJson(res, 200, {
      success: true,
      config,
      totals,
      recentDonations,
      offlineTotals,
      recentOfflineDonations
    });
  } catch (error) {
    console.error('[Payments] Failed to load donation summary:', error);
    writeJson(res, 500, { success: false, error: 'Failed to load donation summary' });
  }
}

export async function handleListAdminPaymentDonations(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  if (!isPaymentAdmin(userId)) {
    writeJson(res, 403, { success: false, error: 'Admin permissions required' });
    return;
  }

  try {
    const limit = clampPositiveInteger(url.searchParams.get('limit'), 500) ?? 100;
    const donations = paymentRepository
      .listServerDonationActivity(DEFAULT_WORKSPACE_ID, limit)
      .map(toDonationLedgerResponse);
    writeJson(res, 200, {
      success: true,
      count: donations.length,
      donations
    });
  } catch (error) {
    console.error('[Payments] Failed to load admin donation audit:', error);
    writeJson(res, 500, { success: false, error: 'Failed to load donation audit trail' });
  }
}

export async function handleGetPaymentDonationConfig(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  if (!isPaymentAdmin(userId)) {
    writeJson(res, 403, { success: false, error: 'Admin permissions required' });
    return;
  }

  writeJson(res, 200, {
    success: true,
    config: getPaymentDonationConfig()
  });
}

export async function handleSavePaymentDonationConfig(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  if (!isPaymentAdmin(userId)) {
    writeJson(res, 403, { success: false, error: 'Admin permissions required' });
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
    writeJson(res, 400, { success: false, error: 'Invalid donation config payload' });
    return;
  }

  const config = savePaymentDonationConfig(body);
  notifyDonationUpdated({
    workspaceId: DEFAULT_WORKSPACE_ID,
    reason: 'config'
  });
  writeJson(res, 200, {
    success: true,
    config
  });
}

export async function handleListAdminOfflineDonations(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  if (!isPaymentAdmin(userId)) {
    writeJson(res, 403, { success: false, error: 'Admin permissions required' });
    return;
  }

  try {
    const limit = clampPositiveInteger(url.searchParams.get('limit'), 500) ?? 100;
    const donations = manualSettlementRepository
      .listOfflineDonations(DEFAULT_WORKSPACE_ID, limit)
      .map((row) => toOfflineDonationResponse(row, { adminView: true }));
    writeJson(res, 200, {
      success: true,
      count: donations.length,
      donations
    });
  } catch (error) {
    console.error('[Payments] Failed to load admin offline donations:', error);
    writeJson(res, 500, { success: false, error: 'Failed to load offline donations' });
  }
}

export async function handleCreateAdminOfflineDonation(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  if (!isPaymentAdmin(userId)) {
    writeJson(res, 403, { success: false, error: 'Admin permissions required' });
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
    writeJson(res, 400, { success: false, error: 'Invalid offline donation payload' });
    return;
  }

  const amountMinor = clampPositiveInteger(body.amountMinor, 1_000_000_000);
  const currency = toUpperCode(body.currency, 3);
  const donorLabel = normalizeOptionalString(body.donorLabel, 120);
  const description = normalizeOptionalString(body.description, 280);
  const metadata = normalizeMetadata(body.metadata);

  if (!amountMinor || !currency) {
    writeJson(res, 400, { success: false, error: 'amountMinor and currency are required' });
    return;
  }

  try {
    const donation = manualSettlementRepository.createSettlement({
      settlementKind: 'offline_donation',
      createdByUserId: userId,
      amountMinor,
      currency,
      donorLabel,
      description,
      status: 'recorded',
      metadata
    });
    const hydratedDonation =
      manualSettlementRepository
        .listOfflineDonations(DEFAULT_WORKSPACE_ID, 100)
        .find((row) => row.settlement_id === donation.settlement_id) ||
      null;
    writeJson(res, 201, {
      success: true,
      donation: toOfflineDonationResponse(
        hydratedDonation || {
          ...donation,
          metadata_json: donation.metadata ? JSON.stringify(donation.metadata) : null,
          recorded_by_username: null
        } as OfflineDonationRecordRow,
        { adminView: true }
      )
    });
    notifyDonationUpdated({
      workspaceId: DEFAULT_WORKSPACE_ID,
      reason: 'offline_recorded',
      settlementId: donation.settlement_id,
      status: donation.status
    });
  } catch (error) {
    console.error('[Payments] Failed to create offline donation:', error);
    writeJson(res, 500, { success: false, error: 'Failed to create offline donation' });
  }
}

export async function handleVoidAdminOfflineDonation(
  req: IncomingMessage,
  res: ServerResponse,
  settlementId: string
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  if (!isPaymentAdmin(userId)) {
    writeJson(res, 403, { success: false, error: 'Admin permissions required' });
    return;
  }

  const settlement = manualSettlementRepository.findViewBySettlementId(settlementId);
  if (!settlement || settlement.settlement_kind !== 'offline_donation') {
    writeJson(res, 404, { success: false, error: 'Offline donation not found' });
    return;
  }
  if (settlement.status === 'voided') {
    writeJson(res, 200, {
      success: true,
      alreadyTerminal: true,
      donation: toOfflineDonationResponse(
        {
          ...settlement,
          metadata_json: settlement.metadata ? JSON.stringify(settlement.metadata) : null,
          recorded_by_username: null
        } as OfflineDonationRecordRow,
        { adminView: true }
      )
    });
    return;
  }
  if (settlement.status !== 'recorded') {
    writeJson(res, 409, { success: false, error: `Offline donation cannot be voided from status ${settlement.status}` });
    return;
  }

  let metadata = null as Record<string, unknown> | null;
  try {
    const body = await parseJsonBody(req);
    const reason = normalizeOptionalString(body.reason, 280);
    metadata = reason ? { voidReason: reason, voidedByUserId: userId } : { voidedByUserId: userId };
  } catch (error) {
    if (isPayloadTooLargeError(error)) {
      writeJson(res, 413, { success: false, error: 'Payload too large' });
      return;
    }
    if (!isJsonParseError(error)) {
      writeJson(res, 400, { success: false, error: 'Invalid void payload' });
      return;
    }
  }

  manualSettlementRepository.updateSettlement(settlementId, {
    status: 'voided',
    voidedAt: Date.now(),
    metadata
  });
  const updated =
    manualSettlementRepository
      .listOfflineDonations(DEFAULT_WORKSPACE_ID, 100)
      .find((row) => row.settlement_id === settlementId) || null;
  if (!updated) {
    writeJson(res, 500, { success: false, error: 'Offline donation disappeared after void' });
    return;
  }

  notifyDonationUpdated({
    workspaceId: DEFAULT_WORKSPACE_ID,
    reason: 'offline_voided',
    settlementId: updated.settlement_id,
    status: updated.status
  });
  writeJson(res, 200, {
    success: true,
    donation: toOfflineDonationResponse(updated, { adminView: true })
  });
}

export async function handleRefundAdminPaymentDonation(
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
  if (!isPaymentAdmin(userId)) {
    writeJson(res, 403, { success: false, error: 'Admin permissions required' });
    return;
  }

  const intent = paymentRepository.findViewByIntentId(intentId);
  if (!intent || !isServerDonationIntent(intent)) {
    writeJson(res, 404, { success: false, error: 'Donation payment not found' });
    return;
  }

  let reason = 'Refund issued by server admin';
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
      writeJson(res, 400, { success: false, error: 'Invalid refund payload' });
      return;
    }
  }

  if (intent.status === 'refunded') {
    writeJson(res, 200, {
      success: true,
      alreadyTerminal: true,
      intent: toIntentResponse(intent),
      events: paymentRepository.listEvents(intent.intent_id, 25).map(toEventResponse)
    });
    return;
  }

  if (intent.status !== 'succeeded') {
    writeJson(res, 409, {
      success: false,
      error: `Only completed donations can be refunded (current status: ${intent.status})`
    });
    return;
  }

  try {
    const refundResult = await pluginLoader.refundPaymentIntent(intent.plugin_id, {
      intentId: intent.intent_id,
      providerIntentId: intent.provider_intent_id || undefined,
      amountMinor: intent.amount_minor,
      reason,
      idempotencyKey: `refund_admin_${intent.intent_id}`
    });
    if (!refundResult) {
      writeJson(res, 409, { success: false, error: 'Donation cannot be refunded by this provider' });
      return;
    }

    paymentRepository.setStatus(intent.intent_id, refundResult.status, {
      metadata: isRecord(refundResult.metadata) ? refundResult.metadata : null,
      failureCode: refundResult.status === 'failed' ? 'refund_failed' : null,
      failureMessage: refundResult.status === 'failed' ? 'Refund request failed' : null
    });
    paymentRepository.addEvent(intent.intent_id, {
      eventType: 'intent.admin_refund',
      status: refundResult.status,
      source: 'manual',
      payload: {
        pluginId: intent.plugin_id,
        refundedByUserId: userId,
        reason,
        providerRefundId: refundResult.providerRefundId || null,
        donationKind: 'server_donation'
      },
      idempotencyKey: `refund_admin_${intent.intent_id}`
    });
  } catch (error) {
    console.error(`[Payments] Admin donation refund failed for ${intent.intent_id}:`, error);
    writeJson(res, 502, { success: false, error: 'Payment provider refund failed' });
    return;
  }

  const updated = paymentRepository.findViewByIntentId(intent.intent_id);
  if (!updated) {
    writeJson(res, 500, { success: false, error: 'Donation payment missing after refund' });
    return;
  }

  emitIntentRealtimeUpdate(updated, 'refund');
  writeJson(res, 200, {
    success: true,
    intent: toIntentResponse(updated),
    events: paymentRepository.listEvents(updated.intent_id, 25).map(toEventResponse)
  });
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

  const access = evaluateCreatePaymentAccess(userId);
  if (!access.allowed) {
    writeJson(res, access.status, {
      success: false,
      error: access.error,
      code: access.code
    });
    return;
  }

  const openPaymentRequestCount = countOpenPaymentRequests(userId);
  if (openPaymentRequestCount >= PAYMENT_MAX_OPEN_REQUESTS_PER_USER) {
    writeJson(res, 429, {
      success: false,
      error: 'Too many open payment requests. Cancel one or wait for older requests to expire.',
      code: 'too_many_open_payment_requests',
      openCount: openPaymentRequestCount,
      maxOpen: PAYMENT_MAX_OPEN_REQUESTS_PER_USER
    });
    return;
  }

  const rateLimit = checkPaymentCreateRateLimit(userId);
  if (!rateLimit.allowed) {
    writeJson(res, 429, {
      success: false,
      error: 'Payment request rate limit exceeded. Wait a moment and try again.',
      code: 'payment_request_rate_limited',
      retryAfterMs: rateLimit.retryAfterMs || PAYMENT_CREATE_WINDOW_MS
    });
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

  const parsedRequest = parseCreatePaymentIntentRequest(body, userId);
  if (!parsedRequest) {
    writeJson(res, 400, {
      success: false,
      error: 'pluginId, methodId, amountMinor, and currency are required'
    });
    return;
  }

  const {
    pluginId,
    methodId,
    currency,
    countryCode,
    amountMinor,
    workspaceId,
    channelId,
    description,
    customerRef,
    metadata,
    idempotencyKey
  } = parsedRequest;

  const capabilities = await pluginLoader.getPaymentCapabilities(pluginId);
  if (!capabilities) {
    writeJson(res, 404, { success: false, error: `Payment plugin '${pluginId}' is not available` });
    return;
  }

  const linkedAccount = getPaymentAccountLink(userId, pluginId, workspaceId);
  const isServerDonationRequest = isServerDonationMetadata(metadata);
  let effectiveCustomerRef = isServerDonationRequest
    ? null
    : customerRef || linkedAccount?.providerAccountRef || null;

  const selectedMethod = capabilities.methods.find((method) => method.id === methodId);
  if (!selectedMethod) {
    writeJson(res, 400, { success: false, error: `Method '${methodId}' is not supported by ${pluginId}` });
    return;
  }
  if (!isMethodEligible(selectedMethod, amountMinor, currency, countryCode)) {
    writeJson(res, 400, { success: false, error: `Method '${methodId}' is not eligible for this amount/currency/country` });
    return;
  }
  if (pluginId === 'th-payments' && methodId === 'promptpay_qr' && !isServerDonationRequest) {
    const normalizedPromptPayReference = normalizeThaiPromptPayReference(effectiveCustomerRef);
    if (!normalizedPromptPayReference) {
      writeJson(res, 400, {
        success: false,
        error:
          'Thai PromptPay requests need your own PromptPay number or registered PromptPay ID. Save it in Saved Payment References or enter a one-off number.'
      });
      return;
    }
    effectiveCustomerRef = normalizedPromptPayReference;
  }
  if (pluginId === 'btc-payments' && methodId === 'bitcoin_qr' && !isServerDonationRequest) {
    const normalizedBitcoinAddress = normalizeBitcoinAddressReference(effectiveCustomerRef);
    if (!normalizedBitcoinAddress) {
      writeJson(res, 400, {
        success: false,
        error:
          'Bitcoin QR requests need your own Bitcoin address. Save it in Saved Payment References or enter a one-off address.'
      });
      return;
    }
    effectiveCustomerRef = normalizedBitcoinAddress;
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
    customerRef: effectiveCustomerRef,
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
    customerRef: effectiveCustomerRef || undefined,
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

    paymentRepository.setStatusWithEvent(
      draftIntent.intent_id,
      created.status,
      {
        metadata: isRecord(created.metadata) ? created.metadata : metadata,
        expiresAt: Number.isFinite(created.expiresAt as number) ? Math.floor(created.expiresAt as number) : null
      },
      {
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
      }
    );

    const finalIntent = paymentRepository.findViewByIntentId(draftIntent.intent_id);
    if (!finalIntent) {
      throw new Error('payment_intent_missing_after_create');
    }

    emitIntentRealtimeUpdate(finalIntent);
    writeJson(res, 201, {
      success: true,
      reused: false,
      idempotencyKey,
      intent: toIntentResponse(finalIntent),
      events: paymentRepository.listEvents(finalIntent.intent_id, 25).map(toEventResponse)
    });
  } catch (error) {
    console.error(`[Payments] Plugin createIntent failed for ${pluginId}:`, error);
    const createFailure = mapCreateIntentPluginError(error);
    paymentRepository.setStatusWithEvent(
      draftIntent.intent_id,
      'failed',
      {
        failureCode: createFailure.failureCode,
        failureMessage: createFailure.failureMessage
      },
      {
        eventType: 'intent.create_failed',
        status: 'failed',
        source: 'core',
        payload: {
          pluginId,
          reason: error instanceof Error ? error.message : 'unknown'
        },
        idempotencyKey
      }
    );

    const failedIntent = paymentRepository.findViewByIntentId(draftIntent.intent_id);
    emitIntentRealtimeUpdate(failedIntent);
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
  let refreshedIntent = false;
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
        refreshedIntent = true;
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

  if (refreshedIntent) {
    emitIntentRealtimeUpdate(intent);
  }
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

  emitIntentRealtimeUpdate(updated, updated.status === 'refunded' ? 'refund' : 'intent');
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
    rawBody = (await readRequestBuffer(req, MAX_PAYMENT_BODY_BYTES)).toString('utf8');
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

  const webhookEvent: PaymentEventInput = {
    eventId: normalizedEventId,
    eventType: normalizeOptionalString(verification.event.eventType, 160) || 'provider.event',
    status: normalizedStatus,
    source: 'webhook',
    payload: isRecord(verification.event.raw) ? verification.event.raw : {},
    signatureValid: true,
    idempotencyKey: normalizeOptionalString(verification.event.idempotencyKey, 180)
  };

  if (normalizedStatus) {
    paymentRepository.setStatusWithEvent(
      intent.intent_id,
      normalizedStatus,
      { metadata: isRecord(verification.event.raw) ? verification.event.raw : null },
      webhookEvent
    );
  } else {
    paymentRepository.addEvent(intent.intent_id, webhookEvent);
  }

  const updated = paymentRepository.findViewByIntentId(intent.intent_id);
  emitIntentRealtimeUpdate(updated, normalizedStatus === 'refunded' ? 'refund' : 'intent');
  writeJson(res, 200, {
    success: true,
    matchedIntent: true,
    eventId: normalizedEventId,
    intent: updated ? toIntentResponse(updated) : null
  });
}

export async function handleGetPaymentAccess(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const policy = getPaymentAccessPolicy();
  const userId = getAuthenticatedUserIdFromRequest(req);

  if (!userId) {
    writeJson(res, 200, {
      success: true,
      policy,
      actor: {
        authenticated: false,
        userId: null,
        roles: ['guest'],
        blocked: false,
        canCreate: false,
        reasonCode: 'not_authenticated',
        reason: 'Sign in with a registered account to create payments'
      }
    });
    return;
  }

  const verdict = evaluateCreatePaymentAccess(userId);
  writeJson(res, 200, {
    success: true,
    policy,
    actor: {
      authenticated: true,
      userId,
      roles: verdict.roles,
      blocked: verdict.blocked,
      canCreate: verdict.allowed,
      reasonCode: verdict.allowed ? null : verdict.code,
      reason: verdict.allowed ? null : verdict.error
    }
  });
}

export async function handleListPaymentAccountLinks(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  writeJson(res, 200, {
    success: true,
    links: listPaymentAccountLinks(userId, DEFAULT_WORKSPACE_ID)
  });
}

export async function handleUpsertPaymentAccountLink(
  req: IncomingMessage,
  res: ServerResponse
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
    writeJson(res, 400, { success: false, error: 'Invalid payload' });
    return;
  }

  const parsedRequest = parsePaymentAccountLinkRequest(body);
  if (!parsedRequest) {
    writeJson(res, 400, { success: false, error: 'pluginId and providerAccountRef are required' });
    return;
  }
  const { pluginId, displayLabel, metadata } = parsedRequest;
  let { providerAccountRef } = parsedRequest;
  if (pluginId === 'th-payments') {
    const normalizedPromptPayReference = normalizeThaiPromptPayReference(providerAccountRef);
    if (!normalizedPromptPayReference) {
      writeJson(res, 400, {
        success: false,
        error:
          'Thailand PromptPay references must be a Thai mobile number or registered PromptPay ID.'
      });
      return;
    }
    providerAccountRef = normalizedPromptPayReference;
  }
  if (pluginId === 'btc-payments') {
    const normalizedBitcoinAddress = normalizeBitcoinAddressReference(providerAccountRef);
    if (!normalizedBitcoinAddress) {
      writeJson(res, 400, {
        success: false,
        error: 'Bitcoin payment references must be a valid Bitcoin address.'
      });
      return;
    }
    providerAccountRef = normalizedBitcoinAddress;
  }

  const link = upsertPaymentAccountLink({
    userId,
    workspaceId: DEFAULT_WORKSPACE_ID,
    pluginId,
    providerAccountRef,
    displayLabel,
    metadata
  });

  if (!link) {
    writeJson(res, 500, { success: false, error: 'Failed to save payment account link' });
    return;
  }

  writeJson(res, 200, {
    success: true,
    link
  });
  notifyPaymentAccountLinksUpdated({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId
  });
}

export async function handleDeletePaymentAccountLink(
  req: IncomingMessage,
  res: ServerResponse,
  pluginId: string
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  const normalizedPluginId = normalizePluginId(pluginId);
  if (!normalizedPluginId) {
    writeJson(res, 400, { success: false, error: 'Invalid plugin id' });
    return;
  }

  const cleared = deletePaymentAccountLink(userId, normalizedPluginId, DEFAULT_WORKSPACE_ID);
  writeJson(res, 200, {
    success: true,
    cleared
  });
  if (cleared) {
    notifyPaymentAccountLinksUpdated({
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId
    });
  }
}

export async function handleGetPaymentAccessPolicy(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  if (!isPaymentAdmin(userId)) {
    writeJson(res, 403, { success: false, error: 'Admin permissions required' });
    return;
  }

  writeJson(res, 200, {
    success: true,
    policy: getPaymentAccessPolicy()
  });
}

export async function handleSavePaymentAccessPolicy(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  if (!isPaymentAdmin(userId)) {
    writeJson(res, 403, { success: false, error: 'Admin permissions required' });
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
    writeJson(res, 400, { success: false, error: 'Invalid policy payload' });
    return;
  }

  const policy = savePaymentAccessPolicy(body);
  notifyPaymentAccessUpdated({
    workspaceId: DEFAULT_WORKSPACE_ID
  });
  writeJson(res, 200, {
    success: true,
    policy
  });
}

export async function handleListPaymentUserBlocks(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  if (!isPaymentAdmin(userId)) {
    writeJson(res, 403, { success: false, error: 'Admin permissions required' });
    return;
  }

  const limit = clampPositiveInteger(url.searchParams.get('limit'), 5000) || 500;
  const blocks = listPaymentUserBlocks(DEFAULT_WORKSPACE_ID, limit);
  writeJson(res, 200, {
    success: true,
    blocks
  });
}

export async function handleUpsertPaymentUserBlock(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  if (!isPaymentAdmin(userId)) {
    writeJson(res, 403, { success: false, error: 'Admin permissions required' });
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
    writeJson(res, 400, { success: false, error: 'Invalid payload' });
    return;
  }

  const targetUserId = clampPositiveInteger(body.userId, Number.MAX_SAFE_INTEGER);
  if (targetUserId == null) {
    writeJson(res, 400, { success: false, error: 'userId is required' });
    return;
  }

  const managementCheck = canManagePaymentUserBlock(userId, targetUserId);
  if (!managementCheck.allowed) {
    writeJson(res, 403, { success: false, error: managementCheck.error || 'Forbidden' });
    return;
  }

  const reason = normalizeOptionalString(body.reason, 512);
  const expiresAtRaw = body.expiresAt;
  let expiresAt: number | null = null;
  if (expiresAtRaw != null) {
    const parsed = Number(expiresAtRaw);
    if (!Number.isFinite(parsed) || Math.floor(parsed) <= Date.now()) {
      writeJson(res, 400, { success: false, error: 'expiresAt must be a unix timestamp in the future' });
      return;
    }
    expiresAt = Math.floor(parsed);
  }

  let block = null;
  try {
    block = upsertPaymentUserBlock({
      userId: targetUserId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      blockedByUserId: userId,
      reason,
      expiresAt
    });
  } catch (error) {
    console.error('[Payments] Failed to upsert payment user block:', error);
    writeJson(res, 400, { success: false, error: 'Failed to set payment block for this user' });
    return;
  }

  if (!block) {
    writeJson(res, 500, { success: false, error: 'Failed to set payment user block' });
    return;
  }

  writeJson(res, 200, {
    success: true,
    block
  });
  notifyPaymentUserBlocksUpdated({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: targetUserId
  });
  notifyPaymentAccessUpdated({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: targetUserId
  });
}

export async function handleDeletePaymentUserBlock(
  req: IncomingMessage,
  res: ServerResponse,
  targetUserId: number
): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  if (!isPaymentAdmin(userId)) {
    writeJson(res, 403, { success: false, error: 'Admin permissions required' });
    return;
  }

  const managementCheck = canManagePaymentUserBlock(userId, targetUserId);
  if (!managementCheck.allowed) {
    writeJson(res, 403, { success: false, error: managementCheck.error || 'Forbidden' });
    return;
  }

  const cleared = clearPaymentUserBlock(targetUserId, DEFAULT_WORKSPACE_ID);
  writeJson(res, 200, {
    success: true,
    cleared
  });
  if (cleared) {
    notifyPaymentUserBlocksUpdated({
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: targetUserId
    });
    notifyPaymentAccessUpdated({
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: targetUserId
    });
  }
}
