# Western Bank-to-Bank Payments Research (2026) — "PromptPay for the West" Attempt 2

Status: Research, verified Aug 2026
Owner: Payments (th-payments / western-payments / btc-payments)
Related: `PROJECT_DOCS/04-payments/PAYMENTS_NONCUSTODIAL_PLAN.md`, `PROJECT_DOCS/archive/PAYMENTS_IMPLEMENTATION.md`, `PROJECT_DOCS/archive/PAYMENTS_ADAPTER_CONTRACT.md`

## 1) The reframe

The Western problem was never "there are no bank-to-bank rails." It was that
the **card machine** (PSP / merchant account / Stripe) is the only thing anyone
talks about, so every Western-payments attempt funnels into "become a business
middleman or force KYC." That's a false binary.

The truth: **bank-to-bank request rails exist and are open in the EU, UK, and
Canada, and semi-open in the US.** The PSP mountain is only required for
*cards*. If the art bazaar is fine with buyers paying from their own banking
app (exactly like PromptPay in Thailand), Wabi can do the West the same way it
did Thailand: **encode the seller's bank destination into a QR/link; Wabi
never touches money; the seller shares no more than the rail itself requires.**

What PromptPay is in Thailand: a QR that encodes a recipient ID + amount,
scanned by any Thai banking app, settled instantly. Equivalent rails, 2026:

