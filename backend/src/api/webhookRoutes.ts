import { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import { getAuthenticatedUserIdFromRequest } from '../auth/requestAuth.js';
import { webhookRepository } from '../db/repositories/webhookRepository.js';
import { WEBHOOK_EVENTS, type WebhookEventType, deliverWebhookEventToTarget } from '../webhooks/deliveryService.js';

function parseBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: Record<string, any>) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseAndValidateWebhookInput(body: Record<string, any>): {
  name: string;
  targetUrl: string;
  parsedUrl: URL;
  events: string[];
} | { error: string } {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const targetUrl = typeof body.targetUrl === 'string' ? body.targetUrl.trim() : '';
  const requestedEvents = Array.isArray(body.events) ? body.events : [];

  if (!name || !targetUrl) {
    return { error: 'name and targetUrl are required' };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return { error: 'targetUrl must be a valid URL' };
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { error: 'targetUrl protocol must be http or https' };
  }

  const events = requestedEvents
    .filter((event: unknown): event is string => typeof event === 'string')
    .filter((event) => event === '*' || WEBHOOK_EVENTS.includes(event as any));

  if (events.length === 0) {
    return { error: `events must include '*' or one of: ${WEBHOOK_EVENTS.join(', ')}` };
  }

  return { name, targetUrl, parsedUrl, events };
}

export async function handleCreateWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const body = await parseBody(req);
    const parsed = parseAndValidateWebhookInput(body);
    if ('error' in parsed) {
      writeJson(res, 400, { success: false, error: parsed.error });
      return;
    }

    const secret = crypto.randomBytes(24).toString('hex');
    const id = webhookRepository.create(userId, {
      name: parsed.name,
      target_url: parsed.parsedUrl.toString(),
      secret,
      event_filters: parsed.events,
      enabled: 1
    });

    writeJson(res, 201, {
      success: true,
      webhook: {
        id,
        name: parsed.name,
        targetUrl: parsed.parsedUrl.toString(),
        events: parsed.events,
        enabled: true,
        secret
      }
    });
  } catch (error) {
    writeJson(res, 400, { success: false, error: error instanceof Error ? error.message : 'Invalid request' });
  }
}

export async function handleListWebhooks(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  const webhooks = webhookRepository.listByUser(userId).map((webhook) => ({
    id: webhook.id,
    name: webhook.name,
    targetUrl: webhook.target_url,
    events: JSON.parse(webhook.event_filters),
    enabled: webhook.enabled === 1,
    createdAt: webhook.created_at,
    updatedAt: webhook.updated_at
  }));

  writeJson(res, 200, { success: true, webhooks });
}

export async function handleDeleteWebhook(req: IncomingMessage, res: ServerResponse, webhookId: number): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  const deleted = webhookRepository.delete(webhookId, userId);
  if (!deleted) {
    writeJson(res, 404, { success: false, error: 'Webhook not found' });
    return;
  }

  writeJson(res, 200, { success: true });
}

export async function handleListWebhookDeliveries(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  const deliveries = webhookRepository.listDeliveriesForUser(userId).map((delivery) => ({
    id: delivery.id,
    webhookId: delivery.webhook_id,
    webhookName: delivery.webhook_name,
    eventType: delivery.event_type,
    status: delivery.status,
    attemptCount: delivery.attempt_count,
    responseCode: delivery.response_code,
    lastError: delivery.last_error,
    createdAt: delivery.created_at,
    updatedAt: delivery.updated_at,
    deliveredAt: delivery.delivered_at
  }));

  writeJson(res, 200, { success: true, deliveries });
}

