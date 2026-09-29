# 06 — Architecture decision records

## ADR-1 · Sabi is a new app in `sabi/`, and Wabi stays as the donor tree
**Context.** Wabi is a large, working community-chat product with its own CI, and the brief says to avoid breaking unrelated backend functionality.
**Decision.** Build Sabi in `sabi/` with its own npm workspace. Leave `core/`, `frontend/` and the rest untouched.
**Consequences.** The repository holds two products for now. A later split can move Sabi to its own repository with `git subtree split -P sabi`, or move Wabi into `donor/`.

## ADR-2 · Node.js 22 + TypeScript (type-stripping) for the server, not the Rust Authority
**Context.** The Rust Authority cannot be compiled in this environment (there is no toolchain, and crates.io and rustup are unreachable). Separately, the ERP domain needs:
- serializable read-modify-write for numbering, stock and allocation;
- flexible JSON fields;
- domain logic shared between server and browser (live totals, workflow hints).
**Decision.** A single Node 22 process. TypeScript runs directly, with no build step, using erasable syntax only (no enums, namespaces or parameter properties). The domain logic in `@sabi/core` is imported by both server and web.
**Consequences.** One runtime to install. It deploys as one container and can later become a single executable (Node SEA). The Wabi Authority can still be *attached* later rather than reused:
- (a) as an identity provider;
- (b) for voice/video calls on a job;
- (c) by porting the journal onto WabiDB once it offers serializable commands. The `Journal` boundary in `apps/server/src/journal.ts` is the seam for that.

## ADR-3 · SQLite with a hash-chained event journal and same-transaction projections
**Decision.** Every write is a named **command**. A command validates against current projections and emits **events**. Events are appended to `events`, where `hash = sha256(prev_hash ‖ canonical(event))`. The projector updates the read tables **in the same transaction**. Triggers reject UPDATE and DELETE on `events`.
**Why not pure projections in memory (the WabiDB style)?** Reports and search need SQL, and the file must stay readable by standard tools for years.
**Why not plain CRUD?** Audit, the activity timeline and "what changed" all come for free from events, and tampering becomes detectable.
**Verification.** `sabi verify` recomputes the hash chain, then replays every event into a fresh database and compares the projection tables row by row.
**Exceptions.** `users.password_hash` and `sessions` are auth state and are not projected from events. User creation and role changes *are* journaled, without secrets.

## ADR-4 · Accounting postings are stored as events, not derived at read time
Posting rules will change. The ledger must not. `ledger.posted` events carry the full entry lines, so replay restores exactly the entries that were posted. Voiding posts a reversal and never modifies the original.

## ADR-5 · The business lives in configuration packs, behaviour lives in effects
Job and document *types*, states, transitions, guards, fields, measure templates, numbering prefixes and roles all come from a configuration pack. The core knows only **phases** (`draft | issued | closed | void` for documents; `open | done | cancelled` for jobs) and **effects** (`reserve`, `stock_out`, `stock_in`, `receivable`, `payable`). The pack is TypeScript data rather than YAML, so it is type-checked. It is plain data, so it can be exported as JSON and edited through a UI later.

## ADR-6 · Jurisdiction adapter interface
`Jurisdiction` provides:
- `taxRate(code, date)`
- `whtCategories`
- `validateParty` / `validateIssue(doc, ctx)` → errors and warnings
- `partyFields`
- `chartOfAccounts` and `postingAccounts`
- `formatDocumentNumber`
- `amountInWords`
- `paymentQr?`
- `reports`

Thailand is the first implementation. The core computes totals by asking the adapter for rates. It never sees "VAT 7%".

## ADR-7 · Server-Sent Events for realtime
Writes go through `POST /api/commands/:name`. After commit, the server broadcasts `{seq, type, subject}` on `/api/stream`. Clients re-fetch the workspaces they are showing. This is simple, works through proxies, and needs no socket library. It trades bandwidth for simplicity, which is correct at SME scale.

## ADR-8 · Cookie sessions, with a header fallback for embedded use
The session is an opaque random token, stored hashed (sha256) at rest. It travels as an HttpOnly cookie: `SameSite=Lax` over plain HTTP, and `Secure; SameSite=None; Partitioned` over HTTPS, so the app also works inside an iframe on another site. Where the browser blocks cookies completely, the client keeps the token for the tab and sends it as `Authorization: Bearer` / `x-sabi-session`. GET-only loads (EventSource, downloads) may use `?access_token=`, which is refused for every mutation. Passwords use scrypt from `node:crypto`. There is no JWT secret to generate, rotate or lose.

## ADR-9 · Frontend: SvelteKit static SPA, hand-written CSS, no component library
Svelte 5 runes, following Wabi's rules. `adapter-static` output is served by the Sabi server. There is no Tailwind or UI kit. Design tokens are CSS custom properties, and fonts come from `@fontsource/*` packages, so nothing loads from a CDN. Vite's default minifier is used: Vite 8 with `minify: 'esbuild'` fails to build, so Wabi's rule 1 does not carry over.

