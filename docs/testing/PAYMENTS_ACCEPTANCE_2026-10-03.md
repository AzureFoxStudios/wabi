# Direct-payment acceptance — 2026-10-03

Status: local uncommitted candidate; not pushed, merged or deployed. Current
frontend/backend checks and strict packaged browser acceptance pass.
External bank/wallet settlement and provider checkout remain unverified.
Synthetic receiving destinations in these artifacts are fixtures, **never payment destinations**.

## Current results

| Check | Result | Scope |
|---|---|---|
| Canonical frontend suite (`bun run test`) | 1,319 passed; 3 skipped; 0 failed | 216 files; 34,329 assertions; repeated after durable dependency restoration |
| Typed frontend | 0 errors; 128 warnings | Complete frontend, including payment/admin/donation surfaces |
| Static production frontend build | Passed | 338 immutable assets; static adapter and esbuild preserved |
| Focused payment/policy frontend tests | 52 passed | 213 assertions: exact amounts, instructions, sharing, historic QR/timestamps, routing and policy |
| Direct payment/API/admin fixtures | 31 passed | 114 assertions; three isolated fixture files; account/server/logout/renewal fences and authoritative acknowledgment |
| Backend payment API contracts | 27 passed | Access 8, retained admission 3, projection/receipt 8, optional rails 8 |
| Server payment unit/migration tests | 11 passed | Actual current checkout, `payments-rails,field-embed`; proxy namespace, exact amount, Unicode byte limits, partial migration preservation |
| Optional rail unit tests | 25 passed | Crypto 8, EU 9, US 8 |
| WabiDB payment projection tests | 10 passed | Durable read model and replay |
| Provider harness offline guards | 14 passed | No network/credentials; test-only proof, ambient-key isolation, private artifacts, hosted acceptance binding |
| Complete headful diagnostic | Passed | 12 methods, eight QR decodes, two copied manual instructions, ten real session checks including the corrected bootstrap race; explicitly omits old packaged asset matching |
| Final headful Chromium acceptance | Passed | Actual packaged Authority; exact served index/entry bytes; 12 methods, eight exported QR decodes, two copied instructions and ten real session checks |

The Rust subtotal is 73 passing tests. The three admission tests contain matrices
covering 18 queued-credential endpoint cases, 10 role/owner denial cases, and 14
cancelled durable mutations verified after restart. These scenario counts are
not added again to the Rust test total.

An additional broad frontend discovery run found one unrelated Lore source
contract mismatch: a test expects `LoreChannelShell projectPicker`, while
concurrent source uses `compactHeader`. That run reported 1,497 passes, 3 skips
and 1 failure. The canonical frontend suite and all payment checks pass. The
separate Lore work was preserved; its failure is not silently omitted from
whole-repository acceptance.

## Integration and provenance

Current checkout baseline HEAD is
`0b82cec796061d274b22655d16f24ca29720c7c3`, with uncommitted payment and independent
work. Unlike the initial isolated run, the expanded contracts compile and test
the actual checkout with repository-pinned Rust 1.93.1 and `--locked` dependencies.
The earlier consensus private-field compilation blocker is resolved in current
source. This report does not certify every unrelated working-tree change.

A concurrent `state.rs` update changed default-off recovery-publisher startup
after the focused Rust test runs. It was preserved; payment locks/admission
fields remained unchanged. The final complete build includes it. The recorded
test runs are not represented as exact reruns of that later unrelated update;
the provenance records their timing and scope.

The packaged Authority uses a debug build with `payments-rails,field-embed`
to carry the actual static frontend, including the bootstrap correction. It is
not a release deployment. Binary
fingerprint, commands/results and current backend source hashes are retained in
[build provenance](payments-2026-10-03/final/backend-build-provenance.json).
Binary SHA-256:
`8d97d437a3d1e8896c716d799a2d33e79f895467914aa8686d189c6a70397e70`.
Read-only inspection confirms that the exact current frontend HTML is
physically present in that binary.
[Embedded-entry proof](payments-2026-10-03/final/embedded-index-proof.json)

Current static frontend index SHA-256:
`dcd1649dbd18c75e116f24b6d25e72ce7d8c4330b8eea840dff8db5be2085b69`.
The 338 immutable assets also have an independently recorded path/size/content
[manifest](payments-2026-10-03/final/frontend-immutable-assets.json), with its
canonical entries SHA-256:
`93b85d0de7212692d0540382e1125b054e5ca61968ed3d1d3e9b75000cd6db7c`.

The reproduced bootstrap failure joined the second Authority successfully,
then an unscoped prior-login probe replaced its socket with `join(null)`,
removing the profile/settings controls. The correction removes that global-hint
branch; valid saved current-Authority sessions still initialize normally.
The browser now waits 3.5 seconds past login and rejects null socket joins.
[Pre-fix evidence](payments-2026-10-03/final/bootstrap-login-race-before.json)

The final strict run passed with the diagnostic flag disabled and no uncaught
application errors or null socket joins.
[Complete browser result](payments-2026-10-03/final/result.json) and
[frontend checks/source fingerprints](payments-2026-10-03/final/frontend-verification.json)
identify the accepted candidate. The captured backend and frontend source
fingerprints still match after acceptance.

Root visual review covered settled real headful pixels for the mobile PromptPay
request, Base USDC, SEPA, ordinary-member history/receipt, administrator settings
and unsupported donations. Finite entrance animations were fast-forwarded only
for stable screenshot capture; the app behavior and assertions were retained.
Representative synthetic screenshots:

- [Mobile payment request](payments-2026-10-03/final/payments-request-mobile.png)
- [Member receipt and rejected request](payments-2026-10-03/final/payments-member-receipt-and-close.png)
- [Administrator payment settings](payments-2026-10-03/final/payments-admin-session-boundary.png)
- [Unsupported donations](payments-2026-10-03/final/payments-donations-unavailable.png)

These images use fixtures; never pay their destinations. The eight exported QR
artifacts were decoded to the exact server-owned payloads. Copy checks retained
the Tron network and Lightning amount limitations. Session checks cover actual
logout/login with delayed responses, ordinary-member receipt/rejection, own
history filtering, admin block/clear acknowledgments, retired admin responses and
drafts, independent Authorities with identical numeric user IDs, startup identity
stability, delayed donation results, unavailable legacy donation forms and a
failed read followed by successful retry.

Six missing frontend packages and their cached transitive dependencies were
restored at the committed versions under `frontend/node_modules`, preserving
existing packages and all manifests/lockfiles. No restored package depends on a
`/tmp` symlink. Canonical tests and complete typed checks passed afterward.
[Dependency proof](payments-2026-10-03/final/frontend-dependency-restoration.json)

## Reproduction

From `frontend/`, with the repository-pinned Bun and Node:

```sh
bun run test
bun test --isolate src/lib/payments src/lib/adminPaymentPolicy.test.ts
bun test --isolate test/payment-reference-api.fixture.test.ts test/payment-access-store.fixture.test.ts test/admin-policy-deadline.fixture.test.ts
bun run check
STATIC_BUILD=1 bun run build
```

From the repository root, with pinned Rust:

```sh
cargo test --locked -p wabidb payments
cargo test --locked -p wabi-server --features payments-rails,field-embed --test payment_access_contract --test payments_admission_contract --test payments_projection_contract --test payments_rails_contract
cargo test --locked -p wabi-server --features payments-rails,field-embed --lib api::payments
cargo test --locked -p wabi-payments-crypto -p wabi-payments-eu -p wabi-payments-us
cargo build --locked -p wabi-server --features payments-rails,field-embed --bin wabi-server
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/payments -p 'test_*.py' -v
```

The browser harness requires real headful Chromium. On a machine with no display,
use Xvfb. Install `jsqr@1.4.0` and `pngjs@7.0.0` in a disposable QA directory,
then run from `frontend/`:

```sh
WABI_PAYMENTS_STATIC=1 WABI_PAYMENTS_REQUIRE_RAILS=1 \
  WABI_PAYMENTS_QR_QA=/path/to/disposable-qr-qa \
  WABI_SMOKE_SERVER_BINARY=/path/to/current/payments-rails-field-embed/wabi-server \
  node scripts/payments-browser-smoke.mjs
```

For an existing Chromium installation, set `WABI_BROWSER_EXECUTABLE`; otherwise
install the pinned Playwright browser. The harness creates two isolated local
Authorities with synthetic accounts, strips operator environment, and stops both
processes afterward. It checks the actual Authority-served index and entry chunk
against the frontend used by the browser. Missing optional rails fail acceptance
when `WABI_PAYMENTS_REQUIRE_RAILS=1`.

[Payment CI](../../.github/workflows/payments-acceptance.yml) uses these commands,
pinned QR tools and headful Xvfb. YAML and gate configuration were checked
locally; no GitHub workflow run, push or deployment has been performed. Only
synthetic screenshots and result metadata are configured for upload, never test
account data or provider secrets.

Current logs and safe provenance are saved under
[`payments-2026-10-03/final/`](payments-2026-10-03/final/frontend-tests.log.gz).
Initial screenshots/result remain in the parent evidence directory as history;
they do not prove the subsequent source corrections.

## Provider access and remaining acceptance

No current Stripe or PayPal checkout/signed-settlement adapter exists in Rust.
A provider fixture does not verify a manual Wabi receipt.

Fresh official Stripe CLI 1.53.0 anonymous provisioning returned HTTP 429,
“Too many requests,” without a disclosed reset window. Its login fallback did
not save credentials; the actual harness refused the unauthenticated profile
before payment mutations. Earlier worker reports of synthetic API success,
decline and refund cannot be re-inspected because their temporary profiles and
evidence are gone. Current API and hosted checkout acceptance are unverified.

The actual PayPal sandbox-accounts page redirected to an empty sign-in form.
Developer login, virtual seller/buyer accounts and app sandbox credentials are
not available. No login, registration or payment was attempted. Its webhook
simulator is not evidence of a real sandbox capture.

[Public provider observations](payments-2026-10-03/provider-sandbox-status.json)
and [repeatable test/setup guide](../../scripts/payments/README.md) distinguish
these blockers from the 14 passing offline harness guards. No live provider
credentials or real funds were used.

No banking or wallet app submitted a transfer, and no mainnet/testnet settlement
was attempted. Decoding an exported QR proves its payload, not bank/wallet
acceptance or settlement. Destination shape checks do not prove ownership or
complete checksum validity. Refunds, disputes and authenticated payer linkage
remain absent. Actual transfer acceptance needs the intended accounts/apps and
an explicitly specified recipient, amount and currency.

See [operating guidance](../payments/DIRECT_TRANSFER_OPERATIONS.md),
[the audit/plan](../plans/2026-10-03-payments-audit-and-hardening.md), and
[official research/setup matrix](../research/payments-direct-transfer-options-2026-10-03.md).