export async function handleUpdateWebhook(req: IncomingMessage, res: ServerResponse, webhookId: number): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  const existing = webhookRepository.findByIdForUser(webhookId, userId);
  if (!existing) {
    writeJson(res, 404, { success: false, error: 'Webhook not found' });
    return;
  }

  try {
    const body = await parseBody(req);
    const updates: { name?: string; target_url?: string; event_filters?: string[]; enabled?: number } = {};

    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        writeJson(res, 400, { success: false, error: 'name must be a non-empty string' });
        return;
      }
      updates.name = body.name.trim();
    }

    if (Object.prototype.hasOwnProperty.call(body, 'targetUrl')) {
      if (typeof body.targetUrl !== 'string' || !body.targetUrl.trim()) {
        writeJson(res, 400, { success: false, error: 'targetUrl must be a non-empty string' });
        return;
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(body.targetUrl.trim());
      } catch {
        writeJson(res, 400, { success: false, error: 'targetUrl must be a valid URL' });
        return;
      }
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        writeJson(res, 400, { success: false, error: 'targetUrl protocol must be http or https' });
        return;
      }
      updates.target_url = parsedUrl.toString();
    }

    if (Object.prototype.hasOwnProperty.call(body, 'events')) {
      if (!Array.isArray(body.events)) {
        writeJson(res, 400, { success: false, error: 'events must be an array' });
        return;
      }
      const events = body.events
        .filter((event: unknown): event is string => typeof event === 'string')
        .filter((event) => event === '*' || WEBHOOK_EVENTS.includes(event as any));
      if (events.length === 0) {
        writeJson(res, 400, { success: false, error: `events must include '*' or one of: ${WEBHOOK_EVENTS.join(', ')}` });
        return;
      }
      updates.event_filters = events;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
      updates.enabled = body.enabled ? 1 : 0;
    }

    const updated = webhookRepository.update(webhookId, userId, updates);
    if (!updated) {
      writeJson(res, 400, { success: false, error: 'No valid fields to update' });
      return;
    }

    const webhook = webhookRepository.findByIdForUser(webhookId, userId);
    writeJson(res, 200, {
      success: true,
      webhook: webhook ? {
        id: webhook.id,
        name: webhook.name,
        targetUrl: webhook.target_url,
        events: JSON.parse(webhook.event_filters),
        enabled: webhook.enabled === 1,
        createdAt: webhook.created_at,
        updatedAt: webhook.updated_at
      } : null
    });
  } catch (error) {
    writeJson(res, 400, { success: false, error: error instanceof Error ? error.message : 'Invalid request' });
  }
}

export async function handleRotateWebhookSecret(req: IncomingMessage, res: ServerResponse, webhookId: number): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  const existing = webhookRepository.findByIdForUser(webhookId, userId);
  if (!existing) {
    writeJson(res, 404, { success: false, error: 'Webhook not found' });
    return;
  }

  const secret = crypto.randomBytes(24).toString('hex');
  webhookRepository.rotateSecret(webhookId, userId, secret);
  writeJson(res, 200, { success: true, secret });
}

export async function handleTestWebhook(req: IncomingMessage, res: ServerResponse, webhookId: number): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  const webhook = webhookRepository.findByIdForUser(webhookId, userId);
  if (!webhook) {
    writeJson(res, 404, { success: false, error: 'Webhook not found' });
    return;
  }

  try {
    const eventType: WebhookEventType = 'message.created';
    await deliverWebhookEventToTarget(
      { id: webhook.id, target_url: webhook.target_url, secret: webhook.secret },
      eventType,
      {
        test: true,
        webhookId: webhook.id,
        issuedByUserId: userId,
        message: 'Webhook test event from Wabi admin endpoint'
      }
    );
    writeJson(res, 200, { success: true });
  } catch (error) {
    writeJson(res, 500, { success: false, error: error instanceof Error ? error.message : 'Failed to deliver test webhook' });
  }
}

export async function handleGetWebhookDelivery(req: IncomingMessage, res: ServerResponse, deliveryId: number): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  const delivery = webhookRepository.findDeliveryForUser(deliveryId, userId);
  if (!delivery) {
    writeJson(res, 404, { success: false, error: 'Delivery not found' });
    return;
  }

  writeJson(res, 200, {
    success: true,
    delivery: {
      id: delivery.id,
      webhookId: delivery.webhook_id,
      webhookName: delivery.webhook_name,
      eventType: delivery.event_type,
      status: delivery.status,
      attemptCount: delivery.attempt_count,
      responseCode: delivery.response_code,
      lastError: delivery.last_error,
      payloadJson: delivery.payload_json,
      createdAt: delivery.created_at,
      updatedAt: delivery.updated_at,
      deliveredAt: delivery.delivered_at
    }
  });
}

export async function handleRetryWebhookDelivery(req: IncomingMessage, res: ServerResponse, deliveryId: number): Promise<void> {
  const userId = getAuthenticatedUserIdFromRequest(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }
  const delivery = webhookRepository.findDeliveryForUser(deliveryId, userId);
  if (!delivery) {
    writeJson(res, 404, { success: false, error: 'Delivery not found' });
    return;
  }

  const eventType = delivery.event_type as WebhookEventType;
  if (!WEBHOOK_EVENTS.includes(eventType)) {
    writeJson(res, 400, { success: false, error: 'Cannot retry unknown event type' });
    return;
  }

  try {
    const parsed = JSON.parse(delivery.payload_json || '{}') as { data?: Record<string, any> };
    await deliverWebhookEventToTarget(
      { id: delivery.webhook_id, target_url: delivery.target_url, secret: delivery.secret },
      eventType,
      parsed?.data && typeof parsed.data === 'object' ? parsed.data : {}
    );
    writeJson(res, 200, { success: true });
  } catch (error) {
    writeJson(res, 500, { success: false, error: error instanceof Error ? error.message : 'Failed to retry delivery' });
  }
}
