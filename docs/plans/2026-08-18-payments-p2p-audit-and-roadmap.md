# Payments P2P Audit & Roadmap — 2026-08-18

Status: **Audit + roadmap (docs pass); Phase UX + Phase 1 (WabiDB payment
projection) + Phases 2-4 (crypto / EPC SEPA / US rails) executed same day**
Provenance: payments audit session 2026-08-18 (regional rails re-verified against
Aug 2026 sources; repo state surveyed; legal posture question raised by Ronin).
Related: `docs/research/western-bank-to-bank-payments-2026.md` (canonical rail
reference, updated same day), `PROJECT_DOCS/04-payments/PAYMENTS_NONCUSTODIAL_PLAN.md`
(non-custodial hard boundaries), `core/crates/wabi-server/src/api/payments/`
(live PromptPay v1, shipped 2026-08-16).

---

## 0. Ground rules (unchanged, restated)

- **Wabi never touches money.** No custody, no stored value, no internal ledger,
  no escrow, no fee cut, no wallets. Every payment is buyer's-app → seller's-account
  on the rail itself. Wabi is an invoice/QR generator and a chat where two humans
  confirm a payment happened.
- The design center is the **handshake model**: commission agreed in chat →
  "I do 200 for a poster" → seller's QR/link/pointer → buyer pays from their own
  banking app or wallet → "Sent!" → seller manually confirms. PromptPay v1 already
  implements exactly this.
- Regional rails are **compile-time-optional** so an NA instance carries no Asia/EU
  rail code (see §3).
- This is technical policy, not legal advice (same disclaimer as the research doc §6).

## 1. Verified regional audit (all facts re-verified 2026-08-18)

| Region | Verdict | Rail |
|---|---|---|
| Thailand | **Done, shipped** | PromptPay (Rust v1 live, `api/payments/`, 2026-08-16) |
| EU/EEA | **Buildable now** | SEPA Instant + EPC QR-067 (GiroCode); Wero stays watch-only |
| US | **Manual rails only** | Pointer display + reference code; no open bank QR exists |
| Crypto | **Specified, not built** | Static pointer strings; USDC-first (see §4) |

- **Thailand** — nothing left for the audit to change: EMVCo QR builder + CRC16,
  JSONL intents, admin manual-confirm. This is the canonical pattern all other
  lanes copy.
- **EU** — the "fancy QR that avoids KYC" is **EPC QR-067**, not Wero: an open
  11-line text payload (name, IBAN, EUR amount, reference) any of 500+ banking
  apps scans; pure string generation, no PSP, no merchant account, no KYC beyond
  the bank account the seller already has. VoP (mandatory since 9 Oct 2025) makes
  the payee-name check the anti-quishing safety net. Wero remains closed to
  third-party QR generation (live BE/FR/DE only; NL/LU planned 2026; e-commerce
  request-to-pay QR piloting in France 2026, PoS 2026–27) — build nothing on it
  yet. Research doc §2 rates the EPC builder at ~a day of work.
- **US** — no open bank QR standard exists; Zelle QRs are minted inside bank apps
  only. Zelle's standard terms prohibit goods/services payments on personal
  profiles; Zelle never issues 1099-Ks (bank network, not a TPSO). OBBBA restored
  the 1099-K threshold to **$20,000 AND 200 transactions for 2026+** — under that
  bar, hobbyist sellers on US P2P rails get no automatic federal reporting
  (income still legally taxable). Privacy.com is alive, US-only, and **buyer-side
  only** (virtual cards for spending; its sole marketplace role is a buyer
  masking their card in a PSP checkout — merchants can detect/decline its BINs).
  So the US lane = `us-bank` manual rail: display pointers (Zelle phone/email,
  Cash App $cashtag, Venmo handle) + `WABI-XXXX` reference code + manual confirm.
  Crypto is the private US lane.
- **Crypto** — "theoretically done" was generous: the btc-payments plugin died
  with the Node layer; **no crypto code exists in the Rust server**. It is
  architecturally the easiest lane: every modern receive standard (BIP21 URI,
  LNURL-pay, BOLT 12 offer, Monero address, stablecoin address) is a static
  pointer string that fits `PaymentAccountLink` exactly like a PromptPay ID.
  BOLT 12 gives static, reusable receive QRs natively (no LNURL web server).

## 2. Legal posture — "when does it become a shop?"

Ronin's framing: *originally I thought it was just handshakes off communication —
"hey can I commission you? Yeah I do 200 for a poster. Deal! — here's the QR. —
Sent!"* vs. *a literal marketplace where a user can be away but still be selling
goods. Would that make Wabi a legal trap — essentially becoming a shop?*

- **Money transmission is not the line that moves.** Non-custodial QR/link
  generation keeps the operator out of money-transmitter scope whether the UI is
  a handshake or a listing board (FinCEN 31 CFR 1010.100(ff)(5), Ruling 2003-8 —
  research doc §6). No custody ⇒ no transmitter, no TPSO, no PSI.
