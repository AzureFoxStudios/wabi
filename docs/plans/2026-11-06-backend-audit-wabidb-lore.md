# Wabi backend audit: WabiDB and Lore (read-only, 2026-11-06)

Branch audited: `main` at d995087 (checked out as `claude/awesome-galileo-0c55cb`, no changes made).
Method: five parallel source reviews (WabiDB durability, WabiDB data model/crypto, WabiDB replication/subscription, Lore server API, Lore addon crate) plus one terrain survey for the localhost-sharing idea. Every High finding below was re-read in the source by me before being listed. "Confirmed" means read in code; "suspected" means the mechanism is clear but the exact trigger was not exercised.

Evidence runs performed in this container (pinned Rust 1.93.1):

| Run | Result |
|---|---|
| `cargo test -p wabidb` | 1021 passed, 0 failed, 1 ignored |
| `cargo test -p wabidb --features test-harness ... power_loss -- --ignored` | 5 passed (these are process-exit injection, not lost-page-cache tests) |
| `cargo test -p wabi-lore` (addon crate) | 61 passed |
| `cargo test -p wabi-server --features wabi-lore --lib -- lore` | 28 passed |
| `cargo check -p wabi-server --features wabi-lore` | compiles (needed an empty `frontend/build` dir for the embed macro) |

---

## 1. Bottom line

**WabiDB's core write path is sound and carefully built. The engine around it is roughly one-third real, two-thirds scaffolding that looks finished but has no production caller.** The commit sequencer, per-stream segments, global commit index, advisory lock, and strict replay are genuinely good work and the 1021 tests back them. But the headline features that justified writing a custom engine instead of using SQLite (cryptographic deletion, key rotation, segment compaction, the subscription engine, the double ratchet, the operator CLI) are either unwired, in-memory only, or read the wrong on-disk layout. The data is also not actually encrypted at rest in practice, because the projection snapshot is plaintext JSON next to the encrypted segments.

**Lore is a well-defended integration with several real logic bugs**, two of which are cross-channel write and memory exhaustion issues reachable by ordinary members. It is also never compiled by CI.

**On the "pivot" question: do not rip WabiDB out, but stop treating it as a database product and treat it as what it is, an application-specific event log with in-memory read models.** Section 6 gives the reasoning and the alternative.

---

## 2. WabiDB: what is genuinely solid

- **Durability ordering is correct.** Every segment touched by a command is fsynced before the commit index entry is submitted; the index fsync is awaited before any caller is acknowledged (`core/crates/wabidb/src/sequencer/mod.rs:550-585`).
- **Advisory lock honors golden rule 9.** `try_acquire_process_lock` opens with `truncate(false)`, locks the existing inode, writes the PID only after winning, rejects symlinks, and no code path ever unlinks it (`engine/locks.rs:55-83`).
- **Replay is strict and refuses to lie.** It sorts by `(commit_seq, ordinal)`, requires every indexed post-snapshot event to decode, never resurrects orphaned segment records, and fails startup rather than silently dropping (`engine/replay.rs`).
- **Projection checkpoint uses the right atomic pattern** (temp, fsync, rename, directory fsync) under one write lock.
- **AES-GCM record framing** binds the header as AAD, nonce = `commit_seq`, and the sequencer rejects two events on one stream per command so the nonce cannot repeat within a commit.
- **Writer fencing is fail-closed.** Any fence marker, even half-written, refuses local commits on open; a replica cannot ingest unless fenced; nothing unfences.
- **Auth revocation and recovery-code projections** use JSON with `deny_unknown_fields`, size caps, and admission preflight that mirrors replay.
- **Replication is honestly default-off** and the docs hedge it correctly.

---

## 3. WabiDB findings

### High

**W1. A zero-filled or torn tail in the commit index makes the server non-starting. (Confirmed.)**
`commit_index/batcher.rs:470-496` `parse_widx_file` calls `CommitIndexEntry::decode(...)?` on every entry whose length field fits. A power loss during `flush_batch` can leave zero-filled bytes at the tail (common on ext4/XFS with delayed allocation). Zero bytes decode as `entry_len = 0`, `decode` returns `Corrupt("body too short")`, the error propagates through `read_all_entries` into `replay_projections` and `WabiDbEngine::open` fails. The segment reader handles exactly this case by breaking; the index reader does not. No CLI can truncate the index to the last valid entry. STORAGE_FORMAT §3.5 claims this truncation exists.

