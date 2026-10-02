# Local encrypted recovery RPC acceptance

**Recorded:** 2026-10-01. **Result:** 39 checks passed; terminal exit zero.
This is an isolated experimental coordination crate. It is not wired to the
Authority, does not recover Wabi application state and grants no writer permit.

## Executed scope

```sh
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline --locked \
  -p wabi-consensus -- --test-threads=1
```

| Group | Passed | Scope |
|---|---:|---|
| Library | 14 | Original command model plus authenticated Noise channels, actual RPC handlers, identity/key checks, bounds, shared outbound cancellation/deadline budgets and shutdown |
| Encrypted TCP/process | 10 | Actual TCP voters, each voter return/full restart, minority refusal/heal, purged snapshot catch-up, separate-process SIGKILL/reopen, exact original-command proof, private bootstrap/configuration and timing bounds |
| Durable storage | 12 | Original storage contracts including 35 upstream subcontracts, cancellation, process-kill durability and snapshot consistency |
| In-process voters | 3 | Original three actual Raft scenarios |

Three ignored child entry points are explicitly invoked by the passing parent
contracts. No ordinary contract was skipped. The first compile refused an
ambiguous task result; an explicit `JoinSet<Result<()>>` corrected the type.
No authentication, identity, resource or writer guard was removed.

The command fingerprint golden now runs in Rust and agrees with the previously
accepted Python golden. A subsequent
[actual Rust/Python interface run](geographic-2026-10-01/rust-python-control-codec-contract.json)
also passed with the same frozen executable and stable helper sources: three
real locally supervised workers, strict kernel peer identity and real reply
decoding, exact accepted receipt convergence, changed-content refusal and
original-receipt readback after a follower SIGKILL/restart. Private-key and store
lock inodes were preserved. All three real supervisor receipts report stopped
children and complete cleanup; no thread/node root/parent stage remained. The
runner was removed after its compressed source matched. These are local
fixtures, not a physical WAN or Wabi recovery claim.

The later [physical coordination trial](PHYSICAL_ENCRYPTED_RECOVERY_RPC_2026-10-01.md)
also passed across dotRonin, Ronin and Iyoku: four exact durable operations,
each owned worker killed/reaped/restarted, two surviving voters accepting the
next operation, complete receipt/state convergence on return, original key and
store-lock inodes preserved and complete fixture cleanup. This advances the
physical metadata-coordination slice; it does not change this local run's
count or prove whole-host loss, Wabi writer activation or application recovery.
A further physical owned-proxy trial passes minority no-ACK/heal and actual
snapshot installation after prefix purge, with 32 exact accepted metadata
operations, second restart and complete cleanup. It uses the same frozen Rust
artifact and unchanged helper/request/lifetime limits. These separate fixtures
do not add to the local count or constitute Wabi application recovery.

## Dependencies and provenance

Only Snow **0.10.0** was added. All 637 preceding package names, versions,
sources and checksums were preserved. The root manifest was unchanged. Exact
source, artifact and lock digests and five compressed logs are in
[the receipt](geographic-2026-10-01/encrypted-rpc-contracts.json).

Snow's downloaded manifest, builder, RNG resolver and build script were checked.
The selected protocol is fixed KK/25519/ChaChaPoly/SHA256. OS randomness is
explicitly selected. Its `std` feature also enables existing Ring and Blake2
dependencies; Ring resolver and Blake2 algorithm features were not selected.
That feature behavior is recorded rather than described as absent.

Cargo-audit 0.22.2 exited zero using the same pinned RustSec revision
`9b3a3b73a7f42606494c943e95f8196e9994df46`, without fetching or scanning yanked
versions. It found zero vulnerability-section matches and the same four
maintenance warnings and two terminal-client `lru` unsoundness warnings. No
Snow match was reported. This is a dated database comparison, not independent
cryptographic verification or a claim that every dependency is free of issues.

The frozen TCP test executable is 85,751,720 bytes, SHA-256
`52455067953e0d2d67f04dff308caca01cc2d4715a17f60828f6eee3a17dd3ec`.
It includes explicitly invoked fixture workers and private create-only key
bootstrap. It is not a deployed service or production enrollment CLI.

## Ownership, cleanup and remaining gates

The security owner explicitly serialized this dependency/build slot. It was
returned after the actual final process exited. No new target tree or physical
node/service was created. Passing fixture parents reap their known children
and close their roots. Five exact temporary files totaling 60,811 bytes were
removed only after compressed copies matched; shared build artifacts remain.
About 91 GiB was available at receipt creation.

The compiled module and direct integration test now replace the previously
unwired `tests/pending` source stage. Historical source-only receipts remain
historical evidence; they do not describe the current compilation status.

Next: whole-host and Wabi recovery/data-plane integration. The scoped physical
minority and metadata-snapshot trials are accepted; the small fixture workload
do not establish general WAN tuning. Dynamic
enrollment/revocation/rotation, complete Wabi state and tail/blob recovery,
canonical command/publication/nonce fencing, discovery, automatic Wabi recovery,
regional room ownership and capacity/privacy remain required.
`canonical_writer_permitted` is still false. No Wabi HA gate closes here.
