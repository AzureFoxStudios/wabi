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
| 343 | 3.5.2 | Channels move to the read model (table `channels`, schema 2, generation 2). Room placement skips its same-commit check for commits the read model already holds; rows an update creates get creation time 0 so replay is deterministic. Independent review: no blocker; its one should-fix test is in. |
| 344 | (fix) | Recovery-code crash test registered the same username twice (test bug, not a lockout); CI's `power-loss` job now also runs `cargo test -p wabidb --features test-harness --lib`. |
| 345 | 3.5.3 | Channel members move to the read model (tables `channel_members` with an indexed `user_id`, `channel_membership_versions`; generation 3). User deletion's membership cascade follows the read-model watermark (`Projection::apply_to_read_model`). Review: 225 snapshot/read-model restart pairs all match live; a full-table scan on every socket join was replaced by an index (8.9 ms to 12 µs at 50k memberships). |
| 346 | 2.7a | `zip` 2.4.2 to 9.1.3; removes the four zip advisories; tests for hostile uploaded archives added first. |
| 347 | (docs) | Removed descriptions of the membership repair PR 345 deleted; handoff update. |
| 349 | (fix) | A user deletion sets the membership revision of each channel it removes the user from (generation 4), so call rejoin and E2EE room checks notice. |
| 350 | (fix) | A user deletion is announced to the user's groups like a removal (both deletion paths: final disconnect and idle guest sweep), and the user is dropped from calls. |
| 351 | 2.7b | `rusqlite` 0.41.1 (bundled SQLite 3.54.1) for RUSTSEC-2026-0459; a test asserts the linked SQLite is at least 3.54.0. |
| 354 | (DM) | Server-side DM encryption boundary: `core/crates/wabi-server/tests/dm_encryption_contract.rs` (19 tests). Readable text is refused in conversations with experimental encryption enabled or pending on every path found: chat (all transports, edits), notes, forum, wiki, albums, gallery, incidents, whiteboard (REST and socket), bots, and uploads that are not the opaque encrypted shape. File refs beside an envelope must be registry-issued; reaction ids and envelopes are shape-checked. |
| 340 | 4.8g | `wabi-sync` state records whose folder it is (server + channel) and refuses a mismatch; `link` moves old state aside; mass-delete guard (`--allow-mass-delete`); refusals (400/403/413/422) remembered per file, 5xx retried; one sync per folder (OS lock). |

## Open PRs

| PR | Task | State | Next step |
|---|---|---|---|
| 348 | 3.5.4 | Users to the read model (schema 4, generation 5; case-folded login column with the Unicode version recorded; `secure_delete`; 729-pair restart matrix). Green; independent review done and fixed. **On hold:** CodeQL reports 5 new alerts (1 critical, 4 high) that no available tool can list; the visible one is a test fixture (`rust/hard-coded-cryptographic-value`, `auth_revocations.rs`). | Owner looks at the alert list on GitHub; if all are test fixtures or the intended `password_hash` storage, dismiss and merge. Trying to satisfy the scanner with generated test values made it worse (6 alerts); that attempt was reverted. |
| 353 | 2.7c | `p256` 0.14 / `ecdsa` 0.17: Wabi's own P-256 code leaves the affected `crypto-bigint`; golden tests for signatures and key files added first. Green. **On hold:** one CodeQL alert, a fixed key in a golden test (`community_roster.rs`), for the owner to dismiss. RUSTSEC-2026-0387 stays reported through `age` 0.12 (Wabi uses only its x25519 part). | Owner dismisses the alert; merge. |
| 355 | (DM) | Client: decrypted content does not go back to the server or to other hosts (`frontend/src/lib/privacy/`): no link previews, no remote media without a click, no audio/video/3D from a URL, no auto-translate, albums/forward/Lore/Blender off, report needs an explicit disclosure. Three review rounds; the coordinator re-ran the browser smoke and a 273-payload probe on the last head. | Merge on green CI. Owner runs the browser checklist in the PR. |
| (soon) | (DM) | Durable per-room encryption marker in WabiDB so a missing or rolled-back `e2ee_state.json` cannot reopen readable sends; the server sets `encrypted` itself; `#EXTM3U` uploads refused (session `session_012VCxQLQKEp9pfEBxcSnvNc`, branch `claude/encryption-durable-room-marker`). | Independent review, then merge. |
| 329 | 4.8b | Green. **On hold.** | Needs the owner's result for `q1` from the real-`lore` checks (does a review-branch upload leave the mainline's files alone). If yes: merge `main` in, re-check CI, merge. If no: do Task 4.9 first. |

