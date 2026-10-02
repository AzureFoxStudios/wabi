# 02 — Domain model

This document defines the smallest set of primitives that can represent many business workflows cleanly. The first deployment is a Thai metal-sheet and construction-materials business, but nothing listed below is specific to that business.

## 1. From the candidate list to primitives

The brief listed 26 candidate primitives. Many of them turn out to be *the same shape with a different label*:

| Candidate(s) | Resolution | Why |
|---|---|---|
| Person, Organization, Customer, Supplier | **Party**, with `kind` (person / organization) and `roles[]` | The same company can be a customer this month and a supplier the next. Thai shops buy from and sell to each other. A contact person is a Party with a `parent_id` |
| Product, Service, Resource, (material) | **Item**, with `kind`: `stock`, `service` or `non_stock` | They share price, unit, tax code and description. Only stock items create stock movements |
| Quote, Order, Purchase, Invoice, Receipt, Delivery note, Credit note, Expense | **Document**, typed by configuration | They are all *numbered commercial papers with a party, lines, tax and totals*. What differs is their **effects** (reserve stock, move stock, create a receivable or payable). Thai SMEs already think this way: เอกสาร with running numbers |
| Job, Project, Inquiry/Opportunity | **Job**, typed by configuration | A long-lived unit of work with a workflow. A "project" is a job type with more tasks. An "inquiry" is a job's first state |
| Task | **Task**, attached to any subject | A small action owned by one person |
| Workflow, State, Approval | **Workflow** (configuration) + **Approval** (record) | The states, transitions and guards live in configuration. An approval is a pending decision recorded in data |
| Inventory movement | **StockMove** (ledger) | Moves between locations. Stock on hand is the sum of moves |
| Payment, Transaction | **Payment** (money in or out, with allocations to documents) + **JournalEntry** (accounting) | Operational money and accounting entries are deliberately kept separate |
| Message, Attachment, Event, Audit entry | **Message**, **File**, **Event** | All three attach to *any subject*. The audit log and the activity timeline are the same journal |
| Asset | **Deferred** | Not needed for the first workflow. It will later become an Item kind, or a module with depreciation |
| Document (file sense) | **File** | "Document" is reserved for commercial documents, matching Thai usage |

The result is **10 core primitives**: Party, Item, Job, Document, StockMove, Payment, JournalEntry, Task, Message/File, and Event. On top of those sit two **configuration primitives**: Workflow and Field schema.

## 2. Primitives

```
                       ┌────────────── Event journal (append-only, hash-chained) ──────────────┐
                       │  every command → events → projections; timeline of any subject        │
                       └───────────────────────────────────────────────────────────────────────┘
   Party ──< Job ──< Document ──< Line ──> Item
     │        │         │  └─ source_id (lineage: quote → order → invoice)
     │        │         ├──> StockMove (effect: stock_out / stock_in)
     │        │         ├──> JournalEntry (effect: receivable / payable, via posting policy)
     │        │         └──< PaymentAllocation >── Payment ──> JournalEntry
     │        └──< StockMove (material issued to the job)
     └── any subject ──< Task, Message, File, Approval
```

### Party
`id, kind, name, roles[], tax_id, phone, email, address, parent_id, payment_terms_days, credit_limit, fields{}`.
Jurisdiction-specific data, such as the Thai **branch code** (สำนักงานใหญ่ = `00000`), lives in `fields` using a schema supplied by the jurisdiction adapter.

### Item
`id, sku, name, kind, uom, sale_price, cost_price, tax_code, wht_category?, line_template?, attributes{}`.
`line_template` refers to a configured **measure template**. For example, the metal-sheet pack defines `pieces × length_m → qty (m)`. The core evaluates the formula with a safe arithmetic parser, so the core knows nothing about sheets.

### Job
`id, number, type, title, party_id, contact_id, owner_id, state, due_date, fields{}`.
The job is the **workspace** that holds the discussion, documents, tasks, files and money for a piece of work. Its money summary (quoted, ordered, invoiced, paid) is derived from its documents.

### Document
`id, type, number?, state, phase, party_id, job_id?, source_id?, date, due_date, price_mode (exclusive|inclusive), lines[], totals, party_snapshot, seller_snapshot`.

The core enforces these invariants whatever the configuration says:
- **draft**: editable, with no number.
- **issue**: assigns a gapless number per document type and year inside the same transaction; freezes the party and seller snapshots (a tax invoice must show the details *as they were at issue*); applies effects. After this the lines are immutable.
- **void**: never delete. It needs a reason, reverses the effects, and keeps the number.
- Every configured state maps to one of these **phases**: `draft | issued | closed | void`.

