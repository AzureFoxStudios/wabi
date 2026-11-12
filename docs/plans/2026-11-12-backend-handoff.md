# Backend plan: handoff, 2026-11-12

Where the backend plan (`2026-11-06-backend-plan.md`, prompts in `2026-11-06-backend-plan-prompts.md`) stands, and how to finish it. Written for whoever picks it up next, person or model.

## Scope note from the owner (2026-11-12)

Wabi is not deployed. The only data directory is a test server the owner can wipe. So:

- Do not build or keep upgrade paths, compatibility checks or repairs whose only job is to carry data written by earlier pre-release builds. Say in the docs that such directories are not supported and should be wiped.
- Keep everything that protects data written by the current build going forward: crash safety, refusing rather than silently losing, honest error text, the durable-record versioning rule (AGENTS.md golden rule 5) for records written from now on.
- When a review finding only affects pre-release data, note it and move on.

## How the work is run

- One task per cloud session, one PR per task. The coordinating session starts each task session, reviews its PR, fixes small things on the branch itself as new commits, and merges.
- Every durability or sync change gets an **independent review** by a separate agent that writes scratch tests and tries to break it. Every risky PR so far has had a real finding in that review; do not skip it for SQLite, sync or startup code.
- Merge only when `test`, `build-server`, `features-full` and `power-loss` are green on the current head (plus `frontend-checks` when the frontend changed). Merge with the full head SHA. Read any failure by test name; excuse it only if it is red on `main` too or is a runner/network outage, and say so in one PR comment.
- Never skip or weaken a test to get green. Never rewrite history on a task branch; merge `main` in.
- Usage limits pause sessions for hours. A stalled session shows `status_bucket: failed` with "hit your limit"; send it a message to continue once the limit resets.

## Merged since 2026-11-11

| PR | Task | What |
|---|---|---|
| 328 | 3.4 | Message index keys use the message's own id; repair for old snapshots. |
| 330, 338 | (kit) | Real-`lore` checks, `docs/testing/LORE_REAL_BINARY_CHECKS.md`, `core/addons/lore/backend/tests/real_lore_binary.rs` (8 ignored checks). |
| 331 | 4.8c | `wabi-sync` keeps local work when an upload goes to review. |
| 332 | 4.2 | Lore revision cache: opt-in pruning (`WABI_LORE_REVCACHE_KEEP`, default keep all), hard links, removed on repo delete. |
| 333 | 4.8d | `wabi-sync` stops re-uploading files over 4 MiB every round. |
| 335 | 4.8e | `wabi-sync` reads the real server's camelCase; contract test against the real router (`core/crates/wabi-server/tests/wabi_sync_contract.rs`, in CI). |
| 336 | 4.8f | `wabi-sync` conflicts never overwrite either side; create-only uploads; refused uploads are per file; state saved after every step. |
| 337 | 4.3 | Lore Range downloads read from the confined handle; ETag hashed under the gate on a miss; stream stops if the file changes. |
| 339, 342 | (plan) | This handoff note; removed the unused clock-based reference code in the `payments-us` addon. |
| 341 | 4.7 | Lore health check runs the `lore` program; missing `lore`/`git` is 503, a bad import URL 400, a path `.wabiignore` excludes 422 (typed `wabi_lore::LoreError`). |
| 334 | 3.5.1 | Messages move to the SQLite read model (`projections/read-model.sqlite3`). A rebuild replays the log into the messages only; the other projections still load from `snapshot.json`. Refuses to start rather than lose messages when the log is incomplete; bounded write-ahead log. Data directories from before this PR are not supported: wipe them. |
| 340 | 4.8g | `wabi-sync` state records whose folder it is (server + channel) and refuses a mismatch; `link` moves old state aside; mass-delete guard (`--allow-mass-delete`); refusals (400/403/413/422) remembered per file, 5xx retried; one sync per folder (OS lock). |

## Open PRs

| PR | Task | State | Next step |
|---|---|---|---|
| 343 | 3.5.2 | Channels move to the read model. Independent review: no blocker; its one should-fix (a test that notices if the channels replay-floor skip is lost) is in, and checked by removing the skip. | Merge on green CI. Then 3.5.3 (channel_members). |
| 329 | 4.8b | Green. **On hold.** | Needs the owner's result for `q1` from the real-`lore` checks (does a review-branch upload leave the mainline's files alone). If yes: merge `main` in, re-check CI, merge. If no: do Task 4.9 first. |

## Remaining tasks, in order

1. **Owner:** run the real-`lore` checks on a machine with `lore` (paste block at the top of `docs/testing/LORE_REAL_BINARY_CHECKS.md`). Unblocks 329 and 4.9.
2. **4.9** (prompt in the prompts file once 329 merges; it is on 329's branch). A failed upload must not leave bytes in the shared tree; store the mainline's name; put the tree back at startup. Add: a `PUT` or `DELETE` can answer 500 after the server already wrote or removed the file, so the client's view and the tree disagree. (The ignored-path 500 is fixed: 422 since 341.) Needs the real-`lore` answers.
3. **4.10** (prompt on 329's branch). Review uploads recorded and announced as commits; approval records nothing. Touches a durable record: AGENTS.md golden rule 5.
4. **4.11** Server-side repository identity: a repository deleted and recreated under the same channel looks the same to `wabi-sync` today (the mass-delete guard in 340 is the only defence). Give each repository an id the client can compare.
5. **3.5.3 to 3.5.n**: channel_members, users, then the rest, one per PR, reusing 334's schema, generation and startup rules. Independent review for the first three.
6. **3.5 follow-up**: batch the startup rebuild and keep progress (ADR-0001 asked for it); move SQLite I/O off async tasks.
7. **Dependency upgrades** from Task 2.7: `zip` 2 to 9, `p256`/`crypto-bigint`, the unmaintained notices. Prompts still to write.
8. **3.3** last: remove `projections/snapshot.json` once every projection is in SQLite.

Phase 5 is new features, not hardening; stop and ask the owner before starting it.

## Things nobody has verified

- Any of this against the real `lore` program (the checks above), in a browser, or on a real long-lived data directory.
- A real power cut (the crash tests kill the process).
- Windows for the server (the Windows CI job builds only the desktop shell, which does not include Lore).

## Notes for a model picking this up

- The SQLite read model (3.5) and anything touching startup, the sequencer floor or the snapshot is the hardest work left. Give it the strongest model available and always the independent review.
- Sync client and Lore tasks are well understood now; the contract test against the real router catches most mistakes.
- Keep messages to the owner short and plain: what changed, what it means for them, what is unverified.