**W2. New `.widx` file is created without a directory fsync. (Confirmed.)**
`commit_index/batcher.rs:281-309` `open_widx` does `create_new` + header write + flush, no `fsync_dir`. The directory is first fsynced in `seal_file` after 10,000 entries or clean shutdown. Each restart opens a new file. Between creation and seal, a power loss can lose the directory entry while the file data was fsynced. Every acknowledged commit since restart then has no index entry and replay drops their segment records as orphans with only a `warn!`. `SegmentWriter::open` does the dir fsync, so this is an inconsistency. Latent on modern ext4/XFS where fsync of a new file usually journals the entry too, but not guaranteed and contrary to the project's own `storage/fsync.rs` rules.

**W3. Projection-handler failure or panic on a durable event is an unrecoverable crash loop with no repair tool. (Confirmed.)**
`engine/locks.rs:773-815`: handler error sets `apply_failed`, dispatcher returns, sequencer halts. On restart replay maps the same error to `Corrupt{"repair required before startup"}`. A panic poisons the application RwLock live and panics inside `open` on restart (no `catch_unwind`). The message points at repair tooling that does not exist (`cli/rebuild_indexes.rs` only counts records, and walks the wrong directory depth). The only recovery is restore from backup or hand-editing binary files. Fail-closed is the right policy; the missing half is an operator path.

**W4. "Cryptographic deletion", key destruction, tombstones, and compaction have no production caller; timed retention is a soft-delete that keeps plaintext-recoverable ciphertext forever. (Confirmed.)**
`retention/key_destruction.rs`, `retention/tombstone.rs` (in-memory HashMap), `retention/reaper.rs`, `retention/compaction.rs`: no callers outside tests. Actual retention (`wabi-server/src/main.rs:727-775`) appends a `message_deleted` event whose payload includes the full record including `content`. The original `message_created` ciphertext stays in the append-only segment. Even if key destruction ran, keys are deterministically re-derived from the bootstrap key on every start (`engine/mod.rs:600-612`), so destruction would not survive restart. `src/lib.rs:22-23` and STORAGE_FORMAT §89 describe a mechanism that is never written. This matters for the privacy wording (golden rule 13): "timed retention" currently means "hidden from the read model", not "gone".

**W5. The projection snapshot is plaintext JSON of every projection value, defeating at-rest encryption. (Confirmed.)**
`engine/locks.rs:583-650` serializes all indexes (message content, `password_hash`, token hashes, recovery-code digests) as hex-in-JSON to `projections/snapshot.json`, on open, on drop, and every 1000 commits. Anyone with filesystem read access or a `data/` backup has the full message history in the clear. Not documented anywhere.

**W6. `reaction_removed` is a durable no-op: reactions cannot be removed. (Confirmed.)**
`projections/noop.rs` registers `reaction_removed`, `member_joined`, `member_left`, `channel_renamed` as no-ops. `ReactionsProjection::apply` only handles `reaction_added` and only inserts. The adapter's `remove_reaction` (`adapter/mod.rs:1358-1384`) writes the event, which is persisted and then ignored. The un-react reappears on next read or restart. This is a user-visible product bug.

**W7. Message secondary indexes key `message_created` by `msg_<commit_seq>` while primary and time index use the UUID. (Confirmed.)**
`projections/messages.rs:804, 840`: `extract_keys` uses `format!("msg_{:x}", commit_seq)` for every `message_created`, but the primary row uses the adapter-stamped UUID. Edits and deletes land under the UUID key, so every message leaves a stale `msg_<seq>` entry with `is_deleted=false` that `compact` never evicts (unbounded growth of two indexes) and the author query path returns stale versions. The existing unit tests assert the `msg_<seq>` key, which is why the bug is invisible.

**W8. Postcard records are unversioned; `#[serde(default)]` does not give trailing-field compatibility under postcard; the try-new-then-old fallback silently zeroes fields. (Confirmed shape.)**
Only `MessageRecord` (V0 fallback), `UserRecord` (V1 fallback), and `ProjectTaskRecord` (magic prefix + JSON, the right pattern) have any version path. Unversioned postcard with no fallback: `ChannelMemberRecord`, `DmMessageRecord`, `DmRecipientRecord`, `DmIdentityRecord`, `Reaction`, `Emote`, `Webhook`, `UserLayout`, `WhiteboardDoc`, album/wiki/forum/incident/gallery records, all six `Lore*Record`s, all `Payment*Record`s. Adding, removing or reordering a field in any of these breaks replay of existing data, and per W3 that bricks startup. This is golden rule 5 with no safety net in the type system.