| Region | Rail | Open QR? | Settle | Middleman needed? | Real-name exposure |
|---|---|---|---|---|---|
| EU/EEA | SEPA Instant | **Yes (EPC QR-067)** | <10s, mandatory | No | Name + IBAN (VoP check) |
| Switzerland | Swiss QR-bill | Yes (own spec) | SEPA instant | No | Name + IBAN |
| UK | Faster Payments | Partial (no EPC-style standard) | Real-time | No | Name + sort/account |
| Canada | Interac e-Transfer | No (bank-app generated only) | Real-time | No | Email/phone + name |
| US | Zelle | No (bank-app generated only) | Minutes | No | Phone/email + name |
| US | ACH | No (account # is dangerous) | Days | No | Name + routing/acct (doxx-risk) |
| Cards | Visa/MC/Amex | — | T+1 | **Yes (always)** | Full KYC at PSP |

## 2) EU/EEA — the closest thing to PromptPay (2026 facts)

- **SEPA Instant is now law.** Regulation (EU) 2024/886 (Instant Payments
  Regulation): euro-area banks must receive instant transfers (since 9 Jan
  2025) and must send them at no more than standard-SEPA cost (since 9 Oct
  2025). Non-euro EU countries phased through 2027. ~2,792 PSPs (79% of SEPA,
  92% of euro area) were live by Oct 2025; SCT Inst is ~31% of all euro credit
  transfers and climbing.
- **Verification of Payee (VoP) is mandatory since 9 Oct 2025** — banks check
  the payee name matches the IBAN before sending. Practical effects for Wabi:
  (a) payouts don't get eaten by typos, (b) the seller's real name is verified
  and visible to the buyer — that is the floor of doxx on this rail.
- **The QR standard is open and universal: EPC QR (EPC069-12), aka
  GiroCode/Stuzza.** An 11-line plain-text payload (service tag `BCD`, version,
  charset, `SCT`, BIC optional, name ≤70 chars, IBAN, `EUR<amount>`,
  purpose, refs, info ≤70 chars). Error correction level M. Read by 500+
  banking apps (Sparkasse, Deutsche Bank, ING, N26, Revolut, KBC, OP, etc.).
  Mandatory for German banks since 2019; adopted in AT, BE, DE, NL, FI, LU,
  EE, LV, LT. This is functionally PromptPay's EMVCo QR, but bank-rail-flavored.
  (Switzerland's "QR-bill"/Swiss QR is its own similar spec, mandatory for
  business invoices there.)
- **Nov 15 2026:** structured addresses become mandatory for SEPA — any
  address field in the payload must be structured; keep payload addresses empty
  or structured. Easy to comply with if we generate payloads ourselves.
- **Wero (EPI wallet) — watch item, not buildable today.** P2P live in DE/FR/BE
  (45M+ users), P2PRO merchant QR (≈0.7%) in DE/FR/BE, iDEAL→Wero migration in
  NL during 2026, more countries phased through 2027. QR generation is
  merchant/bank-side, not open to third parties yet — so Wabi can't mint Wero
  QR today. But it's the commercial proof that Western QR bank payments work.
- **SEPA Request to Pay (SRTP)** — EPC scheme exists, minimal bank adoption.
  Ignore for now.

**Implementation shape for Wabi (pure, no API, no merchant account):**
generate the EPC QR-067 string from {seller IBAN, name, amount, reference},
render QR (reuse th-payments QR rendering), buyer scans with any EU banking
app, VoP confirms name, money lands in ~10s, buyer types the Wabi reference
code into the transfer's reference field, seller confirms in chat. Status =
existing `Unverified QR` / `Manual` model — no webhooks exist on this rail.

## 3) UK — Faster Payments

- **FPS (Pay.UK)**: real-time, 24/7/365, up to £1m, standard for UK bank-to-bank
  (sort code + account number). 5.55B transactions / £4.84T in 2025.
- **No EPC-style QR standard for FPS.** UK QR payments in 2026 are either
  card-QR (PSP) or **Open Banking "Pay by Bank" QR** via regulated PISPs
  (Atoa, Wonderful, Noda, Stripe+Tink, GoCardless, NatWest Payit). OB has
  15-16M active users; Amazon UK launched Pay by Bank at checkout in 2026.
  OB QR = the PISP is a small middleman (£0.20/tx or similar, no merchant
  account needed beyond a UK business account receiving FPS). It's a
  "contracted adapter" — much cheaper than a PSP but still a third party.
- **Purest Wabi path**: no QR standard exists, so generate a text/URL QR
  carrying sort code + account + amount + reference, or a `paylink` that
  pre-fills the bank app where supported. Same Manual-confirmation model.
  Watch: pay.by app / "Pay by Bank app" standard attempts; nothing solid yet.

## 4) Canada — Interac e-Transfer

- The rail: email/mobile-number addressing, near-real-time, 300+ institutions,
  autodeposit eliminates security-question friction.
- **Explicitly NO open QR prefill standard for personal e-Transfer** — Interac
  itself states you cannot natively generate a QR that pre-fills a personal
  P2P e-Transfer with amount+recipient.
- Interac **Business Request Money** (QR-driven) exists but is a bank business
  product via BMO/CIBC/DC Bank/Peoples Trust/Scotiabank — seller-side setup,
  not third-party generatable.
- **Practical Wabi path**: the seller generates an e-Transfer "request money"
  link/QR inside their own banking app and pastes it into the Wabi listing;
  Wabi stores it as the artifact (saved-account-link pattern), buyer opens it,
  pays from their bank app. Wabi adds the amount + reference note. Confirmation
  is Manual. No middleman, no API, no KYC beyond having a Canadian account.

## 5) US — the real mountain (and its honest shape in 2026)

- **Zelle** is the only true bank-to-bank P2P rail and it is **semi-closed**:
  - QR codes exist (Zelle® QR Code) but are generated inside the bank apps
    (Chase, BoA, Wells Fargo, US Bank, Huntington, HSBC) — no public payload
    spec, so Wabi cannot mint them. Seller pastes their own Zelle QR/link
    into Wabi (same pattern as Canada).
  - Zelle for Business is now mainstream: $357B in small-business payments
    (2025, +26% YoY), 7.7M businesses enrolled, no fees, per-bank limits
    (daily ~$5k-$25k business).
  - Doxx floor is the best in the West: phone/email + name, **no account
    numbers ever exposed**.
  - Caveats: both parties must be enrolled at participating banks; no buyer
    protection; business receipt rules vary by bank; US-only.
- **ACH direct** (routing + account): works but in the US an account number can
  be used to *pull* funds (ACH debit), so sharing it is a genuine doxx/security
  risk — unlike IBAN in SEPA. Offer as last resort with a warning.
- **FedNow / RTP**: instant rails with "Request for Payment" QR concepts, but
  they require bank/FI APIs and business accounts — and FedNow is explicitly
  excluded in Wabi policy. Keep excluded; note as future if policy changes.
- **Cards**: the only US expectation that needs a PSP. `western-payments`
  plugin (contracted adapter) is the correct home for that — opt-in, per-seller.
- **Bottom line for the US**: no fully-open bank-QR rail exists. The honest
  bazaar UX is "seller attaches their own Zelle QR/request link (or Venmo/
  Cash App), Wabi reconciles via reference/amount, crypto covers the rest."
  This is the one region where the "no middleman, no doxx" bar cannot be met
  by Wabi code alone — but Zelle gets ~90% of the way with zero fees.

## 5b) Links vs QR — QR is not required

QR is only ever a *transport* for the same request data. Every region that
supports QR also supports a link or a copy-paste path; QR just removes the
typing. Per region:

