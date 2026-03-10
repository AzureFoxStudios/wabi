# Payments Implementation

Last updated: 2026-03-10
Scope: current shipped payment behavior in this repository. This document describes what is implemented now, not the longer-term regional expansion plan.

## 1) Core Model

Wabi payments are non-custodial orchestration only.

What Wabi does:
- creates payment requests
- stores payment request state and immutable payment events
- renders provider artifacts such as QR payloads, checkout links, redirects, and app handoff URLs
- reconciles status from provider polling, signed webhooks, and refund callbacks

What Wabi does not do:
- hold user funds
- provide an internal wallet balance
- provide an internal stored-value ledger
- expose payment provider secrets to the frontend

Provider-specific money movement lives inside payment plugins plus their external adapters.

## 2) Stored State

Core persistence:
- `payment_intents`
  - request metadata, provider identifiers, amount, currency, optional channel attachment, presentation payload, terminal timestamps
- `payment_events`
  - immutable event log for create, refresh, webhook, cancel, refund, and manual admin actions
- `payment_account_links`
  - per-user, per-provider reusable account reference or label
- `payment_user_blocks`
  - per-user payment deny overrides
- `manual_settlements`
  - private DM cash trades
  - admin-recorded offline/manual donations
  - confirmation, completion, void, and dispute timestamps

Policy storage:
- `policy:payments_access`
  - `enabled`
  - `allowGuest`
  - `allowedRoleNames`
- `policy:payments_donations`
  - donation-specific provider, method, currency, country, copy, and suggested amounts

## 3) Status Model

`payment_intents` use this lifecycle:
- `draft`
- `pending`
- `succeeded`
- `failed`
- `expired`
- `refunded`
- `disputed`
- `canceled`

Idempotency is enforced on create and event ingestion paths. Provider refresh and refund metadata are merged back into the stored request instead of replacing application metadata such as donation tags.

## 4) Backend Flow

Normal request flow:
1. Frontend loads provider capabilities from `GET /api/payments/providers`.
2. Frontend opens the payment sheet with the current conversation context when available.
3. Frontend posts `POST /api/payments/create`.
4. Core stores the request row and initial audit event.
5. Plugin `createIntent` returns normalized provider presentation data.
6. Frontend polls `GET /api/payments/:intentId` for convergence.
7. Signed webhooks and provider refreshes update the same request/event stream.

Cancel/refund behavior:
- `POST /api/payments/:intentId/cancel`
  - cancels non-terminal requests
  - upgrades to provider refund behavior if the request already succeeded and the plugin supports refunds

Webhook ingress:
- `POST /api/payments/webhooks/:pluginId`

## 5) Access Control

Payment creation is controlled on the backend by:
- global payment enable switch
- guest allowance switch
- allowed role list
- per-user payment blocks

Effective create rules:
- if payments are disabled, creation is denied
- if a user has an active payment block, creation is denied
- if a user's effective role is not in the allowed role list, creation is denied
- guests are only allowed when `allowGuest=true`

Default shipped policy:
- `enabled=false` unless seeded or forced through bootstrap or admin policy save
- `allowGuest=false`
- allowed roles default to `owner, admin, mod, member`

## 6) Privacy Boundaries

Direct user-to-user and normal payment requests:
- only the creator can read the request by intent ID
- admins do not get a general payment backdoor

Server donations are the explicit exception:
- public donation summary is allowed
- owner/admin donation audit is allowed
- owner/admin donation refunds are allowed
- owner/admin offline donation recording and voiding are allowed

Manual settlement split:
- DM cash trades are private to the two DM participants
- offline/manual donations are server-governed donation records, not private peer payments

This split is intentional:
- private payments stay private
- community donations remain governable

## 7) Account Links

Account links are reusable per-user, per-provider references such as:
- wallet handle
- customer id
- provider account ref

Important behavior:
- account links do not install providers
- providers only appear when the backend has the corresponding payment plugin loaded
- if a payment request omits `customerRef`, backend creation automatically reuses the saved link for that provider when one exists
- users can still override that behavior with a one-off custom reference

## 8) Donations

Donation config is server-owned and separate from normal payments.

Public donation summary:
- `GET /api/payments/donations`
- returns:
  - sanitized donation config
  - completed provider-verified donation totals by currency
  - recorded offline/manual donation totals by currency
  - recent masked donation activity
  - recent masked offline/manual donation activity

Admin donation management:
- `GET /api/admin/payments/donations`
- `POST /api/admin/payments/donations`
- `GET /api/admin/payments/donations/log`
- `POST /api/admin/payments/donations/:intentId/refund`
- `GET /api/admin/payments/donations/offline`
- `POST /api/admin/payments/donations/offline`
- `POST /api/admin/payments/donations/offline/:settlementId/void`

Donation-only rules:
- only donation-tagged requests are visible in the admin donation ledger
- refund UI is donation-only
- donor labels are masked before they are returned to the client
- refunded donations stay visible in the ledger but are removed from active totals
- offline/manual donations are kept separate from verified provider totals

## 9) Manual Cash And Offline Donations

DM manual cash:
- only available in DM channels
- only registered DM participants can create or confirm
- Wabi does not verify physical exchange
- lifecycle:
  - `pending`
  - `confirmed_by_creator`
  - `confirmed_by_counterparty`
  - `completed`
  - `canceled`
  - `disputed`
- both people must confirm before the trade becomes `completed`

