import { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import { verifyToken } from '../auth/jwt.js';
import { sessionRepository } from '../db/repositories/sessionRepository.js';
import { webhookRepository } from '../db/repositories/webhookRepository.js';
import { WEBHOOK_EVENTS } from '../webhooks/deliveryService.js';

function getAuthenticatedUserId(req: IncomingMessage): number | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  try {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    const dbSession = sessionRepository.findById(payload.sessionId);
    if (!dbSession || (dbSession.expires_at && dbSession.expires_at < Date.now())) {
      return null;
    }
    return payload.userId;
  } catch {
    return null;
  }
}

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

export async function handleCreateWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = getAuthenticatedUserId(req);
  if (!userId) {
    writeJson(res, 401, { success: false, error: 'Unauthorized' });
    return;
  }

  try {
    const body = await parseBody(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const targetUrl = typeof body.targetUrl === 'string' ? body.targetUrl.trim() : '';
    const requestedEvents = Array.isArray(body.events) ? body.events : [];

    if (!name || !targetUrl) {
      writeJson(res, 400, { success: false, error: 'name and targetUrl are required' });
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      writeJson(res, 400, { success: false, error: 'targetUrl must be a valid URL' });
      return;
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      writeJson(res, 400, { success: false, error: 'targetUrl protocol must be http or https' });
      return;
    }

    const events = requestedEvents
      .filter((event: unknown): event is string => typeof event === 'string')
      .filter((event) => WEBHOOK_EVENTS.includes(event as any));

    if (events.length === 0) {
      writeJson(res, 400, { success: false, error: `events must include at least one of: ${WEBHOOK_EVENTS.join(', ')}` });
      return;
    }

    const secret = crypto.randomBytes(24).toString('hex');
    const id = webhookRepository.create(userId, {
      name,
      target_url: parsedUrl.toString(),
      secret,
      event_filters: events,
      enabled: 1
    });

    writeJson(res, 201, {
      success: true,
      webhook: {
        id,
        name,
        targetUrl: parsedUrl.toString(),
        events,
        enabled: true,
        secret
      }
    });
  } catch (error) {
    writeJson(res, 400, { success: false, error: error instanceof Error ? error.message : 'Invalid request' });
  }
}

export async function handleListWebhooks(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const userId = getAuthenticatedUserId(req);
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
  const userId = getAuthenticatedUserId(req);
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
  const userId = getAuthenticatedUserId(req);
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
