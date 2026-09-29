# 04 — Information architecture and primary workflows

## 1. Principles

1. **The work is the place.** A job, document or customer is a *workspace*. You do not open a form to look at it.
2. **Conversation lives in the margin of the work.** Every workspace has a live stream alongside its content, holding messages, files and system events. There is no separate chat app.
3. **The next action is always visible.** The workflow engine works out what can happen next and what is blocking it. That appears at the top of every workspace as one primary button, plus the reason whenever the button is blocked.
4. **Money is never more than one glance away.** Each job header shows quoted → ordered → invoiced → paid.
5. **Lists are for triage and workspaces are for work.** Lists are dense and keyboard-navigable. They are not dashboards made of cards.
6. **Keyboard first, mouse friendly.** `Ctrl/⌘ K` opens the command palette (search, jump, create). `g` then a letter navigates. `j`/`k` move through lists. `c` creates. `?` shows help.
7. **Thai and English are equal.** Every label comes from a dictionary or a configuration pack `{en, th}`. The document font is Sarabun and the UI font is IBM Plex Sans Thai. Both are self-hosted, with no CDN.

## 2. Navigation (one level only)

```
┌──────┬──────────────────────────────────────────────────────────────┐
│ Sabi │  ⌘K  Search or jump…                                (you) ●  │
│      ├──────────────────────────────────────────────────────────────┤
│ ◉ Attention       ← what needs me, what changed                      │
│ ▣ Jobs            ← board by workflow state / list                   │
│ ▤ Documents       ← all sales & purchase papers, filter by type      │
│ ◎ Parties         ← customers, suppliers, people                     │
│ ▥ Items & stock   ← catalogue, on hand, reserved, moves              │
│ ฿ Money           ← receivables, payables, payments                  │
│ ▦ Reports         ← tax reports, sales, stock valuation, audit       │
│ ⚙ Settings        ← company, users, workflows, backup/export         │
└──────┴──────────────────────────────────────────────────────────────┘
```

There are no nested sidebars. Filters and views sit in a single toolbar row inside each section.

## 3. Screens and the questions they answer

| Screen | Answers |
|---|---|
| **Attention** | *What needs my attention?* Sections, in priority order: **Your next actions** (jobs where your role or you own the next step), **Approvals waiting for you**, **Mentions**, **Blocked** (jobs whose primary transition is blocked, with the reason), **Overdue** (tasks, receivables), then **Since you last looked** (the journal feed, grouped by subject) |
| **Job workspace** | Header: number, title, customer, owner, state pipeline, money strip, primary action. Main column: *Overview* (key fields, open documents in lineage order, tasks, materials, files). Right column: *Stream* (discussion plus activity). Tabs: `Overview · Documents · Materials · Files · Activity` |
| **Document workspace** | Header: type, number or "Draft", state, party, job link, primary action (Issue, Accept, Convert…). Body: editable line grid for drafts, read-only once issued, totals with VAT and WHT preview, and any jurisdiction warnings (missing tax ID, branch…). Stream on the right. `Print` opens an A4 view |
| **Party workspace** | Contact facts, tax identity, balance owed and owing, open jobs, recent documents, stream |
| **Item workspace** | On hand by location, reserved, available, incoming, stock-move ledger, recent documents |
| **Money** | Receivables aging (who owes what, how late), payables, recent payments. *Record payment* from any row |
| **Reports** | Output tax / input tax report per month (shaped for PP.30), sales by customer, stock on hand and valuation, journal verification |

## 4. Primary workflow: metal-sheet sale with delivery and installation

Configured by `packs/sheet-metal`. The core sees only states, guards and effects.

```
Job states:  Inquiry → Site survey → Quoted → Confirmed → Production → Ready → Delivery / install → Completed
                                     ↘ Lost (cancelled)
```

| Step | User action (UI) | Commands | Guard / effect |
|---|---|---|---|
| 1 Inquiry | `c` → New job, choose or create a customer | `party.create`, `job.create` | – |
| 2 Measurements | Fill in job fields (site, roof area, measured-by date), attach photos and a sketch in the stream | `job.update`, `file.attach`, `message.post` | *Site survey → Quoted* needs `site_address` |
| 3 Quotation | "Create quotation" from the job. Line grid: sheet × pieces × length → metres (formula), screws, ridge caps, installation labour | `document.create`, `document.update` | Discount > 10% needs **manager approval** before sending |
| 4 Send | Issue the quotation (QT-2026-0001) and print or share it | `document.transition(issue)` | Job auto-advances to *Quoted* (requires issued quotation) |
| 5 Customer approves | Mark the quotation accepted, then "Convert to sales order" | `document.transition(accept)`, `document.create{source}` | SO issue → effect `reserve` |
| 6 Allocation / purchasing | The Materials tab shows needed vs available. Shortfall → "Create purchase order" for the supplier | `document.create(purchase_order)` | Goods receipt → `stock_in` |
| 7 Production / cutting | Job → *Production*, a task is auto-created for the workshop role, and cut materials are issued | `job.transition`, `task.complete`, `stock.issue` | `on_enter: create_task` |
| 8 Delivery / install | Create the ใบส่งของ/ใบกำกับภาษี from the SO. Issuing it moves stock out and posts AR and output VAT | `document.create{source}`, `document.transition(issue)` | Jurisdiction validates the tax-invoice particulars |
| 9 Completion | Job → *Completed* once the delivery is issued | `job.transition` | requires issued `tax_invoice` |
| 10 Payment | "Record payment": amount plus WHT withheld by the customer (3% on installation labour) and a slip photo | `payment.record` | Posts cash/bank, WHT prepaid, AR |
| 11 Archive / reporting | The job shows *Paid*. The invoice appears in the output tax report for the month | – | – |

Throughout: discussion, files and tasks attach to the job or document. The job's stream shows the events of its documents inline, for example "QT-2026-0001 issued by Nok".