**W9. `wabidb-cli check/verify/status` walk the wrong on-disk layout and the wrong manifest schema. (Confirmed.)**
Engine layout is `streams/<kind>/<stream_id>/events/*.wseg` (`sequencer/mod.rs:44-63`). Every CLI command walks `streams/<stream_id>/events`, one level too shallow (`cli/check.rs:45-74` and siblings). On a real tree `check` finds no segments and returns `ok: true`, a false clean bill of health even if real segments are corrupt. `verify` deserializes a `ManifestSummary` shape the engine never writes, so it always fails with "invalid JSON". `cli/backup.rs` copies only two directory levels (never the segments or the index) and writes a success manifest; it is not wired to any binary. Operators currently have no working integrity or backup tool.

**W10. Replication push cannot move a segment larger than ~1.5 MiB; the sync loop then stalls forever. (Confirmed; experimental scope.)**
Sender ships whole `.wseg` files base64-in-JSON up to 128 MiB (`replication_transport.rs:33, 407-450, 641-678`). Receiver `wabi-db-replica-dev` keeps axum's default 2 MiB JSON body limit; the Authority's own `/api/sync/push` is capped at 2 MiB by middleware. Once a busy channel's segment passes ~1.5 MiB every batch gets 413, the loop logs and breaks, and the next tick restarts from the same position. Also: the transport targets `/api/v1/sync/*` but the Authority mounts `/api/sync/*`, so Authority-to-Authority sync is unreachable by path (safe by accident, undocumented).

**W11. Subscription bridge in `main.rs:888` exits silently on broadcast `Lagged`. (Confirmed; currently dead.)**
`while let Ok(delivery) = delivery_rx.recv().await` ends the task on the first lag error. Harmless today only because nothing in production calls `subscribe_stream`. The moment anyone wires it, push delivery dies permanently under load with no log. `websocket.rs:179-186` handles the same case correctly.

### Medium

**W12. AES-GCM nonce reuse after a torn segment record. (Confirmed logic.)** The sequencer reseeds `next_commit_seq` from complete records only. A crash mid-payload leaves a header with `commit_seq=N` and partial ciphertext; the reader breaks before recording it; `N` is reassigned and re-encrypted under the same per-stream key and nonce. Torn tails are never truncated at startup. Confidentiality impact (XOR of two plaintexts with a predictable JSON prefix), not durability.

**W13. Batcher death leaves `/health` green while every write fails.** Any `flush_batch` error ends the batcher task; `is_writer_running` only checks the sequencer, so readiness stays 200 and all commands return `InternalInvariantViolated`.

**W14. Whole commit index is re-read on every startup, checkpoint, replication tick, and replicated commit** (`engine/replay.rs:64-68`, `engine/mod.rs:369-373, 462-466, 710`). Never pruned. Startup time and memory grow with total history; replication is O(N²).

**W15. Periodic checkpoint serializes the whole projection as hex-JSON under the application write lock inside the dispatcher task**, every 1000 commits. Write latency stalls for the full snapshot duration. This is the mechanism that will make write stalls visible as the community grows.

**W16. `ProjectionState::insert` takes the outer write lock on every insert** (`locks.rs:231-237`), contradicting the "lock-free" module docs and serializing readers against the dispatcher.

**W17. Mid-file header corruption silently hides every later record in a 64 MiB segment** (treated as truncated tail), while a payload-CRC failure skips and continues. Inconsistent, undocumented.

**W18. `compact_segment` is dead code that would brick the server if wired**: it shifts offsets, and replay requires `StreamRef.offset == rec.offset`.

**W19. `clientMessageId` is never persisted; idempotency is in-memory only.** `adapter/mod.rs:517-531` generates a server UUID per call; `idempotency_key_hash` is written to the index but never read back. A socket retry after a lost ack produces a duplicate durable message. Golden rule 3 is a client-side rule the backend cannot help enforce.

