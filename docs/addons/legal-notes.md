# Legal Notes

Wabi's legal model for payments and server operation.

## Core Principle

**Wabi is infrastructure, not a financial service.**

Wabi provides communication and coordination. Users and server operators handle their own compliance.

## Payment Model

### What Wabi Does

- Stores payment intent records (like storing messages)
- Generates payment requests (QR codes, links)
- Coordinates payment status updates via webhooks
- Does NOT touch funds

### What Wabi Does NOT Do

- Hold user funds
- Process transactions
- Convert currencies
- Manage accounts at payment providers

### Non-Custodial Design

Payments flow directly between users via external providers:

```
User A → Generates payment intent → Provider (Stripe, Bitcoin, etc.)
User A → Pays provider directly
Provider → Notifies Wabi via webhook
User B → Receives funds from provider
```

Wabi never sees or handles money.

## Server Operator Responsibilities

Server operators are independent controllers:

- Choose which addons to enable
- Configure payment providers
- Set server donation settings
- Comply with local laws

### Operator Checklist

- [ ] Understand local regulations for chat apps
- [ ] Understand regulations for payment facilitation
- [ ] Obtain necessary licenses if required
- [ ] Configure server donation disclosures
- [ ] Enable server-auditor for compliance (optional)

## User Responsibilities

Users control their own:

- Payment provider accounts
- Donation settings
- Export data requests

## Data as Record

Payment intents are records, not financial instruments:

- Wabi stores intent metadata (amount, status, timestamps)
- Not financial account data
- User can export their payment history anytime

This mirrors how email providers store message headers without touching money.

## Disclaimer

Wabi enables communication and coordination. Users and server operators are responsible for their own compliance with applicable laws.