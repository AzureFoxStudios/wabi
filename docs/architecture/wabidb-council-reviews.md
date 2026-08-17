# WabiDB Council Reviews

> **Purpose:** Captures the outcomes of council-of-judgment reviews on the load-bearing WabiDB cards. Each review records the original design, the council's findings, the decisions taken, and the cards/actions that result.
>
> **Process:** Council reviews run on cards flagged as high-risk before implementation begins. Findings here propagate to the design docs and the kanban card bodies.
>
> **Reviewer model identity:** tracked per-entry (e.g. "Z.AI GLM 5.2", "Opus 4.8"). Reviews are independent — they get verified against the endstate doc and source code before any decision is final.

---

## Council Review #1: wabidb-05 (Per-Stream Encryption) + wabidb-15 (Commit Sequencer)

**Date:** 2026-06-19
**Reviewer:** Z.AI GLM 5.2 (Free)
**Source of design context:** `docs/proposals/wabidb-endstate.md` §2.2, §4.4, §6.9, §11.4
**Status:** Decisions logged, propagation to design doc and kanban cards pending verification

### Part 1: wabidb-05 findings

**1.1 Nonce uniqueness**
- AES-GCM catastrophic failure occurs on (key, nonce) reuse.
- Per-stream keys mean the safety requirement is: `commit_seq` strictly monotonic *within a single stream*. This is satisfied because the global sequencer assigns monotonic `commit_seq` and each stream receives a strictly increasing subset.
- **Key rotation trap:** if a stream's encryption key is rotated, the new key must not reuse `commit_seq` values the old key used. Safe as long as the global sequencer never resets.
- **Decision:** `StreamKeyRegistry` must enforce that a key is only used for a contiguous range of `commit_seq`s. On rotation, record `max_commit_seq` used by the old key. The sequencer must never encrypt a record with a `commit_seq` <= the key's `min_commit_seq`.

**1.2 Nonce construction**
- Current design: 8-byte u64 padded to 12 bytes.
- Wraps at 2^64 (~584 years at 1M commits/sec).
- **Recommendation:** use 96-bit internal counter. Reserve 1 byte for algorithm versioning.
- **Verdict:** u64 acceptable for v1; document wrap limit. Implement 96-bit if trivial.

**1.3 AAD (Authenticated Additional Data)**
- Current design: AAD is the `RecordHeader` (magic, version, kind, `commit_seq`, length).
- **Verdict:** Excellent. Binds metadata to ciphertext; prevents truncation, splicing, kind-altering attacks.
- **Action item:** `header_crc32c` must be computed over the header before encryption; GCM tag covers the header as passed to AES-GCM. `payload_crc32c` is redundant with the GCM tag — set to 0 during encryption, or exclude from AAD if computed post-decryption.

### Part 2: wabidb-15 findings

**2.1 Sequencer permit (concurrency)**
- `tokio::sync::Semaphore(1)` or capacity-1 mpsc as a mutex is correct.
- **Risk:** if the projection dispatch mpsc fills, the sequencer blocks. This is desired backpressure but can stall all writes.
- **Action item:** monitor the bounded mpsc capacity (~1024). When full, enter degraded mode (reject non-essential commands) rather than deadlock.

**2.2 Write atomicity & rollback (the load-bearing finding)**
- The endstate doc says: "If any step fails, the commit is rolled back: stream records written but not referenced by the commit index are orphans (ignored on recovery)."
- **Failure mode the design must handle:** sequencer assigns `commit_seq=100`, writes to stream A's segment (fsyncs), fails to write to stream B's segment (disk full). Rolls back. Bytes for seq 100 are physically in stream A's segment but not in the commit index. On recovery, segment reader finds a valid record with `commit_seq=100`, looks at the commit index, no entry.
- **Option A (WAL):** write an "Intent to Commit" record to the commit index first. On crash, recovery cleans up orphans and marks the intent aborted.
- **Option B (Segment Compaction):** allow orphaned records on disk. Recovery MUST skip them, never truncate. Physical truncation only in compaction (wabidb-42) or retention (wabidb-39).
- **Decision: Option B.** Simpler, aligns with log-structured storage, avoids WAL overhead. `wabidb-07` (segment reader) must treat orphans as no-ops, not errors.

