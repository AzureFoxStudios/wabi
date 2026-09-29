# 07 — Status and what remains

Date: 2026-09-29. This document states plainly what Sabi does today and what it does not do yet. Nothing here is certified by the Thai Revenue Department or by an auditor. The software helps a business keep correct records; it does not replace an accountant.

## 1. What works end to end

The full flow runs on the demo seed and in `apps/server/test/workflow.e2e.test.ts` (over real HTTP):

Customer → Job (install workflow) → Quotation (with discount approval) → issue → convert to Sales order → materials reserved, shortage shown → Purchase order (approval over 50,000) → Goods receipt (stock in) → Supplier bill → workshop tasks → delivery (stock out) → Tax invoice (VAT, AR posting) → payment with 3 % WHT certificate → invoice becomes *paid* → job *completed*. Discussion, files, tasks and the activity timeline hang off every job, document and party.

Checks that pass on every run:
- 24 `node --test` tests: core, Thai adapter, pack validation, and 4 HTTP end-to-end tests.
- `tsc` strict, `svelte-check` 0/0, and a Vite build with no warnings.
- `scripts/smoke-api.mjs` runs against a live server.
- `sabi verify` confirms the hash chain is intact and that replaying the journal gives the same projections.
- `scripts/browser/flow.mjs` is a UI test: a salesperson creates a customer, a job and a quotation, adds a line with the picker, saves with ⌘S and issues it.
- The ledger balances: debits = credits. VAT and WHT reports match the documents.

Screenshots are in `docs/screenshots/`.

## 2. Known gaps: Thai compliance and tax

| Gap | Notes |
|---|---|
| **PromptPay QR image** | The EMVCo payload is generated and tested, but the UI shows only the PromptPay ID and amount. It does not draw a QR yet. This needs a small QR encoder, either vendored or as a dependency. |
| **e-Tax Invoice** | Not implemented. It is voluntary in Thailand. There are two routes: ETDA XML with a digital signature (form บอ.01), or e-Tax by Email (PDF/A-3 plus ETDA timestamp, turnover ≤ 30M, form กอ.01). This belongs in the jurisdiction adapter as an integration. |
| **Credit / debit notes** | There are no document types for them yet. A mistake is corrected today by voiding and reissuing, which keeps the number and reverses the postings. Thai practice needs proper ใบลดหนี้/ใบเพิ่มหนี้ that reference the original invoice. |
| **Receipt / tax-invoice-receipt print** | Payments are numbered (RC/PV) and posted, but they have no print layout. Services whose tax point is payment (ใบกำกับภาษี/ใบเสร็จรับเงิน) need a combined form. |
| **50 ทวิ certificate for WHT we deduct** | WHT on outgoing payments is posted and reported. The certificate form itself is not printed. |
| **Filing formats** | The ภ.พ.30 summary and the ภ.ง.ด.3/53 lists are screens and CSV exports only. Nothing is produced in the RD e-Filing upload format. |
| **Payroll** | Not in scope yet. There is no ภ.ง.ด.1 and no social security. Employees are users; salaries can be recorded as expenses. |
| **Abbreviated tax invoices, POS** | Not implemented. |
| **VAT after 30 Sep 2027** | The adapter falls back to the statutory 10 % and flags `vat_rate_unconfirmed`. This needs updating when a new decree is gazetted. |

## 3. Known gaps: product

- **The business pack is code.** `packages/pack-sheet-metal` is a validated TypeScript object. There is no UI for editing workflows, fields or roles, and no migration for records sitting in a state that a new pack version removes. `validatePack` catches broken references at start-up.
- **Stock:** single location in the UI (the `stock.transfer` command exists, but there is no screen for it). There is no lot/serial tracking, no costing beyond the item's standard cost, and no stock count. The reorder point is read from a pack field key (`reorder_point`); it should become a first-class item property.
- **Units** print their raw code, so "m2" appears instead of "m²". A unit label table is needed in the pack.
- **Permissions** are per capability and per role (who can issue, approve or void). There are no record-level rules (such as "sales see only their own customers") and no field-level hiding.
- **Automation** covers workflow auto-transitions and actions (create a task, notify a role) and the settled/paid transitions. There is no general rule builder and no time-based triggers such as overdue reminders.
- **Notifications** are in-app only (the Today view plus live updates over SSE). There is no LINE, e-mail or push.
- **Documents:** one currency (THB), one company, one seller branch. There are no recurring invoices, deposits or progress billing (งวดงาน), and no retention (เงินประกันผลงาน). The last two are common in construction and should come next.
- **Import:** there is no Excel or Express/FlowAccount import. Export exists: a full journal as JSONL, CSV reports, and a SQLite backup.
- **Search** uses SQL `LIKE`, which is fine for thousands of records. FTS5 would be the next step.
- **Mobile:** the layout is responsive, but it has not been designed for installers on a phone. There is no PWA or offline mode.
- **Browser tests** are ad-hoc scripts (`scripts/browser/`) and do not run in CI. Visual review was done with screenshots.
- **Docker:** a `Dockerfile` and `compose.yaml` are provided, but they are **untested** because this sandbox has no Docker. `npm run start` on Node 22 is the tested path.
- **Accessibility:** keyboard navigation (⌘K, g-shortcuts, j/k, ⌘S) and labelled controls are in place. No formal audit has been done.

## 4. Security notes

- Sessions are an HttpOnly cookie (token stored as SHA-256) with a Bearer fallback. Over HTTPS the cookie is `SameSite=None; Secure; Partitioned`, so the app also works inside an iframe on another site. When cookies are blocked completely, the web client keeps the token for the tab (`sessionStorage`) and sends it as `Authorization: Bearer`. GET-only browser loads (EventSource, images, the export download) may carry `?access_token=`. **That query parameter is refused for every mutating request.**
- CSRF: every mutation must be `application/json`, which forces a CORS preflight that the server never grants, and must pass an Origin/Host check.
- Login is throttled (10 failures per IP per minute). Passwords use scrypt.
- The journal is append-only (SQLite triggers) and hash-chained. This makes edits *detectable*, but it does not prevent someone with file access from rewriting the whole database. Back up off-machine.

## 5. Suggested next steps (in order)

1. Credit/debit notes, plus receipt and tax-invoice-receipt print layouts.
2. Deposits, progress billing and retention for construction jobs.
3. PromptPay QR rendering and 50 ทวิ print.
4. Pack editor, starting with read-only views of the pack and then editing of fields, states and roles.
5. Import from spreadsheets (parties, items, opening balances, opening stock).
6. LINE notifications through an integration module.
7. e-Tax Invoice by Email through the Thai adapter.
