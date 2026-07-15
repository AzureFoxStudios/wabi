# Wabi Verified Operations — Trust Layer for Odoo Business Data

## Summary

This addon exists to solve one specific problem: **proving what happened after someone changes the numbers.**

A typical Thai construction/roofing business runs across disconnected layers — LINE for orders, Excel for tracking, Odoo for official records, bank portals for payments, physical paper for delivery receipts. When money goes missing, a manager must manually trace each transaction across every layer, cross-referencing months of paper against bank statements to build a legal case. This takes months, because none of the systems link together and none of them are trusted.

The reason they went back to paper? Someone demonstrated the digital system could be tampered with — changed numbers after approval, and nobody noticed until the money was gone. Paper can't be edited, so paper became the source of truth. But paper requires months of manual cross-referencing to investigate anything.

This addon makes digital **more trustworthy than paper** by creating an independent verified audit layer between Wabi and Odoo. Every approved value is cryptographically snapshotted. Background re-verification detects divergence. Anomalies are surfaced immediately in a dashboard and the relevant Wabi channel. A manager can search any user's actions and export a complete timeline with anomaly flags in seconds — not months.

The spreadsheet viewer, draft worksheets, and bento dashboard are the interface. The verified snapshot system is the product.

## The trust problem

### The paper-digital trust cycle

Thai construction businesses commonly go through this cycle:

1. **Start digital** — Use Odoo (or another system) for POs, invoices, inventory
2. **Someone exploits it** — Employee changes a PO amount after approval, or creates a fake vendor and approves payment
3. **Trust breaks** — Management discovers the loss, but can't prove exactly which transactions were tampered with using only the digital system (Odoo CE has no reliable change tracking)
4. **Go back to paper** — Managers require physical signatures, paper delivery slips, printed bank statements. Paper can't be edited, so it becomes the "real" record
5. **Fragmentation** — Now data lives across LINE, paper, Excel, Odoo, and bank portals. Investigating anything requires manually matching records across all five
6. **Months of work** — When theft is suspected, a manager spends weeks or months going through every document, highlighting matching rows on bank statements, building a case one transaction at a time
7. **Repeat** — Eventually someone proposes a new digital system, and the cycle starts over

### What the manager actually needs

Not a spreadsheet. Not a dashboard. A **provable, searchable, exportable ledger** of every action by every user, with automatic anomaly detection, that cannot be silently altered after approval.

If a manager suspects Somchai changed a PO amount after approval, they should be able to:

1. Open the Transaction Audit widget
2. Type "Somchai" in the search bar
3. See every PO he created, every edit, every amount, all timestamped
4. See which ones were flagged as tampered (approved snapshot ≠ current value)
5. Click "Export PDF" — get a complete report ready for police/legal proceedings

That replaces months of paper highlighting with 15 seconds of searching.

## How Wabi restores trust

The addon creates a three-layer trust model that makes digital provably tamper-evident:

### Layer 1: Approved-value snapshots

When Wabi pushes an approved record to Odoo, it stores a cryptographic hash of every monitored field value in Wabi's own storage:

```
approved_record = {
  odoo_record_id: 42,
  model: "purchase.order",
  fields: {
    "amount_total":           { value: 5000.00, hash: "a1b2c3..." },
    "order_line": [
      { product_id: 17, price_unit: 500, quantity: 10 }
    ]
  },
  snapshot_hash: "9f8e7d...",
  approved_by: "manager@wabi",
  approved_at: 2026-06-13T10:00:00Z,
  pushed_at:   2026-06-13T10:00:05Z
}
```

This snapshot exists **outside Odoo** — in Wabi's plugin storage. Odoo cannot modify it. Wabi cannot modify it after creation (append-only). It is the independent record of what was approved.

### Layer 2: Scheduled re-verification

A background task runs every N minutes (configurable, default 15) and re-reads every monitored record from Odoo. It recomputes the hashes and compares:

| Hash match | Result |
|---|---|
| Snapshot hash == current hash | Clean. No action. |
| Snapshot hash ≠ current hash | Wabi compares field-by-field, identifies what changed, who changed it (Odoo `create_uid`/`write_uid`), and when |

On mismatch, Wabi:

- Posts an alert to the relevant channel: `⚠️ PO-042 tampered since approval — amount_total: 5,000 → 6,000 (changed by Somchai, Jun 13 14:32)`
- Adds a red entry to the Tamper Monitor dashboard card
- Creates an audit event with full details
- Optionally emits a Socket.IO event for real-time frontend notification

