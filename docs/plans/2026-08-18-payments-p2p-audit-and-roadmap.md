# Payments P2P Audit & Roadmap — 2026-08-18

Status: **Audit + roadmap (docs pass); Phase UX executed same day**
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

## 7. Open questions (counsel review items, Phase 5 gate)

1. DAC7 scope for self-hosted multi-seller instances: is an operator-run Wabi
   with a commission sheet a "platform operator" if it never facilitates payment?
2. DSA "online marketplace" definition boundary: pinned price sheet vs. listing
   board.
3. Thai RD platform-reporting thresholds for hobbyist-scale instances.
4. Whether displaying third-party payment pointers creates any operator duty
   in US state money-transmitter statutes (analysis says no; confirm).

## 8. Sources (2026-08-18 verification)

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
