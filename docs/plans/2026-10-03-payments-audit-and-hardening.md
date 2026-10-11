# Payments audit and hardening — 2026-10-03

Scope: current Rust Authority, optional Rust rails, payment UI/settings, donations
and historical provider scaffolding. User decision: direct person-to-person
payments; no custody, escrow or transaction cut. Countries/providers remain open.
This candidate is uncommitted and has not been pushed or deployed.

Operator model clarified by the user on 2026-10-04: Ronin intends his own Wabi
server for close friends and family, while publishing self-hostable software.
Independent commercial/SaaS hosts must assess and meet the obligations of their
own deployments and manage any provider accounts or financial arrangements.
Preserve per-server payment configuration and the absence of a central Wabi
account accepting or transmitting users' funds. This product boundary is not a
legal determination or a blanket exemption for developers or private servers.

## Current maturity

Active `api/payments` routes cover policy, receiving references, donation
configuration, request creation/listing and manual confirmation/rejection.
WabiDB persists the records. Optional `payments-rails` enables EU, US and crypto
instruction builders. There is no active Rust Stripe/PayPal checkout, onboarding,
signed settlement callback, refund or dispute route. Old Node plugins and the
PSP scaffold (which returns an example checkout URL) do not establish support.

## Findings and corrections

| Risk | Finding | Implemented correction |
|---|---|---|
| High | Browser destination cache spanned accounts/servers; rejected writes reported success | Require server acknowledgment; no stale destination fallback; session-fence results |
| High | Old credential with the same numeric account ID could be sent to another Authority | Require the exact current scoped credential when invoking payment APIs; preserve result ownership during same-account renewal |
| High | Selected reference omitted; PromptPay fell back to operator destination | Explicit recipient required and transmitted; remove personal operator fallback |
| High | Account metadata could persist a postcard record that cannot replay | Reject populated metadata at API and adapter before durability |
| High | Arbitrary currency differed from QR/method | Enforce method/currency compatibility server-side |
| High | USDC Base QR represented native ETH without token/amount | Correct EIP-681 transfer; refuse unsafe historic instructions |
| High | Crypto input URI could be wrapped twice/conflict on amount | Normalize supported plain prefixes; reject unsupported query input |
| Medium | Floating minor-unit formatting and silently truncated extra decimals | Exact integer formatting; reject excess precision/bad grouping/unsafe JS integer |
| Medium | SEPA invalid structured reference and unrelated operator payee name | Require payee name; unstructured reference; remove unrelated name/BIC defaults |
| Medium | Ordinary recipients needed admin to record receipt | Registered creator can manually confirm/close; other-member denial remains |
| Medium | Confirmation changed original amount; inconsistent timestamp units; racing finalization | Immutable amount, milliseconds, serialized finalization |
| Medium | Donation client targeted absent routes/dropped tagging | Refuse unsupported checkout; disclose unavailable ledger/refund behavior |
| Medium | History hid instructions and left malformed old QR actionable | Reopen instructions; fail closed on incompatible historical requests |
| Medium | Legacy migration renamed failed input | Preserve source on failure; avoid overwriting imported IDs |
| Medium | Pay/verified connection/instant/anonymity labels exceeded behavior | Request/manual receipt/reference language with method limitations |
| Medium | Older admin block aliases lacked current admission; cancellation released proof before durable work ended | Retain account/role/owner admission across every authenticated payment surface and cancellation; serialize dependent policy decisions |
| Medium | Draft payment preference appeared saved through an ignored user-settings field | Retire phantom persistence; keep method choice local to the current draft |
| Medium | Copied manual crypto instructions lost network or amount limitations | Include method/network, destination label, reference and presentation note in copy/share output |
| Medium | PromptPay e-wallet ID encoded with national-ID tag | Use 15-digit e-wallet subtag `03`; fail closed on historic `02`/15-digit payloads |
| Medium | Unicode operator labels could exceed QR byte limits despite character truncation | Bound uppercase merchant/city labels by UTF-8 bytes; reject oversized historic labels |
| Medium | Older terminal records used microseconds where history expects milliseconds | Normalize legacy update timestamps when reading; keep durable records unchanged |
| Medium | Freshly signed-in member without chat selected had no payment-policy grant in history | Load the existing scoped policy store when history opens/refreshed; no chat visit required |
| Medium | Admin block settings required a success flag absent from the actual server response | Validate the real list/block/clear acknowledgments and their target; retain session fencing and no automatic mutation retries |
| Medium | Global prior-login hint started a probe that replaced a new Authority's successful login with a null/stale username | Remove the unscoped reconnect branch; restore only the current Authority's saved identity and session; browser regression waits beyond the old probe interval |

No persistent record fields were added, removed or reordered. An expanded payer,
payee or verified-provider model needs a versioned storage design.

## Surface coverage

- Chat/DM action: create receiving request, not charge a peer.
- Request sheet: method, amount/currency, explicit reference, payee name, errors,
  QR/instructions, copy/save/share, refresh and status.
- Saved references: reads/writes/deletes, session isolation, method-specific
  destinations, visible failures and sensitive-data wording.
- History: ordinary-account ownership/admin view, export, reopen, manual
  receipt/close, conflict/error feedback.
- Admin access: backend-enforced policy, roles, guests, blocks; old records do
  not become verified payments when policy changes.
- Donations: configuration exists; tracked checkout/ledger/refund does not.
- Providers: inactive Node/plugin and example PSP scaffolds identified honestly.