- **The line that moves is platform-facilitation regimes.** Structured commerce
  features — listing boards with prices, order/cart state, facilitated checkout —
  pull the *instance operator* toward: **EU DAC7** (platform operators report
  seller income to tax authorities), **DSA online-marketplace obligations**
  (trader verification/traceability duties), **Thai Revenue Department platform
  reporting**, and US TPSO-adjacent scrutiny — even with zero custody. A DM
  handshake between two users is communication; an order-processing system is
  intermediation. Ronin's instinct is correct.
- **The self-hosting multiplier:** these duties attach to whoever *operates* the
  instance. Artists running their own Wabi is the safest posture that exists;
  a large public multi-seller instance with structured listings is the riskiest.
- **Decision for v1:** handshake + pointers + reference codes ONLY. Async selling
  ("seller away but still selling") gets the safe middle path: a **commission
  sheet** — a pinned message / profile block with prices, terms, and payment
  pointers. That is advertising + contact information, not order processing.
  It delivers ~90% of the marketplace value with none of the intermediation
  exposure.
- A full marketplace channel-kind stays on the roadmap **behind an explicit
  legal-review gate** (echoes the standing warning in
  `docs/futuresight-private-swarm-transfer-addon.md:196`).

## 2b. Counterparty privacy — the "free doxx" question (added 2026-08-18)

Ronin's objection: *Patreon at least obfuscates the data so you're buying from
Sakimichan and not Yue. A payment rail that shows legal names hands a free doxx
to bad actors — one payment and a tumblr user learns an artist's identity.*

The structural fact: **non-custodial + bank rails + counterparty anonymity —
pick two.** Patreon can show "Sakimichan" because Patreon is the merchant of
record: the buyer pays Patreon and Patreon pays the creator. That obfuscation
IS custody — the exact overlord model (fees, freezes, deplatforming, 1099-K
reporting, central breach surface) this project rejects. Wabi cannot replicate
Patreon's aliasing without becoming Patreon.

What Wabi CAN do — and ethically must:

1. **Per-rail doxx-floor labeling in the sheet, before creating the request.**
   The UI states plainly what the payer's app will display: e.g. "Your
   PromptPay-registered name is shown to the payer by their banking app",
   "Zelle shows your bank-registered name + phone/email". Hiding the exposure
   would be the unethical version; informed choice is the ethical one.
2. **Order US rails by doxx floor, aliased first.** This corrects the earlier
   "US = legal name" framing, which was Zelle-specific:

   | US rail | Counterparty sees | Doxx floor |
   |---|---|---|
   | Cash App $cashtag | Chosen display name + $cashtag | Low — counterparty-aliased (platform knows all) |
   | Venmo @handle | Chosen display name + @handle | Low — counterparty-aliased |
   | Zelle | Bank-registered legal name + phone/email | High — the "free doxx" rail; label it |
   | ACH (routing+acct) | Account numbers (pull-capable!) | Doxx + security risk; last resort with warning |

   Cash App / Venmo give Patreon-grade *counterparty* privacy without Wabi
   custody — the aliasing custodian is Block/PayPal (accounts users already
   have), not Wabi, and Wabi never touches the money. Trade-offs: platform
   ToS prefers business profiles for commerce; 1099-K applies above the
   $20k/200tx threshold.
3. **A real anonymity lane always available:** crypto (roadmap Phase 2). The
   EU "brand without legal name" lane is the seller-side named vIBAN at an EMI
   (research doc §5c) — buyer's VoP check shows "Mika's Print Studio", not
   "Mika N."; KYC lives at the EMI, not with the counterparty. US equivalent:
   business banking/DBA (Zelle for Business under an LLC name, Wise Business).
4. **Symmetry note:** exposure runs both ways — sellers learn buyer identities
   too. Minimize what Wabi itself ever stores (pointers only, never statements
   or PANs), so the platform is never the doxx vector.

Verdict: offering a legal-name rail is ethical ONLY as a labeled, non-default
choice next to aliased and anonymous alternatives. The default US handshake
should be $cashtag/@handle first; Zelle opt-in with the warning visible.

## 3. Architecture — rail-agnostic core, optional regional rails

Requirement from Ronin: *keep the areas that matter to the server as plugins —
NA only needs NA, not Asia/EU.*

- **Core (always compiled, rail-agnostic):**
  - Implement the already-stubbed `PaymentAccountLink` persistence — the
    handlers in `api/payments/handlers.rs` are no-ops annotated *"Will be wired
    to a WDB commands::payment command in a follow-up."* New payment projection
    in wabidb (`state_payment_*` table names already reserved in
    `standby/tables.rs:25–37`); the `("payment", _)` ingest arm at
    `adapter/mod.rs:1508` already writes payment events with no projection
    attached. Never touch `UserRecord` (golden rule 5 — new postcard records
    are fine, mutating existing ones is not).
  - Rail-agnostic intents + manual confirm + short reference-code
    reconciliation (`WABI-7F3K` pattern, research doc Lane 1) — the reference
    code is "the reconciliation API that doesn't require any API."
