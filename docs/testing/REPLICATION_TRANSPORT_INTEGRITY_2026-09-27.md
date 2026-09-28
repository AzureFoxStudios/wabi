# Replication transport integrity check — 2026-09-27

## Scope

This checks the experimental sender and a fenced WabiDB-only receiver in disposable local processes. It does not establish a complete standby, promotion permission, or a three-site result.

## Defect and change

The pull decoder treated already decoded 16-byte caller hashes as hex text. Those conversions failed and silently replaced the caller device and command hashes with zeroes. It also dropped malformed payload hashes. The decoder now preserves the binary caller hashes and rejects malformed stream/payload hashes, inconsistent event counts or idempotency metadata, and unordered or out-of-range commits. The current push worker does not use pull for catch-up, so this is a wire-path correctness fix rather than evidence of new receiver behavior.

Before sending a push, the sender now requires every referenced source stream and segment to exist as a regular file under the expected directory. Missing, symlinked, oversized, or short source segments stop preparation locally. A batch reads each unique segment once and checks every commit reference against those bytes, rather than rereading a segment for every commit in the batch. The fenced receiver continues to validate encrypted records and the commit prefix before accepting them.

## Verification

- `cargo test --locked -p wabi-server --lib replication_transport::tests`: five tests passed, including nonzero caller-hash preservation, malformed peer data rejection, missing/symlinked source segment refusal, and two commits sharing one segment.
- `cargo test --locked -p wabi-server --test db_replica_process_contract`: five tests passed with disposable processes. They cover receiver restart/catch-up, same-key divergent prefix rejection, skipped-commit rejection, encrypted stopped baseline plus verified upload catch-up, and resumed upload-byte transfer with wrong-byte rejection.

## Remaining boundary

The sender still ships whole segment bytes in buffered JSON. The receiver remains durably fenced and cannot serve Wabi clients. General sidecars and external state do not catch up, current upload copying is limited, and no safe promotion, automatic election, room ownership, physical partition test, or sustained capacity result has passed.
