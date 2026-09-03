# Payments Adapter Contract

Last updated: 2026-03-11
Scope: adapter contract for verified payment sensing between Wabi payment plugins and external PSP/acquirer integrations.

## 1) Purpose

Wabi core creates payment requests. It does not hold funds, store cards, or log into user bank accounts.

The adapter layer exists so Wabi can get industry-standard settlement truth from a real provider without moving sensitive PSP credentials into the frontend or into shared STDB state.

Use this contract when a payment plugin needs:
- real checkout creation
- real status polling
- real refunds
- real webhook-confirmed completion

Do not use this contract for:
- manual cash
- QR-only request generation with no provider confirmation path
- fake “app returned so payment succeeded” logic

## 2) Trust Boundaries

Wabi core owns:
- request creation
- shared request state
- UI presentation
- audit/events
- backend auth/RBAC

Adapter owns:
- PSP credentials
- PSP SDK/API calls
- provider-specific normalization
- settlement truth from the PSP

Wabi must never store:
- card PANs
- bank credentials
- PSP secret keys in frontend code

## 3) Truth Model

Authoritative settlement sources, in order:
1. signed webhook from provider/adapter
2. signed/authorized status API from provider/adapter
3. manual confirmation flow

Not authoritative:
- browser redirect completion
- mobile app return/deep-link return
- user claiming they paid

Those can improve UX, but they must not mark a request paid by themselves.

## 4) Outbound Calls From Wabi Plugin To Adapter

Both current provider plugins use the same adapter path shape:
- `POST /v1/intents/create`
- `POST /v1/intents/status`
- `POST /v1/intents/refund`

Common headers:
- `content-type: application/json`
- `x-wabi-provider: <plugin-id>`
- `authorization: Bearer <adapter-token>` when configured
- `x-idempotency-key: <key>` on create/refund when present

Optional signed-request headers when adapter signing is enabled:
- `x-wabi-adapter-timestamp`
- `x-wabi-adapter-nonce`
- `x-wabi-adapter-signature`

Signature base:
- `<timestamp>.<nonce>.<raw-json-body>`

Signature algorithm:
- `HMAC-SHA256(signing_secret, signature_base)`

## 5) Create Intent Request

`POST /v1/intents/create`

Request body:
```json
{
  "providerIntentId": "provider-scoped-id-generated-by-plugin",
  "intentId": "wabi-intent-id",
  "workspaceId": "default-workspace",
  "channelId": "optional-channel-id",
  "amountMinor": 10000,
  "currency": "THB",
  "countryCode": "TH",
  "customerRef": "optional-non-sensitive-reference",
  "description": "optional description",
  "metadata": {},
  "methodId": "promptpay_qr_or_provider_method",
  "idempotencyKey": "stable-create-key"
}
```

Required adapter response:
```json
{
  "providerIntentId": "provider-intent-id",
  "status": "pending",
  "presentation": {
    "mode": "payment_link",
    "url": "https://..."
  },
  "expiresAt": 1760000000000,
  "metadata": {}
}
```

Allowed `presentation.mode` values:
- `qr`
- `payment_link`
- `redirect`
- `app_switch`
- `tap_to_pay`

The adapter response must be enough for Wabi to render the request artifact immediately.

## 6) Status Request

`POST /v1/intents/status`

Request body:
```json
{
  "providerIntentId": "provider-intent-id"
}
```

Response:
```json
{
  "status": "pending",
  "presentation": {
    "mode": "payment_link",
    "url": "https://..."
  },
  "expiresAt": 1760000000000,
  "metadata": {}
}
```

Status is used as:
- webhook fallback
- periodic reconciliation
- operator recovery path

## 7) Refund Request

`POST /v1/intents/refund`

Request body:
```json
{
  "providerIntentId": "provider-intent-id",
  "amountMinor": 10000,
  "reason": "admin or user reason",
  "idempotencyKey": "stable-refund-key"
}
```

Response:
```json
{
  "status": "refunded",
  "providerRefundId": "provider-refund-id",
  "metadata": {}
}
```

Accepted refund response statuses:
- `refunded`
- `pending`
- `failed`

## 8) Webhook Contract Back Into Wabi

Wabi webhook ingress:
- `POST /api/payments/webhooks/:pluginId`

Current plugin-specific signature headers:
- Thai: `x-th-payments-signature`
- Western: `x-west-payments-signature`

Signature algorithm:
- `HMAC-SHA256(plugin_webhook_secret, raw_body)`

Minimum webhook JSON:
```json
{
  "eventId": "provider-event-id",
  "eventType": "payment.status",
  "intentId": "optional-wabi-intent-id",
  "providerIntentId": "optional-provider-intent-id",
  "status": "succeeded",
  "occurredAt": 1760000000000
}
```

Notes:
- either `intentId` or `providerIntentId` must be present
- webhook payload may include extra provider raw data
- webhook events must be replay-safe and idempotent

## 9) Supported Status Vocabulary

Normalized statuses accepted by current plugins/core:
- `draft`
- `pending`
- `succeeded`
- `failed`
- `expired`
- `refunded`
- `disputed`
- `canceled`

UI policy on top of that:
- provider-backed `pending` -> `Awaiting provider confirmation`
- QR-only/non-provider-managed `pending` -> `Awaiting external confirmation`
- local simulator `pending` -> `Awaiting test confirmation`

## 10) Thai-Specific Recommendation

For Thailand, use this operating model:

1. `PromptPay QR`
- always available as low-friction request generation
- good for Krungthai and other Thai bank apps
- not auto-verified by app return

2. `PSP/merchant-backed checkout`
- use the adapter contract above
- this is the path for Lineman-like sensing
- completion should come from webhook first, status polling second

3. `Manual`
- use only when there is no verified provider signal

## 11) Security Requirements

Minimum requirements:
- adapter tokens kept server-side only
- signed adapter requests when possible
- signed webhooks required for terminal state transitions
- idempotency on create and refund
- replay-safe webhook ingestion
- timeout and retry policy on adapter calls
- no sensitive provider data stored in STDB shared state

## 12) Current Implementations

Current plugins following this shape:
- [th-payments plugin](C:\Users\Willp\Documents\GitHub\Wabi\plugins\th-payments\backend\index.mjs)
- [western-payments plugin](C:\Users\Willp\Documents\GitHub\Wabi\plugins\western-payments\backend\index.mjs)

Core routes and state handling:
- [paymentRoutes.ts](C:\Users\Willp\Documents\GitHub\Wabi\backend\src\api\paymentRoutes.ts)
- [paymentRepository.ts](C:\Users\Willp\Documents\GitHub\Wabi\backend\src\db\repositories\paymentRepository.ts)
- [PAYMENTS_IMPLEMENTATION.md](C:\Users\Willp\Documents\GitHub\Wabi\PROJECT_DOCS\PAYMENTS_IMPLEMENTATION.md)
