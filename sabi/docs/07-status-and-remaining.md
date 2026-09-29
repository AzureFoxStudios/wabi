# 07 — Status and what remains

Date: 2026-09-29. This page says plainly what Sabi does today and what it does not. **Nothing here is certified by the Thai Revenue Department or by an auditor.** `08-certification.md` explains the RD's software standard and how Sabi measures against it. Sabi helps a business keep correct records; it does not replace an accountant.

## 1. What works end to end

### Operations
- **Workflow:** Customer → Job (configurable workflow) → Quotation (discount approval) → Sales order → materials reserved and shortages flagged → Purchase order (approval over a limit) → Goods receipt → Supplier bill → workshop tasks → Delivery / tax invoice → Payment with WHT → invoice *paid* → job *completed*.
- **Every job, document, party and item is a workspace:** overview, discussion with @mentions and files, tasks, documents, fulfilment and activity. The Today view answers *what needs me, what changed, what's blocked, what money is due*.
- **Stock:** per-location balances; a stock card with every movement, its voucher and a running balance; adjustments; **counts** (enter the counted quantity, the difference is posted with the reason); **transfers** between locations; **reorder points** on the item, which flag low stock on Today and in the item list ("Short or low only").
- **Units:** pack unit labels are shown everywhere, in Thai on printed documents (เมตร, แผ่น, …).

### Documents, money and tax (Thai adapter)
- Quotation, sales order, delivery / tax invoice (ม.86/4 content), purchase order, goods receipt, supplier bill, all printable (A4, Thai/English, Sarabun).
- **Credit and debit notes** (ใบลดหนี้ / ใบเพิ่มหนี้). They are made only from the invoice they correct, show the original value, correct value, difference and reason, can return goods to stock, and appear in the VAT report as referenced negative or positive rows. **Supplier credits** work the same way against bills.
- **Credit balances and refunds:** an over-credited invoice shows under Money → Credit balances and is paid back with a refund.
- **Retention (เงินประกันผลงาน):** a percentage on the invoice. VAT is charged on the full value, the retained part is held in *Retention receivable*, "Due now" excludes it, and the retention is released later with one action.
- **Progress billing:** partial invoices from one sales order; each new invoice opens with what is still unbilled. **Deposits:** a separate deposit invoice, deducted later with a credit note. Negative invoices are refused (ADR-14).
- **Payments:** receipts and payment vouchers, with allocation across documents and WHT with certificate numbers. There are print layouts for **receipt / payment voucher / refund**, and a two-copy **50 ทวิ WHT certificate** when we withhold.
- **PromptPay QR** on invoices for the balance due (EMVCo payload, drawn as SVG).
- **Reports:** output VAT and input VAT (with notes, counterparty tax ID and branch), WHT by us and from us, stock valuation, trial balance. All export as CSV.

### Books and controls
- **Books** (new navigation item):
  - *Journal entries*: manual, balanced entries, corrected only by reversal.
  - *General ledger*: any account and period, with opening, running and closing balances and links to source documents.
  - *Chart of accounts*: the adapter's 32 accounts plus user-added accounts.
  - *Corrections report*: every void, note, manual entry and reversal, with time, user, amount and reason. It is built from the journal and cannot be hidden.
- **Corrections password:** a second password, separate from sign-in, for voids of issued documents and payments, manual entries and reversals. The browser asks for it only when the server needs it. Each use is logged.
- **Settings → Controls & audit:** the system flowchart, a *who can do what* matrix with people per role, journal status (events, chain head, database size) and the sign-in / password-use log.
- **Settings → Import from CSV:** customers and suppliers, and items. Headers are matched in English or Thai, a preview is shown, the import is all-or-nothing, and failing rows are reported with the reason. A template can be downloaded.
- **Settings → Integrations:** an outgoing **webhook** (HMAC-signed) for LINE bots, n8n or spreadsheets, and a **sign-in notice** shown on the first screen.
- **Audit and data ownership:** an append-only, hash-chained event journal, and `sabi verify` (chain + replay). Backups hold a SQLite snapshot, the journal as JSONL and the attachments. The full journal can be downloaded from Settings.

### Checks that pass on every run (and in CI once `sabi/ci/github-workflow.yml` is copied to `.github/workflows/`)
- **30 `node --test` tests**:
  - core maths, the Thai adapter, pack validation;
  - HTTP end-to-end: the full sales workflow, auth/CSRF, no-cookie embedding, seed consistency, backup and restore;
  - books end-to-end: retention, notes, refunds, supplier credits, manual entries, the corrections password, the corrections report, imports, settings, the webhook, progress billing, tax codes locked to the item.
