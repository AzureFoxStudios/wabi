# Wabi Local Dev Foundation Before Frontend Polish Plan

> **For Hermes:** Plan mode only. When executing, update/push `main` directly unless Ronin explicitly asks for a PR. Do not do PR ceremony.

**Goal:** Make Wabi easy to develop on any computer by first stabilizing local development, mock/offline frontend workflows, backend health, and verification gates; only after that resume frontend visual polish.

**Architecture:** Treat local dev as two lanes: real-stack dev (`bun run dev:local`, Rust backend + frontend) and frontend-only mock dev (`bun run dev:mock`, Vite + in-browser mock socket/state). The real stack must prove backend health and socket path; the mock stack must prove frontend screens can be worked on without SpacetimeDB/backend. Keep the mock mode additive and explicitly dev-only.

**Tech Stack:** Bun, SvelteKit/Vite, Rust `wabi-server`, Socket.IO client stores, browser `localStorage`, static build via `STATIC_BUILD=1 bun run build`.

---

## Current Context

Current repo path:

```text
/var/home/Ronin/wabi
```

Current branch:

```text
main
```

User direction:

- Work directly on `main` and push directly when done.
- Do not create PRs unless explicitly requested.
- Frontend prettying/polish comes last.
- First priority is making local dev and cross-computer workflow reliable.

Already pushed to `main`:

- `35746ce feat: polish DM surfaces and fix dev runtime`
  - DM visual polish baseline.
  - fixed `opus-recorder` runtime import.
  - cleaned malformed CSS fallbacks.
- `33e2b4f chore: repair local dev stack launcher`
  - `bun run dev:local` starts real Rust backend + frontend.
  - frontend HTTP 200 verified.
  - backend `/health` HTTP 200 verified.

Existing handoff doc:

```text
docs/local-mock-dev-handoff.md
```

---

## Priority Order

1. Clean current local state and finish the frontend-only mock dev mode.
2. Verify real local dev stack still works.
3. Make the setup portable to another computer.
4. Add repeatable smoke/check commands.
5. Investigate backend reducer/default-channel seed failure.
6. Only after local dev foundation is reliable, resume frontend polish.

---

## Phase 1: Finish Frontend-Only Mock Dev Mode

Done/verified in `docs/local-mock-dev-handoff.md` as of 2026-06-06.

Expected command:

```bash
bun run dev:mock
```

Done criteria:

- frontend serves HTTP 200 without backend/STDB.
- guest login reaches app shell.
- mock channels/users/messages appear.
- mock message send is accepted and not stuck sending.
- mock messages persist in `localStorage` key `wabi:local-mock:messages:v1`.

---

## Phase 2: Verify Real Local Dev Still Works

Done/verified in `docs/local-mock-dev-handoff.md` as of 2026-06-06.

Expected command:

```bash
bun run dev:local
```

Done criteria:

- frontend `http://127.0.0.1:5173/` returns HTTP 200.
- backend `http://127.0.0.1:3000/health` returns HTTP 200.
- backend health body contains `"service":"wabi-server"` and `"status":"ok"`.

Known follow-up:

```text
wabi_server::db: Reducer call failed: Failed to call reducer
```

This still appears around startup/default `general` channel seeding. It does not block frontend HTTP 200 or backend health HTTP 200. Treat it as a separate backend/STDB seed investigation.

---

## Phase 3: Make Cross-Computer Local Setup Easier

### Task 3.1: Add or update local dev documentation

**Objective:** Give future Ronin / other-computer setup a single clear entry point.

**Likely file:**

- Create or update: `docs/local-dev.md`

**Content required:**

- Prereqs:
  - Bun
  - Rust/Cargo
  - platform notes for Linux/Windows
- Commands:
  - `bun install`
  - `cd frontend && bun install` if frontend has separate deps workflow
  - `bun run dev:mock`
  - `bun run dev:local`
- What each mode means:
  - `dev:mock`: frontend only, no backend/STDB
  - `dev:local`: frontend + Rust backend
- Ports:
  - frontend `5173`
  - backend `3000`
- Health checks:
  - frontend root HTTP 200
  - backend `/health` HTTP 200
- Troubleshooting:
  - kill stale dev processes
  - clear mock localStorage key `wabi:local-mock:messages:v1`
  - known reducer seed warning

### Task 3.2: Add a smoke helper script if useful

**Objective:** Make checks repeatable without remembering curl commands.

**Potential file:**

- Create: `scripts/local-dev-smoke.sh`

**Suggested behavior:**

- checks `http://127.0.0.1:5173/`
- checks `http://127.0.0.1:3000/health` if backend is expected
- prints clear PASS/FAIL lines
- no dependencies beyond shell/curl

**Keep optional:** If this starts becoming too much, skip and just document commands.

---

## Phase 4: Investigate Real Backend Reducer Seed Failure

### Task 4.1: Reproduce and capture exact logs

**Objective:** Stop treating the reducer failure as vague noise.

**Command:**

```bash
cd /var/home/Ronin/wabi
bun run dev:local 2>&1 | tee /tmp/wabi-reducer-seed.log
```

Capture lines around:

```bash
grep -n -C 8 "Reducer call failed\|ingest_wabi_event\|default.*general\|channel.*general" /tmp/wabi-reducer-seed.log || true
```

### Task 4.2: Trace seed path

**Objective:** Identify where default channel seeding originates and why STDB rejects it.

Search for:

```text
ingest_wabi_event
general
default channel
channel_id
Reducer call failed
```

Use Hermes `search_files` instead of shell `rg` when operating through tools.

### Task 4.3: Fix only if root cause is clear

**Objective:** Avoid random STDB changes.

Possible root causes:

- payload shape mismatch
- timestamp type mismatch
- reducer expects a different operation/entity name
- default seed runs before STDB module is ready
- duplicate channel create not idempotent

**Verification after fix:**

```bash
cd /var/home/Ronin/wabi
bun run dev:local
curl -sS http://127.0.0.1:3000/health
```

Then verify no reducer failure appears during startup.

---

## Phase 5: Frontend Polish Comes Last

Only after local-dev foundation and backend seed issue are handled:

- resume visual frontend polish
- use `bun run dev:mock` for fast UI iteration where possible
- use `bun run dev:local` when backend/socket behavior matters
- continue to verify with:
  - `bun run check`
  - `STATIC_BUILD=1 bun run build`
  - runtime smoke in browser

Suggested frontend polish order later:

1. DM/sidebar state polish using mock DM data.
2. Connection/empty/loading states.
3. Settings/admin warning cleanup if it blocks confidence.
4. Artistic customization and theme polish.

---

## Non-Goals

Do not do these until foundation is done:

- major frontend visual redesign
- component fracture/refactor
- theme personalization work
- Tauri packaging changes
- PR creation/merge ceremony
- broad warning cleanup unrelated to local dev
