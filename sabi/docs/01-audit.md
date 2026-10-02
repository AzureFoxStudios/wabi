# 01 — Wabi repository audit and architecture assessment

Date: 2026-09-29 · Branch: `arena/01a0ebbd-wabi` (from `main@f088da4`)

Sabi is a work-management and ERP application for small businesses that anyone can self-host. It uses Wabi as a **donor**. This document records what the donor contains, what Sabi keeps, and why.

## 1. What Wabi is

| Layer | Path | Size | Summary |
|---|---|---|---|
| Rust Authority server | `core/crates/wabi-server` | ~45k LOC | Axum REST (30+ route groups), Socket.IO realtime, auth (bcrypt + JWT with per-user `iat` floors, owner bootstrap, step-up tokens), uploads/blobs, calls/SFU, CAD conversion, Lore, mesh, Steam, games, payments |
| Event-sourced storage | `core/crates/wabidb` | ~40k LOC | Single-writer sequencer, append-only encrypted `.wseg` segments, commit index, 22+ hand-written in-memory projections (SkipMap), snapshot/replay, experimental replication |
| Protocol | `crates/wabi-core` → `packages/wabi-protocol` | generated | ts-rs types for chat entities |
| Frontend | `frontend/` | ~193k LOC TS/Svelte, 366 components, ~40k LOC CSS | SvelteKit (static adapter, Svelte 5). A Discord-like shell: server rail, channels, chat, calls, whiteboard, wiki, Planner (device-local), Reader, CAD viewer, games, effects, themes |
| Desktop / mobile | `src-tauri/` | | Tauri 2 shell |
| Deployment | `docker-compose.yml`, `Caddyfile.*`, `docs/deployment/` | | Single-container Authority, optional TURN/LiveKit/tunnels, backup and recovery runbooks |
| Addons / plugins | `addons/`, `plugins/`, `core/addons/` | | Payments (PromptPay, PSP, BTC), compliance auditor, content addons. JS runtime plugins are **legacy**: the current Rust server has no JS plugin host |
| Prior business research | `docs/proposals/business-ops-adaptation-roofing-thailand.md`, `docs/research/thai-construction-*.md`, `docs/research/odoo-thailand-*.md` | | Earlier plans to make Wabi a coordination layer *around* Odoo or Express for this same Thai roofing business |

## 2. Assessment

**What Wabi does well**
- It is self-hosted by design: one process, no external database, first-boot owner setup, and honest operator documentation.
- **Command → event → projection** with a single writer. This is exactly the right shape for a business system that needs an audit trail.
- Realtime is designed in from the start: clients get a snapshot, then incremental events.
- It is disciplined about honesty: product claims must match what is actually shipped (AGENTS.md rules 11 and 13). Sabi adopts the same rule for tax-compliance claims.
- There is real Thailand-specific material: PromptPay EMVCo QR generation and earlier research on this exact business.

**What makes it a poor base to keep as-is for an ERP**
1. **The storage engine fights business data.** WabiDB records are postcard-encoded, with strict rules about field order and compatibility (AGENTS.md rule 5). Every entity needs a hand-written projection, WabiStore trait methods in two implementations, adapter methods and ts-rs types. That is about six layers per entity, and configurable fields do not fit it. The engine also says explicitly that it is *not* MVCC or serializable for read-modify-write. Accounting needs exactly that: gapless numbering, stock checks and allocation totals.
2. **The data format is opaque.** Data sits in encrypted custom segments that only Wabi can read. An ERP must let owners inspect and keep their records for 5–7 years (Thai retention rules) without needing any particular vendor's binary.
3. **Most of the surface area is off-mission.** Calls, games, Steam, effects, emotes, mesh and anchors, Lore and the Discord-like shell make up most of the code. Wabi's own AGENTS.md says the UI "accumulated code from many generations".
4. **The frontend cannot be salvaged as a base.** `tokens.css` defines tokens as references to themselves (for example, `--surface-app: var(--surface-app, …)`), and there are three layout systems plus 40k lines of CSS. Its layout contract is channels plus stubs plus right panels. That is the wrong mental model for business objects.
5. **Sandbox constraint (a real technical limit for this milestone).** This environment has no Rust toolchain, and `static.rust-lang.org` and `crates.io` are unreachable. Only npm, GitHub and PyPI are. The Rust Authority therefore cannot be compiled, tested or extended here. Writing ERP code in Rust that could not be compiled would break the "working software" requirement.

