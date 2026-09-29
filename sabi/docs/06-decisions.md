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

## ADR-8 · Cookie sessions
The session is an opaque random token sent as an HttpOnly, SameSite=Lax cookie and stored hashed (sha256) at rest. A `Bearer` header is accepted for scripts. Passwords use scrypt from `node:crypto`. There is no JWT secret to generate, rotate or lose.

## ADR-9 · Frontend: SvelteKit static SPA, hand-written CSS, no component library
Svelte 5 runes, following Wabi's rules. `adapter-static` output is served by the Sabi server. There is no Tailwind or UI kit. Design tokens are CSS custom properties, and fonts come from `@fontsource/*` packages, so nothing loads from a CDN. The esbuild minifier is used (Wabi rule 1).

## ADR-10 · Money is integer satang, quantities are 3-decimal numbers
Amounts are stored and computed in minor units (integers). Line amounts are rounded half-up to the satang. VAT is computed on the document's taxable base per tax code (the Thai invoice convention), not summed from rounded per-line VAT. Quantities are rounded to 3 decimals, which is enough for metres and kilograms.
