# 05 — Implementation plan

## Repository layout

```
sabi/
├── packages/
│   ├── core/              @sabi/core            pure TS: types, workflow engine, formulas, totals, conversion, posting
│   ├── jurisdiction-th/   @sabi/jurisdiction-th Thai VAT/WHT/tax-invoice rules, tax-ID checksum, baht text, PromptPay QR, CoA
│   └── pack-sheet-metal/  @sabi/pack-sheet-metal business configuration + demo seed (the only business-specific code)
├── apps/
│   ├── server/            @sabi/server          node:http + node:sqlite; journal, projector, commands, queries, auth, SSE, files, CLI
│   └── web/               @sabi/web             SvelteKit (static) + Svelte 5
├── docs/                  this series
├── Dockerfile, compose.yaml
└── package.json           npm workspaces
```

Dependency direction: `web → core`, `server → core, jurisdiction-*, pack-*`, `jurisdiction-* → core (types)`, `pack-* → core (types)`. The core imports nothing else.

## Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | Audit, domain model, research, IA (docs 01–04) | ✅ docs written |
| M1 | `@sabi/core`: types, money, formula evaluator, totals, workflow evaluation, conversion, posting | unit tests pass |
| M2 | `@sabi/jurisdiction-th` + `@sabi/pack-sheet-metal` | unit tests pass (tax ID, VAT by date, WHT, PromptPay CRC, validation) |
| M3 | Server: SQLite schema, hash-chained journal, projector, commands, queries, auth/session, SSE, files, export/backup/verify | integration test drives the full workflow over HTTP |
| M4 | Web: shell, command palette, Attention, Jobs board + workspace, Document editor + print, Parties, Items, Money, Reports, Settings | built statically, served by the server |
| M5 | End-to-end: demo seed + scripted run + browser screenshots | workflow completes, reports reconcile |
| M6 | UX and architecture fixes from testing; status/remaining doc | `07-status-and-remaining.md` |

## Testing strategy
- `node --test` for packages and server (no test framework dependency).
- `apps/server/test/workflow.e2e.test.ts` boots a real server on a temp data dir and runs the full metal-sheet flow over HTTP. It then asserts stock, AR, VAT report, journal hash-chain validity and replay equivalence.
- Browser screenshots via headless Chromium when one is available, to check the UI visually.
