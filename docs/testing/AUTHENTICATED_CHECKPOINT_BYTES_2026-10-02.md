# Authenticated checkpoint byte candidate — October 2

Main Wabi, not ERP. This is a local experimental library candidate; normal
Authority startup does not automatically enable it. No new deployment, main
branch update, automatic recovery or writer permission is claimed.

## What changed

- Linux-only optional `MaterialService` compares its actual opened/locked
  store's community, partition and voter ID with the fixed Noise roster.
- Raft-only `serve` remains compatible and refuses material. Optional combined
  service and ciphertext-only service retain strict roster authentication; the
  latter refuses Raft operations.
- Complete 64 KiB objects, separate signed schema-2 manifests and fresh byte
  receipts can be transferred. Reads are limited to the exact indexed object
  in a signed, content-addressed manifest. Metadata retrieval alone does not
  certify byte availability.
- Remote replies deserialize into a strict untrusted wire type. An immutable
  authenticated-target acknowledgment is constructed only after every content,
  identity, position, count and readiness field matches the exact request.
  Local receipts remain private and Serialize-only.
- Blocking work retains its store and admission after caller cancellation.
  Serving shutdown drains admitted work. Started synchronous I/O cannot be
  forcibly stopped at a deadline; late work may leave immutable bytes, but
  an expired request never returns a successful acknowledgment.
- No dependency, durable ControlCommand, native WabiDB format, writer/nonce
  semantics, auth gate or frontend change was introduced in this slice.

## Actual tests and preserved failures

| Run | Actual result | Scope |
|---|---|---|
| 65781 | 20 passed, 0 failed | Initial transport-only synthetic fixtures and existing Raft transport |
| 99493 | 73 passed, 0 failed, 5 ignored | Whole consensus package, earlier source2 |
| 28923 | 5 passed, **1 failed** | Test added orphan upload; safe Authority restart correctly refused missing registry |
| 47056 | 6 passed, 0 failed | Only fixture corrected to use real durable upload publisher |
| 99944 | Reported shell exit **143**, no test groups | Full compile interrupted by SIGTERM; signal source not verified; no descendants remained |
| 47619 | **2,673 passed, 0 failed, 15 ignored, 88 groups** | Fresh complete frozen workspace after interruption |

Counts are distinct scopes and are not additive. The failed fixture and
interrupted compile remain in exact gzip logs and JSON receipts. No production
guard was weakened. Full acceptance invokes subprocess entrypoints through
their parent checks; external two-computer/discovery fixtures remain unaccepted.

The actual producer test captures an encrypted archive with a registered
160 KiB upload, verifies its restored plaintext locally, and transfers more
than two ordered chunks over authenticated loopback sockets. It obtains fresh
receipts, retrieves a complete copy, stops one owned copy endpoint, removes
only that disposable copy's payload/manifest, restarts it with its same binding,
key and lock inode, and reseeds it from the surviving endpoint. A genuine
Authority reconstruction then preserves the community and lock inode. This
is not three physical sites, a host/process power-loss test, inactive-state
activation or committed byte-majority availability.

Wrong keys/roster, forged target/content/readiness replies, missing/corrupt
bytes and strict codecs refuse. A serving shutdown test waits for a canceled
caller's still-blocked worker before completing; its original lock inode is
preserved. Existing Raft loss, restart and snapshot tests also pass.

## Exact source and artifacts

- Execution: dotRonin, `/home/ironin/wabi`, branch
  `codex/security-boundary-hardening-20260930`, base
  `138abe39e08e400188d1812ed3bfd378df435315`.
- Before-launch source/build digest:
  `3fa45956c443881e1519631002aba7fdb17f0b6d194ea98334a4c3e2d7796635`.
  All 5,165 workspace inputs and 17 labeled preexisting uncompiled Tauri
  generated snippets remain unchanged. The extra snippets are not new inputs.
- Full log SHA256:
  `a07d724df612d6c38587ed6b5637ea997af22cdc3389273b762e3cbca5664a7c`.
- Exact 638-package lock remains
  `2c31a8723232abaffc228fd9801cd444997211e5b2530d994072a7f7cd4b522a`.
- Frontend index remains the later UI owner's bundle:
  `2fdbecedd4fbc2fcbc900cf0717a7070128cde4a76bb09d3c5e146f004a8fb2e`.
- 78 current test executables total 5,234,504,984 bytes; hashes retained.
  Related 28 Rust source files are archived as exact content, not just hashes.

[Full receipt](geographic-2026-10-02/byte-rpc-workspace-acceptance.json),
[final readback](geographic-2026-10-02/byte-rpc-final-readback.json),
[artifact inventory](geographic-2026-10-02/byte-rpc-workspace-artifacts.json).
Pinned Rust/Cargo 1.93.1, offline/locked, one build job, incremental disabled,
test debug info stripped; assertions and unwind behavior unchanged.

## Remaining gates

The earlier independent review accepted metadata source3; it does not cover
this new byte-RPC slice. Physical three-site transfer/reseed with exact artifacts
is still open. A subsequent [three-computer field trial](PHYSICAL_CHECKPOINT_BYTES_2026-10-02.md)
copied the actual encrypted capture to Ronin and Iyoku and rebuilt Ronin's lost
copy from Iyoku; its final restarted-listener check failed, all owned roots were
cleaned, and no complete physical acceptance is claimed. Committed operation/current-roster byte availability, tail/blob
delivery, independent inactive verification, complete enabled-instance inventory,
every publication/mutation fence and safe encryption allocation remain required
before activation. Automatic client recovery, regional room ownership/selective
fanout and measured capacity/privacy/operator gates remain open.

Allocation is **unknown**. Source role, payload encryption/replay, quorum,
full-instance readiness and canonical writer permission remain false. The
1024 ordered 64 KiB reference limit still caps one checkpoint at 64 MiB logical
ciphertext. Large instances require segmented manifests and incremental tails;
500k members remains an unmeasured sizing target.

Own raw logs are removed only after byte-for-byte gzip readback. No new target
tree or shared blanket clean; current artifacts and unrelated work are preserved.
Approximately 30 GiB remains free. Historical 35 GiB executable candidates need
exact obsolete-owner release before shared deletion. Lore revision9 contains
the prior progress note, not automatically synchronized source; its imported
Git pointer is stale on Tim. See [Lore receipt](geographic-2026-10-02/lore-publication.json).