## Privacy and legal direction

Aim for **no extra identity-document collection by Wabi**, not universal KYC-free
payments. Banks/regulated providers already verify users, including PromptPay.
Stripe/PayPal compliance cannot be bypassed by describing the app as peer-to-peer.
Stripe distinguishes goods/services sales from restricted personal transmission.
Public-chain crypto is pseudonymous and traceable.

No custody is not a blanket legal exemption: some regulated payment-initiation
services hold no funds, and marketplace/reporting obligations depend on features
and jurisdiction. QR display differs from bank API initiation. Assess the actual
deployment before adding orders, fees, initiation or centralized provider accounts.
See [official research](../research/payments-direct-transfer-options-2026-10-03.md).

## Remaining roadmap

1. Accept supported instructions in actual banking/wallet apps; choose first
   countries. Keep direct transfer/manual receipt as the core boundary.
2. Add optional seller-owned hosted checkout links with clear external-provider
   terms. Ordinary chat can already share those links.
3. If verified status is wanted, add a versioned party/provider/request domain,
   durable idempotency, signed callback verification, exact seller/amount/currency/
   environment binding, replay protection and supported transition ordering.
4. Test actual provider sandboxes: success, decline, authentication, asynchronous
   completion, duplicate/reordered events, refunds and disputes. Advertise only
   providers with a real adapter and passing acceptance.
5. Assess full listings/orders marketplace separately; these records provide
   neither escrow, purchase protection nor accounting.

Open gaps: no provider verification or authenticated payer; no proven payee-account
ownership; address checks not complete checksum verification; deleted references
remain in event history; lists not paginated; old bad metadata needs explicit
backup/recovery. These changes do not certify the whole app or legal status.

## Expanded acceptance gates

The active hard goal covers the direct-transfer model and all work possible with
available local tools and provider test environments. Completion requires:

- [x] Research actual bank/wallet/provider and verification boundaries using
  official sources; withdraw older blanket legal and anonymity claims.
- [x] Correct destination selection, exact amounts/currencies, unsafe stored QR
  artifacts, metadata durability, manual status ownership and visible errors.
- [x] Render the real app on desktop/mobile and exercise all twelve instruction
  methods against disposable Authority data.
- [x] Validate mutations across credential revocation, changing roles/payment
  policy and cancellation; close any proven admission gaps.
- [x] Validate administrator settings and rendered payment data across actual
  account/server changes, including pending requests.
- [x] Build and test the full current checkout with optional payment rails;
  resolve safe narrow integration blockers while preserving independent work.
- [x] Decode exported QR artifacts to verify they represent intended request
  details, where an actual decoder is available.
- [x] Attempt available provider sandbox access and record its exact relationship
  to the manual Wabi flow. Stripe provisioning returned HTTP 429 without keys;
  PayPal requires unavailable Developer access. Actual provider checkout remains
  unverified; the 14 offline harness guards passed.
- [x] Make the regression acceptance repeatable in CI without provider secrets
  or uploading disposable account data.
- [x] Update operating guidance and acceptance evidence to the final candidate.

Actual bank settlement and deployment remain separate acceptance stages. They
require intended bank/wallet accounts or a production target, rather than a
simulation being represented as a successful real transfer. Future custody,
escrow, internal balances, platform fees and centralized Connect accounts remain
outside the agreed product boundary.

## Validation

- Full frontend: **1,319 passed, 3 skipped, 0 failed** across 216 files; typed
  checks report **0 errors, 128 warnings**; static production build passed.
- Focused payment/policy frontend coverage: **52 passed**, with 213 assertions.
  Three direct API/admin fixtures: **31 passed**, with 114 assertions.
- Backend: **73 tests passed** (27 API contracts, 11 server payment tests,
  25 addon rail tests and 10 WabiDB payment projection tests). The admission
  tests include credential/role/owner denial and cancelled durable mutations
  verified after restart.
- The actual current checkout compiles with pinned Rust 1.93.1 and locked
  dependencies, including optional rails and the embedded static frontend.
  The earlier consensus integration blocker is resolved in current source.
  Final packaging passed after the complete browser diagnostic. Concurrent
  default-off recovery startup work was preserved; its later source change and
  the focused Rust test timing are disclosed in the acceptance provenance.
- The complete headful diagnostic passed all 12 methods, eight exported QR
  decodes, two copied manual instruction checks and ten real session checks,
  including identity stability past the former bootstrap probe interval.
  The subsequent strict packaged run also passed the entire matrix, including
  actual Authority-served entry bytes and the bootstrap regression. Root visually
  reviewed the final mobile/request/history/admin/donation screenshots.
- Provider harness offline guards: **14 passed**. Current Stripe provisioning
  returned HTTP 429 without credentials; PayPal Developer access is unavailable.
  Provider checkout and settlement remain unverified.
- Payment CI is configured and its YAML/gates were checked locally. No cloud
  workflow, push or deployment was performed. An additional broad frontend
  discovery run found one unrelated concurrent Lore contract mismatch; canonical
  and payment suites pass, without certifying all unrelated working-tree changes.

The unrelated push-client union check was narrowed with `key.ok === false` so
the complete typed frontend check could run; behavior is unchanged. No generated
protocol files, persistent record layouts, production data or provider accounts
were changed. No real transfer was attempted. See
[acceptance evidence](../testing/PAYMENTS_ACCEPTANCE_2026-10-03.md).