**W20. Homegrown Double Ratchet / X3DH are dormant and deviate from Signal.** No caller outside `crypto/`. `decrypt` mutates ratchet state before authenticating the ciphertext; no previous-chain-length in the header; the two modules' `HandshakeResult` types are unrelated; key-bearing structs derive `Debug`/`Clone` with no zeroize. The shipped experimental encryption is client-side WebCrypto envelopes (`api/e2ee.rs`). `double_ratchet.rs:17-20` claims the Tauri client uses it; false.

**W21. Key rotation helpers (`rekey.rs`, `dm_rekey.rs`, `place_rekey.rs`) would make data unrecoverable after restart** because the registry is never persisted. Dormant landmine.

**W22. Replication token has no minimum length on the Authority side**, no mTLS, and anyone holding it can read the whole commit index plus a blake3 of the root key (an offline oracle for passphrase-derived keys). Documented as full-trust; fine for "experimental", not for anything more.

**W23. Messages-by-time index grows one entry per edit forever; `channel_deleted` leaves all its messages in every index.**

**W24. `CommitIndexEntry::decode` can panic on a CRC-valid but inconsistent entry** (`record.rs:244-262`, no bounds check on `event_ref_count`). The `fuzz/` module is four fixed inputs, not a fuzz target.

### Scaffolding with no production caller (flag before someone builds on it)

`replication/{failover,snapshot_shipping,rate_limit,observability,anti_entropy}`, `SyncWorker`, `ReplicaStateMachine`, all of `subscription/` (no ACL, no dedup, unbounded), all of `ephemeral/` (single unscoped broadcast, fake persistence), `protocol/` (plaintext wire format), `auth/` token tables, ticket auth (`tkt_{user}_{device}_{micros}`, zero entropy), `commands/membership_revalidation.rs`, `retention/*`, `crypto/{double_ratchet,x3dh_*,rekey,dm_rekey,place_rekey,re_encrypt}`. `snapshot_shipping::ship_snapshot` records `success: true` without transmitting anything, a textbook golden-rule-11 trap.

### Documented claims the code does not back (WabiDB)

- STORAGE_FORMAT §2.4 / §3.5: recovery "truncates at the first invalid record" and corrupt index files are "truncated to the last valid entry and re-sealed". Neither exists.
- STORAGE_FORMAT §1/§4/§5: `.wsnap` magic and layout, blob `.meta` binary format, StreamRef sizes, AAD = 40 bytes (code binds 48). All differ from code.
- PERSISTENCE_MODEL §5-§7: manifest validation on open, `wabidb backup`, key registry persistence, cryptographic deletion. None true.
- `src/lib.rs` module doc: retention engine with key destruction and compaction. Not wired.
- `engine/locks.rs:19-22`: "lock-free, outer RwLock only for first insert". Write lock on every insert.
- `projections/noop.rs:9-10`: reaction removal "handled within other projections". It is not.
- `sequencer/mod.rs:160-165`: "≤1 fsync per window". True only for the index; each command still fsyncs every touched segment.
- `docs/architecture/overview.md:156`, SERVER_MESH_PLAN §68-77: `SyncWorker` and `/api/v1/sync/*` on the Authority.
- PROJECT_STATUS "crash harness passed": accurate for process-exit injection; no test ever loses the page cache, so fsync ordering is enforced by code review only.

What is accurate and careful: `docs/deployment/BACKUP_AND_RECOVERY.md` and the HA hedging in PROJECT_STATUS.

---

## 4. Lore findings

Context: "Lore" is Epic's binary version control, shelled out to as a CLI. Server feature `wabi-lore` wraps it; the addon crate `wabi-lore` owns the filesystem and git logic.

### What is solid

- **Descriptor-relative confinement** (`core/addons/lore/backend/src/confined_fs.rs`) is real: cap-std style `open_dir_nofollow` per component, `FollowSymlinks::No`, regular-file check, create_new temp + rename publish, rejection of `..`, absolute, NUL, control chars, backslash, leading `-`, reserved furniture, Windows device names, 1024-byte cap. Tests cover the parked-directory-to-symlink race.
- **Git bridge** (`git_remote.rs`): HTTPS-only, public-IP allowlist including CGNAT and v4-mapped v6, DNS pinned via reqwest `.resolve()` (rebinding-proof), redirects refused, env and config scrubbed, bounded output and deadlines, `--force-with-lease` keyed on an inspected ls-remote.
- **Token boundary**: `wblore_` connect tokens hashed at rest, exact scope parsing, re-checked after body and membership waits, no owner/admin exemption, all under contract tests.
- **Host operations** (scripts, editor, mirror export) require the live server owner with current-credential re-admission.
- **All Lore WabiDB writes go through the sequenced command path**; no golden-rule-8 bypass found.
- Downloads use private temp snapshots tied to the response stream; internal errors are masked.