## ADR-10 · Money is integer satang, quantities are 3-decimal numbers
Amounts are stored and computed in minor units (integers). Line amounts are rounded half-up to the satang. VAT is computed on the document's taxable base per tax code (the Thai invoice convention), not summed from rounded per-line VAT. Quantities are rounded to 3 decimals, which is enough for metres and kilograms.

## ADR-11 · Corrections are new records, never edits
Once a document is issued or an entry posted, nothing changes it in place. A correction is always a new, dated, attributed record:
- **Credit and debit notes** correct an issued invoice or bill (ADR-12).
- **Void** is allowed only while nothing depends on the document. It is refused when payments are allocated (`has_payments`), when child documents exist (`has_children`) or when a refund would be needed first. The number is kept and the postings and stock moves are reversed.
- **Reversing journal entries** undo a manual entry.

These actions can require a separate **corrections password** (Settings → Controls & audit). The server answers `corrections_password` (403). The web client asks for it once, keeps it in memory for 5 minutes and retries the command, so no screen has to know which actions count as corrections. Each use is written to `auth_log`. The **corrections report** (Books → Corrections) is built from the journal itself, so it cannot be edited or hidden. This design follows the Revenue Department's software standard, clauses 12(ข)–(ง) and 14(ค)–(ง); see `08-certification.md`.

## ADR-12 · Credit and debit notes adjust another document's balance
A document type may declare `adjusts: 'credit' | 'debit'`. Such a note:
- can only be created from an issued source (`sourceId`), with the source's lines copied and then edited down to the difference;
- needs a reason, and shows the original value, correct value and difference (Thai ม.86/10 and ม.86/9);
- posts mirrored ledger lines and reverses stock when `goods_returned` is set;
- records a `doc_adjustments` row. The note has **no balance of its own**. The source's outstanding amount becomes total − payments ± adjustments.

When a document is over-credited it has a **credit balance**. Money → Credit balances lists these, and the balance is paid back with a payment allocation flagged `refund`. The same mechanism serves suppliers (`supplier_credit` against a bill). Notes appear in the VAT reports as negative rows (credit) or positive rows (debit), each referencing the original tax invoice.

## ADR-13 · Retention is held apart, not deducted from the invoice
Construction customers hold back a percentage (เงินประกันผลงาน). An invoice's `retention_pct` field sets `documents.retention`. VAT is still charged on the full value, as the tax point requires. At posting, the retained part goes to *Retention receivable* (1150) instead of *Trade receivables*. The invoice's collectable balance ("Due now") excludes held retention. `document.releaseRetention` moves it back to receivables when the warranty period ends. Retention is a field that a pack attaches to a document type; the core only knows the `retention` amount.

## ADR-14 · Deposits and progress billing reuse conversion; there are no negative lines
- **Progress billing (งวดงาน):** each stage is an invoice converted from the same sales order with the quantity reduced. For a lump-sum line, 0.3 means 30 %. Conversion always opens with what is still unbilled, so the order shows how much has been invoiced (tested in `books.e2e.test.ts`).
- **Deposits:** a deposit is its own tax invoice, because receiving it is a tax point in Thailand. Deducting it later is done with a credit note against the deposit invoice, not with a negative "less deposit" line.

An invoice whose total is negative is refused at issue (`invalid`). This keeps every VAT row traceable to one positive supply or one referenced note.

## ADR-15 · Outgoing webhook is a notification, not an integration bus
Settings → Integrations holds one webhook URL. After commit, a short summary of each event (type, subject, actor, time) is POSTed. With a secret, the body is signed with HMAC-SHA256 in `x-sabi-signature`. Delivery is best-effort with a 5-second timeout and no retries. The journal export remains the complete, replayable record. This covers LINE bots, n8n and spreadsheets without building a queue. A durable outbox can come later without changing the event model.

## ADR-16 · Where settings live
Business settings (webhook, sign-in notice, custom accounts) are **events** (`settings.updated`, `account.created`), so they are exported, replayed and audited like everything else. Secrets that must not travel with an exported journal (the corrections password hash) and machine-local state live in `local_state`. They are lost on a journal-only restore, which is the intended behaviour. Only the owner sees the webhook secret; other roles see "(set)".

## ADR-17 · Import goes through the ordinary create commands, all-or-nothing
`import.parties` and `import.items` run each row through `party.create` or `item.create` inside one transaction. Rows are validated exactly like records typed by hand, including the tax-ID checksum and the SKU uniqueness check. If any row fails, the batch rolls back and the response lists each failing row (`import_failed`, 422). The browser parses the CSV (UTF-8 with BOM; `,`, `;` or tab as separator), maps headers (English or Thai aliases, plus the pack and adapter field keys) and shows a preview. There is no separate import schema to keep in sync.

## ADR-18 · Manual entries and the chart of accounts
The adapter's chart of accounts and its posting accounts are fixed: automatic postings depend on them. Businesses can **add** accounts (`account.create`); they cannot rename or delete them. Manual journal entries (`journal.post`) need the `ledger.write` capability, must balance, and can require the corrections password. They are corrected only by `journal.reverse`, never by editing. Books → General ledger shows the opening balance, the postings with links to their source documents, and the running balance for any account and period.