- **Regional rails as compile-time-optional addons** (the lore pattern: separate
  workspace crate + cargo feature in wabi-server + `enabled_addons()` entry +
  frontend `hasAddonCapability` gating so the PaymentSheet only offers compiled
  rails):
  - `payments-th` — PromptPay (relocate/wrap existing `promptpay.rs`)
  - `payments-eu` — EPC QR-067 builder (~1 day) + IBAN/reference copy-block fallback
  - `payments-us` — manual pointer display + reference-code UX (no QR standard
    exists). Rail order per §2b: Cash App $cashtag / Venmo @handle (aliased)
    first, Zelle behind a legal-name disclosure, ACH last-resort with warning.
  - `payments-crypto` — address validation + BIP21/LNURL/BOLT12/Monero/stablecoin URI rendering
- An NA instance compiles `payments-us` (+ `payments-crypto` if wanted) and
  carries no TH/EU rail code.

## 4. Crypto lane — what "industry standard users like best" means (Aug 2026)

- **Primary: USDC on Base + Solana.** USDC is the #1-ranked stablecoin for
  business/creator payments in 2026; Stripe itself now accepts USDC from
  self-custody wallets on Ethereum, Solana, Polygon, and Base — that is the
  mainstream consumer checkout shape. Base smart-wallet UX is gasless; Coinbase
  app onboarding is the easiest path for non-crypto-native buyers.
- **Secondary: USDT (TRC-20).** Dominant among Thai/SEA artists and buyers —
  matches the existing user base of this instance.
- **Later/optional:** Monero (the actual privacy rail for the anon lane),
  BTC BIP21 + LNURL/BOLT 12 static offers.
- All of these are pointer strings + chain tag in `PaymentAccountLink`. The
  server validates the format and renders URIs/QRs; it never custodies. Note
  honestly in-UI: stablecoin chains are not private (public ledgers); point
  privacy-wanting users at the future Monero lane.

## 5. UX modernization (added 2026-08-18, executed same day)

The payments frontend suite (19 files, `frontend/src/lib/payments/`) was ported
from the TS era and still carries dead references: `paymentSettlements.ts` calls
`/api/manual-cash/*` routes that no longer exist in the Rust server;
`paymentRealtime.ts` listens for socket events nothing emits; account-links
endpoints return empty until Phase 1 lands. Goals of the pass:

- Graceful degradation instead of dead calls: no requests to nonexistent routes;
  feature surfaces that need Phase 1 backend show honest empty states.
- Svelte 5 runes compliance throughout (ported code predates the rule).
- Visual/interaction parity with the post-design-polish (s2–s6) language:
  consistent tokens, smooth modal transitions, loading/skeleton and empty
  states, copy-to-clipboard affordances for QR fallback blocks.
- Scope: frontend only. No backend, no schema, no new endpoints.
- **Per-rail privacy disclosure (§2b):** the sheet states what the payer's app
  will show about the seller (v1 PromptPay: bank-registered name) before the
  request is created.

