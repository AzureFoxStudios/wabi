import crypto from 'crypto';
import { webhookRepository, type Webhook } from '../db/repositories/webhookRepository.js';

export const WEBHOOK_EVENTS = [
  'message.created',
  'channel.created',
  'user.joined',
  'user.left'
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500, 4000];
const REQUEST_TIMEOUT_MS = 5000;

function signPayload(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function shouldDispatchWebhook(webhook: Webhook, eventType: WebhookEventType): boolean {
  try {
    const filters = JSON.parse(webhook.event_filters);
    if (!Array.isArray(filters)) return false;
    return filters.includes('*') || filters.includes(eventType);
  } catch {
    return false;
  }
}

async function deliverWithRetry(webhook: { id: number; target_url: string; secret: string }, eventType: WebhookEventType, body: string): Promise<void> {
  const deliveryId = webhookRepository.createDelivery({
    webhook_id: webhook.id,
    event_type: eventType,
    payload_json: body
  });

  let attempt = 0;
  let lastError = 'Unknown delivery failure';

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    webhookRepository.markDeliveryAttempt(deliveryId, attempt);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(webhook.target_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-wabi-event': eventType,
          'x-wabi-delivery-id': String(deliveryId),
          'x-wabi-signature': signPayload(webhook.secret, body)
        },
        body,
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (response.ok) {
        webhookRepository.markDeliverySuccess(deliveryId, response.status, attempt);
        return;
      }

      lastError = `HTTP ${response.status}`;
      if (attempt >= MAX_ATTEMPTS) {
        webhookRepository.markDeliveryFailure(deliveryId, attempt, lastError, response.status);
        return;
      }
    } catch (error) {
      clearTimeout(timeout);
      lastError = error instanceof Error ? error.message : 'Network error';
      if (attempt >= MAX_ATTEMPTS) {
        webhookRepository.markDeliveryFailure(deliveryId, attempt, lastError);
        return;
      }
    }

    const retryDelay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }

  webhookRepository.markDeliveryFailure(deliveryId, attempt, lastError);
}

export async function dispatchWebhookEvent(eventType: WebhookEventType, payload: Record<string, any>): Promise<void> {
  const webhooks = webhookRepository.listEnabled().filter((webhook) => shouldDispatchWebhook(webhook, eventType));
  if (webhooks.length === 0) return;

  const body = JSON.stringify({
    event: eventType,
    timestamp: Date.now(),
    data: payload
  });

  await Promise.allSettled(
    webhooks.map((webhook) => deliverWithRetry(webhook, eventType, body))
  );
}