## Remaining tasks, in order

1. **Owner:** run the real-`lore` checks on a machine with `lore` (paste block at the top of `docs/testing/LORE_REAL_BINARY_CHECKS.md`). Unblocks 329 and 4.9.
2. **4.9** (prompt in the prompts file once 329 merges; it is on 329's branch). A failed upload must not leave bytes in the shared tree; store the mainline's name; put the tree back at startup. Add: a `PUT` or `DELETE` can answer 500 after the server already wrote or removed the file, so the client's view and the tree disagree. (The ignored-path 500 is fixed: 422 since 341.) Needs the real-`lore` answers.
3. **4.10** (prompt on 329's branch). Review uploads recorded and announced as commits; approval records nothing. Touches a durable record: AGENTS.md golden rule 5.
4. **4.11** Server-side repository identity: a repository deleted and recreated under the same channel looks the same to `wabi-sync` today (the mass-delete guard in 340 is the only defence). Give each repository an id the client can compare.
5. **3.5.5 to 3.5.n**: the remaining projections, one per PR, reusing the same schema, generation and startup rules (see 343 and 345 for cross-projection reads during replay and the replay-floor mutation test). Independent review at least for users (3.5.4) and anything an in-memory projection reads during apply.
6. **3.5 follow-up**: batch the startup rebuild and keep progress (ADR-0001 asked for it); move SQLite I/O off async tasks.
7. **Dependency upgrades** from Task 2.7: `zip` (346) and `rusqlite` (351) are done. Still to do: `p256`/`crypto-bigint` (RUSTSEC-2026-0387) (a RustCrypto major bump; `wabi-consensus` pins `p256`). **Owner decisions:** accept the six unmaintained notices with a written expiry or not; the `bans` wildcard rule for four in-workspace path dependencies.
8. **3.3** last: remove `projections/snapshot.json` once every projection is in SQLite.

Phase 5 is new features, not hardening; stop and ask the owner before starting it. The owner has asked for one: a game overlay, planned in `2026-11-13-game-overlay-plan.md` (nothing built; the owner is starting it from a desktop session on a real machine, because it cannot be verified in a cloud sandbox).

## DM encryption: known gaps after 354 and 355

- Registry loss or rollback reopens readable sends until the marker PR lands.
- Attachments in encrypted messages: the server's `FileAttachmentRecord` reads snake_case and the client sends camelCase `files[]`, so the list is dropped server-side. What recipients actually get has not been checked end to end.
- Upload completion re-check is not under the policy lock (init, enable, complete window).
- No media-src CSP; a blob: HLS playlist is followed by Chromium, so no inline player for decrypted audio/video may be added without refusing `#EXTM3U`.
- Client: a same-origin path such as `/api;x/image-proxy` passes the `/api/` check as written (it misses the proxy on a bare Authority). Strip `;params` before the check.
- Not started: key verification that does not depend on the server, and the choice of a published protocol. These need an owner decision and a design note first.
- After these land: one pass over docs and UI strings so they say exactly what is enforced.

## For a session on the owner's desktop

- This note, the overlay plan and `docs/testing/LORE_REAL_BINARY_CHECKS.md` are the shared state. Cloud sessions keep working on `core/crates/wabi-server/src/api/e2ee.rs`, the upload and message paths, `frontend/src/lib/privacy/`, `frontend/src/lib/components/message/` and `frontend/src/lib/e2ee*.ts`; avoid those files or expect conflicts.
- Overlay work belongs in `src-tauri/` and new frontend files. One PR per step of the plan's build order.

## Things nobody has verified

- Any of this against the real `lore` program (the checks above), in a browser, or on a real long-lived data directory.
- A real power cut (the crash tests kill the process).
- Windows for the server (the Windows CI job builds only the desktop shell, which does not include Lore).
- An install from nothing by a non-expert (blank machine to a running server with a friend invited). The owner's goal is that this is easy; nothing measures it yet.

## Notes for a model picking this up

- The SQLite read model (3.5) and anything touching startup, the sequencer floor or the snapshot is the hardest work left. Give it the strongest model available and always the independent review.
- Sync client and Lore tasks are well understood now; the contract test against the real router catches most mistakes.
- Keep messages to the owner short and plain: what changed, what it means for them, what is unverified.