- **EU**: no universal "pay link" exists (banks have no shared deep-link
  scheme; SEPA Request to Pay is the link-based spec but has minimal
  adoption). The EPC QR *is* the universal carrier — scan opens the banking
  app. Without QR: show IBAN + reference with a copy button; buyer pastes
  into their bank app manually. Works, but ~20 seconds of typing vs one scan.
- **UK**: no standard either way. A `paylink` (bank-app deep link where
  supported) or text payload with sort code/account/reference; copy button.
- **Canada**: **links are native** — Interac "request money" links/QR are
  generated inside the seller's banking app and shared; Wabi just stores and
  wraps them.
- **US**: **links are native** — Zelle request (via bank app) and Venmo/Cash
  App request links; Wabi stores and wraps them.

So the bazaar UX should be artifact-agnostic: a payment intent can carry
`qr`, `paylink`, or `bank_details` (copy block) presentations — the plugin
contract already models `payment_link` / `redirect` modes. QR where a public
standard exists (EU), links everywhere else.

## 5c) Proxy cards / virtual IBANs — can we get PromptPay-style renaming?

**Yes, "proxy" products exist — they are called virtual IBANs (vIBANs), and
the 2026 regulatory reality decides how much renaming they actually give.**

How vIBANs work: an EMI/BaaS (ClearBank, Currencycloud, ConnectPay, etc.)
issues a unique, normal-looking IBAN per seller that routes to a licensed
master account and auto-reconciles to the right seller. This is exactly how
Stripe/Adyen run marketplace payouts in Europe, and it is the receive-side
proxy the "proxy card" intuition points at. (Virtual *cards* — Privacy.com,
Revolut, Payoneer — are spend-side only; they never help someone pay *you*.)

The renaming reality, 2026:

- **Anonymous/pooled vIBANs are dead.** The EBA's 2024 vIBAN report, the EU
  AMLR (applies 10 July 2027), and mandatory **Verification of Payee**
  (since 9 Oct 2025) mean every vIBAN must be a *named* vIBAN tied to a
  KYC-verified entity — an anonymous vIBAN fails the VoP name check and the
  payer's bank blocks or warns. There is no fiat-rail identity hiding left in
  Europe; PSD3/AMLR tighten this further from 2027.
- **What renaming IS achievable**: a vIBAN registered to a **brand/company
  name** (business account at the EMI) — the buyer's VoP check sees "Mika's
  Print Studio", not "Mika N." The seller's real identity lives with the EMI
  (KYC once), never with the buyer. For individuals without a registered
  brand, their legal name shows — same floor as every other fiat rail.
- **What vIBANs DO always give you**: your real bank account identifier is
  never exposed (disposable IBAN string instead), and reconciliation is
  automatic (unique IBAN per seller — no ref codes). That's a real privacy
  + QoL win over raw rails.
- **The trap for Wabi**: pooled-vIBAN-under-Wabi (Wabi holds the master
  account, issues vIBANs to sellers) makes Wabi the money holder — money
  transmission, safeguarding rules (FCA EMIs from May 2026, EU fund
  segregation), client-money attribution, the whole regulatory edifice. That
  is the "become a business middleman" lane wearing a nicer hat.
- **The clean version (in plain terms)**: the *seller* opens their own
  account at the EMI — one-time KYC with the EMI, gets a vIBAN — and Wabi
  does nothing but display that vIBAN on the listing, exactly as it would
  display a normal IBAN. Money path: buyer's bank → EMI → seller's real bank
  account. Wabi never holds, routes, or touches the money. The EMI is the
  seller's own relationship, not Wabi's; if the seller stops paying the EMI,
  they stop getting money — nothing breaks for Wabi. Wabi stays
  non-custodial; the EMI is a middleman-lite (~€5-30/mo per account, no
  per-transaction %). This is a "pro" lane for sellers who want a brand name
  on the rail and don't want to hand out their main account — not an
  anonymity mechanism.

**Honest bottom line on "anon renaming on both sides":** Thai PromptPay
renaming is a feature of Thai bank apps (display aliases); Western fiat rails
enforce legal names by law (VoP) as of Oct 2025. The only lanes with true
two-sided renaming are the wallet/EMI layer (brand-name accounts, KYC at the
provider) and crypto (already shipped). Wabi should present this as a choice:
raw rail (real name, zero middleman), brand-EMI vIBAN (brand name, light
middleman), or crypto (nothing shown).

## 6) The compliance answer (why this doesn't make Wabi a money transmitter)