- `tsc` strict, `svelte-check` 0 errors / 0 warnings, and a production build.
- `scripts/smoke-api.mjs` against a live demo server, followed by `sabi verify`.
- **Browser flows** (run by hand, not in CI):
  - `scripts/browser/flow.mjs`: a salesperson creates a customer, a job and a quotation, then issues it.
  - `scripts/browser/books-flow.mjs`: the owner turns on the corrections password, posts and reverses a manual entry through the password prompt, checks the corrections report, and imports a CSV with one bad row and then a fixed file.

Screenshots are in `docs/screenshots/`.

## 2. Deliberately out of scope for this round

These were decided, not forgotten. Each needs its own design, and usually an outside party.

| Item | Why it is out | What it would take |
|---|---|---|
| **Payroll** (ภ.ง.ด.1, social security, payslips) | A separate domain with its own legal calendar | A payroll module posting to the ledger; users are already people with roles |
| **e-Tax Invoice** (XML + signature, or e-Tax by Email) | Needs a signing certificate and RD registration (บอ.01 / กอ.01) by the business, or an e-Tax Service Provider | An integration in the Thai adapter that sends issued documents to a provider |
| **RD e-Filing upload formats** (ภ.พ.30, ภ.ง.ด.3/53) | The formats change, and filing is the accountant's step | Exporters in the Thai adapter; the report data already exists |
| **Record-level permissions** ("sales see only their own customers") | Capability-per-role covers current needs | A rule layer in queries; the journal already records the actor |
| **Multi-currency, multi-company, multi-branch seller** | One Thai company per install is the target | Per-document currency with rate snapshots; a company id on records |
| **Encryption at rest** | Disk or volume encryption on the host is the simpler, stronger control | SQLCipher, or an encrypted filesystem, documented for operators |
| **Docker** | The `Dockerfile` and `compose.yaml` exist but are **untested**: this sandbox has no Docker | Build and run once on a Docker host; `npm run start` on Node 22 is the tested path |

## 3. Known gaps (smaller, but real)

- **Business packs are code.** A pack is a validated TypeScript object; Settings → Business setup shows it read-only. There is no editor yet, and no migration for records in a state that a new pack version removes.
- **Stock:** no lot or serial tracking; costing uses the item's standard cost (no FIFO or average). There is no printed ม.87 stock-and-raw-material report with quantities and values by day (the stock card has the data).
- **Combined tax invoice / receipt** (for services whose tax point is payment) and **abbreviated tax invoices / POS** are not document types yet. A pack can add the first without core changes once its print layout exists.
- **Automation:** workflow auto-transitions, actions (create a task, notify a role) and paid/settled transitions exist. There are no time-based triggers (overdue reminders) and no rule builder.
- **Notifications:** in-app (Today + live updates) and the outgoing webhook. There is no built-in e-mail or LINE sender.
- **Import:** parties and items. Opening balances are entered as a manual journal entry and opening stock as adjustments or a count; there is no CSV importer for either.
- **Search** uses SQL `LIKE`, which is fine for thousands of records; FTS5 would be next.
- **Mobile:** the layout is responsive but not designed for installers on a phone. There is no PWA or offline mode.
- **Browser tests** do not run in CI (they need a headless Chromium; the scripts are in `scripts/browser/`).
- **Accessibility:** keyboard navigation (⌘K, g-shortcuts, j/k, ⌘S) and labelled controls are in place. No formal audit has been done.
- **VAT after 30 Sep 2027:** the adapter falls back to the statutory 10 % and flags `vat_rate_unconfirmed`. Update it when a new decree is gazetted.

## 4. Security notes

- **Sessions:** an HttpOnly cookie (token stored as SHA-256), `SameSite=None; Secure; Partitioned` over HTTPS, so the app also works inside an iframe on another site.
  - When cookies are blocked completely, the client keeps the token for the tab and sends it as a header. If storage is blocked too, a manual reload signs you out.
  - `?access_token=` is accepted only on GET.
- **CSRF:** every mutation must be `application/json` and pass an Origin/Host check.
- **Login:** throttled (10 failures per IP per minute), scrypt passwords, and every sign-in and failure logged.
- **The journal** is append-only (SQLite triggers) and hash-chained. This makes edits *detectable*; it does not stop someone with file access from rewriting the whole database. Back up off-machine and keep the backups' chain heads.

## 5. Suggested next steps

1. The ม.87 stock report layout and the RD printed layouts for the VAT reports (the remaining items in `08-certification.md` §5).
2. A pack editor: fields, states, roles and document types, with migrations.
3. Overdue reminders (time-based automation) sent through the webhook or a LINE module.
4. e-Tax Invoice by Email through a provider integration in the Thai adapter.
5. Payroll as a module.