**2.3 Fsync batching & durability latency**
- Commit index fsync'd in batches (10 entries or 50ms).
- **Risk:** if `run_command` returns `Ok` before the batch is fsync'd, a power failure within the 50ms window loses the message after the client was told it sent.
- **Action item:** `run_command` must not return `Ok` until the batch containing its `commit_seq` has been fsync'd. The sequencer must provide a `Future` that resolves on batch-fsync. If too slow, tune batch size — never lie to the client about durability.

**2.4 Interaction with wabidb-05 (encryption nonce)**
- A "burned" `commit_seq` (assigned but rolled back, never appeared in commit index) is safe for encryption: the burned seq is never used with that stream's key. In fact, burning sequences is the safest way to prevent nonce reuse.
- **Invariant:** the sequencer must never reuse a burned `commit_seq`.

### Required actions before coding

1. **wabidb-07 (Segment Reader):** handle orphaned records (skip, no panic, no truncate).
2. **wabidb-15 (Sequencer):** adopt Option B for rollback; commit index is the source of truth; burned `commit_seq`s are never reused.
3. **wabidb-15 (Sequencer):** `run_command` must await fsync of the batch containing its `commit_seq` before returning `Ok` to the client.
4. **wabidb-05 (Encryption):** document the 2^64 wrap limit, or implement a 96-bit nonce.
5. **wabidb-20 (Locks):** proceed with `SkipMap` and versioned-watermark approach. Defer memory-ceiling concerns to Phase 15 benchmarking (wabidb-95).

### Decisions linked to wabidb-20 open questions (Council Review #0)

These council decisions resolved the 3 open questions in the wabidb-20 design doc §8:

- **Q1 (Snapshot strategy):** Versioned-watermark reads off one growing `SkipMap`. arc-swap is rejected: cloning the entire materialized state on every commit is catastrophic for GC and memory at 5,000+ messages/min.
- **Q2 (Tombstone representation):** Separate `SkipMap<TombstoneKey, TombstoneValue>`. Keeps the hot read path branch-free, makes retention audit (wabidb-39) and compaction (wabidb-42) trivial.
- **Q3 (Memory ceiling):** Proceed with crossbeam-skiplist. Add a memory probe to the wabidb-95 benchmark suite. Fallback (if probe fails): unrolled linked list or sharded `BTreeMap` behind `RwLock`. Don't block Phase 2 on a hypothetical; measure.

### Verification status

- All findings cross-checked against `docs/proposals/wabidb-endstate.md` lines 2062 (async projection), 2081 (single-writer sequencer contract), 2395 (100 prekeys / top-up at 20), 2459 + 2618 (64 KiB max plaintext), 2588 (`rotated_from` in `StreamKeyRegistry`), 2941 (50k backlog load-shed), 3044 (Section 9.4 atomic UPDATE).
- **One card-number error in the council's submission:** "TOFU pinning (wabidb-70)" — in the current (renumbered) kanban, TOFU is wabidb-76. The council was working from the pre-renumber card set. Doesn't affect the substance.
- **One architectural claim that is a real gap:** the council noted the 64 KiB plaintext cap doesn't bound skipped message keys in Double Ratchet. This is a real gap in the endstate doc; flagged for wabidb-79 review.

### Propagation