### Layer 3: Optional change-blocking

For maximum protection against post-approval editing, Wabi can install a lightweight Python constraint on the Odoo model via automated action. The constraint checks for a "wabi_approval_token" field — without a valid token from Wabi's approval flow, the record cannot be saved if locked fields change.

This is a one-time setup per model using only standard Odoo CE automation features (Automated Actions, Server Actions). No Enterprise modules required.

### The Transaction Audit widget

This is the feature that directly replaces months of paper work:

```
┌─────────────────────────────────────────────────────────────────┐
│ 🔍 TRANSACTION AUDIT               role-tag: manager+          │
├─────────────────────────────────────────────────────────────────┤
│ [SEARCH BY USER, CUSTOMER, AMOUNT...]  [ALL TYPES ▼] [ALL USERS │
│  ▼]  [EXPORT PDF]                                               │
├──────┬──────┬──────┬──────┬──────────┬──────────┬───────────────┤
│ DATE │ USER │ TYPE │ REF  │ AMOUNT   │ STATUS   │ FLAG          │
├──────┼──────┼──────┼──────┼──────────┼──────────┼───────────────┤
│ 14/6 │Somchai│ PO   │PO-042│12,500 THB│ pending  │⚠ exceeds cap  │
│ 14/6 │Malee  │ PO   │PO-040│ 6,000 THB│ tampered │🔴 price chngd │
│ 14/6 │Wichai │DRAFT │EST-08│ 8,200 THB│ pending  │               │
│ 14/6 │Mngr   │APPRVL│PO-039│ 4,500 THB│ approved │               │
│ 13/6 │Malee  │INV   │INV-38│ 5,600 THB│ paid     │⚠ edited aftr │
│ 13/6 │Somchai│DRAFT │DW-022│ 3,200 THB│ pushed   │               │
└──────┴──────┴──────┴──────┴──────────┴──────────┴───────────────┘
                       6 of 142 records · LOAD MORE →
```

- Rows are color-flagged: yellow left border (warning), red left border + pulse (tamper alert)
- Filter by action type: drafts, POs, invoices, payments, approvals
- Filter by user
- Search free-text across references, customer names, amounts
- Export to PDF with all timestamps and hashes — ready for legal proceedings

This eliminates the need to cross-reference LINE, paper, Excel, Odoo, and bank statements. Every action by every user is in one searchable timeline.

## Spending controls and approval chain

Approval without spending control is just theater. The addon enforces:

### Role-based spending caps

| Role | Max per request | Escalation |
|---|---|---|
| staff / estimator | 5,000 THB | → manager |
| manager | 50,000 THB | → director |
| director | 500,000 THB | → admin |
| admin | unlimited | — |

If a user submits a request exceeding their cap, Wabi automatically escalates it to the next role tier. The request cannot proceed to Odoo until the appropriate level approves.

### Full purchase request flow

```
Employee creates draft PO in Wabi dashboard
    ↓
Wabi checks spending cap against employee's role
    ↓ (if exceeds)
Wabi escalates to next role tier automatically
    ↓
Manager sees request in approval queue (full-width strip card)
    - animated alert dots
    - diff view: items, vendor, total, budget
    - context: channel discussion, photo evidence
    ↓
Manager approves / rejects (reason required for rejection)
    ↓ (if exceeds manager cap too)
Escalates to director tier
    ↓
Wabi pushes approved data to Odoo via standard API
    ↓
Wabi stores approved-value snapshot (cryptographic hash)
    ↓
Wabi posts result to channel: "PO-042 approved by Manager → synced"
    ↓
Background re-verification runs every 15 minutes
    - if tampered: channel alert + dashboard card + audit event
```

### Additional controls

- **Vendor whitelist**: Unknown vendors blocked at draft stage. Validated against Odoo's approved supplier list.
- **Budget guard**: Checks Odoo analytic account balances before submission. Flagged if cost center is exhausted.
- **Photo/receipt requirement**: Field expense worksheets can require photo evidence before submission.
- **Emergency override**: Admin can force-approve with mandatory reason field. Creates a permanent audit event with red flag in all reports.

## Permission model and role-gated dashboard

Every element of the dashboard is role-gated — both in the frontend (render control) and backend (data access enforcement).

### What each role sees on the dashboard

