# Direct payment options for Wabi — 2026-10-03

Status: researched design and test setup reference; current provider payment
acceptance is **unverified**. Local direct-payment acceptance is documented separately.
Scope: self-hosted communication software that lets one person request payment from another.
Related: `docs/payments/PAYMENTS_NONCUSTODIAL_PLAN.md`, `docs/PROJECT_STATUS.md`.

## Recommendation

Preserve the direct-payment model: the recipient supplies a bank destination,
wallet receive address, or their own provider-hosted checkout link; the payer
authorizes payment in their bank, wallet, or provider. Wabi records the request
and the recipient's acknowledgement. Wabi must not hold funds, take a cut,
pool payments, provide escrow, or create an internal spendable balance.

The achievable privacy goal is **no extra identity-document collection by
Wabi**. Existing banks/processors can still require verification. No payment
method should be described as universally free of KYC or guaranteed anonymous.

Start with reliable existing direct rails. Seller-owned Stripe and PayPal links
are a possible optional extension, subject to country/product eligibility.
Centralized Connect or PayPal marketplace processing is a separate integration
decision; it should not silently turn every self-hosted server into the operator
of a provider marketplace account. This recommendation is provisional until
operator country, seller countries, and desired confirmation model are known.

User clarification, 2026-10-04: the developer intends his personal Wabi server
for close friends and family. Third-party commercial/SaaS operators would manage
their own deployments, provider accounts and applicable compliance. Assess
software publishing and that private use separately from an independently
operated commercial marketplace; do not infer an automatic exemption from
FOSS licensing, an invitation-only server or this allocation of responsibilities.

## What the current source actually implements

- `core/crates/wabi-server/src/api/payments/` exposes payment access,
  account-link, donation, and manual-intent routes. It has no Stripe/PayPal
  checkout API or provider webhook settlement route.
- `core/addons/payments-{us,eu,crypto}/` generates payment destinations/artifacts;
  these are not bank or wallet settlement integrations.
- `addons/payments-psp/backend/src/index.ts` is legacy scaffolding. It advertises
  methods based on credentials but returns an `example.com` checkout URL;
  verification, status retrieval, and refunds are unimplemented.
- `plugins/western-payments/` belongs to the older Node plugin adapter/test
  architecture. Its presence is not evidence of a working Rust provider path.

Therefore an automated “verified paid”, refund, or dispute label cannot be
inferred from the current manual rails, a redirect, a generated QR, or old plugin
credentials. Use recipient-recorded receipt and external-provider support labels.

## Options and verification boundaries