Offline/manual donations:
- only owner/admin can record them
- intended for in-person cash or off-platform donations
- included in public server donation transparency as `offline/manual`
- voidable by owner/admin
- not treated as provider-verified payment success

## 10) Frontend Surfaces

Current user-facing payment entry points:
- chat composer payment button
- chat DM manual cash button
- DM conversation header payment button
- DM conversation header manual cash button
- user context menu -> Request Payment
- user context menu -> Record Cash Trade
- `/pay` command in chat
- Settings -> Payment History
- Settings -> Payment Connections
- Settings -> View Donations

Current admin-facing payment surfaces:
- Admin payment access policy
- Admin payment user blocks
- Admin server donation configuration
- Admin donation audit trail
- Admin donation refund action
- Admin offline/manual donation recording
- Admin offline/manual donation void action

## 11) Current Payment Sheet Behavior

The payment sheet now behaves like a user-facing request flow instead of exposing raw backend fields.

Current UX rules:
- destination is implicit from the entry point when available
  - active channel opens with that channel attached
  - DM/group/chat context is shown at the top as a destination summary
- raw channel id editing is no longer the normal path
- provider is selected from live backend plugin capabilities
- method is derived from the selected provider and filtered by amount/currency/country eligibility
- country and currency are resolved from provider capabilities instead of always being free-text internals
- linked accounts are summarized in the sheet, not edited inline
- managing linked accounts hands off to Settings / Payment Connections
- customer/account reference is hidden behind an explicit advanced toggle

This keeps the backend contract the same while making the normal flow less error-prone.

## 12) API Surface

User routes:
- `GET /api/payments/access`
- `GET /api/payments/account-links`
- `POST /api/payments/account-links`
- `DELETE /api/payments/account-links/:pluginId`
- `GET /api/payments/providers`
- `GET /api/payments/history`
- `GET /api/payments/donations`
- `GET /api/manual-cash/:channelId`
- `POST /api/payments/create`
- `POST /api/manual-cash`
- `POST /api/manual-cash/:settlementId/confirm`
- `POST /api/manual-cash/:settlementId/cancel`
- `POST /api/manual-cash/:settlementId/dispute`
- `GET /api/payments/:intentId`
- `POST /api/payments/:intentId/cancel`
- `POST /api/payments/webhooks/:pluginId`

Admin routes:
- `GET /api/admin/payments/access`
- `POST /api/admin/payments/access`
- `GET /api/admin/payments/blocks`
- `POST /api/admin/payments/blocks`
- `DELETE /api/admin/payments/blocks/:userId`
- `GET /api/admin/payments/donations`
- `POST /api/admin/payments/donations`
- `GET /api/admin/payments/donations/log`
- `POST /api/admin/payments/donations/:intentId/refund`
- `GET /api/admin/payments/donations/offline`
- `POST /api/admin/payments/donations/offline`
- `POST /api/admin/payments/donations/offline/:settlementId/void`

## 13) Payment Plugins

Current implemented provider plugins:
- `th-payments`
  - PromptPay QR
  - contracted PSP checkout adapter
  - refund support
- `western-payments`
  - card / wallet / pay-by-bank style provider contract
  - refund support
  - local test checkout path exists for localhost verification

Operational rule:
- the frontend only knows about providers returned by the backend
- if a provider does not appear in `GET /api/payments/providers`, the backend has not loaded a compatible payment plugin for the current runtime

## 14) Verification

Current deterministic verification coverage includes:
- backend build
- frontend build
- core payment persistence smoke
- provider sandbox smokes
- localhost E2E smoke covering:
  - Thai provider discovery
  - western provider discovery
  - request creation
  - donation tagging
  - public donation ledger
  - admin donation audit
  - admin donation refund
  - DM manual cash creation and two-party confirmation
  - offline/manual donation record and void
  - direct-payment privacy enforcement

## 15) Known Gaps

Implemented but still needing product cleanup:
- broader Settings/modal layering still needs a dedicated audit outside the payment handoff fixes
- no richer dispute-management UI exists beyond marking a manual cash trade as disputed
- provider ranking is not yet using historical success or personalized recommendation logic
- provider connections are still manual references, not provider OAuth or bank-native linking

Important operational constraint:
- `Payment Connections` manages user account links only
- it is not a plugin installer
- if the backend has no active payment plugin, that panel will correctly show no providers

## 16) Relevant Files

Backend:
- `backend/src/api/paymentRoutes.ts`
- `backend/src/api/manualSettlementRoutes.ts`
- `backend/src/db/repositories/manualSettlementRepository.ts`
- `backend/src/db/repositories/paymentRepository.ts`
- `backend/src/payments/accessPolicy.ts`
- `backend/src/payments/accountLinks.ts`
- `backend/src/payments/userBlocks.ts`
- `backend/src/payments/donations.ts`
- `backend/scripts/payments-smoke-check.ts`
- `backend/scripts/payments-local-e2e-smoke.ts`

Frontend:
- `frontend/src/lib/api.ts`
- `frontend/src/lib/components/ManualCashModal.svelte`
- `frontend/src/lib/components/PaymentSheet.svelte`
- `frontend/src/lib/components/PaymentConnectionsModal.svelte`
- `frontend/src/lib/components/PaymentHistoryModal.svelte`
- `frontend/src/lib/components/ServerDonationModal.svelte`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/components/Chat.svelte`

Provider plugins:
- `plugins/th-payments/plugin.json`
- `plugins/th-payments/backend/index.mjs`
- `plugins/western-payments/plugin.json`
- `plugins/western-payments/backend/index.mjs`
