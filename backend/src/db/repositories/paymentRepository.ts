import { randomUUID } from 'crypto';
import db from '../database.js';
import { DEFAULT_WORKSPACE_ID } from '../../constants.js';

export type PaymentIntentStatus =
  | 'draft'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'refunded'
  | 'disputed'
  | 'canceled';

export type PaymentCheckoutMode = 'qr' | 'payment_link' | 'app_switch' | 'redirect' | 'tap_to_pay';

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

function toView(row: PaymentIntentRow): PaymentIntentView {
  return {
    ...row,
    metadata: safeParseJson(row.metadata_json),
    presentation: safeParseJson(row.presentation_json)
  };
}

export class PaymentRepository {
  findByIntentId(intentId: string): PaymentIntentRow | null {
    const row = db
      .prepare('SELECT * FROM payment_intents WHERE intent_id = ? LIMIT 1')
      .get(intentId) as PaymentIntentRow | undefined;
    return row || null;
  }

  findViewByIntentId(intentId: string): PaymentIntentView | null {
    const row = this.findByIntentId(intentId);
    return row ? toView(row) : null;
  }

  findByIdempotencyKey(idempotencyKey: string): PaymentIntentRow | null {
    const row = db
      .prepare('SELECT * FROM payment_intents WHERE idempotency_key = ? LIMIT 1')
      .get(idempotencyKey) as PaymentIntentRow | undefined;
    return row || null;
  }

  findByProviderIntentId(pluginId: string, providerIntentId: string): PaymentIntentRow | null {
    const row = db
      .prepare('SELECT * FROM payment_intents WHERE plugin_id = ? AND provider_intent_id = ? LIMIT 1')
      .get(pluginId, providerIntentId) as PaymentIntentRow | undefined;
    return row || null;
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

    const created = this.findByIntentId(intentId);
    if (!created) {
      throw new Error(`payment_intent_create_failed:${intentId}`);
    }
    return toView(created);
  }

  updatePresentation(intentId: string, checkoutMode: PaymentCheckoutMode, presentation: Record<string, unknown> | null): boolean {
    const result = db.prepare(`
      UPDATE payment_intents
      SET checkout_mode = ?, presentation_json = ?, updated_at = ?
      WHERE intent_id = ?
    `).run(checkoutMode, presentation ? JSON.stringify(presentation) : null, Date.now(), intentId);
    return (result.changes || 0) > 0;
  }

  setProviderIntentId(intentId: string, providerIntentId: string): boolean {
    const result = db.prepare(`
      UPDATE payment_intents
      SET provider_intent_id = ?, updated_at = ?
      WHERE intent_id = ?
    `).run(providerIntentId, Date.now(), intentId);
    return (result.changes || 0) > 0;
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
      options.metadata ? JSON.stringify(options.metadata) : null,
      options.expiresAt ?? null,
      completedAt,
      refundedAt,
      now,
      intentId
    );

    return (result.changes || 0) > 0;
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

    const row = db
      .prepare('SELECT * FROM payment_events WHERE event_id = ? LIMIT 1')
      .get(eventId) as PaymentEventRow | undefined;
    return row || null;
  }

  listRecentByWorkspace(workspaceId: string = DEFAULT_WORKSPACE_ID, limit = 50): PaymentIntentView[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = db
      .prepare(`
        SELECT *
        FROM payment_intents
        WHERE workspace_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(workspaceId, safeLimit) as PaymentIntentRow[];
    return rows.map(toView);
  }

  listEvents(intentId: string, limit = 100): PaymentEventRow[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    return db
      .prepare(`
        SELECT *
        FROM payment_events
        WHERE intent_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(intentId, safeLimit) as PaymentEventRow[];
  }

  findEventByEventId(eventId: string): PaymentEventRow | null {
    const row = db
      .prepare('SELECT * FROM payment_events WHERE event_id = ? LIMIT 1')
      .get(eventId) as PaymentEventRow | undefined;
    return row || null;
  }
}

export const paymentRepository = new PaymentRepository();