## 3. Decision summary

Sabi is a new application in `sabi/`. The Wabi tree stays in place so that later work can extract more from it, and so that Wabi's CI and build are not broken.

- **Runtime:** Node.js 22 LTS with the built-in `node:sqlite` and native TypeScript type-stripping. No build step on the server, no native addons and no ORM.
- **Storage:** one SQLite file. Every change goes into an append-only, **hash-chained event journal**, and projection tables are updated in the same transaction. This is Wabi's command → event → projection pattern on a boring, inspectable and archival-grade format. SQLite is a Library of Congress recommended storage format.
- **Realtime:** Server-Sent Events. Writes are named commands sent by POST, so push only needs to go one way.
- **Frontend:** a new SvelteKit + Svelte 5 static app. Wabi's stack is kept; its UI is not.

See `06-decisions.md` for the full ADRs, including the path back to the Rust Authority.

## 4. Reuse matrix

| Wabi system | Verdict | What Sabi does with it |
|---|---|---|
| Command → event → projection, single writer, snapshot/replay (WabiDB) | **Reuse the pattern, replace the engine** | `apps/server/src/journal.ts`: events are appended in the same SQLite transaction as projection updates. `sabi verify` replays the journal into a scratch database and compares the result |
| Audit projection (`projections/audit.rs`) | **Reuse the idea, strengthen it** | Every command is audited, not only RBAC and payments. The journal is hash-chained (`prev_hash` → `hash`) and SQLite triggers reject UPDATE and DELETE |
| Owner bootstrap (`setupRequired` gates on owner) | **Reuse directly (pattern)** | `/api/setup` is only available while no users exist |
| Revocable sessions (per-user `iat` floor) | **Modify** | Sabi uses opaque server-side session tokens (hashed at rest) in an HttpOnly cookie. Revoking a session is a row delete. No JWT secret to manage |
| Step-up for destructive operations | **Planned** | Voiding issued documents is restricted to certain roles and needs a reason. Re-authentication is on the roadmap |
| Roles as a fixed built-in catalog | **Modify** | Roles map to capability sets defined in the configuration pack, not hard-coded names |
| Channels / threads / messages | **Redesign** | Discussion is attached to the business object (`subject_type`, `subject_id`) instead of being a separate channel universe. The job, document or customer *is* the thread |
| Notifications | **Redesign** | A computed *Attention* inbox (my next actions, mentions, approvals, overdue items) plus SSE push |
| Uploads/blobs (content-addressed) | **Reuse the pattern** | `data/files/<sha256>`, with metadata in SQLite and attachment to any subject |
| Planner (Kanban, calendar, device-local) | **Discard** | Replaced by tasks on records and a job board grouped by workflow state. It was device-local and had no server sync |
| PromptPay EMVCo QR (`plugins/th-payments`) | **Extract** | Ported to typed code with tests in `packages/jurisdiction-th/src/promptpay.ts` and printed on invoices |
| Thai business research docs | **Reuse** | They feed into `03-research.md` |
| Docker / Caddy / backup runbooks | **Modify** | Sabi has a single-container Dockerfile, a compose file, and backup/restore through `VACUUM INTO` plus a JSONL journal export |
| Tauri shell | **Keep for later** | The web app is static and can be wrapped with the same Tauri config later |
| svelte-i18n setup | **Replace** | A small typed dictionary with English and Thai from day one. Configuration packs carry `{en, th}` labels |
| Design tokens / theme system | **Discard** | New token set (`apps/web/src/lib/styles/tokens.css`), light and dark |
| Calls/SFU/TURN, whiteboard, CAD review | **Keep in donor, integrate later** | CAD review (DXF) is relevant for roof layouts. Voice calls are not an ERP priority |
| Games, Steam, effects, emotes, mesh/anchor, Lore, Reader, crypto payments | **Discard for Sabi** | Off-mission |
| Legacy JS runtime plugins | **Discard** | The Rust server no longer hosts them |
| Odoo "verified operations" addon (archived) | **Discard** | Earlier reviews found it unsafe: client-supplied identity, a fake sha256, mutable audit arrays |

## 5. What stays out of scope in the donor tree

Nothing in the Wabi tree was deleted. Sabi does not import anything from `frontend/` or `core/`. Only the PromptPay algorithm and some patterns were ported. Deleting or moving the donor is a separate decision, recorded in `07-status-and-remaining.md`.