**Effects** are semantic operations known to the core. Document *types* are only configuration:

| Effect | Applied when | Result |
|---|---|---|
| `reserve` | issued | Open quantities count as reserved against stock (derived, no moves) |
| `stock_out` | issued | StockMove from warehouse → customer (virtual) |
| `stock_in` | issued | StockMove supplier (virtual) → warehouse |
| `receivable` | issued | Posting: AR / revenue / output tax |
| `payable` | issued | Posting: inventory or expense / input tax / AP |

Conversion (`quote → order → invoice`) copies the lines that are still open and records `source_line_id`. That makes "ordered vs delivered vs invoiced" a query rather than a set of status flags.

### StockMove
`id, item_id, qty, from_location, to_location, document_id?, job_id?, at`.
Locations are `internal` (warehouse, yard, van) or `virtual` (`supplier`, `customer`, `consumed`, `adjustment`). On hand at a location is Σin − Σout. Using materials on a job is a move to `consumed` tagged with that `job_id`. Adjustments are moves to or from `adjustment`, and each one needs a reason.

### Payment
`id, number, direction (in|out), party_id, date, method, amount, wht_amount, wht_certificate?, reference, allocations[]`.
A payment settles documents through allocations. The printed **receipt** is a view of the payment. Withholding tax is modelled explicitly: when a Thai corporate customer withholds 3% on installation services, the settled amount is `amount + wht_amount`.

### JournalEntry (accounting)
`id, date, memo, source (document|payment), lines[account, debit, credit, party_id]`.
Entries are generated by a **posting policy** when an operational event happens. They are **stored as events**, not recomputed, so a later change to the posting rules never rewrites history. Voiding a document creates a reversal entry. The chart of accounts comes from the jurisdiction package.

### Task, Message, File, Approval
All four attach to a `(subject_type, subject_id)` pair. The possible subjects are job, document, party, item and payment.
- **Task**: `title, assignee_id, due, done_at`.
- **Message**: `body, mentions[], file_ids[]`. Mentions create attention items.
- **File**: content-addressed by sha256.
- **Approval**: `transition, rule, approver_role, state (pending|approved|rejected)`.

### Event (journal)
`seq, id, at, actor_id, type, subject_type, subject_id, data, prev_hash, hash`.
The journal is the audit trail, the activity timeline, the "what changed since I looked" feed, and the source for rebuilding projections, all at once.

## 3. Configuration primitives

### Workflow
The same structure is used for job types and document types:

```ts
states:      [{ id, label{en,th}, phase, owner_role?, color? }]
transitions: [{ id, from[], to, label{en,th}, roles?, primary?,
                requires?: { fields?, documents?: [{type, phase}], tasks_done?, approval?: {role, when?} },
                on_enter?: [{ create_task: {...} } | { notify_role }] }]
```

Guards are generic predicates. Evaluating every transition out of the current state gives:
- **Next action**: the primary transition that is allowed.
- **Blocked**: a transition whose guards fail, together with the exact reason (for example, "needs an issued Sales order") and the action that would unblock it.
- **Who acts next**: the state's `owner_role` together with the job owner.

### Field schema
`[{ key, type: text|number|date|select|boolean|party|user, label{en,th}, options?, required_in_states? }]`. These are defined per job type, per document type, for parties and for items. Values are stored in JSON `fields`. There is deliberately no generic entity builder: custom fields add to the fixed primitives, they do not replace them.

## 4. Three separated layers

| Layer | Owns | Location |
|---|---|---|
| **Operational records** | Parties, items, jobs, documents, stock, payments, tasks, discussion | `packages/core` + server commands |
| **Accounting records** | Chart of accounts, journal entries, posting policy | `packages/core/src/accounting.ts` (mechanism) + jurisdiction chart of accounts |
| **Jurisdiction behaviour** | Tax rates and effective dates, tax-document rules and required particulars, WHT categories and rates, ID validation, number and date formats, tax reports, payment QR | `packages/jurisdiction-th` implementing the `Jurisdiction` interface |

The core depends only on the `Jurisdiction` interface. To add Laos, Vietnam or the EU you would write a new package, not change the core.

## 5. What is intentionally *not* in the core
- No "roof", "sheet", "coil", "cutting" or "install" anywhere in `packages/core` or `apps/server`.
- No business status enums. Every job and document state comes from configuration.
- No hard-coded fabrication stages. The metal-sheet pack defines them as workflow states and tasks.
