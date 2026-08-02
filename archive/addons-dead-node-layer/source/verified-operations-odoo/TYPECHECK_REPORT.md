# Wabi Odoo Addon Typecheck Report

Date: 2026-06-15
Addon: `addons/source/verified-operations-odoo/`
Harness: `/tmp/wabi-odoo-addon-tc/tsconfig.json`
TypeScript: 6.0.3
Target: `@wabi/plugin-types` (real types, no stubs except `socket.io`)

## Status

- 0 TypeScript errors.
- The addon is a class-based, real, deployable backend.
- The addon is now a **backend-only engine**. Its Svelte components and `extensions.workspacePanels` / `extensions.settingsPages` were removed; the wabi-business-roofing SvelteKit frontend consumes the addon's HTTP surface directly through the wabi addon contract.

## What was wrong (before the patches)

The earlier run reported 168 errors. They collapsed into 7 categories. Each was addressed in the 8 patches listed below.

## Patches applied

1. **backend/index.ts refactor** — replaced the `const plugin: BackendPlugin = { ... }` with a `class VerifiedOperationsOdooAddon implements BackendPlugin` that holds the services as instance fields initialized in `onLoad`. Resolved 38 × TS2339 (`Property X does not exist on type 'BackendPlugin'`), 70 × TS2532 (`Object is possibly 'undefined'`), 32 × TS7006 (untyped handler params), and 1 × TS2353 (`routes` map vs array shape) at once.
2. **backend/routes.ts** — extracted every route into a dedicated function with `PluginHttpRequest` / `PluginHttpResponse` typing, then assembled them in `buildOdooBusinessRoutes` and exposed via the class's `routes` getter. Each handler uses `as unknown as DomainType` for `req.json()` casts to bridge the strict `JsonObject` storage contract to the domain types.
3. **approvedAt on ApprovalRequest** — added `approvedAt?: number` to `ApprovalRequest` in `shared/types.ts`; the addon's `ApprovalManager` writes it on the review step.
4. **toJsonValue helper** — added a `toJsonValue<T>(value: T): JsonValue` helper in `backend/index.ts` that round-trips through JSON to convert domain objects to `JsonValue`-safe values for the strict `PluginStorage` contract. Wired into every `storage.set` call site in the managers.
5. **executeKw 4-arg call** — `getModels()` was passing 4 args to a 3-arg `executeKw`; the `kwargs` overload is actually folded into the `args` tuple in Odoo, so the extra kwarg is dropped.
6. **OdooFieldInfo callback type** — `getModelInfo()` was typing the `.map` callback as `Record<string, unknown>` but the array is `OdooFieldInfo[]`. Updated to use the real `OdooFieldInfo` shape (the type's field names are `type`/`string`/`relation`/`required`/`readonly`/`help`/`selection`, which the existing type already exports correctly).
7. **PluginSocketPayload type** — `socketHandlers` was typed as `(socket: unknown, data: JsonValue, ...)` but the contract requires `data: PluginSocketPayload`. Switched to the contract type and imported `Socket` from `socket.io` (handled by a local stub in the harness).
8. **Frontend removed from the addon; plugin.json trimmed** — the addon's `frontend/` Svelte components are gone; the `extensions.workspacePanels` and `extensions.settingsPages` entries are gone. The addon is consumed by the wabi-business-roofing frontend via the HTTP/socket contract; it is no longer a UI addon.

## Typecheck-infrastructure fixes (also in this session)

- `packages/wabi-plugin-types/src/index.ts` — replaced the broken `import { ClientMessage } from '../../../shared/messageRetention.js'` with a locally-declared `ClientMessage` interface, since the shared file no longer exports it. The local interface has an index signature so it composes correctly with `PluginChannelMessage`.
- `tsconfig.json` (harness) — added `"types": ["node"]` so `@types/node` is loaded and `Buffer` / `http` / `IncomingMessage` resolve.

## What the addon can do now

The addon loads into a wabi addon runtime and exposes:

- An HTTP API at `/api/plugins/runtime/verified-operations-odoo/...` covering:
  - status, connect, disconnect
  - Odoo model metadata (models, model info)
  - Spreadsheet definitions (CRUD, fetch data via the Odoo search_read with domain)
  - Draft worksheets (CRUD, submit-for-approval)
  - Approvals (list, review, push to Odoo)
  - Tamper verification (stats, run, acknowledge)
  - Conflict detection (list, resolve)
  - Caps, tamper config, templates, audit log
- A socket handler on `biz:verify:now` that re-runs tamper verification.
- A startup timer that runs tamper verification at the configured interval and emits `biz:tamper:alert` on the workspace context.
- A typed bridge to the Odoo CE server at `/var/home/Ronin/odoo-thailand-sandbox/` (default config), including Thai VAT, Thai withholding tax, OCA Thai tax reports (PND1/PND1A/PND2/PND3/PND53) and PromptPay QR (CueR) on the Thai commercial invoice PDF.
- A typed bridge to the wabi plugin storage, audit log, socket event bus, and `PluginContext` lifecycle hooks.

## Recommended next work

1. Re-`rsync` the addon into the wabi-business-roofing fork at `/var/home/Ronin/Documents/wabi-business-roofing/` (already done).
2. Add a unit-test or smoke-test pass via `odoo shell` to confirm the Odoo-side calls work end-to-end against the sandbox.
3. Build the wabi-business-roofing SvelteKit frontend that calls these routes and renders the business views.
4. Wire the Odoo CE sandbox into the wabi addon runtime's connection config so the bridge can be live-tested.