| Option | Funds path and setup | Wabi confirmation | Identity/privacy limits |
| --- | --- | --- | --- |
| Personal PromptPay QR | Payer's bank → recipient's registered bank destination | Recipient records receipt | Registration links an existing bank account to a citizen ID/phone; bank verification remains. Payer's bank can reveal the registered recipient name. [BOT PromptPay](https://www.bot.or.th/en/financial-innovation/digital-finance/digital-payment/promptpay.html) |
| EPC SEPA transfer QR / bank details | Payer initiates in their bank → recipient's bank | Recipient records receipt | Existing bank onboarding remains; bank details and recipient name are disclosed. QR generation is not a guarantee of app support, transfer speed, or settlement. |
| US payment-app pointer | Payer uses their supported payment app → recipient's account | Recipient records receipt | Provider verification and commerce-account rules remain. Display names are not proof of anonymity or destination ownership. |
| Self-custody crypto receive request | Payer's wallet → recipient's address on the specified network | Recipient records receipt unless a separate verifier is implemented | No Wabi identity document is technically needed. Exchanges/onramps can require KYC; addresses and public transaction history can identify users. [Bitcoin privacy](https://bitcoin.org/en/protect-your-privacy) |
| Seller-owned Stripe Payment Link | Buyer → seller's Stripe account; seller creates hosted link | Manual in Wabi without authenticated seller-specific reconciliation | Seller needs Stripe account and required verification; hosted page handles payment details. Link price/currency must be checked externally. [Stripe Payment Links](https://docs.stripe.com/payment-links) |
| Seller-owned PayPal Payment Link | Buyer → seller's PayPal account; seller creates hosted link | Manual in Wabi without authenticated seller-specific reconciliation | PayPal Business account is a documented prerequisite for this product. Provider controls verification and eligibility. [PayPal create payment link](https://developer.paypal.com/payment-links-buttons/create-payment-link/) |
| Optional Stripe Connect direct charge | Buyer → connected seller's Stripe balance; no Wabi application fee | Possible with correctly bound, signed provider events | Every seller is subject to Stripe verification. Choose dashboard, fee payer, and negative-balance liability explicitly. [Charge types](https://docs.stripe.com/connect/charges), [verification](https://docs.stripe.com/connect/identity-verification) |
| Optional PayPal multiparty integration | Buyer pays onboarded seller through approved partner integration | Possible with correct provider events/API reconciliation | PayPal screens sellers; live marketplace APIs require partner approval. Casual-seller support depends on the configured product/intent. [Get started](https://developer.paypal.com/platforms/get-started), [seller onboarding](https://developer.paypal.com/platforms/seller-onboarding) |

Stripe supports goods/services payments; it prohibits personal or peer-to-peer
money transmission. Wabi's phrase “two people pay each other for whatever” must
not imply an unrestricted Stripe money-transfer service. Content platforms and
other restricted categories may also require approval. [Stripe restricted businesses](https://stripe.com/legal/restricted-businesses)

Stripe-hosted onboarding handles the evolving account verification flow. Actual
requirements depend on country, capabilities, entity/structure, agreement, and
risk. Incremental onboarding reduces initial steps; it does not remove eventual
requirements or prevent processing/payout pauses. [Stripe identity verification](https://docs.stripe.com/connect/identity-verification)

Stripe's PromptPay checkout is a distinct PSP product from Wabi-generated
personal QR. The current public product supports THB and Thai business accounts;
US business support is private preview. It supports Connect and Payment Links.
[Stripe PromptPay](https://docs.stripe.com/payments/promptpay)

For Wabi-generated personal PromptPay QR, BOT's Thai QR standard distinguishes
mobile-number subtag `01` (13 normalized digits), national/tax-ID subtag `02`
(13 digits), and e-wallet subtag `03` (15 digits). Encoding a 15-digit e-wallet
as a national-ID proxy is invalid, even when its CRC is correct. Payload
validation must bind both the proxy type and its value to the request.
[BOT Thai QR standard, §2.3](https://www.bot.or.th/content/dam/bot/fipcs/documents/FPG/2562/EngPDF/25620084.pdf)

## Correct the earlier legal and privacy assumptions

1. **Thailand has not removed verification.** PromptPay uses existing bank
   relationships; BOT's e-money PromptPay guidance explicitly requires customer
   identification/account-owner verification. Wabi can avoid adding its own
   duplicate identity-document workflow. [BOT e-money PromptPay guidance](https://www.bot.or.th/content/dam/bot/fipcs/documents/FPG/2563/EngPDF/25630315.pdf)
2. **Crypto is not an automatic KYC exemption or anonymity guarantee.** Bitcoin
   transactions are public and traceable. Thailand's TouristDigiPay sandbox
   converts assets to THB through licensed operators/e-money providers and
   requires KYC/CDD; it is not unrestricted direct crypto merchant payment.
   [SEC sandbox launch](https://www.sec.or.th/EN/Pages/News_Detail.aspx?SECID=12095),
   [SEC TouristDigiPay](https://www.sec.or.th/EN/Pages/Shortcut/TouristDigiPay.aspx)
3. **“No custody ⇒ no regulated payment service” is too broad.** PSD2 Article
   3(j) excludes qualifying technical support, but explicitly excludes payment
   initiation/account information from that carve-out. Recital 35 describes
   regulated providers that do not hold client funds. Displaying a destination
   differs from accessing a bank account to initiate a transfer.
   [PSD2 Article 3(j), Recital 35](https://eur-lex.europa.eu/eli/dir/2015/2366/oj/eng)
4. **US treatment depends on actual control and activity.** FinCEN's CVC
   guidance distinguishes hosted services, user-controlled wallets, software
   development, and deployment to perform transmission. It does not establish
   worldwide immunity for software labelled “non-custodial”.
   [FinCEN FIN-2019-G001, §§4.2.1, 5.2](https://www.fincen.gov/system/files/2019-05/FinCEN%20CVC%20Guidance%20FINAL.pdf)
5. **Advertising-only exclusions are conditional.** DAC7 Annex V I(A)(1)
   excludes software exclusively processing payments, listing/advertising, or
   redirecting without further intervention. That does not prove every
   commission-sheet/chat deployment qualifies. DSA trader traceability has its
   own scope and Article 29 micro/small-enterprise exception; custody is not the
   test. Assess the actual operator/deployment before expanding commerce flows.
   [DAC7](https://eur-lex.europa.eu/eli/dir/2021/514/oj),
   [DSA Articles 29–30](https://eur-lex.europa.eu/legal-content/en/TXT/PDF/?uri=CELEX%3A32022R2065)

These are engineering boundaries and source-backed corrections, not a legal
determination that any particular operator is exempt or regulated.

## Test setup matrix

| Test level | Possible without provider credentials? | Required setup / evidence |
| --- | --- | --- |
| Amount/currency precision, QR/URI vectors, wrong network, invalid destination | Yes | Local unit/contract tests; no real payment |
| Recipient ownership, role/block gates, confirmation transitions, replay/restart, cross-account privacy | Yes | Isolated local Wabi data and test users; backend regression tests |
| Sheet, settings, connections, history, donation, mobile/narrow states | Yes | Real rendered browser; two local users; QR decode where possible |
| Stripe seller-owned hosted-link payment | Credentials required; human registration can sometimes be avoided | Official CLI can provision a temporary anonymous test sandbox; current attempts returned HTTP 429 without keys. With a usable sandbox, complete the hosted page with test cards and inspect the resulting seller transaction |
| Stripe Connect onboarding, charge, failure/3DS, refund, dispute, payout simulation | No | Operator Stripe sandbox with Connect enabled, test sellers, test keys, signed webhook listener; no real identity documents/funds |
| PayPal hosted-link or Checkout payment/refund | No | Developer account, sandbox Business seller + Personal buyer, app credentials if using API; actual sandbox capture/refund |
| PayPal multiparty onboarding | No | Sandbox platform app/configuration; live mode additionally needs approved partnership |
| PromptPay/SEPA/US apps end-to-end bank settlement | No | Real supported bank/app/account and separately authorized small transfer; simulator cannot prove actual bank compatibility |
| Crypto wallet interoperability | Partially | QR/URI vectors locally; wallet/network integration needs compatible wallet + explicit testnet/devnet/regtest route, never a mainnet URI with test assets |

Stripe sandboxes provide synthetic identity/payout/payment values and simulate
funds; they may not enforce every production capability. Passing a sandbox does
not prove live eligibility. [Connect testing](https://docs.stripe.com/connect/testing),
[payment testing](https://docs.stripe.com/testing)

PayPal developer accounts provide sandbox buyer/seller accounts. Its webhook
simulator emits mock events that are not actual transactions and cannot use
the postback signature-verification API. Use real sandbox payments to prove
settlement handling. [PayPal API setup](https://developer.paypal.com/api/get-started/),
[webhook simulator](https://developer.paypal.com/api/rest/webhooks/simulator/)

## Implementation sequence

1. Fix existing direct-rail ownership, precision, policy enforcement, persistence,
   manual receipt wording, and settings/browser behavior; add regression tests.
2. Make supported rails/currencies/network and settlement limitations visible;
   show genuine disabled/loading/error states and truthful connection labels.
3. Consider seller-owned hosted-link support with strict URL validation, clear
   provider/domain labels, and manual acknowledgement. A return URL never proves
   payment and arbitrary link prices are not controlled by Wabi.
4. Only after a provider account/configuration is selected, build a verified
   optional adapter. Bind merchant, request/reference, amount, currency, network,
   test/live mode and event ID; reject forged/replayed/mismatched events. Provider
   refunds/disputes require their real lifecycle, not a manual boolean.
5. Run provider sandbox acceptance, then separately authorized production
   validation. Keep API secrets and identity documents out of browser storage,
   chat, committed files, and logs. [Stripe webhook requirements](https://docs.stripe.com/webhooks)

## Observed provider test access

Stripe connector discovery failed to expose a usable authenticated session.
The official CLI offers temporary anonymous sandboxes, which can avoid human
registration for synthetic testing. Fresh CLI 1.53.0 provisioning on this run
returned HTTP 429, “Too many requests,” then fell back to browser login without
saving keys. Three attempts were made; no retry/reset window was exposed and no
further provisioning was attempted. The harness refused the unauthenticated
profile before payment mutations. [Stripe sandboxes](https://docs.stripe.com/sandboxes)

An earlier worker reported synthetic API success/decline/refund and creation of
hosted fixtures. Its temporary profile and provider evidence are now absent;
those results cannot be re-inspected, resumed or counted as current acceptance.
Hosted checkout acceptance is unverified. No live account was claimed and no
real funds moved.

The actual PayPal sandbox-accounts page redirected to an empty sign-in form.
There is no available authenticated Developer session, sandbox seller/buyer or
app credential. No login, registration or payment was attempted. Its documented
setup remains required. [PayPal sandbox guide](https://developer.paypal.com/sandbox-testing/overview)

The test-only CLI harness and 14 offline safety checks are saved under
[`scripts/payments/`](../../scripts/payments/README.md). Its strict hosted mode
requires completed success and documented decline, rather than fixture creation.
See [current public evidence](../testing/payments-2026-10-03/provider-sandbox-status.json).
This harness exercises a provider separately; it does not add a Stripe/PayPal
adapter or verified receipt to Wabi.
