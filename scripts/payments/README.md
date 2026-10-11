# Provider sandbox acceptance

These scripts test provider behavior separately from Wabi. The current Rust
Authority has no Stripe or PayPal checkout or signed settlement adapter. A
provider test payment does not make a Wabi request verified, refunded, or
disputed. Wabi's active direct-payment flow retains recipient-recorded receipt.

## Offline safety checks

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/payments -p 'test_*.py' -v
```

These standard-library tests use a fake executable under `/tmp`. They require
no network, provider credentials, or funds. They prove that a live profile or
missing/malformed test-mode proof stops before any payment mutation, ambient
`STRIPE_API_KEY` does not override the selected profile, response artifacts are
owner-readable only, and prepared hosted sessions are not accepted as payments.
They also reject foreign account/session fixtures and currency mismatches.

## Stripe synthetic acceptance

Use the official CLI and an explicit isolated test-only profile. Do not use
live credentials, real card data, or the operator's production account. The CLI
can create a temporary anonymous sandbox without registration. Its output can
contain a claim link or credentials, so save it privately. Creating a sandbox
does not claim it or create a live payment account.

The npm registry reported CLI `1.53.0` for the 2026-10-03 run. Installation below
stays outside Wabi's dependency tree:

```sh
umask 077
stripe_qa_dir=$(mktemp -d /tmp/wabi-stripe-qa-XXXXXX)
npm install --prefix "$stripe_qa_dir/cli" --ignore-scripts --no-audit --no-fund @stripe/cli@1.53.0
stripe_qa_cli="$stripe_qa_dir/cli/node_modules/.bin/stripe"
env -u STRIPE_API_KEY "$stripe_qa_cli" --config "$stripe_qa_dir/config.toml" --project-name wabi-synthetic sandbox create --email wabi-payments-sandbox@example.com --non-interactive > "$stripe_qa_dir/provision.private.log" 2>&1
python3 scripts/payments/stripe-sandbox-acceptance.py --cli "$stripe_qa_cli" --config "$stripe_qa_dir/config.toml" --project wabi-synthetic
```

`sandbox create` can exit successfully after falling back to browser login
without saving keys. The harness independently requires authenticated test
credentials, explicit absence of live credentials, and an account identifier
before it writes anything. If provisioning is rate limited, stop and follow
provider retry guidance. Do not register an account with invented personal data.
Do not use Stripe MCP with an unclaimed temporary sandbox.

The preparation run creates USD 1 synthetic fixtures in the selected provider
account. It confirms API success using `pm_card_visa`, generic decline using
`pm_card_visa_chargeDeclined`, and a full refund verified against the test Charge.
It also creates a test Payment Link and separate hosted success/decline Checkout
Sessions. A creation response proves only that those fixtures exist.

The printed summary contains a `state_file` path and private artifact directory.
The state file contains hosted checkout URLs and provider object identifiers.
Inspect them privately, never commit the state or request logs. Complete the
success session in a real browser with Stripe's documented successful test card
(`4242 4242 4242 4242`). Submit the generic-decline test card
(`4000 0000 0000 0002`) to the separate decline session. Use a future expiry,
synthetic name, and any documented valid test CVC; never use a real card.

```sh
python3 scripts/payments/stripe-sandbox-acceptance.py --cli "$stripe_qa_cli" --config "$stripe_qa_dir/config.toml" --project wabi-synthetic --verify /tmp/PRIVATE_STATE_DIRECTORY/state.private.json --require-hosted
```

Verification binds the account, run, case, test environment, USD currency, and
100-cent amount. `--require-hosted` requires a completed/paid successful Session
and succeeded PaymentIntent plus an open/unpaid decline Session with the
documented `card_declined` / `generic_decline` PaymentIntent error. Without that
flag, incomplete cases are explicitly reported as pending. The harness does not
test 3DS, asynchronous methods, signed callbacks, event ordering, disputes,
Connect onboarding, or payouts. Those require additional acceptance before any
corresponding Wabi provider support can be claimed.

Current documentation: [Stripe sandboxes](https://docs.stripe.com/sandboxes),
[Stripe testing](https://docs.stripe.com/testing). Fetch Stripe documentation
with `stripe docs` when the CLI is available.

## PayPal setup boundary

PayPal's documented test flow requires an authenticated Developer account,
virtual Business seller and Personal buyer accounts, and app client ID/secret
for REST API access. These credentials were not available in the 2026-10-03
checkout. Opening the Developer sandbox accounts page in the available browser
redirected to an empty PayPal sign-in form. No credentials were entered, account
registered, or sandbox payment attempted.

The webhook simulator emits mock notifications. It does not create a payment
or capture and its events cannot use the postback signature-verification API.
It cannot replace actual sandbox capture/refund acceptance.

References: [PayPal sandbox guide](https://developer.paypal.com/sandbox-testing/overview),
[API authentication](https://developer.paypal.com/api/rest/authentication/),
[webhook simulator](https://developer.paypal.com/api/rest/webhooks/simulator/).
