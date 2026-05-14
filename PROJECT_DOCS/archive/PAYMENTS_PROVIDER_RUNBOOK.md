# Payments Provider Runbook (Non-Custodial)

Last updated: 2026-03-08  
Scope: operator procedures for production payment providers in Wabi.

## 1) Core Safety Invariants

- Wabi is orchestration only. No custody, no internal wallet ledger, no stored value.
- Provider credentials stay server-side only.
- All provider status transitions must come from signed webhook or signed adapter API response.
- Plugin loading in production should run with:
  - `PLUGINS_ENABLED=true`
  - `PLUGIN_SIGNATURE_POLICY=signed-only`

## 2) Signed-Only Rollout

1. Verify plugin signature locally:
   - `npm run plugin:verify -- --plugin plugins/th-payments --strict`
2. Register plugin signer in server trust store:
   - `node scripts/payments-signed-only-rollout.mjs --plugin plugins/th-payments --server https://<wabi-host> --token <admin-bearer-token>`
3. Enforce signed policy:
   - set `PLUGIN_SIGNATURE_POLICY=signed-only` in `.env` (or `wabi.config` -> launch flow).
4. Restart backend and verify:
   - `GET /api/plugins` should show `signatureStatus=verified`.

## 3) Thailand Provider (`th-payments`) Onboarding

Required env:

- `TH_PAYMENTS_PROMPTPAY_PROXY_ID` (PromptPay target for QR)
- `TH_PAYMENTS_WEBHOOK_SECRET` (HMAC verification secret)
- `TH_PAYMENTS_ADAPTER_BASE_URL` (contracted PSP adapter service)
- `TH_PAYMENTS_ADAPTER_TOKEN` (adapter API auth token)
- optional: `TH_PAYMENTS_ADAPTER_SIGNING_SECRET` (request signing toward adapter)
- optional: `TH_PAYMENTS_ADAPTER_TIMEOUT_MS`

Deployment checks:

1. Plugin methods list:
   - `GET /api/payments/providers` includes `promptpay_qr` and `psp_checkout`.
2. Sandbox smoke:
   - `npm --prefix backend run payments:provider-sandbox-smoke`
3. Core persistence smoke:
   - `npm --prefix backend run payments:smoke`

## 3b) Western Provider (`western-payments`) Onboarding

Required env:

- `WEST_PAYMENTS_WEBHOOK_SECRET`
- `WEST_PAYMENTS_ADAPTER_BASE_URL`
- `WEST_PAYMENTS_ADAPTER_TOKEN`
- optional: `WEST_PAYMENTS_ADAPTER_SIGNING_SECRET`
- optional: `WEST_PAYMENTS_ADAPTER_TIMEOUT_MS`

Deployment checks:

1. Plugin methods list:
   - `GET /api/payments/providers?country=US&currency=USD` includes:
     - `card_checkout`
     - `wallet_checkout`
     - `pay_by_bank`
     - `paypal_checkout`
2. Sandbox smoke:
   - `npm --prefix backend run payments:western-provider-sandbox-smoke`
3. Core persistence smoke:
   - `npm --prefix backend run payments:smoke`

## 4) Key Rotation Procedure

1. Generate new signing keypair:
   - `npm run plugin:keygen -- --out-dir .wabi-keys`
2. Re-sign provider plugin:
   - `npm run plugin:sign -- --plugin plugins/th-payments --private-key <new-private-key.pem>`
3. Verify signature:
   - `npm run plugin:verify -- --plugin plugins/th-payments --strict`
4. Trust new signer:
   - `POST /api/plugins/signers` with `keyId` + `publicKey`.
5. Deploy plugin update.
6. Remove old signer only after successful rollout:
   - `DELETE /api/plugins/signers/:oldKeyId`

## 5) Webhook Hardening

- Use a unique long `TH_PAYMENTS_WEBHOOK_SECRET` per environment.
- Terminate TLS before webhook ingress.
- Restrict ingress by source allowlist where provider supports fixed ranges.
- Reject unsigned or invalid signature events (default behavior).
- Store and review webhook event history using payment events/audit trail.

## 6) Failure Handling / Rollback

### Provider outage

1. Disable payment creation by policy:
   - `POST /api/admin/payments/access` with `enabled=false`
2. Keep existing intents readable for status polling and reconciliation.
3. Post incident banner to community; restore when provider healthy.

### Plugin compromise suspicion

1. Set `PLUGINS_ENABLED=false` (or disable affected plugin).
2. Rotate:
   - adapter token
   - webhook secret
3. Untrust compromised signer key:
   - `DELETE /api/plugins/signers/:keyId`
4. Deploy known-good signed plugin and restore `signed-only`.

### Fast operational fallback

1. Disable payments globally (policy gate).
2. Keep chat core unaffected.
3. Re-enable after adapter/webhook verification and smoke checks pass.

## 7) Per-Provider Operational Template

Use this checklist for every new provider plugin (`western-payments`, `jp-payments`, `cn-inbound`, crypto):

1. Merchant onboarding completed and contract approved.
2. Provider adapter endpoint deployed with auth + TLS + request logging.
3. Webhook secret configured and signature verification tested.
4. Plugin signed and signer trusted.
5. `PLUGIN_SIGNATURE_POLICY=signed-only` enforced.
6. Sandbox smoke checks pass (create/status/refund/webhook replay/outage).
7. Payment access policy configured (`enabled`, role allow-list, user blocks).
8. Incident rollback steps documented and rehearsed.