- The line that matters: **custody/transmission, not "payment"-looking code**.
  FinCEN's definition (31 CFR 1010.100(ff)(5)) covers accepting and
  transmitting funds. FinCEN Ruling 2003-8 already carved out
  third-party-origination/invoice services: a service that only submits
  payment instructions obtained from a merchant to a bank and passes through
  funds is not a money transmitter; more importantly for Wabi, a platform that
  **never touches funds at all** is a classifieds/invoicing tool, same as the
  many unlicensed invoice-with-QR generators (Venmo/Zelle/PayPal invoice QR
  tools), and the "classifieds site where two people settle directly" example
  cited in MSB guides.
- Wabi's hard boundaries already guarantee this: no custody, no stored-value,
  no internal ledger, no P2P transfer ledger (see plan §2). Generating an
  EPC QR or storing a seller's Zelle request link adds nothing to that posture.
- **The doxx is the rail's, not Wabi's**: every bank rail reveals name +
  contact (SEPA VoP-verified name + IBAN; UK name + sort/acct; CA email/phone;
  US phone/email). That is a property of the banking system, identical in
  spirit to PromptPay exposing a phone number. Wabi should say this honestly in
  the UX ("this rail shows your bank name to the buyer") and point anon-wanting
  sellers to the crypto lane. For brand-name renaming, see §5c (EMI vIBAN
  lane) — it hides your *real account*, not your name, unless you registered a
  brand at the EMI.
- **Volume thresholds are the seller's problem**: US 1099-K reporting (now
  $600+, IRS threshold), UK income tax, EU micro-entrepreneur rules. The bazaar
  should nudge sellers ("talk to your bank beyond X volume"), but Wabi is not
  the reporting entity because it doesn't process the money.
- This is technical policy, not legal advice — same disclaimer as the payments
  plan (§9).

## 7) Recommendation — four lanes, not one