| Role | AFK trigger | Widgets | Sees |
|---|---|---|---|
| owner / admin | 5 min idle | all | server health, all approvals, all spending, tamper alerts |
| manager | 5 min idle | approval queue, budget, team activity | their team's approvals, spending within cap, server health (RO) |
| estimator | 10 min idle | my projects, stock alerts, material prices | own drafts, assigned jobs, project status, material stock |
| installer | 10 min idle | my jobs | only assigned job sheets, photo upload, checklists |
| reception | never | open invoices (RO), calendar, directory | customer lookup, no financial data |

### Widget permission model

```javascript
widgets: {
  transaction-audit:   { minRole: "manager" },
  server-health:       { minRole: "admin" },
  approval-queue:      { minRole: "manager" },
  budget-gauge:        { minRole: "manager" },
  active-projects:     { minRole: "contributor" },
  stock-alerts:        { minRole: "estimator" },
  open-invoices:       { minRole: "viewer", readonly: true },
}
```

- Widget catalog only lists widgets the user's role can access
- Backend API endpoints check user role before returning data
- Frontend never renders widgets the user can't see

### AFK auto-summon

The dashboard can be accessed three ways:

1. **Upper-left Wabi logo**: long-press (300ms) → overlays dashboard for current role
2. **AFK auto-summon**: idle timer reaches role threshold → dim overlay → dashboard appears as ambient screensaver
3. **Workspace panel**: Business icon in right dock (standard Wabi panel)

AFK thresholds are configurable per role in addon settings.

## What about Odoo Enterprise?

Odoo SA ships two editions: Community (free, open-source) and Enterprise (~$31/user/month). Enterprise adds exactly the guardrails this addon provides — approvals, spending controls, field-level permissions, dashboards, audit trails — but Odoo's Enterprise Approvals module is a separate app, not a unified trust layer. It also doesn't provide cross-system tamper detection or a searchable multi-user transaction audit.

This addon works with Odoo Community Edition only. It uses the same `/jsonrpc` → `execute_kw` endpoints that Odoo CE exposes freely. No Enterprise license needed. If the business later upgrades to Enterprise, nothing breaks — the addon operates alongside Odoo's own enterprise features as an additional trust layer.

## Implementation mechanism: spreadsheets and dashboards

The trust layer is surfaced through:

### Bento-grid dashboard

A Nothing/NullFrame-inspired dark dashboard with role-gated cards:

```
┌──────────────────────────────────────────────────────────────────┐
│ HERO: Live clock · Date · Odoo status · Summary stats            │
├────────────────┬──────────────────┬──────────────────────────────┤
│ SERVER HEALTH  │ INVOICES         │ PURCHASE                     │
│ admin+         │ viewer+          │ estimator+                   │
├────────────────┴──────────────────┴──────────────────────────────┤
│ APPROVALS (full width, attention-grabbing)  manager+             │
├────────────────────────────────┬─────────────────────────────────┤
│ CONFIGURABLE WIDGET ZONE       │ ACTIVITY FEED                  │
│ · Transaction Audit (manager+) │ · color-coded events           │
│ · Active Projects (contrib+)   │ · time-ago timestamps          │
│ · Stock Alerts (estimator+)    │                                │
│ · Budget Gauge (manager+)      │                                │
│ [+ ADD WIDGET]                 │                                │
└────────────────────────────────┴─────────────────────────────────┘
```

### Draft worksheets

Role-locked operational worksheets hosted entirely in Wabi. No Odoo mutation until approved. Templates for purchase requests, job estimates, field reports. Photo/file attachments per cell.

### Read-only Odoo views

Sortable, filterable, paginated table views of any Odoo model. Row click → "Open in Odoo". Configurable per-model, per-role.

## Add-on architecture

### Server addon

This is a **server addon** (has `backend/` + `frontend/`), not an app plugin (frontend only). The backend handles Odoo communication, approval logic, spending cap enforcement, tamper detection scheduling, and audit search. The frontend provides the dashboard UI, but the intelligence lives on the server.

### File structure