### High

**L1. Cross-channel write via `POST /promote/from-message` with explicit `repo_channel_id`. (Confirmed.)**
`api/lore.rs:921` checks membership of the *message's* channel only. `repo_channel_id` from the body (lines 950-957) is never passed to `ensure_channel_member`; gates are only global caps `lore.stage`/`lore.commit`. The handler then runs branch create/switch and `upload_file` on that repo. `set_binding` does check the target channel (line 782), so this is an omission. A member with the Artist role in any channel can commit files into a private Lore channel they cannot read, probe path existence there, and in `mode:"direct"` switch its checked-out branch.

**L2. Unbounded in-memory buffering of raw upload bodies before any authorization. (Confirmed.)**
`upload_file` (`api/lore.rs:1830-1836`) and `upload_recording` (2000-2006) take `axum::body::Bytes`. These routes are exempted from the 2 MiB JSON budget (`app_router.rs:728-737`) and the only ceiling is the transport `max_body_size`, default 50 GiB (`app_router.rs:809-812`). The blob cap and the stage/membership checks run after the whole body is in RAM. Any authenticated account can OOM the Authority with one PUT. Even legitimate uploads hold up to the 1 GiB default blob cap in memory per request.

**L3. Promote-from-chat cannot succeed via the UI, and branch handling corrupts repo state. (Confirmed.)**
Binding paths must start with `/` (lines 773-778, and the modal forces it), but `sanitize_repo_path` rejects `RootDir`, so every binding-driven promote fails after all checks. `mode:"stage"` switches to a review branch and never switches back (1067-1082): all later uploads by everyone land on it. `mode:"direct"` switches back to hardcoded `"main"`, not the captured branch. Each step takes `io_gate` separately, so readers can observe the other branch mid-operation. The same leave-on-review-branch-on-error shape exists in `lib.rs:1223-1306` and `approve_review_branch`.

**L4. Any Artist can upload `.wabiignore`, which hides files from the manifest and makes `wabi-sync` delete them on every synced machine. (Confirmed.)**
`confined_fs.rs:17-23` reserves `.git`, `.lore`, `.mirror-cache`, `.wabi-repo.json` but not `.wabiignore`. `list_files` drops ignored paths; the manifest is `list_files`; `crates/wabi-sync/src/sync.rs:263-281` removes any clean local file missing from the manifest. A `.wabiignore` containing `*` makes every member's `wabi-sync watch` delete their clean local copies, and the ignore file itself is hidden from listings so victims cannot see why. `ignore.rs:8-9` says "not a security boundary"; the sync client turned it into one.

**L5. (Latent, feature currently cannot be enabled) Script runner executes member-authored code as the server user with no sandbox and the full server environment.** `script_runner.rs:147-154`: no `env_clear`, no uid drop, no rlimits, stdin inherited, working dir is the channel tree, scripts are ordinary repo files any Artist can upload. The owner is a confused deputy. Also the editor bridge runs `docker run ... --auth none` with the generated token never enforced, no container limits, and a `http://localhost:<port>` URL only usable on the host. Both are safe today only because `lib.rs:513-514` always constructs them with `enabled: false` and no config path can flip them. `docs/addons/lore.md` §11.2 "disabled by default" implies a switch that does not exist.

### Medium

**L6. Capability model is partly decorative.** `lore.view`, `lore.approve`, `lore.lock`, `lore.admin` are defined and editable but no handler checks them; locking uses `lore.stage`, approve/reject use `can_edit_lore`. Docs §11.2 and §14.2 describe channel-scoped tiers that do not exist.

**L7. `/recordings` bypasses role and size gates**: membership of the "Recordings" channel is the only check; no capability, no blob cap, user-chosen filename with subdirectories.

