import { randomUUID } from 'crypto';
import { DEFAULT_WORKSPACE_ID } from '../../constants.js';
import { stdbPaymentIngest, stdbPaymentRows, stdbPaymentsEnabled, parseStdbRowJson, lookupStdbUsername } from '../../payments/stdbRuntime.js';
import { escapeSqlLiteral } from '../../state-plane/stdbSyncClient.js';
import type { PaymentCheckoutMode, PaymentIntentStatus } from '../../../../shared/paymentContracts.js';
import db from '../database.js';
export type { PaymentCheckoutMode, PaymentIntentStatus } from '../../../../shared/paymentContracts.js';

export interface PaymentIntentRow {
  id: number;
  intent_id: string;
  workspace_id: string;
  created_by_user_id: number | null;
  channel_id: string | null;
  plugin_id: string;
  provider_name: string;
  provider_intent_id: string | null;
  amount_minor: number;
  currency: string;
  country_code: string | null;
  status: PaymentIntentStatus;
  checkout_mode: PaymentCheckoutMode;
  idempotency_key: string | null;
  customer_ref: string | null;
  description: string | null;
  metadata_json: string | null;
  presentation_json: string | null;
  failure_code: string | null;
  failure_message: string | null;
  expires_at: number | null;
  completed_at: number | null;
  refunded_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PaymentEventRow {
  id: number;
  intent_id: string;
  event_id: string;
  event_type: string;
  status: string | null;
  source: 'core' | 'plugin' | 'webhook' | 'manual';
  payload_json: string;
  signature_valid: number | null;
  idempotency_key: string | null;
  created_at: number;
}

export interface CreatePaymentIntentInput {
  intentId?: string;
  workspaceId?: string;
  createdByUserId?: number | null;
  channelId?: string | null;
  pluginId: string;
  providerName: string;
  providerIntentId?: string | null;
  amountMinor: number;
  currency: string;
  countryCode?: string | null;
  status?: PaymentIntentStatus;
  checkoutMode?: PaymentCheckoutMode;
  idempotencyKey?: string | null;
  customerRef?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  presentation?: Record<string, unknown> | null;
  expiresAt?: number | null;
}

export interface PaymentEventInput {
  eventId?: string;
  eventType: string;
  status?: string | null;
  source: 'core' | 'plugin' | 'webhook' | 'manual';
  payload?: Record<string, unknown> | null;
  signatureValid?: boolean | null;
  idempotencyKey?: string | null;
}

export interface PaymentIntentView extends Omit<PaymentIntentRow, 'metadata_json' | 'presentation_json'> {
  metadata: Record<string, unknown> | null;
  presentation: Record<string, unknown> | null;
}

export interface PaymentDonationSummaryRow {
  currency: string;
  amount_minor: number;
  payment_count: number;
}

export interface PaymentDonationLedgerRow {
  intent_id: string;
  created_by_user_id: number | null;
  donor_username: string | null;
  amount_minor: number;
  currency: string;
  status: PaymentIntentStatus;
  created_at: number;
  completed_at: number | null;
  refunded_at: number | null;
  updated_at: number;
}

const PAYMENT_STATUSES: ReadonlySet<PaymentIntentStatus> = new Set([
  'draft',
  'pending',
  'succeeded',
  'failed',
  'expired',
  'refunded',
  'disputed',
  'canceled'
]);

const CHECKOUT_MODES: ReadonlySet<PaymentCheckoutMode> = new Set([
  'qr',
  'payment_link',
  'app_switch',
  'redirect',
  'tap_to_pay'
]);

function generateIntentId(): string {
  return `pay_${randomUUID().replace(/-/g, '')}`;
}

function generateEventId(): string {
  return `payevt_${randomUUID().replace(/-/g, '')}`;
}

function safeParseJson(value: string | null): Record<string, unknown> | null {
  if (!value || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPaymentStatus(value: unknown, fallback: PaymentIntentStatus = 'draft'): PaymentIntentStatus {
  return typeof value === 'string' && PAYMENT_STATUSES.has(value as PaymentIntentStatus)
    ? (value as PaymentIntentStatus)
    : fallback;
}

function toCheckoutMode(value: unknown, fallback: PaymentCheckoutMode = 'payment_link'): PaymentCheckoutMode {
  return typeof value === 'string' && CHECKOUT_MODES.has(value as PaymentCheckoutMode)
    ? (value as PaymentCheckoutMode)
    : fallback;
}

function normalizeIntentRow(row: Partial<PaymentIntentRow> | null | undefined): PaymentIntentRow | null {
  const intentId = toStringOrNull(row?.intent_id);
  const workspaceId = toStringOrNull(row?.workspace_id);
  const pluginId = toStringOrNull(row?.plugin_id);
  const providerName = toStringOrNull(row?.provider_name);
  const currency = toStringOrNull(row?.currency);
  if (!intentId || !workspaceId || !pluginId || !providerName || !currency) return null;

  return {
    id: Math.floor(toNumberOrNull(row?.id) || 0),
    intent_id: intentId,
    workspace_id: workspaceId,
    created_by_user_id: toNumberOrNull(row?.created_by_user_id),
    channel_id: toStringOrNull(row?.channel_id),
    plugin_id: pluginId,
    provider_name: providerName,
    provider_intent_id: toStringOrNull(row?.provider_intent_id),
    amount_minor: Math.floor(toNumberOrNull(row?.amount_minor) || 0),
    currency: currency.toUpperCase(),
    country_code: toStringOrNull(row?.country_code)?.toUpperCase() || null,
    status: toPaymentStatus(row?.status),
    checkout_mode: toCheckoutMode(row?.checkout_mode),
    idempotency_key: toStringOrNull(row?.idempotency_key),
    customer_ref: toStringOrNull(row?.customer_ref),
    description: toStringOrNull(row?.description),
    metadata_json: typeof row?.metadata_json === 'string' ? row.metadata_json : null,
    presentation_json: typeof row?.presentation_json === 'string' ? row.presentation_json : null,
    failure_code: toStringOrNull(row?.failure_code),
    failure_message: toStringOrNull(row?.failure_message),
    expires_at: toNumberOrNull(row?.expires_at),
    completed_at: toNumberOrNull(row?.completed_at),
    refunded_at: toNumberOrNull(row?.refunded_at),
    created_at: Math.floor(toNumberOrNull(row?.created_at) || 0),
    updated_at: Math.floor(toNumberOrNull(row?.updated_at) || 0)
  };
}

function normalizeEventRow(row: Partial<PaymentEventRow> | null | undefined): PaymentEventRow | null {
  const intentId = toStringOrNull(row?.intent_id);
  const eventId = toStringOrNull(row?.event_id);
  const eventType = toStringOrNull(row?.event_type);
  const source = toStringOrNull(row?.source) as PaymentEventRow['source'] | null;
  if (!intentId || !eventId || !eventType || !source) return null;
  if (!['core', 'plugin', 'webhook', 'manual'].includes(source)) return null;

  return {
    id: Math.floor(toNumberOrNull(row?.id) || 0),
    intent_id: intentId,
    event_id: eventId,
    event_type: eventType,
    status: toStringOrNull(row?.status),
    source,
    payload_json: typeof row?.payload_json === 'string' ? row.payload_json : '{}',
    signature_valid: toNumberOrNull(row?.signature_valid),
    idempotency_key: toStringOrNull(row?.idempotency_key),
    created_at: Math.floor(toNumberOrNull(row?.created_at) || 0)
  };
}

function toView(row: PaymentIntentRow): PaymentIntentView {
  return {
    ...row,
    metadata: safeParseJson(row.metadata_json),
    presentation: safeParseJson(row.presentation_json)
  };
}

function viewToRow(view: PaymentIntentView): PaymentIntentRow {
  const { metadata, presentation, ...rest } = view;
  return {
    ...rest,
    metadata_json: metadata ? JSON.stringify(metadata) : null,
    presentation_json: presentation ? JSON.stringify(presentation) : null
  };
}

function isServerDonation(view: PaymentIntentView): boolean {
  return view.metadata?.kind === 'server_donation';
}

function donationSortKey(row: Pick<PaymentDonationLedgerRow, 'refunded_at' | 'completed_at' | 'created_at'>): number {
  return row.refunded_at ?? row.completed_at ?? row.created_at;
}

function sortPaymentIntentsByCreatedAtDesc(left: PaymentIntentRow, right: PaymentIntentRow): number {
  const diff = right.created_at - left.created_at;
  return diff !== 0 ? diff : right.intent_id.localeCompare(left.intent_id);
}

function sortPaymentEventsByCreatedAtDesc(left: PaymentEventRow, right: PaymentEventRow): number {
  const diff = right.created_at - left.created_at;
  return diff !== 0 ? diff : right.event_id.localeCompare(left.event_id);
}

export class PaymentRepository {
  private findByIntentIdLegacy(intentId: string): PaymentIntentRow | null {
    const row = db
      .prepare('SELECT * FROM payment_intents WHERE intent_id = ? LIMIT 1')
      .get(intentId) as PaymentIntentRow | undefined;
    return row || null;
  }

  private findByIdempotencyKeyLegacy(idempotencyKey: string): PaymentIntentRow | null {
    const row = db
      .prepare('SELECT * FROM payment_intents WHERE idempotency_key = ? LIMIT 1')
      .get(idempotencyKey) as PaymentIntentRow | undefined;
    return row || null;
  }

  private findByProviderIntentIdLegacy(pluginId: string, providerIntentId: string): PaymentIntentRow | null {
    const row = db
      .prepare('SELECT * FROM payment_intents WHERE plugin_id = ? AND provider_intent_id = ? LIMIT 1')
      .get(pluginId, providerIntentId) as PaymentIntentRow | undefined;
    return row || null;
  }

  private findByIntentIdStdb(intentId: string): PaymentIntentRow | null {
    const rows = stdbPaymentRows(
      'payment_intents.find_by_intent_id',
      `SELECT row_json FROM state_payment_intent WHERE intent_id = ${escapeSqlLiteral(intentId)} LIMIT 1`
    );
    return rows && rows.length > 0 ? normalizeIntentRow(parseStdbRowJson<PaymentIntentRow>(rows[0])) : null;
  }

  private findByIdempotencyKeyStdb(idempotencyKey: string): PaymentIntentRow | null {
    const rows = stdbPaymentRows(
      'payment_intents.find_by_idempotency_key',
      `SELECT row_json FROM state_payment_intent WHERE idempotency_key = ${escapeSqlLiteral(idempotencyKey)} LIMIT 1`
    );
    return rows && rows.length > 0 ? normalizeIntentRow(parseStdbRowJson<PaymentIntentRow>(rows[0])) : null;
  }

  private findByProviderIntentIdStdb(pluginId: string, providerIntentId: string): PaymentIntentRow | null {
    const rows = stdbPaymentRows(
      'payment_intents.find_by_provider_intent_id',
      `SELECT row_json FROM state_payment_intent WHERE plugin_id = ${escapeSqlLiteral(pluginId)}`
    );
    return (rows || [])
      .map((row) => normalizeIntentRow(parseStdbRowJson<PaymentIntentRow>(row)))
      .filter((row): row is PaymentIntentRow => Boolean(row))
      .find((row) => row.provider_intent_id === providerIntentId) || null;
  }

  private listRecentByWorkspaceLegacy(workspaceId: string, limit: number): PaymentIntentView[] {
    const rows = db
      .prepare(`
        SELECT *
        FROM payment_intents
        WHERE workspace_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(workspaceId, limit) as PaymentIntentRow[];
    return rows.map(toView);
  }

  private listRecentByWorkspaceStdb(workspaceId: string, limit: number): PaymentIntentView[] {
    const rows = stdbPaymentRows(
      'payment_intents.list_recent_by_workspace',
      `SELECT row_json FROM state_payment_intent WHERE workspace_id = ${escapeSqlLiteral(workspaceId)}`
    );
    return (rows || [])
      .map((row) => normalizeIntentRow(parseStdbRowJson<PaymentIntentRow>(row)))
      .filter((row): row is PaymentIntentRow => Boolean(row))
      .sort(sortPaymentIntentsByCreatedAtDesc)
      .slice(0, limit)
      .map(toView);
  }

  private listByCreatorLegacy(userId: number, workspaceId: string, limit: number): PaymentIntentView[] {
    const rows = db
      .prepare(`
        SELECT *
        FROM payment_intents
        WHERE workspace_id = ? AND created_by_user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(workspaceId, userId, limit) as PaymentIntentRow[];
    return rows.map(toView);
  }

  private listByCreatorStdb(userId: number, workspaceId: string, limit: number): PaymentIntentView[] {
    const rows = stdbPaymentRows(
      'payment_intents.list_by_creator',
      `SELECT row_json FROM state_payment_intent WHERE workspace_id = ${escapeSqlLiteral(workspaceId)}`
    );
    return (rows || [])
      .map((row) => normalizeIntentRow(parseStdbRowJson<PaymentIntentRow>(row)))
      .filter((row): row is PaymentIntentRow => Boolean(row))
      .filter((row) => row.created_by_user_id === Math.floor(userId))
      .sort(sortPaymentIntentsByCreatedAtDesc)
      .slice(0, limit)
      .map(toView);
  }

  private summarizeServerDonationsLegacy(workspaceId: string): PaymentDonationSummaryRow[] {
    return db
      .prepare(`
        SELECT
          currency,
          SUM(amount_minor) AS amount_minor,
          COUNT(*) AS payment_count
        FROM payment_intents
        WHERE workspace_id = ?
          AND status = 'succeeded'
          AND metadata_json LIKE '%"kind":"server_donation"%'
        GROUP BY currency
        ORDER BY currency ASC
      `)
      .all(workspaceId) as PaymentDonationSummaryRow[];
  }

  private summarizeServerDonationsStdb(workspaceId: string): PaymentDonationSummaryRow[] {
    const rows = stdbPaymentRows(
      'payment_intents.summarize_server_donations',
      `SELECT row_json FROM state_payment_intent WHERE workspace_id = ${escapeSqlLiteral(workspaceId)} AND status = 'succeeded'`
    );
    const totals = new Map<string, PaymentDonationSummaryRow>();
    for (const row of rows || []) {
      const parsed = normalizeIntentRow(parseStdbRowJson<PaymentIntentRow>(row));
      if (!parsed) continue;
      const view = toView(parsed);
      if (!isServerDonation(view)) continue;
      const current = totals.get(view.currency) || {
        currency: view.currency,
        amount_minor: 0,
        payment_count: 0
      };
      current.amount_minor += view.amount_minor;
      current.payment_count += 1;
      totals.set(view.currency, current);
    }
    return [...totals.values()].sort((left, right) => left.currency.localeCompare(right.currency));
  }

  private listServerDonationActivityLegacy(workspaceId: string, limit: number): PaymentDonationLedgerRow[] {
    return db
      .prepare(`
        SELECT
          pi.intent_id,
          pi.created_by_user_id,
          u.username AS donor_username,
          pi.amount_minor,
          pi.currency,
          pi.status,
          pi.created_at,
          pi.completed_at,
          pi.refunded_at,
          pi.updated_at
        FROM payment_intents pi
        LEFT JOIN users u ON u.user_id = pi.created_by_user_id
        WHERE pi.workspace_id = ?
          AND pi.metadata_json LIKE '%"kind":"server_donation"%'
          AND pi.status IN ('succeeded', 'refunded')
        ORDER BY COALESCE(pi.refunded_at, pi.completed_at, pi.created_at) DESC, pi.intent_id DESC
        LIMIT ?
      `)
      .all(workspaceId, limit) as PaymentDonationLedgerRow[];
  }

  private listServerDonationActivityStdb(workspaceId: string, limit: number): PaymentDonationLedgerRow[] {
    const rows = stdbPaymentRows(
      'payment_intents.list_server_donation_activity',
      `SELECT row_json FROM state_payment_intent WHERE workspace_id = ${escapeSqlLiteral(workspaceId)}`
    );
    const ledger: PaymentDonationLedgerRow[] = [];
    for (const row of rows || []) {
      const parsed = normalizeIntentRow(parseStdbRowJson<PaymentIntentRow>(row));
      if (!parsed) continue;
      const view = toView(parsed);
      if (!isServerDonation(view)) continue;
      if (!['succeeded', 'refunded'].includes(view.status)) continue;
      ledger.push({
        intent_id: view.intent_id,
        created_by_user_id: view.created_by_user_id,
        donor_username: lookupStdbUsername(view.created_by_user_id),
        amount_minor: view.amount_minor,
        currency: view.currency,
        status: view.status,
        created_at: view.created_at,
        completed_at: view.completed_at,
        refunded_at: view.refunded_at,
        updated_at: view.updated_at
      });
    }
    return ledger
      .sort((left, right) => {
        const diff = donationSortKey(right) - donationSortKey(left);
        return diff !== 0 ? diff : right.intent_id.localeCompare(left.intent_id);
      })
      .slice(0, limit);
  }

  private findEventByEventIdLegacy(eventId: string): PaymentEventRow | null {
    const row = db
      .prepare('SELECT * FROM payment_events WHERE event_id = ? LIMIT 1')
      .get(eventId) as PaymentEventRow | undefined;
    return row || null;
  }

  private findEventByEventIdStdb(eventId: string): PaymentEventRow | null {
    const rows = stdbPaymentRows(
      'payment_events.find_by_event_id',
      `SELECT row_json FROM state_payment_event WHERE event_id = ${escapeSqlLiteral(eventId)} LIMIT 1`
    );
    return rows && rows.length > 0 ? normalizeEventRow(parseStdbRowJson<PaymentEventRow>(rows[0])) : null;
  }

  private listEventsLegacy(intentId: string, limit: number): PaymentEventRow[] {
    return db
      .prepare(`
        SELECT *
        FROM payment_events
        WHERE intent_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(intentId, limit) as PaymentEventRow[];
  }

  private listEventsStdb(intentId: string, limit: number): PaymentEventRow[] {
    const rows = stdbPaymentRows(
      'payment_events.list_by_intent',
      `SELECT row_json FROM state_payment_event WHERE intent_id = ${escapeSqlLiteral(intentId)}`
    );
    return (rows || [])
      .map((row) => normalizeEventRow(parseStdbRowJson<PaymentEventRow>(row)))
      .filter((row): row is PaymentEventRow => Boolean(row))
      .sort(sortPaymentEventsByCreatedAtDesc)
      .slice(0, limit);
  }

  private upsertStdbIntent(row: PaymentIntentRow): void {
    stdbPaymentIngest('payment_intents.write', 'upsert_intent', {
      intentId: row.intent_id,
      row
    });
  }

  private appendStdbEvent(row: PaymentEventRow): void {
    stdbPaymentIngest('payment_events.write', 'append_event', {
      eventId: row.event_id,
      row
    });
  }

  findByIntentId(intentId: string): PaymentIntentRow | null {
    if (stdbPaymentsEnabled()) {
      const shadow = this.findByIntentIdStdb(intentId);
      if (shadow) return shadow;
      const legacy = this.findByIntentIdLegacy(intentId);
      if (legacy) this.upsertStdbIntent(legacy);
      return legacy;
    }
    return this.findByIntentIdLegacy(intentId);
  }

  findViewByIntentId(intentId: string): PaymentIntentView | null {
    const row = this.findByIntentId(intentId);
    return row ? toView(row) : null;
  }

  findByIdempotencyKey(idempotencyKey: string): PaymentIntentRow | null {
    if (stdbPaymentsEnabled()) {
      const shadow = this.findByIdempotencyKeyStdb(idempotencyKey);
      if (shadow) return shadow;
      const legacy = this.findByIdempotencyKeyLegacy(idempotencyKey);
      if (legacy) this.upsertStdbIntent(legacy);
      return legacy;
    }
    return this.findByIdempotencyKeyLegacy(idempotencyKey);
  }

  findByProviderIntentId(pluginId: string, providerIntentId: string): PaymentIntentRow | null {
    if (stdbPaymentsEnabled()) {
      const shadow = this.findByProviderIntentIdStdb(pluginId, providerIntentId);
      if (shadow) return shadow;
      const legacy = this.findByProviderIntentIdLegacy(pluginId, providerIntentId);
      if (legacy) this.upsertStdbIntent(legacy);
      return legacy;
    }
    return this.findByProviderIntentIdLegacy(pluginId, providerIntentId);
  }

  createIntent(input: CreatePaymentIntentInput): PaymentIntentView {
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return toView(existing);
    }

    const now = Date.now();
    const intentId = input.intentId || generateIntentId();
    const row: Omit<PaymentIntentRow, 'id'> = {
      intent_id: intentId,
      workspace_id: input.workspaceId || DEFAULT_WORKSPACE_ID,
      created_by_user_id: input.createdByUserId ?? null,
      channel_id: input.channelId ?? null,
      plugin_id: input.pluginId,
      provider_name: input.providerName,
      provider_intent_id: input.providerIntentId ?? null,
      amount_minor: Math.floor(input.amountMinor),
      currency: input.currency.toUpperCase(),
      country_code: input.countryCode ? input.countryCode.toUpperCase() : null,
      status: input.status || 'draft',
      checkout_mode: input.checkoutMode || 'payment_link',
      idempotency_key: input.idempotencyKey ?? null,
      customer_ref: input.customerRef ?? null,
      description: input.description ?? null,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
      presentation_json: input.presentation ? JSON.stringify(input.presentation) : null,
      failure_code: null,
      failure_message: null,
      expires_at: input.expiresAt ?? null,
      completed_at: null,
      refunded_at: null,
      created_at: now,
      updated_at: now
    };

    db.prepare(`
      INSERT INTO payment_intents (
        intent_id,
        workspace_id,
        created_by_user_id,
        channel_id,
        plugin_id,
        provider_name,
        provider_intent_id,
        amount_minor,
        currency,
        country_code,
        status,
        checkout_mode,
        idempotency_key,
        customer_ref,
        description,
        metadata_json,
        presentation_json,
        failure_code,
        failure_message,
        expires_at,
        completed_at,
        refunded_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.intent_id,
      row.workspace_id,
      row.created_by_user_id,
      row.channel_id,
      row.plugin_id,
      row.provider_name,
      row.provider_intent_id,
      row.amount_minor,
      row.currency,
      row.country_code,
      row.status,
      row.checkout_mode,
      row.idempotency_key,
      row.customer_ref,
      row.description,
      row.metadata_json,
      row.presentation_json,
      row.failure_code,
      row.failure_message,
      row.expires_at,
      row.completed_at,
      row.refunded_at,
      row.created_at,
      row.updated_at
    );

    const created = this.findByIntentIdLegacy(intentId);
    if (!created) {
      throw new Error(`payment_intent_create_failed:${intentId}`);
    }
    if (stdbPaymentsEnabled()) {
      this.upsertStdbIntent(created);
    }
    return toView(created);
  }

  updatePresentation(intentId: string, checkoutMode: PaymentCheckoutMode, presentation: Record<string, unknown> | null): boolean {
    const result = db.prepare(`
      UPDATE payment_intents
      SET checkout_mode = ?, presentation_json = ?, updated_at = ?
      WHERE intent_id = ?
    `).run(checkoutMode, presentation ? JSON.stringify(presentation) : null, Date.now(), intentId);
    const updated = (result.changes || 0) > 0;
    if (updated && stdbPaymentsEnabled()) {
      const row = this.findByIntentIdLegacy(intentId);
      if (row) this.upsertStdbIntent(row);
    }
    return updated;
  }

  setProviderIntentId(intentId: string, providerIntentId: string): boolean {
    const result = db.prepare(`
      UPDATE payment_intents
      SET provider_intent_id = ?, updated_at = ?
      WHERE intent_id = ?
    `).run(providerIntentId, Date.now(), intentId);
    const updated = (result.changes || 0) > 0;
    if (updated && stdbPaymentsEnabled()) {
      const row = this.findByIntentIdLegacy(intentId);
      if (row) this.upsertStdbIntent(row);
    }
    return updated;
  }

  setStatus(
    intentId: string,
    status: PaymentIntentStatus,
    options: {
      failureCode?: string | null;
      failureMessage?: string | null;
      metadata?: Record<string, unknown> | null;
      expiresAt?: number | null;
    } = {}
  ): boolean {
    const now = Date.now();
    const completedAt = status === 'succeeded' ? now : null;
    const refundedAt = status === 'refunded' ? now : null;
    const existing = options.metadata ? this.findByIntentId(intentId) : null;
    const existingMetadata = existing ? safeParseJson(existing.metadata_json) : null;
    const mergedMetadata =
      options.metadata && existingMetadata
        ? { ...existingMetadata, ...options.metadata }
        : options.metadata || null;

    const result = db.prepare(`
      UPDATE payment_intents
      SET
        status = ?,
        failure_code = ?,
        failure_message = ?,
        metadata_json = COALESCE(?, metadata_json),
        expires_at = COALESCE(?, expires_at),
        completed_at = COALESCE(?, completed_at),
        refunded_at = COALESCE(?, refunded_at),
        updated_at = ?
      WHERE intent_id = ?
    `).run(
      status,
      options.failureCode ?? null,
      options.failureMessage ?? null,
      mergedMetadata ? JSON.stringify(mergedMetadata) : null,
      options.expiresAt ?? null,
      completedAt,
      refundedAt,
      now,
      intentId
    );

    const updated = (result.changes || 0) > 0;
    if (updated && stdbPaymentsEnabled()) {
      const row = this.findByIntentIdLegacy(intentId);
      if (row) this.upsertStdbIntent(row);
    }
    return updated;
  }

  addEvent(intentId: string, event: PaymentEventInput): PaymentEventRow | null {
    const eventId = event.eventId || generateEventId();
    const createdAt = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO payment_events (
        intent_id,
        event_id,
        event_type,
        status,
        source,
        payload_json,
        signature_valid,
        idempotency_key,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      intentId,
      eventId,
      event.eventType,
      event.status ?? null,
      event.source,
      JSON.stringify(event.payload || {}),
      event.signatureValid == null ? null : (event.signatureValid ? 1 : 0),
      event.idempotencyKey ?? null,
      createdAt
    );

    const row = this.findEventByEventIdLegacy(eventId);
    if (row && stdbPaymentsEnabled()) {
      this.appendStdbEvent(row);
    }
    return row;
  }

  /**
   * Atomically update status and record an event in a single transaction.
   * Prevents inconsistent state if the process crashes between the two writes.
   */
  setStatusWithEvent(
    intentId: string,
    status: PaymentIntentStatus,
    statusOptions: {
      failureCode?: string | null;
      failureMessage?: string | null;
      metadata?: Record<string, unknown> | null;
      expiresAt?: number | null;
    },
    event: PaymentEventInput
  ): { statusUpdated: boolean; event: PaymentEventRow | null } {
    const txn = db.transaction!(() => {
      const statusUpdated = this.setStatus(intentId, status, statusOptions);
      const evt = this.addEvent(intentId, event);
      return { statusUpdated, event: evt };
    });
    return txn();
  }

  listRecentByWorkspace(workspaceId: string = DEFAULT_WORKSPACE_ID, limit = 50): PaymentIntentView[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    if (stdbPaymentsEnabled()) {
      const shadow = this.listRecentByWorkspaceStdb(workspaceId, safeLimit);
      if (shadow.length > 0) return shadow;
      const legacy = this.listRecentByWorkspaceLegacy(workspaceId, safeLimit);
      for (const view of legacy) {
        this.upsertStdbIntent(viewToRow(view));
      }
      return legacy;
    }
    return this.listRecentByWorkspaceLegacy(workspaceId, safeLimit);
  }

  listByCreator(userId: number, workspaceId: string = DEFAULT_WORKSPACE_ID, limit = 200): PaymentIntentView[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    if (stdbPaymentsEnabled()) {
      const shadow = this.listByCreatorStdb(userId, workspaceId, safeLimit);
      if (shadow.length > 0) return shadow;
      const legacy = this.listByCreatorLegacy(userId, workspaceId, safeLimit);
      for (const view of legacy) {
        this.upsertStdbIntent(viewToRow(view));
      }
      return legacy;
    }
    return this.listByCreatorLegacy(userId, workspaceId, safeLimit);
  }

  summarizeServerDonations(workspaceId: string = DEFAULT_WORKSPACE_ID): PaymentDonationSummaryRow[] {
    if (stdbPaymentsEnabled()) {
      const shadow = this.summarizeServerDonationsStdb(workspaceId);
      if (shadow.length > 0) return shadow;
      const legacy = this.summarizeServerDonationsLegacy(workspaceId);
      const backfill = this.listRecentByWorkspaceLegacy(workspaceId, 1000).filter(isServerDonation);
      for (const view of backfill) {
        this.upsertStdbIntent(viewToRow(view));
      }
      return legacy;
    }
    return this.summarizeServerDonationsLegacy(workspaceId);
  }

  listServerDonationActivity(workspaceId: string = DEFAULT_WORKSPACE_ID, limit = 50): PaymentDonationLedgerRow[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    if (stdbPaymentsEnabled()) {
      const shadow = this.listServerDonationActivityStdb(workspaceId, safeLimit);
      if (shadow.length > 0) return shadow;
      const legacy = this.listServerDonationActivityLegacy(workspaceId, safeLimit);
      const backfill = this.listRecentByWorkspaceLegacy(workspaceId, 1000).filter((view) => isServerDonation(view) && ['succeeded', 'refunded'].includes(view.status));
      for (const view of backfill) {
        this.upsertStdbIntent(viewToRow(view));
      }
      return legacy;
    }
    return this.listServerDonationActivityLegacy(workspaceId, safeLimit);
  }

  listEvents(intentId: string, limit = 100): PaymentEventRow[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    if (stdbPaymentsEnabled()) {
      const shadow = this.listEventsStdb(intentId, safeLimit);
      if (shadow.length > 0) return shadow;
      const legacy = this.listEventsLegacy(intentId, safeLimit);
      for (const row of legacy) {
        this.appendStdbEvent(row);
      }
      return legacy;
    }
    return this.listEventsLegacy(intentId, safeLimit);
  }

  findEventByEventId(eventId: string): PaymentEventRow | null {
    if (stdbPaymentsEnabled()) {
      const shadow = this.findEventByEventIdStdb(eventId);
      if (shadow) return shadow;
      const legacy = this.findEventByEventIdLegacy(eventId);
      if (legacy) this.appendStdbEvent(legacy);
      return legacy;
    }
    return this.findEventByEventIdLegacy(eventId);
  }
}

export const paymentRepository = new PaymentRepository();