```
addons/source/verified-operations-odoo/
├── plugin.json
├── backend/
│   ├── index.ts              # Plugin entry: routes, lifecycle, tamper scheduler
│   ├── odoo-client.ts        # JSON-RPC client: connect, search_read, create, write
│   ├── spreadsheet-engine.ts # Column mapping, data transformation, sort/filter
│   ├── permission-mapper.ts  # Role hierarchy resolution, field access, spending caps
│   ├── draft-manager.ts      # Draft CRUD, templates, state machine
│   ├── approval-manager.ts   # Multi-tier approval chain, cap enforcement, escalation
│   ├── snapshot-verifier.ts  # Approved-value hashing, re-verification, tamper alerts
│   ├── conflict-detector.ts  # Odoo vs Wabi value diff detection
│   ├── audit-logger.ts       # Structured queryable audit events
│   └── config-manager.ts     # Odoo connection, widget config, spending caps, tamper config
├── frontend/
│   ├── index.ts              # Plugin manifest: workspace panel, settings, commands
│   ├── dashboard/
│   │   ├── BusinessDashboard.svelte  # Bento-grid dashboard with role gating
│   │   ├── OdooTableView.svelte      # Read-only data table
│   │   ├── ApprovalQueueCard.svelte  # Full-width attention approval strip
│   │   ├── TamperMonitorCard.svelte  # Verified vs tampered ring gauges
│   │   ├── TransactionAudit.svelte   # Searchable user action timeline
│   │   ├── StatusFeed.svelte         # Color-coded activity feed
│   │   └── shared/
│   │       ├── Led.svelte            # Animated LED dot
│   │       ├── RingMetric.svelte     # Circular progress ring
│   │       └── Tag.svelte            # Corner label tag
│   ├── spreadsheet/
│   │   ├── SpreadsheetViewer.svelte  # Sortable/filterable table
│   │   ├── WorksheetEditor.svelte    # Draft from template
│   │   └── ApprovalPanel.svelte      # Approve/reject UI
│   └── admin/
│       ├── OdooConnectionConfig.svelte  # Connection settings
│       ├── SpreadsheetConfig.svelte     # Model/field mapping
│       └── RoleConfig.svelte           # Spending caps, AFK thresholds, widget perms
└── shared/
    └── types.ts              # All shared TypeScript types
```

### Data storage

All state lives in `ctx.storage` (plugin KV store). No SpacetimeDB schema changes needed.

| Key pattern | Content |
|---|---|
| `verified:odoo:connection` | Encrypted Odoo connection config |
| `verified:snapshots:*` | Approved-value snapshots (append-only) |
| `verified:drafts:*` | Draft worksheet state machine |
| `verified:approvals:*` | Approval chain records |
| `verified:audit:events` | Structured audit event log |
| `verified:tamper:alerts` | Detected tamper events |
| `verified:config:*` | Spending caps, widget perms, AFK thresholds |

## Implementation order

### Phase 1: Odoo connector + read-only preview

Connect to Odoo, configure model/field mappings, render sortable/filterable tables with role-locked access and "Open in Odoo" links. Odoo connection config stored in plugin storage. (Low risk, immediate value.)

### Phase 2: Draft worksheets

Operational worksheets hosted entirely in Wabi. Field-level role locks, file/photo attachments, template system. No Odoo mutation yet. (Enables field data collection without risk to accounting records.)

### Phase 3: Approval chain + spending caps + verified snapshots

The core trust layer. Draft worksheets go through multi-tier approval. On approval, Wabi pushes to Odoo and stores cryptographic snapshots. Background re-verification detects tampering. Transaction Audit widget allows user-based search with anomaly flags and PDF export. (This is the feature that makes the addon worth deploying.)

### Phase 4: Controlled live editing + configurable widgets

Selected Odoo fields editable directly from Wabi with conflict detection and permission mirroring. Widget system for dashboard customization (active projects, stock alerts, budget gauges, etc). (Should only be enabled after the snapshot system is stable.)

## Design principles

- **Digital must be more trustworthy than paper.** Without cryptographic snapshots and tamper detection, there is no reason for a business that has been burned by digital theft to switch away from paper. The verified snapshot system is not a feature; it is the whole reason this addon exists.

- **Wabi is the guardrail, Odoo is the engine.** All business intelligence — who can see what, who can spend what, what counts as tampering — lives in Wabi. Odoo is treated as a reliable but untrusted data store.

- **Approved values are frozen.** Once Wabi pushes data to Odoo, it remembers exactly what it pushed. Any divergence is detected, reported, and surfaced in a dashboard. This is the feature that directly prevents the cycle of digital → theft → paper.

- **Every action is searchable.** The Transaction Audit widget is the replacement for months of paper cross-referencing. Every user action is timestamped, hash-verified, filterable, and exportable.

- **Permissions are explicit and audited.** Every dashboard element, widget, and action is role-gated at both frontend and backend. Users never see data they shouldn't.

- **No Enterprise lock-in.** Everything works with Odoo Community Edition. No Enterprise modules required.