**Execution record (2026-08-18, frontend-only):**
- `api/paymentCheckout.ts` rewritten against the REAL Rust routes
  (`POST/GET /api/payments/intents`, `/intents/{id}/confirm|reject`); Rust
  intent JSON mapped onto the frontend contract; provider list served from a
  static v1 catalog (`V1_PROVIDER_CATALOG`, PromptPay/THB) — the previous
  client called `/api/payments/providers`, `/create`, `/{id}`, `/{id}/cancel`,
  none of which exist (the sheet 404'd end-to-end). User-side cancel removed
  (no such route; admin confirm/reject clients added for Phase 1 UI).
- `api/paymentHistory.ts`: history → `GET /intents`; account-links stored on
  device (localStorage) with best-effort server mirror — the server store is a
  no-op stub until Phase 1.
- `paymentAccessStore.ts`: v1 no longer hides the payments UI (the policy
  store is a server-side stub; intent routes enforce auth only). Restore
  policy gating with Phase 1.
- Manual-cash flow deleted end-to-end (modal, API client, `/cash` command,
  composer button, context-menu items, launch surface) — it targeted routes
  that no longer exist.
- All 9 payments components migrated to Svelte 5 runes (`$props/$state/
  $derived/$effect`, `onclick`, `$bindable`); dead bitcoin/western branches
  removed; PromptPay rail keyed to pluginId `promptpay`.
- `BaseModal.svelte`: additive optional `title`/`subtitle`/`headerTag` props
  (renders a text header instead of requiring the header slot) — lets
  runes-mode payments modals avoid snippet/slot interop; zero impact on the
  ~100 legacy consumers.
- `payment-sheet.css` + modal styles tokenized to the design system
  (`--surface-*`, `--border-default`, `--radius-*`, `--duration-*`),
  hover/active/focus-visible states, QR card enter animation, pending-status
  pulse, `prefers-reduced-motion` respected; privacy-disclosure line added to
  the PromptPay draft.
- Verified: `bun run check` 0 errors (148 pre-existing app-wide warnings,
  baseline unchanged); `STATIC_BUILD=1` production build passes. Live
  browser verification still pending (golden rule 7) — spot-check the
  PaymentSheet and Saved References modal on the next dev run.

## 6. Phased roadmap

- **Phase 0 (this session):** this doc + research-doc verification update +
  UX cleanup pass (§5).
- **Phase 1:** WabiDB payment projection — account links + intents move from
  JSONL into events; policy storage; wire the stubbed handlers. Per repo policy:
  append progress here + update the wabidb skill docs. Tests accompany (wabidb
  unit + server integration).
- **Phase 2:** `payments-crypto` addon (USDC Base/SOL + USDT TRC-20 pointers,
  validation, URI/QR rendering).
- **Phase 3:** `payments-eu` addon (EPC QR-067 builder + tests).
- **Phase 4:** `payments-us` manual rails (pointer display, reference codes,
  confirm UX).
- **Phase 5 (GATED — legal review before any code):** commission sheet /
  marketplace surface. Gate questions in §7.

## 6b. Phase 1 execution record (2026-08-18)

**Scope delivered:** payment account links + intents moved from JSONL into
WabiDB events; policy + user-block storage landed; the no-op stub handlers are
wired; JSONL→event migration hook added; tests accompany.

**WabiDB (`core/crates/wabidb/`):**
- New `projections/payments.rs`: `PaymentsProjection` (stream `"payments"`,
  index names `payment_account_links`, `payment_intents`, `payment_policies`,
  `payment_user_blocks`) + records (`PaymentAccountLinkRecord`,
  `PaymentIntentRecord`, `PaymentPolicyRecord`, `PaymentUserBlockRecord`,
  `PaymentDeleteKey`). All records camelCase-serialized, matching the old
  `intents.jsonl` shape so the frontend contract is unchanged. Postcard cannot
  encode `serde_json::Value`, so `PaymentPolicyRecord` stores `value_json:
  String` (same approach as the audit projection).
- Event types: `payment_account_link_upserted/deleted`,
  `payment_intent_created/confirmed/rejected`, `payment_policy_upserted`,
  `payment_user_block_upserted/deleted`. No existing postcard records were
  touched (golden rule 5 — all records are new).
- Registered in `build_type_registry()` (engine/mod.rs). 10 unit tests in
  `projections::payments` pass.
- `WabiStore` trait + `WdbAdapter` impls: get/upsert `payment_policy`,
  list/upsert/delete `payment_account_link`, create/list/get/confirm/reject
  `payment_intent` (confirm/reject validate `status == "pending"`; 404 unknown
  intent, 409 non-pending), list/upsert/delete `payment_user_block`.

**wabi-server:**
- `api/payments/intents.rs` rewritten off JSONL: `create_intent` (PromptPay QR
  build, `pi_{uuid}` ids, `WABI_PROMPTPAY_PROXY_ID`/`MERCHANT_NAME`/
  `MERCHANT_CITY` env), `list_intents` (admin see-all), confirm/reject
  (admin-only), `migrate_legacy_intents` (replays pre-Phase-1
  `{data_dir}/payments/intents.jsonl` as `payment_intent_created`, skipping ids
  already projected, then renames the file to `intents.jsonl.migrated-{ts}`;
  spawned once from `payments::routes()`).
- `api/payments/mod.rs` + `handlers.rs` + `api/admin.rs`: account-link and
  user-block handlers wired to the store; `PaymentAccountLink`/
  `PaymentUserBlock` are now type aliases to the wabidb records. The
  `intents_mutex` in `state.rs` is gone.
- The legacy `("payment", _)` ingest arm in `adapter/mod.rs` is retained
  (replay-compat/audit); no projection consumes its `payment_{op}` envelope
  events.
- New integration suite `tests/payments_projection_contract.rs` (5 tests:
  account links upsert/list/delete/scope, intent created/listed/confirmed/
  persisted incl. restart replay, payment-access policy persists, user blocks
  admin-only, reject flow + unknown intent).

**Verified:** `cargo test -p wabidb --lib` 861 passed (incl. 10 new payments
tests); `cargo test -p wabi-server` all green (98 unit + 107 onboarding + 5
payments integration + others); `cargo check` clean (13 pre-existing unrelated
warnings); frontend `bun run check` 0 errors, 0 payments warnings. Live browser
verification of the sheet still pending (golden rule 7 — next dev run).

**Debugging note:** three of the new integration tests initially failed at
`register alice` with `Wdb(Io ENOENT)` on `global/commit-index/00000000.widx`.
strace showed the test helper's `TempDir` was being dropped (bindings like
`let (_, app)`), deleting the data dir out from under the engine — a test bug,
not an engine race. Fixed by keeping the `TempDir` alive; engine untouched.

## 6c. Phases 2-4 execution record (2026-08-18)

**Scope delivered:** three optional, compile-time-`payments-rails`-gated rails
as workspace addon crates; wabi-server routing, addons listing and integration
tests; capability-gated frontend checkout. All non-custodial: Wabi builds the
presentation, money moves outside Wabi, confirmation stays manual (Phase 1
confirm/reject UX reused as-is). Phase 5 remains legally gated — see §7.

