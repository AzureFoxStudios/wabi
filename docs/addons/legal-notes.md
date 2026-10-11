# Payment design and operator responsibilities

Updated: 2026-10-03. This describes boundaries, not a determination that an
operator is exempt from regulation.

Wabi creates receiving instructions and records manual receipt. The payer sends
money in their own bank or wallet. Wabi holds no funds, stores no monetary
balance, converts no currencies, takes no transaction cut and provides no escrow
or purchase protection. The current Rust Authority has no Stripe/PayPal signed
settlement callback. See [current operations](../payments/DIRECT_TRANSFER_OPERATIONS.md).

## Classification follows behavior

Calling Wabi a tool or saying “your bank to their bank” does not establish an
exemption. Features, operator jurisdiction, counterparties and provider terms
matter. No custody is not a blanket exclusion: EU payment-initiation services
can be regulated without holding funds. Marketplace/reporting obligations also
depend on scope and features. Displaying instructions differs from bank API
initiation, and manual receipt is not authoritative settlement evidence.

Orders, bank API initiation, fees and centralized checkout must be separately
assessed. The [official-source research](../research/payments-direct-transfer-options-2026-10-03.md)
explains technical-support exclusions and their limits. Earlier absolute
“No custody ⇒ no transmitter, no TPSO, no PSI” claims are withdrawn.

## Identity and commercial terms

Wabi can avoid collecting extra identity documents. Banks and regulated
processors may still require verification, including in Thailand. Stripe and
PayPal offer no general KYC-free marketplace; hosted onboarding can keep
verification documents at the provider rather than Wabi.

Use methods/account types permitted for goods and services. Personal-transfer
modes cannot be advertised as universal commercial checkout or buyer protection.
Public crypto ledgers are traceable; crypto is not an anonymity or legal exemption
guarantee.

## Records and privacy

Wabi stores amount, currency, receiving instructions, status, timestamps and the
manual-confirmation actor/note. Instructions can contain sensitive phone/identity
proxies, payee names, IBANs, wallet addresses and bank-account details. Admins can
inspect requests. Exports are coordination data, not bank statements. Deleting a
saved reference removes its current view, not earlier durable events.

Operators must assess their actual deployment and enabled features. Sellers and
payers retain their own provider accounts, verification, commercial permissions,
tax responsibilities and external refund arrangements. A disclaimer does not
replace that assessment.
