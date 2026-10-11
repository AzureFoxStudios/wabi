# Direct payments between Wabi users

Updated: 2026-10-03. This describes the local payment candidate, not a deployed release.

Wabi creates a request and displays the receiving person's payment instructions.
The payer sends money using their own bank or wallet. Wabi holds no funds, stores
no balance, takes no transaction fee, and offers no escrow. Requests and manual
receipt statuses are coordination records, not bank statements or settlement proof.

## A two-person payment

1. Agree the work, price, currency, receiving account and refund terms in chat.
2. The receiving person opens **Profile settings → My Payment Requests → New
   Payment Request**, or uses **Request payment** in chat. Choose a method, enter
   your own destination and amount, and create the request. Saved PromptPay references
   can fill the destination; SEPA also needs the bank's payee name. Crypto networks
   and US apps require an explicit method-specific destination rather than
   reusing another network's saved address.
3. Share the QR/instructions with the payer. Copying, saving or opening an app
   does not change receipt status. Check destination, amount, currency and network
   in the external app before submitting payment.
4. The receiving person checks their own account and opens **My Payment Requests**
   to record receipt manually. Other ordinary users cannot confirm or close their
   request. Administrators retain the existing ability to inspect requests and
   record manual status; that does not establish provider verification.
5. If payment never arrives, close the pending request. Closing does not cancel
   a bank transfer or refund money. Arrange refunds outside Wabi using the
   provider's permitted process.

Partial/excess payments cannot replace the original requested amount. The durable
model has no separate settled-amount field; reconcile externally. Confirmation
is serialized so competing receipt/close operations cannot both succeed.

## Supported instruction methods

| Method | Wabi supplies | Limits |
|---|---|---|
| PromptPay | THB QR for an explicit mobile, national/tax-ID or e-wallet proxy | Correct proxy-specific QR tag; no bank callback; bank verifies account outside Wabi |
| SEPA / EPC QR | EUR instructions, payee name, IBAN, unstructured reference | Optional rail; bank-app support and instant execution are not guaranteed |
| Cash App / Venmo / Zelle / ACH | Method-specific destination and reference | Optional rail; use accounts/modes permitting commerce; no purchase-protection promise |
| Bitcoin / Monero | Address and amount request URI | Optional rail; format checks do not prove account ownership or all wallet compatibility |
| USDC on Base | EIP-681 transfer with Base chain, USDC contract and atomic amount | Optional rail; wallet must support request; check token/network/amount |
| USDC on Solana | Solana Pay URI with USDC mint, destination and amount | Optional rail; compatible wallet and correct network required |
| USDT on Tron / Lightning | Manual destination/offer instructions | Optional rail; no automatic amount-bearing request QR or settlement verification |

PromptPay is built into the Authority. Other rails require `payments-rails` or
their individual Cargo features. The frontend uses the addon capability inventory.
Never send money to test fixture destinations.

Older requests can contain unsafe instructions. Do not use a native-ETH Base URI
as a USDC request, or a stored currency inconsistent with the method. Recreate the
request. A 15-digit PromptPay e-wallet must use subtag `03`; earlier e-wallet QR
payloads encoded as national ID are unsafe and must be recreated. Historical
checks fail closed without rewriting the durable request.

## Settings and privacy

- **Saved Payment References** stores self-declared destinations for the current
  account/Authority. Saving is not a verified bank connection. Failed reads,
  saves and deletes are errors; the old global browser cache is not a destination
  fallback.
- **My Payment Requests** supplies history, exports, instructions and manual
  receipt/close. Disabling creation does not erase existing records.
- **Admin → Payments** controls request eligibility and blocks, not a working
  Stripe/PayPal gateway. Donation checkout/ledger/refund routes are incomplete;
  unsupported creation is refused, not reported as a tracked donation.
- Phone/citizen-ID proxies, names, IBANs, wallet addresses and account numbers are
  sensitive. Admins can inspect requests. Deleting a saved reference removes its
  current view, not earlier durable events. Bank apps may expose legal names;
  public crypto ledgers are not anonymous.

Account-reference metadata is refused before durability: the existing postcard
record cannot safely decode populated `serde_json::Value`. Previously written
bad metadata needs a stopped-data backup and versioned recovery, not a live
event-log edit. No persistent record shape is changed by this candidate.

## Stripe / PayPal and testing

The active Rust Authority has no Stripe/PayPal checkout, onboarding, signed
webhook, refund or dispute integration. Old Node plugin/scaffold files do not
establish support. Sellers may share their own legitimate hosted links in chat;
their provider controls verification, fees, countries and refund/purchase terms.
Opening or returning from a link is never proof of payment.

Future automated status must verify signed provider events and bind seller,
request, amount, currency, environment and unique event before recording receipt.
A centrally owned Connect platform is a separate liability/operator decision,
not necessary for the direct bank/wallet flow.

Local acceptance needs disposable accounts/data and no payment credentials.
Bank/wallet compatibility needs the actual intended apps or a test network;
QR generation does not prove settlement. Real payment testing needs explicit
recipient/amount/currency approval. Provider acceptance additionally requires a
selected sandbox and credentials; local mocks do not count as Stripe/PayPal tests.
The official Stripe CLI can provision an anonymous test sandbox, but current
provisioning was rate limited without credentials. PayPal requires Developer
login, virtual seller/buyer accounts and app credentials. The
[sandbox guide](../../scripts/payments/README.md) documents the repeatable
test-only checks and setup; neither provider is verified through Wabi.

See [the audit and plan](../plans/2026-10-03-payments-audit-and-hardening.md)
and [official-source research](../research/payments-direct-transfer-options-2026-10-03.md).