**L8. Revision cache (`<id>.revcache/`) copies the entire working tree on every snapshot commit, is never pruned, and survives `delete_repo`.** 5 GB channel × 50 snapshots = 250 GB. Contradicts the handler doc "remove every byte" and §14.3. Old bytes remain servable by revision hash after delete.

**L9. One global `io_gate` serializes all Lore I/O for all channels**, held across 120 s CLI calls, 60 s mirror clones, whole-file download copies, mirror exports, and a full-tree walk plus revcache copy on every commit. One slow mirror or one member scrubbing a 1 GB video stalls every Lore request on the server. Write handlers run under `instance_operations.spawn`, so the 30 s HTTP timeout does not cancel them.

**L10. Every download, including each `Range` request, copies and SHA-256s the whole file** before serving possibly a few KiB (`api/lore.rs:2228-2247`). Docs §8.2 claim an on-disk cache that was removed.

**L11. Commit message is passed verbatim as a CLI argument**; `message=--help` or any Lore global flag is parsed as a flag. `parse_revision_from_output` then returns an empty hash and the API reports a successful upload with revision `""`.

**L12. `import_from_git` deletes an existing on-disk working tree that has no live registration** (`lib.rs:2518-2523`), which is exactly the state a detached repo or a boot-skipped tree is in.

**L13. A mirror whose upstream contains any symlink bricks that channel after the first restart** (`validate_tree` recurses into `.mirror-cache`; rehydrate skips the repo; re-register fails the same way).

**L14. Mirror export cannot work against its documented backends**: the bridge is anonymous by design, GitHub/GitLab require auth, so every push ends in a misleading "destination changed" error. Configs are in-memory only; `branches`, `auto_mirror`, `mirror_on_push` are accepted and ignored.

**L15. "Fail clearly when dependencies are absent" is only partly honored**: embedded-mode `health_check` returns Ok without probing the binary, so the server logs "Lore addon initialized" with no `lore` installed and every operation is a 500. Missing `git`, bad import URL, and ignored-upload also collapse to 500.

**L16. Archive and import have no total disk cap** (100k files into a temp zip; 4 GiB per clone into `$TMPDIR`, repeatable by any Developer) under only the generic per-IP rate limit.

### Low

- Signed download URLs reuse the raw JWT secret as the HMAC key with no domain separation; verification is constant-time and membership is re-checked, as the code comment claims. A server-banned-but-active user keeps a link for up to an hour.
- `GET /repos/{id}` returns the absolute `working_tree` path and `lore_server_url` to any member. `/health` is unauthenticated.
- `list_branches` calls `ensure_writable` so it returns 500 on mirror repos; `file_diff` silently falls back to a working-tree diff with 200 when the revision diff fails.
- Connect tokens never expire (`exp: i64::MAX`); leaving a channel suspends them, rejoining silently restores them.
- In-cache `git ls-files/log/diff/status` calls are not isolated or bounded (no timeout, ambient config, unbounded output under the global gate).
- Git stderr is returned to the client on import failure, leaking bridge port and temp paths.
- Repos can be attached to any channel kind, including DMs.
- `Command::new(binary).current_dir(tree)` with a relative `lore_binary_path` containing a slash has unspecified resolution and could execute a member-uploaded file (suspected; depends on std).

### Process finding

**No CI workflow builds or tests the `wabi-lore` feature.** `ci.yml` runs `cargo test --workspace` and `cargo build -p wabi-server` with no features; no workflow passes `wabi-lore`, `addons`, or `full`. The addon crate's own 61 tests run as a workspace member, but the 3,552-line `api/lore.rs`, `lore_auth.rs`, `lore_roles.rs` and their 27 tests are never compiled by CI. They compile and pass today only because I ran them by hand. Similarly, the WabiDB power-loss harness is `#[ignore]` behind `test-harness` and no workflow runs it.

---

## 5. Severity-ordered action list (not done; for your decision)