1. **Lane 1 — Bank-rail request plugin family (the art bazaar default).**
   Artifact-agnostic: QR where a public standard exists, **links elsewhere,
   copy-block as universal fallback** (see §5b). No PSP, no merchant account,
   no KYC beyond the bank account the seller already has. Reuses th-payments
   QR/presentation machinery:
   - `sepa-bank`: EPC QR-067 payload generation + rendering (pure string math;
     ~a day of work; the EU is the West's PromptPay) + IBAN/reference copy
     block for no-QR users.
   - `uk-bank`: FPS text payload (sort/account/amount/reference) as QR and/or
     copy block; bank-app paylink where supported.
   - `ca-bank`: seller pastes their bank-app e-Transfer request link/QR;
     Wabi wraps it with amount + reference note. Link-first.
   - `us-bank`: seller attaches their Zelle QR/request link (or Venmo/Cash
     App fallback); Wabi reconciles by reference; ACH details offered with a
     security warning. Link-first.
   - Confirmation: existing `Unverified QR` + `Manual` modes. **Key
     mechanism: unique short payment reference** (e.g. `WABI-7F3K`) the buyer
     types into the transfer message and the seller sees in their bank
     statement — that is the reconciliation API that doesn't require any API.
   - Seller bank destinations go in the existing `payment_account_link`
     store (saved-references feature is already built).
2. **Lane 1.5 — EMI vIBAN "pro" lane (the renaming option).** Per-seller
   named vIBANs at an EMI (brand/company name registered once, KYC at the
   EMI). Wabi stays non-custodial — it only stores/renders the vIBAN like any
   other destination; the seller holds the EMI relationship. Gives: brand-name
   renaming on the rail, real account never exposed, automatic reconciliation.
   Costs: ~€5-30/mo per seller. **Never pooled-vIBAN-under-Wabi** (that's
   money transmission). This lane is a later feature, not the bazaar MVP.
3. **Lane 2 — Cards stay PSP-only.** Keep `western-payments` (contracted
   adapter) as an explicit opt-in for sellers who want card/Apple-Pay reach and
   are willing to become merchants. This is the old mountain, deliberately
   quarantined behind a merchant contract instead of blocking the bazaar.
4. **Lane 3 — Crypto.** Already done; remains the anon + global lane and the
   natural cross-region fallback (SEPA is EUR-only, Zelle US-only, e-Transfer
   CA-only, FPS UK-only).

## 8) Open risks / watch items

- **Quishing** (QR-phishing) is rising fast (UK Action Fraud: +587% 2023-2025;
  Europol calls it fastest-rising payment-initiation attack). Mitigation:
  always render bank-rail QRs in-app with the destination previewed, no
  third-party QR stickers, allow listing owners to rotate/replace artifacts.
- **SEPA VoP** means the QR must carry the seller's exact bank-registered name;
  wrong name = rejected transfer. Store the account-link with the name the
  bank verified (seller self-reports; first failed transfer is the validator).
- **EU structured addresses (Nov 15 2026)** — keep payload address fields
  empty/structured.
- **Zelle QR is bank-generated** — Wabi cannot mint it; UX must make
  "attach from your bank app" frictionless or US sellers will fall back to
  phone/email paste, which is fine too.
- **No webhooks on any bank rail** — the plan's `Awaiting external
  confirmation` status is the correct honest state; ref-code matching is the
  only automation lever without open-banking middlemen.
- **Business-use thresholds** (Zelle business limits, 1099-K, EU VAT for
  professional sellers) are seller-side; surface guidance, don't try to solve.
- **Wero** — if EPI ever opens QR issuance to third parties (no sign yet),
  it becomes a native Lane-1 method for DE/FR/BE/NL.
- **"Smite power" is the real reason bank rails are the default.** Card
  networks and PSPs (Visa/MC/Stripe/PayPal) can terminate a business,
  freeze payouts, and eat it via chargebacks — with no recourse, at any
  scale. Raw bank rails have none of that: SEPA/FPS/Interac/Zelle instant
  transfers have no chargeback mechanism and the money is received, full
  stop. Banks can still close accounts for AML flags, and EMIs can hold
  funds for review (the same risk class as PayPal, just smaller), but no
  network can smite a seller who only ever gets paid by bank transfer.
  This is Lane-1/L1.5-over-L2 design rationale, and it's what the
  `western-payments` (cards) plugin must stay behind an explicit opt-in.

## 9) Sources (verified Aug 2026)

- SEPA Instant mandate: EPC SCT Inst page; ECB Instant Payments Regulation;
  PaymentExpert SEPA-instant guide (2026-07); Mollie SEPA Instant guide
  (2026-08) — 10s settlement, VoP 9 Oct 2025, structured address 15 Nov 2026,
  €100k cap removed.
- EPC QR: Wikipedia EPC QR code; EPC069-12 guideline (v3.0 2022);
  GiroCodeGenerator technical guide (2026-06); QRPayHub GiroCode guide;
  Sparkasse GiroCode page.
- Wero: wero-wallet.eu; banking.vision Wero 2025/2026 (P2PRO ~0.7%, iDEAL
  migration, 16-country plan); PayRequest Wero guide (45M+ users);
  Mollie/EPI membership.
- UK: Pay.UK FPS (2026-07: 5.55B tx 2025, up to £1m); businessexpert.co.uk
  QR payments UK (2026-07: OB 15M connections mid-2026, Amazon Pay by Bank,
  Atoa/Wonderful/Noda/Stripe-Tink/GoCardless); paywithatoa.co.uk OB QR
  (2026-06); FCA OB progress update.
- Canada: Interac Business Request Money page (2026-07 — explicitly: no native
  QR prefill for personal e-Transfer; BRM via BMO/CIBC/DC Bank/Peoples
  Trust/Scotiabank); Payments Canada QR perspective (CANQR, no national
  standard); remitbee e-Transfer guide (autodeposit, limits).
- US: Zelle.com Business; the-qrcode-generator.com Zelle QR guide (2026-05:
  $357B business volume 2025, 7.7M businesses, BoA/Wells/US Bank/Chase/
  Huntington QR support); HSBC/US Bank Zelle QR FAQs; WealthVieu Zelle
  business limits (2026-05).
- Compliance: FinCEN Ruling 2003-8 (merchant payment processor not a money
  transmitter); 31 CFR 1010.100(ff)(5); uslawexplained.com MSB guide
  (classifieds example; agent-of-payee exemption).
- vIBANs / proxy accounts: virtual-ibans.com FAQ (named vIBANs, VoP,
  EBA/AMLR); Venly "Virtual IBANs explained" (routing key, safeguarding,
  KYC responsibility); Finqfy vIBAN guide (2026-06: named vs pooled,
  PSD3/AMLR timeline, FCA safeguarding 7 May 2026); Transak vIBAN overview
  (AMLR end-user ID by 2027); Brighty IBAN guide (named vs pooled, EMI
  onboarding); virtual-ibans.com EBA rules 2026 (PSD3 agreed Nov 2025,
  AMLR 10 Jul 2027); Stripe marketplace-payouts guide (2026-06: vIBAN
  per-seller model, payout KYC).