**Addon crates (new workspace members):**
- `core/addons/payments-crypto/backend`: chains `usdc_base` (chain id 8453),
  `usdc_solana`, `usdt_tron` (TRC-20), `btc`, `lightning`, `monero`.
  `RenderParams {chain, pointer, amount_minor, reference_code, merchant_name}`;
  `presentation()` → `{mode:"qr", qrData, copyText, chain, referenceCode, note}`.
  URI scheme per chain (`ethereum:` for EVM, `bitcoin:`, `lightning:`,
  `monero:`). 6 tests.
- `core/addons/payments-eu/backend`: EPC069-12 v3.1 QR builder. **CRC decision:
  EPC069-12 defines NO checksum** — verified against the official v2.1 PDF
  (downloaded to `/tmp/opencode/epc069-12.pdf`, extracted via pdftotext), the
  v3.1 full text, the segno source, and the eupl reference implementation. The
  remembered "9C31" Wikimedia CRC from an earlier session was a self-derived
  construction, not an authoritative vector, and is discarded. Payload: up to 12
  LF-joined elements `[BCD, 002, 1, SCT, BIC|"", name, IBAN, EUR{amount},
  purpose|"", reference|"", text|"", info?]`, trailing empty optional lines
  trimmed (min 7, through IBAN), last populated element has no trailing
  separator, ≤331 bytes, charset always "1" (UTF-8), version "002", minimal
  amount (EUR27, EUR12.3 — trailing zeros stripped), reference (≤35, ISO 11649)
  XOR text (≤140), purpose exactly 4 chars, info ≤70. `presentation()` →
  `{mode:"qr", qrData, copyText, rail:"sepa-instant", referenceCode, note}`. 8
  tests incl. a byte-exact official V2 vector (François D'Alsace S.A.) and the
  Wikimedia / Franz Mustermänn vectors.
- `core/addons/payments-us/backend`: rails `cashapp_pointer`, `venmo_handle`,
  `zelle_pointer`, `ach_details`; per-rail pointer validation;
  `presentation()` → `{mode:"app_switch", pointer, pointerLabel, referenceCode,
  disclosure, amountMinor, currency, note}`. 7 tests.

**wabi-server:**
- `Cargo.toml`: optional deps on the three crates; feature
  `payments-rails = ["wabi-payments-crypto", "wabi-payments-eu",
  "wabi-payments-us"]`.
- `api/addons.rs`: cfg-gated `AddonCapability` entries for `payments-crypto`,
  `payments-eu`, `payments-us` (each gated on its own crate feature,
  `cargo_feature: Some("payments-rails")`, empty contributions/permissions) + 4
  cfg-gated tests. Builds without the feature simply don't advertise them.
- `api/payments/intents.rs`: `CreateIntentInput` extended with `method_id`,
  `country_code`, `provider_ref`; `create_intent` routes per `provider` inside
  `#[cfg(feature = ...)` blocks (off-build arms return `<rail> rail is not
  enabled in this build (compile with --features payments-rails)`). Crypto:
  chain from `method_id`, pointer from `provider_ref`, merchant name from env
  `WABI_CRYPTO_MERCHANT_NAME` (default `WABI`), currency defaulted per chain via
  `default_chain_currency()`. EU: IBAN from `provider_ref`, payee name from env
  `WABI_EU_PAYEE_NAME` (default `WABI`), optional env `WABI_EU_BIC`, reference
  set to the intent's `reference_code`. US: rail from `method_id`, pointer from
  `provider_ref`, currency defaults USD. PromptPay branch unchanged (+
  `method_id` "promptpay_qr", country "TH").
- `reference_code()` / `rand_byte()` moved here from `wabi-payments-us` —
  server-level plumbing shared by all rails: `WABI-XXXX` over the unambiguous
  alphabet `2345679ACDEFGHJKMNPQRSTUVWXYZ` (no 0/O/1/I/8/B). The US crate keeps
  its own tested copy for standalone use (documented in its docs).
- New integration suite `tests/payments_rails_contract.rs` (5 tests,
  `#![cfg(feature = "payments-rails")]` so plain `cargo test` skips it):
  `/addons` lists all three rails; crypto intent round trip (create + confirm,
  exact `ethereum:` qrData, WABI- reference); EU intent builds the EPC payload
  (BCD/002/1/SCT, mod-97 IBAN, minimal EUR27 amount, structured reference as the
  last element); US intent carries pointer + legal-name disclosure; invalid
  inputs (bad wallet address, unknown chain, invalid IBAN, unknown rail) are
  rejected 400 with nothing persisted.

**Frontend (capability-gated via `hasAddonCapability` on `/api/addons`):**
- `paymentCheckout.ts`: provider catalog now filters the three rail definitions
  by server capability; `mapIntent` reads `provider` / `methodId` /
  `countryCode` / `providerRef` / `presentationJson` and surfaces the parsed
  presentation blob (PromptPay JSONL shape still maps identically);
  `createPaymentIntent` sends `provider`, `methodId`, `countryCode`,
  `providerRef` (PromptPay keeps `promptpayProxyId`).
- `paymentSheetHelpers.ts`: route presets for USDC (Base) / USDT (Tron) / BTC /
  Lightning / XMR, the Euro Area EPC QR (DE/EUR) and the US Cash App rail.
- `PaymentConnectionsModal.svelte`: per-rail reference labels, placeholders and
  help text (wallet address / IBAN / US handle).
- `PaymentIntentCard.svelte`: `app_switch` branch now renders a copy-pointer
  button plus the reference code and the legal-name disclosure (previously only
  deep-link/fallback URLs).
- `paymentRequestPresentation.ts`: the three rails map to
  `external_confirmation` (settlement happens outside Wabi; app return is not
  proof). `PaymentSheetBody` shows per-rail QR hints (wallet vs. EU banking app).

**Verified:** `cargo test --workspace` green (861 wabidb lib + all server/other
suites); `cargo test -p wabi-server` green with default features AND with
`--features payments-rails` (103 lib + 112 lib + 5 rail-contract integration +
existing suites); addon crates 6/8/7 green; frontend `bun run check` 0 errors.

**Live smoke test (2026-08-18, headless HTTP):** ran the real binary with
`--features payments-rails` against a throwaway data dir: `/api/addons` lists
`payments-crypto`/`payments-eu`/`payments-us`; register → create intent on each
rail (crypto `ethereum:` URI + WABI- reference; EU EPC payload with minimal
`EUR27` amount and reference as last element; US app_switch with pointer +
disclosure); GET `/api/payments/intents` lists all three; invalid IBAN → 400;
admin confirm → `completed` with note. Full browser pass of the PaymentSheet
still pending (golden rule 7 — next dev run).

**Follow-up fixes folded in (same session):** frontend minor-unit decimals for
crypto now match the addon crate (USDC/USDT 6, XMR 12 — previously only BTC 8
was special-cased, so USDC/USDT/XMR amounts would have been ~4–10 orders of
magnitude off); `mapIntent` exported from `paymentCheckout.ts` and reused by
`paymentHistory.ts` (history was hardcoded to the promptpay shape); the ts-rs
regen from `cargo test --workspace` stripped the manual `"category"|"lore"` /
`position`/`parentId` additions to the generated protocol (restored per repo
golden rule 4).

**Payment UI omit switch (2026-08-19, "empty payment button" fix):** the
`policy:payments_access` row was already persisted by Phase 1 (GET/POST
`/api/payments/access`, admin-only POST); the frontend access store was
deliberately ignoring it ("must NOT hide the UI" — written when the policy was
a stub). Now that the policy is real, the omit behavior is a settings check,
not a teardown:
- `paymentAccessStore.ts` consumes the live policy: `policyEnabled` and
  `canViewPaymentUi` = `policy.enabled`; `canCreate` = authenticated ∧ enabled.
  Unknown policy (no row / server unreachable) fails open for viewing (the
  sheet's empty state explains missing rails), creation stays auth-gated.
  Pure `resolvePaymentAccessSnapshot(policy, token)` extracted for tests.
- Entry-point gating: composer payment button (`Chat.svelte`) and DM payment
  button (`DMMessageView.svelte`) now require `loaded ∧ canCreate`. History,
  pending-intent completion and receipts stay accessible (real data, not empty
  buttons). Default (no policy row) = hidden — servers with no rails no longer
  show an empty payment button.
- Admin settings (`settings/admin/PaymentAccessPanel.svelte`, rendered from
  `AdminSettingsPayments.svelte`): master ON/OFF toggle. **Enabling is one
  click; disabling is deliberately tedious** — the user must tick an
  acknowledgment checkbox AND type `DISABLE` (case-insensitive, exact word,
  `canConfirmDisable()` gate) before the button un-grays, so hiding payments
  for everyone is a considered act. Save path: `savePaymentAccess()` client API
  (new, exported from `$lib/api`) → POST → `refreshPaymentAccess()` updates the
  global store immediately; the existing `payments:access-updated` realtime
  event also reloads the panel.
- Tests: `paymentAccessStore.test.ts` (8) covers fail-open/enabled/disabled
  snapshot derivation and the disable-phrase gate. `bun test src/lib` 107 pass
  (one flaky pre-existing order-dependent failure in `rightPanelStubStrip`),
  `bun run check` 0 errors.
- Note: disabling hides creation entry points; the policy is not enforced on
  the intent routes themselves (auth-only), so direct API calls can still
  create intents while the UI is omitted — fine for the privacy-first "omit"
  goal; a hard server-side gate would be a Phase 5-era decision (it changes
  the product contract, not just the UI).

**Carry-forward:** Phase 0 live-browser PaymentSheet verification (golden rule
7) pending — next dev run (this session also added the admin omit toggle, so
the browser pass should exercise enable → buttons appear, disable-tedious flow
→ buttons vanish); Phase 5 stays gated on §7 counsel answers.

## 6d. WS-3 execution record — access policy enforcement (2026-08-18, ZCode)

Closes the one gap from the Phase 1 audit: the persisted `payments_access`
policy and payment user-blocks are now **enforced**, not just stored.

- **Server** (`api/payments/`):
  - `create_intent` enforces the access policy via the new
    `evaluate_payment_access` (403 with a human reason for: blocked user,
    disabled policy, disallowed role, guest without `allowGuest`).
  - `extract_identity` decodes `(user_id, is_guest)` from the JWT (guest flag
    was already a claim; the payments decoder just ignored it).
  - `GET /payments/access` now returns a server-computed `actor`
    (`PaymentAccessActorStatus` contract the frontend always expected).
  - **Default policy flipped to `enabled: true`.** Semantic: the policy is an
    admin kill-switch/restrictor, not an opt-in — matches the behavior every
    server already had (any registered user could create intents). Flipping
    the old default (`false`) would have bricked payments on upgrade the
    moment enforcement landed.
- **Tests**: new `payment_access_policy_enforced_in_create_intent` (member
  create OK → disabled 403 → role-restrict 403 → restore → block 403 +
  `actor.blocked` → clear → OK); `payment_access_policy_persists` updated for
  the enabled default. Note discovered en passant: registration ids are NOT
  small integers in order (first-boot seeding consumes some) — tests must
  read the real id (`actor.userId`), never assume `userId: 2`.
- **Frontend**: `paymentAccessStore` gates on the server actor (policy-only
  fallback for old servers); account-links list is server-first with the
  localStorage copy demoted to offline cache; Connections modal copy updated
  (references are server-stored, device-cached).

## 7. Open questions (counsel review items, Phase 5 gate)

Research pass 2026-08-18 (web, primary sources where possible; NOT legal
advice — each item still needs confirmation by counsel in the relevant
jurisdiction before Phase 5 code).

1. **DAC7 scope for self-hosted multi-seller instances** — Directive (EU)
   2021/514, Art. 8ac + Annex V §I.A.1: a "Platform" is software connecting
   Sellers to users for a Relevant Activity, "including any arrangement for
   the collection and payment of a Consideration", BUT it "does not include
   software that without any further intervention in carrying out a Relevant
   Activity exclusively allows … (b) users to list or advertise a Relevant
   Activity". Finding: a Wabi instance whose commercial surface is a pinned
   price sheet + payment pointers, with funds moving P2P entirely outside
   Wabi (never collected/paid by the operator), sits squarely in carve-out
   (b) — it is not a DAC7 Platform. Secondary protections: EU nexus is
   required anyway (EU-resident operator, or EU reportable sellers /
   immovable property in a MS); the small-seller de minimis (<30 sales of
   goods and ≤€2,000 consideration) shrinks reportable-seller scope further.
   **Risk line:** the carve-out is "exclusively" — any Wabi-side collection
   or payment of consideration (escrow, in-app checkout, fee/commission
   routed through Wabi) flips the analysis. Member-State transposition
   varies; confirm with counsel in the relevant MS.

2. **DSA "online marketplace" definition boundary** — the DSA never defines
   "online marketplace"; Chapter III Section 4 (Arts 29–32) applies to
   "online platforms allowing consumers to conclude distance contracts with
   traders" (B2C only). Leading analysis (Freshfields; ACM guidelines):
   social-media-style contact between traders and consumers is NOT a
   marketplace "unless such commercial activities are actively facilitated
   by the platform provider (e.g., by way of a formal checkout process
   directly on the platform)"; a shop selling only its own goods is not a
   marketplace. Finding: a pinned price sheet where the buyer contacts the
   seller and pays through external apps = the social-media-chat scenario —
   not a DSA marketplace, as long as Wabi has no on-platform checkout or
   contract conclusion. Baseline hosting/online-platform DSA duties apply to
   Wabi as a chat platform regardless (independent of Phase 5). **Risk
   lines:** any formal checkout/"buy now" that concludes a contract on Wabi
   crosses the line; the P2B Regulation (EU 2019/1150) imposes transparency
   duties on "online intermediation services" used by business users even
   outside the DSA marketplace label — confirm if the sheet targets
   business sellers.

3. **Thai RD platform-reporting thresholds for hobbyist instances** — two
   regimes:
   - RD seller-revenue reporting (DG Revenue Notification 27 Dec 2023,
     effective 1 Jan 2024): applies only to e-platforms ESTABLISHED IN
     THAILAND with total revenue > THB 1,000 million (≈US$28M) per
     accounting period; special accounts of sellers' online revenue filed
     within 150 days of year-end. Hobbyist scale is orders of magnitude
     below; irrelevant to self-hosted instances.
   - Royal Decree on Digital Platform Service Businesses (2022, effective
     Aug 2023, enforced by ETDA): notification + annual reporting applies
     to operators with Thai revenue > THB 1.8M (individual) / THB 50M
     (juristic) OR >5,000 average monthly Thai users — for electronic
     intermediary services connecting merchants/consumers "regardless of
     whether payment is actually made"; extraterritorial if Thai-language
     interface / .th domain / THB payment / Thai governing law. Platforms
     offering only the operator's own goods/services, and web-board +
     hyperlink-only sites, are exempt or light-touch. Finding: a hobbyist
     instance serving its own community is below every threshold; even a
     paid service needs 5,000 monthly users or THB 1.8M/yr to trigger ETDA
     notification. **Watch items:** ETDA's 2026 agenda includes a
     designated-online-marketplace notification (Dec 2025) and a social
     commerce notification — re-check before any storefront/checkout
     feature; a commercial Wabi hosting business aimed at Thai users could
     hit the thresholds.

4. **US state money-transmitter statutes — pointer display duty** — state
   MTL definitions and FinCEN's MSB rules turn on receiving/holding/
   transmitting funds "on behalf of another person". Consistent authority
   (Cornerstone, Tagada, FinCEN commentary): "pure software providers that
   never control funds are generally outside the requirement"; the line is
   control/constructive possession of funds — platforms that only pass
   payment instructions while funds move directly payer→payee via third
   parties are not money transmitters. Finding: the in-house analysis
   holds — Wabi displaying Zelle/Venmo/crypto pointers with money moving
   P2P through the payer's own app never receives, holds, or transmits
   funds. **Risk lines:** the moment Wabi collects anything itself —
   commission routed through Wabi, escrow, held balances, refund
   intermediation, disbursement on behalf of sellers — it becomes an
   intermediary touching funds (MTL per state + FinCEN MSB registration +
   18 U.S.C. 1960 exposure if unlicensed). California's "facilitating"
   language is broader than most states; confirm no state reads pointer
   display as facilitation without fund control. Zelle network terms
   already bar commercial use, so the sheet must stay personal-scale
   (see §8).

**Phase 5 design guardrails derived from the research (bind any future
implementation):**
- G1: Funds must always move P2P directly (payer's app → payee's account).
  Wabi never collects, holds, escrows, or disburses money — including
  commissions.
- G2: No on-platform contract conclusion or checkout. Price sheet =
  informational listing + payment pointers only (DAC7 carve-out (b) / DSA
  no-conclusion boundary).
- G3: Commission, if ever added, must be settled outside the payment flow
  (separate P2P transfer) or deferred until counsel clears the DAC7/MSB
  analysis.
- G4: A Thai-operated commercial service re-checks ETDA thresholds
  (>5,000 monthly users / THB 1.8M individual revenue) before launch.
- G5: Keep the sheet personal-scale for US rails (Zelle/other network terms
  bar commercial use).

## 8. Sources (2026-08-18 verification)

- DAC7: Directive (EU) 2021/514 Art. 8ac + Annex V §I.A.1 (EUR-Lex);
  European Commission DAC7 page; Dutch Tax Administration DAC7 platform
  check (carve-outs: payments processing / listing-advertising / redirect
  only); Lexology DAC7 summary (small-seller de minimis <30 sales / ≤€2,000);
  dodopayments DAC7 guide (platform definition, exclusions, UK equivalent).
- DSA marketplace boundary: Freshfields "DSA decoded #9 — The DSA and online
  marketplaces" (2025-12); ACM draft DSA guidelines (B2C online marketplace
  definition, distance-contract reference); William Fry / Baker McKenzie DSA
  categorisation notes; LexisNexis distance-contract glossaries (Consumer
  Rights Directive 2011/83/EU).
- Thailand: DG Revenue Notification 27 Dec 2023 (Royal Gazette; Grant
  Thornton Thailand; sherrings.com; thailand-business-news) — THB 1,000M
  platform-revenue threshold; Royal Decree on Digital Platform Service
  Businesses B.E. 2565 + ETDA thresholds (ETDA decree text; Tilleke;
  LawPlus; IAPP; TDRI) — THB 1.8M/50M or 5,000 monthly users; ETDA 2026
  roadmap (Silk Legal) incl. designated-marketplace + social commerce
  notifications.
- US MTL: Cornerstone Licensing "Who needs money transmitter licenses"
  (software providers that never control funds are outside; control of
  funds is the line); Tagada MTL guide (constructive possession test);
  Torres Business Law (MSB vs money transmitter, payment processor
  exception); ComplyOne (payment processor exemption elements); FinCEN MSB
  framework via Torres; 18 U.S.C. 1960.
- Wero status/expansion: wero-wallet.eu; banking.vision Wero 2025–2026;
  EPC insight. (Still BE/FR/DE; NL/LU 2026; e-comm QR France 2026; PoS 2026–27.)
- US 1099-K: OBBBA (July 2025) restored $20,000/200-transaction threshold for
  2026+ — 1099online.com threshold summary; tabservice.com 1099-K requirements.
- Zelle: standard network terms (personal, not business/commercial use);
  zelle.com FAQ (no IRS reporting; bank network, not TPSO).
- Privacy.com: privacy.com (active, US-only, identity-verified, spend-side
  virtual cards).
- BOLT 12: bolt12.org (static reusable receive offers, no web server).
- Stablecoins: triple-a.io top stablecoins 2026 (USDC #1);
  stripe.dev stablecoin checkout (USDC on ETH/SOL/Polygon/Base);
  circle.com stablecoin-payments analysis.