- [x] wabidb-05 card body: add 96-bit nonce note (or document 2^64 wrap)
- [x] wabidb-07 card body: add "orphaned records skipped" acceptance criterion
- [x] wabidb-15 card body: add Option B rollback + burned-seq invariants + batch-fsync-await
- [x] wabidb-20 design doc §8: convert open questions to resolved (per Council Review #0)
- [ ] Future: wabidb-79 review will add skipped-key cache cap

### Implementation enforcement (2026-08-16)

The 2026-08-16 engine audit found that three of this review's invariants
were documented but not implemented — the sequencer reset `commit_seq` to 1
on every restart (violating §1.1 "the global sequencer never resets" and
§2.4 "never reuse a burned commit_seq", with the nonce-reuse consequences
§1.1 predicted), segments were not fsynced before the acknowledging index
fsync (§2.3's durability-await held for the index alone), and replay did
not skip orphans (§2.2's "Recovery MUST skip them"). All three are now
enforced in code: the sequencer is seeded at open from the recovered
high-water mark (segments — orphans included — commit index, snapshot
watermark), touched segment writers fsync before the index submit, and
`replay_projections` filters by the committed seq set. See
`docs/plans/2026-08-16-wabidb-restart-recovery-fix.md`.

---

## Council Review #2: wabidb-72 (10 Crash/Resume Tests)

**Date:** 2026-06-20
**Reviewer:** Hermes (Ronin-requested, pre-implementation review)
**Source of design context:** `docs/proposals/wabidb-endstate.md` §15.4 (Testing Strategy), §4 (Commit Infrastructure), §5 (Subscription)
**Status:** Test spec designed, awaiting Ronin approval

### Scope and intent

wabidb-72 is the "architecture validation gate" — the 10 tests in `core/crates/wabidb/tests/crash_resume.rs` must pass deterministically in <60s before any real-world deployment. Each test targets a specific invariant from the endstate doc §15.4 plus the Council Review #1 decisions (Option B rollback, burned-seq invariant, durability-await).

### Gaps in the existing card

1. The endstate doc enumerates 9 test **layers** (Layer 1 through Layer 9), not 10 specific tests. The 10 names on the card are a designer's selection of the most important crash scenarios — not a section of the doc.
2. The card names "outbox crash" but the endstate doc has no "outbox" component. This is a leftover term from the previous SQLite-based design (which had an outbox table for reliable client→server command delivery). In the new log-structured design, the equivalent is "commit index fsync in progress" — i.e., the test should be renamed or re-specified.
3. The card does not specify a crash-injection mechanism. We need to choose between: (a) `std::process::exit` from a debug hook in the sequencer, (b) a panic caught by a parent process, (c) actual `kill -9` from a parent test runner. The mechanism affects determinism.
4. Test 10 (snapshot required) depends on the helper-node protocol (wabidb-79 through wabidb-86) being implemented. As a Phase 11 card, wabidb-72 cannot be fully completed until Phase 13 lands. Two options: (a) split into Phase 11 (tests 1-9) + Phase 13 (test 10), (b) build a minimal helper stub for test 10.

### Recommended test spec

| # | Test name | Setup | Crash / action | Invariant verified | Maps to design doc section |
|---|---|---|---|---|---|
| 1 | `atomic_commit_happy_path` | fresh `/tmp` data dir | 100 commands committed and fsync'd cleanly | Every commit has exactly one commit-index entry; every durable event is replayable | §15.4 Layer 2 |
| 2 | `failure_rollback_option_b` | fresh data dir | Command writes event to stream A segment, fails before writing to stream B segment. Engine continues. | No commit-index entry created; orphan record in A's segment is skipped on subsequent read; commit-index is source of truth | §15.4 Layer 2, Council Review #1 §2.2 |
| 3 | `idempotency_replay` | fresh data dir | Same command, same `(caller, client_request_id)`, called twice | Second call returns cached result; no second commit-index entry; projection is unchanged | §15.4 Layer 2, invariant 5 |
| 4 | `snapshot_barrier` | 1000 prior commits | Client subscribes at seq=500, then commits 501-600 | Client receives 501-600 only, not 1-500 or 601+ | §15.4 Layer 3 |
| 5 | `resume_after_disconnect` | 1000 prior commits | Client receives 1-500, disconnects, 501-700 committed, reconnects with `resume_after=500` | Client receives 501-700 in order, no duplicates, no gaps | §15.4 Layer 3, invariant 4 |
| 6 | `acl_denial_at_subscribe` | User A is member of channel X, user B is not | B subscribes to X's messages topic | Subscribe denied with `Forbidden`; no events delivered to B | §15.4 Layer 3, invariant 6 |
| 7 | `membership_change_revalidation` | A subscribed to X, A is member of X | Admin removes A from X; new event committed to X | A's live subscription is revoked; new event is not delivered to A | §15.4 Layer 3, §15.4 invariant 6, wabidb-57 |
| 8 | `commit_index_fsync_crash` | 1000 prior commits | New commit: stream segments fsync'd, commit-index append in progress, process killed before index fsync | Engine restarts; no commit-index entry for the partial commit; orphan stream records are skipped (Option B); prior 1000 commits are intact | §15.4 Layer 6, Council Review #1 §2.2, §2.3 |
| 9 | `backup_and_restore` | 1000 prior commits | Manifest-based backup. Corrupt a stream segment on disk. Restore from backup. | Engine starts after restore; all 1000 commits recovered; projection rebuilds from surviving commit index; `wabidb check` reports `OK` | §15.4 Layer 6 |
| 10 | `snapshot_required` | 1000 commits, retention=100 events | Helper subscribes with `resume_after=900`; retention reaps events 1-900; helper attempts to resume | Server responds with `SnapshotRequired`; helper fetches snapshot; helper state is consistent | §15.4 Layer 4, invariant 4 |

### Crash injection mechanism

Recommended: **a debug hook in the sequencer that calls `std::process::exit(1)` at a configured point**. The test sets the hook to a specific step (e.g., "after stream fsync, before index fsync"), runs the commit, and the child process exits. The parent test runner waits for the child to die, then re-opens the engine. This is deterministic and fast.

Rejected:
- `kill -9` from parent: requires actual subprocess + IPC; not faster than the hook but harder to make deterministic.
- `panic!` in sequencer: doesn't simulate "process killed at fsync boundary" — a panic unwinds and runs destructors, which can mask bugs (e.g., a Drop impl that accidentally fsyncs).

The debug hook must be **compiled out of release builds** (e.g., `#[cfg(feature = "test-harness")]`).

### Open questions / dependencies

- **Test 7** requires wabidb-57 (membership change revalidation) to be implemented. This is a Phase 8 card. The test will fail until wabidb-57 lands.
- **Test 10** requires a helper stub. Either a minimal in-process helper (Phase 11), or wait for Phase 13. The minimal in-process helper is recommended so wabidb-72 can be the gate.
- **Test 8** is the highest-value test for the Option B decision. It directly exercises the "burned seq + orphan skip" invariant.

### Recommendation

Build wabidb-72 in two waves:
- **Wave A (Phase 11):** Tests 1-9. Excludes test 10. This is enough to validate the core architecture.
- **Wave B (Phase 13):** Add test 10 after the helper-node protocol is implemented.

If the user wants the full 10 in Phase 11, the minimal in-process helper stub for test 10 is a small additional card (estimate: 1-2 hours, not breaking the 60s budget).

### Propagation

- [x] wabidb-72 card body: add the 10-test spec table above, the crash-injection mechanism, and the wave-A/wave-B split recommendation
- [ ] Future: wabidb-99 power-loss test matrix (next deliverable in this batch)

---

## Council Review #4: wabidb-75, wabidb-78, wabidb-79 (Crypto — X3DH + Double Ratchet)

**Date:** 2026-06-19
**Reviewer:** Z.AI GLM 5.2 (Free) — second-pass crypto review
**Source of design context:** `docs/proposals/wabidb-endstate.md` §6.1, §6.2, §6.3
**Status:** Skipped key cap propagated; other findings documented for Ronin's call

### 1. wabidb-79 (Double Ratchet)

**1.1 Skipped key cache (CRITICAL gap, now fixed)**

- The endstate doc bounds plaintext size (64 KiB) but never bounds the *number* of cached skipped message keys.
- A malicious peer can send thousands of out-of-order messages; naive Double Ratchet caches a key per skipped message. DoS vector that exhausts memory.
- **Decision (propagated to endstate §6.3 and the wabidb-79 card):** `MAX_SKIPPED_KEYS = 1000` per session. When the cache is full, incoming messages that would exceed the cap are rejected with a clear error. The client must wait for the missing messages or open a new session.
- **Test required:** a test that sends 1,001 out-of-order messages and verifies the 1,001st is rejected.

**1.2 Where does the ratchet state live (architectural question, NOT yet propagated)**

- The endstate doc has Double Ratchet state in `core/crates/wabidb/src/crypto/double_ratchet.rs`. The wabidb crate is the server-side engine.
- The council's proposed end state keeps Double Ratchet state client-side and stores only ciphertext plus wrapped keys. That behavior is not implemented in current DMs, so the wabidb-79 card remains a client-side security task rather than a current guarantee.
- **Conflict:** the wabidb crate is used by the Tauri desktop client as a shared library. The Double Ratchet implementation may legitimately live in `core/crates/wabidb/src/crypto/` and be linked from the frontend. If so, the council's argument is wrong about WHERE the code lives (it's still in the wabidb crate, but used by clients, not the server).
- **NOT auto-propagated.** Flagged for Ronin to decide. Three options:
  1. Keep the file path as-is (Double Ratchet is a shared library used by the client; the wabidb crate is a shared library, not a server-only crate).
  2. Move the file path to the frontend TypeScript (the client maintains ratchet state in TS; the WabiDB engine has no ratchet code).
  3. Keep the file in the wabidb crate but split: `core/crates/wabidb/src/crypto/double_ratchet.rs` is `pub` for client use, but the wabi-server binary doesn't depend on it.

### 2. wabidb-78 (X3DH)

**2.1 Atomic consume-and-return for prekeys**

- Race condition: two peers can fetch the same prekey #42 simultaneously. The atomic UPDATE pattern in `wabidb-84` ensures only one consumption succeeds. The loser's pre-X3DH computation is wasted.
- **Decision (propagated to the wabidb-78 card):** the `consume_one_time_prekey` command must return the prekey public bytes AND mark it consumed atomically (a single command, not a fetch-then-consume pair). The client must not compute the X3DH handshake until the consumption succeeds.

**2.2 Signed prekey signature verification**

- The endstate doc says signature verification happens in the client. The wabidb-78 acceptance criteria must include a test that verifies a handshake with an invalid signature is rejected.
- **Decision (propagated to the wabidb-78 card):** the X3DH implementation MUST hard-fail on signature verification failure. A test must verify this.

### 3. wabidb-75 (Identity / Prekeys)

**3.1 Prekey pool top-up notification**

- The endstate doc says the server tops up the pool when it drops below 20. The server only stores public keys, so the server cannot generate new private keys — the client does.
- **Decision (propagated to the wabidb-75 card):** the server tracks the count of remaining prekeys. When it drops below 20, the server emits a notification on the device's `user:{id}:device:{device_id}:prekey_pool` topic. The client receives the notification, generates new keypairs, and uploads via `upload_one_time_prekeys`.

**3.2 Prekey cleanup on device revocation**

- A revoked device's unused one-time prekeys become orphaned. A peer fetching an orphaned prekey would compute a shared secret the revoked device can't decrypt.
- **Decision (propagated to the wabidb-75 card):** when a device is revoked, the server MUST delete all of its unused one-time prekeys. The `consume_one_time_prekey` command must check that the device is still active before returning the key.

### Propagation

- [x] endstate doc §6.3: add `MAX_SKIPPED_KEYS = 1000` cap
- [x] wabidb-79 card body: add the cap requirement + test
- [ ] wabidb-79 card: re-scope decision deferred to Ronin (see 1.2 above)
- [x] wabidb-78 card body: add atomic consume-and-return + signature verification test
- [x] wabidb-75 card body: add prekey top-up notification + device revocation cleanup

### Open question for Ronin

**Where does Double Ratchet state live?** See 1.2 above. The council's argument that wabidb-79 should be a client-only task is partially right (the server doesn't store ratchet state) but doesn't necessarily mean the code lives in TypeScript. If the wabidb crate is shared between the Tauri client and the wabi-server, the Rust implementation is fine. If the wabidb crate is server-only, the Rust file is wrong.

Decision options:
- **Option A (shared library):** keep `core/crates/wabidb/src/crypto/double_ratchet.rs` as a `pub` module used by both the wabi-server (for storage) and the Tauri client (for ratchet state). My recommendation.
- **Option B (frontend-only):** move to `frontend/src/lib/crypto/double_ratchet.ts`. The wabidb crate has no ratchet code; the WabiDB engine just stores the wrapped keys.
- **Option C (split):** keep the file in wabidb for shared use, but the wabi-server binary doesn't depend on it.

Recommend Option A. The Rust implementation can be compiled to WASM for the browser client; the Tauri desktop client can use it directly.
