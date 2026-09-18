# Office workspace performance and resource checks

This page describes the follow-up to PR #236's first passing acceptance suite. It is not a claim that every original 36-scenario target or native-device scenario is complete. See the current PR checks and their exact commit identities for observed results.

## Implemented changes

The spreadsheet calculation pass constructs sheet/row/column indexes once per input snapshot. Cell evaluation no longer scans every row to resolve each cell identity. A new snapshot creates new indexes; inserting, deleting or reordering rows cannot accidentally reuse old positions. Missing references and calculation-budget failures become explicit cell diagnostics rather than unexplained blanks.

The sheet worker is lazy and owns at most one active job. Calculations may retain only one latest queued input; replaced queued calculations reject with `SpreadsheetSupersededError`. File operations are never silently superseded. Callers attempting another import/export while one is active receive an explicit busy error and must cancel first.

`close()` clears callback ownership and timers, terminates the worker and rejects pending work. Old-generation messages/errors cannot settle or terminate a replacement worker. No source ArrayBuffer is transferred/detached merely to start a file operation. The existing 30-second per-operation watchdog stays in place.

## Evidence produced by CI

`Office worker resource checks` uses the committed lockfile and real Chromium and Firefox workers. It does not use repository-write permissions, change source, merge or deploy. All test steps fail normally; artifact collection does not turn failures into success.

The suite covers:

- Lazy creation, bounded bursts, file-operation exclusivity, timeout/error/decode/clone failures, stale callbacks, idempotent close, and repeated create/use/close using deterministic worker tests.
- A deterministic axis-access regression which detects repeated row scanning without relying on machine speed.
- A synthetic 10,000-by-20 calculation input, cross-sheet totals, the unchanged single-range budget, conflicts, cycles, and reference behavior across reordered/removed rows.
- Real-browser calculations of 200,000 values; main-page animation advances while work is in the worker. A 500-request burst retains only the running input and latest input.
- Actual browser worker enumeration after cancellation and each of 25 post-warm-up create/use/close cycles. Both ownership counters and browser-reported worker counts must reach zero.
- Main-page JavaScript heap observations in Chromium after forced garbage collection, before and after the repeated cycles. These are recorded, not advertised as native-process memory or a proof that the entire app has no leaks.

The `office-worker-resource-evidence` artifact records source and tested integration SHAs, typecheck/model logs, browser results, timings, counts and observations. It is retained for 14 days. The original Office acceptance suite and Reader regression suite remain separate required evidence.

## Capacity: do not confuse a calculator fixture with a supported workbook

The 200,000-cell fixture exercises the calculation layer, not import, editing, local persistence, five-user collaboration or complete file round trips. The import ceiling remains **50,000 populated cells**, with existing row/column, byte-size, history and archive-expansion bounds unchanged. The single-formula range and overall calculation-operation budgets also remain unchanged.

Raising one parser constant would be insufficient. The current native representation retains per-cell version IDs, stable axis IDs and history; local and server serialized-size limits must also be met. Full 200,000-cell support requires an end-to-end fixture proving import, save/reopen, formula editing, synchronization and export within those limits. Do not describe the calculator benchmark as completion of that acceptance target.

## Dependency findings

As checked on 2026-09-18, the reviewed advisories for `image-size` still list no patched release:

- https://github.com/advisories/GHSA-w3rx-r6r6-pgpr
- https://github.com/advisories/GHSA-5p2g-fcmc-qvqq

The dependency installation audit remains non-clean. The complete Office bundle/worker inventory continues to reject shipping the affected Node parser; the Rust server does not execute the Node PPTX generator. This follow-up does not suppress audit findings, invent an unavailable version, or downgrade the presentation generator to make an audit appear clean. A change in dependency reachability or use with untrusted Node input requires reassessment.

## Still outside this focused pass

Full addon-host listener/subscription and memory-loop acceptance; real native webview/device tests; the full larger-file and five-independent-account matrix; and chat/call coexistence under heavy workspace work remain separate work. Existing owner-reported hosting/calling acceptance is not revoked or replaced by this list. Music remains on hold.