**Fix before showing anyone (user-visible or data-safety):**
1. W6 reactions cannot be removed.
2. L1 cross-channel promote write; L2 unbounded upload buffering; L4 `.wabiignore` reserve-list gap.
3. W1 torn-index-tail tolerance (stop, don't error, at the first bad entry; add a zero-fill test). W2 `fsync_dir` after `open_widx`.
4. W5 decide what the snapshot is: encrypt it, or stop claiming at-rest encryption.
5. W9 fix or delete the CLI; a `check` that says OK on a tree it never read is worse than no tool.
6. Add `wabi-lore` to CI and run the power-loss harness in CI.

**Fix before calling it 1.0:**
7. W3 an operator repair path for "repair required" (truncate index to seq N / quarantine an event), plus `catch_unwind` around replay handler application.
8. W8 a uniform versioning pattern for every postcard record (the `ProjectTaskRecord` magic-prefix approach is already proven in-tree).
9. W7 message secondary-index keys. W23 index growth on edits.
10. W4 either wire real retention (and persist key destruction) or rewrite the retention/privacy wording to "soft delete".
11. W14/W15/W16 startup and checkpoint cost; W13 batcher liveness in health.
12. L3, L6, L7, L8, L9, L10, L11, L12, L13, L15.
13. Delete or quarantine the dead scaffolding list so nobody builds on `snapshot_shipping` or `subscription/`.
14. Docs: STORAGE_FORMAT, PERSISTENCE_MODEL, wabidb module docs, `docs/addons/lore.md` §8.2/§11.2/§14. Mark aspirational sections as such.

---

## 6. The strategic question: is WabiDB worth keeping?

### Correcting the premise

WabiDB is not based on SpacetimeDB. Wabi *used* SpacetimeDB as an external database until June 2026, then replaced it with WabiDB (`docs/architecture/PERSISTENCE_MODEL.md:4`, `docs/proposals/wabidb-endstate.md §1`). The stated reasons were SpacetimeDB's BSL 1.1 licence, its WASM module runtime and SQL engine that Wabi did not need, no retention or per-stream encryption model, and an append-forever commitlog. Those reasons were about *fit*, not about SpacetimeDB being behind other databases. A current web check still shows SpacetimeDB on BSL 1.1 converting to AGPL after a delay, with a 2.2.0 series in 2026 ([clockworklabs/SpacetimeDB README](https://www.Github.com/clockworklabs/SpacetimeDB), [licence text](https://git.adamlamers.com/PublicArchive/SpacetimeDB/src/branch/master/LICENSE.txt)). I could not confirm from primary sources whether any relicensing happened; the original licence objection likely still stands.

### What WabiDB actually is today

Strip away the unwired modules and you have:

- an append-only, per-stream, AES-GCM encrypted event log with a global ordered index and fsync-correct writes;
- a single-writer sequencer with group commit;
- 52 projections that are **entirely in-memory** (`HashMap<String, SkipMap<Vec<u8>, Vec<u8>>>`), rebuilt from a plaintext JSON checkpoint plus replay;
- a hand-written adapter of 4,258 lines implementing a 203-method `WabiStore` trait, with 92 server files also importing `wabidb` types directly.

That is an **application-specific event store with in-RAM read models**. It is not a database in the sense of "a component that handles queries, memory management, and storage growth for you". Every read model must fit in RAM, every checkpoint rewrites the whole state, startup re-reads the whole commit index, and every new query shape is new Rust code in a projection.

### What it buys you, honestly

- **No external dependency, single binary, one data directory.** Real and valuable for a self-hosted product aimed at small communities.
- **An ordered event log** that could feed replication, audit, and offline sync. The log part works.
- **Per-stream encryption at rest.** Undermined today by W5, fixable.
- **Full control of the format.** Also means full responsibility for every tool (W9) and every migration (W8).

### What it costs you

- **You are the only user of this engine.** Every bug in W1-W24 is one only you will ever find and fix. SQLite has had decades of adversarial users on exactly the torn-write, directory-fsync, and corruption-recovery problems found above.
- **The "database" features that justified it over SQLite are mostly not there.** Cryptographic deletion, key rotation, compaction, subscriptions with ACLs, resumable cursors: all scaffolding. What exists is roughly what a well-structured SQLite schema plus an `events` table would give you, with less tooling.
- **In-memory read models cap the deployment.** A community with a few years of history on a small VPS will hit RAM and checkpoint-stall limits (W14, W15) before it hits any CPU limit.
- **Schema evolution is the biggest latent risk.** With unversioned postcard records and strict replay, the next field you add to `ChannelMemberRecord` can brick every existing install's startup (W3 + W8). This is the single most likely way a public release hurts real users.

### My recommendation

**Keep the log. Stop pretending the rest is a database. Decide deliberately between two honest shapes:**

**Option A: Keep WabiDB, shrink it to what works, and harden that.**
Delete or quarantine the dead modules (they are a liability, not an asset, because they look finished). Version every record. Fix W1/W2/W5/W6/W7/W9. Make the in-memory model an explicit, documented design limit ("your community's read model fits in RAM; here is the number") and give it a real checkpoint strategy. Build a small, correct operator CLI. This is weeks of focused work, not months, and the resulting engine is defensible: "a purpose-built encrypted event log with in-memory projections, for one community per server."

**Option B: Keep the event log format, put SQLite under the projections.**
Keep the sequencer, segments, commit index, encryption and replay exactly as they are. Replace the `ProjectionState` skip-maps with SQLite tables written by the same projection handlers (one transaction per commit, `applied_commit_seq` stored in a table). You get: read models that do not need to fit in RAM, no whole-state checkpoint stalls, crash-safe incremental checkpoints for free, real indexes, ad-hoc queries for debugging, and `sqlite3` as the operator tool. The `WabiStore` trait is the seam; the 203 methods become SQL instead of skip-map scans. The at-rest-encryption story also gets *cleaner*: the SQLite file is the derived cache and can be encrypted or simply rebuilt from the log. This is the pivot I would make if I had no deadline, because it removes the hardest class of problems (W3, W5, W8, W14, W15, W16, W23) without throwing away the part that is good.

**What I would not do:** rip out the event log for plain Postgres/SQLite rows. The ordered, encrypted, per-stream log is the part that is both working and differentiating, and the frontend's optimistic-ID reconciliation and the planned offline/replication work want an ordered log underneath.

**What I would not do either:** go back to SpacetimeDB. The licence and the WASM-module model are the same mismatch they were in June.

### Is Lore worth keeping?

Yes, as an optional addon, with caveats. The confinement and git-bridge work is above average and the integration is genuinely useful for a CAD/3D-asset community. But: it depends on an external binary that is not bundled, CI never compiles the server half, the promote-from-chat flow does not work, mirror export cannot authenticate, and the host-operation features (scripts, code-server) cannot be enabled and should probably be deleted rather than finished, because they are a remote-code-execution surface by design. Keep the repository/file/history/lock/token core; cut the script runner, editor bridge, and mirror-export until there is a real design for them.

---

## 7. The "test my localhost app through Wabi" idea

Terrain (nothing exists today; no proposal found):

- **Tailcat** (`core/addons/tailcat`, `src-tauri/src/tailcat*.rs`) is the natural foundation: token-dialed WireGuard pipes over DERP with no inbound port, per-device keys tied to Wabi accounts, an audit log, a tested hyper reverse proxy with WebSocket upgrade handling (dev servers need HMR WebSockets), and the Tauri shell already supervises the `tailcat` sidecar. Today it only goes member → home server. The feature is "reverse the direction": the sharer's desktop runs a pipe listener in front of a forwarder to `localhost:3000`, and the Authority hands out scoped grants.
- **WebRTC data channels** (`frontend/src/lib/p2pFileTransfer.ts`, `turnConfig`) are the browser-only alternative: Authority-brokered signalling and admission, bytes P2P or via TURN, needs an HTTP-over-datachannel layer and still needs a native agent on the sharing side.
- `helper_api.rs`'s `SignedLocalRouteToken` (node, capability, resource, expiry, user) is a ready-made pattern for short-lived scoped grants.
- Anchor and relay-node are poor fits: each has a single fixed upstream and a documented role that a general forwarder would break.

Boundaries it must respect: transport grants reachability, never membership (Wabi auth decides who can view); helper nodes carrying share traffic must not become state authorities; previews must render on a separate isolated origin, never iframed into the Wabi origin with its cookies/tokens (`Caddyfile.tunnel` already sets `frame-ancestors 'none'`); a shared dev app must not be able to spoof Wabi identity headers (keep Tailcat's loopback-bind and in-process-secret pattern); sharing must be explicit, visible, and revocable. Session/grant records should live in the Authority or Tailcat's JSON store, not as new durable WabiDB records until W8 is solved.

Recommendation: a worthwhile differentiator for a developer-community product, but it is a new transport feature on top of Tailcat. Do it after the WabiDB decision in §6, not before.
