# Geographic checkpoint controls and bounded workload — 2026-09-30

**Result:** Selected local contracts pass. Main Wabi candidate, uncommitted and
not deployed. Full-instance recovery, automatic failover and regional room
ownership remain unproven.

## Source and scope

Execution computer: dotRonin. Checkout: `/home/ironin/wabi`. Base commit:
`138abe39e08e400188d1812ed3bfd378df435315`; shared branch at verification:
`codex/security-boundary-hardening-20260930`. Concurrent security and organizer
edits are present. Base HEAD alone does not identify the tested source.
Pinned Cargo/toolchain/dependencies were used; no arbitrary toolchain upgrade.
The configured `wabi-codex-test-20260930` stdio bridge verified `project_brief`,
read and claimed the geographic task in Codex test (`ch_c72`). Progress is on
card `task_1282d0135bc74301b99ed6a7c9713fd4`. Card ownership does not lock files.

## Executed checks

```sh
CARGO_INCREMENTAL=0 cargo test --offline --locked -p wabi-server \
  --test checkpoint_operator_contract --test live_checkpoint_archive_contract \
  --test instance_checkpoint_contract \
  --bin wabi-instance-snapshot --bin wabi-instance-inbox
node scripts/geographic-acceptance/room-load.test.mjs
node --check scripts/three-site-real-authority-smoke.mjs
```

| Contract | Passing Rust cases |
|---|---:|
| Inbox | 7 |
| Snapshot tool and archive compatibility | 36 |
| Operator checkpoint jobs | 3 |
| Coordinated boundary | 6 |
| Live encrypted archive | 4 |
| Total | 56 |

The Node harness has three passing cases. The
[machine receipt](geographic-2026-09-30/focused-tests.json) records command,
counts and final log digest. This is focused evidence, not the complete workspace
suite or an installed desktop test.

The full in-process application router checks actual socket-peer loopback and
operator-secret admission, disabled configuration, concurrent-job conflict and
status during a held application pause. Its owned job persists an encrypted
checkpoint after the initiating request completes; inactive restore reads the
acknowledged fixture user/message, rejects new writes and leaves source writes
usable. Reopening the journal retains the safe receipt; same-size ciphertext
damage refuses ready status. Drain timeout releases its job, interrupted
records become failed, and quota refusal allocates no extra disk record.

Snapshot checks bound bytes, entries, paths and deadline; bind an optional
trusted source digest; preserve owned-directory cleanup on failure/unwind; and
keep stopped V1/live V2 behavior. A real encrypted archive with the old three-path
V2 header restores inactive. New exports require the current five-path
exclusion declaration and omit secret-publication locks. Unknown exclusion
lists remain refused; persistent record layouts do not change.

Inbox checks use real loopback HTTP: authenticated transfer, known digest and
byte-ceiling refusal, interrupted request cleanup, one-upload admission,
headroom/quota refusal and publication collision preserving the existing file.
These do not simulate machine power loss or guarantee that unrelated writers
cannot consume disk after admission.

Development attempts found missing fixture upload directories, a nested route
slash mismatch and a concurrent header/exclusion mismatch. Those were repaired.
A missing macro qualification also stopped compilation before tests; the final
recorded command compiled and passed. No unsuccessful attempt is counted as a
pass.

## Bounded local workload

```sh
WABI_THREE_SITE_LOAD_OPTIONS='{"clients":6,"messages":20,"payloadBytes":512,"messagesPerSecond":2,"deadlineSeconds":90}' \
  node scripts/three-site-real-authority-smoke.mjs /absolute/path/to/wabi-server
```

The [local receipt](geographic-2026-09-30/local-load-receipt.json) passed with
six WebSocket clients through Authority/two Anchors, twenty acknowledged writes,
120/120 expected deliveries and zero duplicates or mismatched accepted IDs.
Achieved rate was 1.99 writes/second, acknowledgment p95 38.08 ms and delivery
p95 36.72 ms. All acknowledged IDs appeared in canonical history. This is a
bounded canary with two provided credentials, not six independent accounts or a
saturation benchmark. Its latency and envelope-byte metrics do not measure
media capacity or whole-uplink traffic. The older default-feature binary's exact
SHA is recorded; this run does not accept the new operator changes through an
external server process. Owned sockets/processes and disposable state were
closed by the parent finalizer.

## Disk and coordination

Under the exclusive Cargo artifact lock, 28 reviewed old generated integration
executables predating September 30 UTC were removed. Logical size was 11.56 GiB;
observed free disk increased from about 54 to 65 GiB. Source, runtime data and
normal server binaries were preserved. See the
[cleanup receipt](geographic-2026-09-30/cleanup-receipt.json). Subsequent shared
builds can consume space again; this receipt is not the final current free-space
measurement.

File ownership was coordinated with the security and organizer chats. Lore is
outside this connector's grants and no local `.wabi-sync.json` or
`.wabi-sync/state.json` baseline was found. The organizer chat owns the live
Lore/mirror audit; no Lore publication or revision is claimed here.

## Remaining gates

Three distinct current uplinks and SSH to Ronin/Iyoku were requalified. Physical
field workload evidence is recorded separately when run. The full desktop,
Tailcat/public-IP/media and capacity cases remain open. Whole enabled-instance
inventory, clean recovery validation, consensus-backed writer authority,
unreachable-node fencing, client discovery and regional room partitions remain
in the [master plan](../plans/2026-09-26-geographic-community-nodes.md).
`fullInstanceReady` remains false. No HA gate is closed by this receipt.

## Field launch pending

The fresh `field-embed` binary built successfully and matching stripped copies
were staged in private disposable directories on Ronin and Iyoku. The
[field preparation receipt](geographic-2026-09-30/field-pending-receipt.json)
records exact digest/size and the separate current three-egress qualification.
Automatic permission review timed out before launching the field workload,
including its one permitted retry. It gave no unsafe-action rejection. No
field test process was launched and no field PASS is claimed. Fresh user
guidance is pending; staged binaries remain for that retry (about 153 MB on
each remote and locally). Remove those exact owned files after execution or
cancellation. No firewall or production deployment was changed.

## October 1 continuation

The [three-uplink field workload](THREE_SITE_FIELD_2026-10-01.md) has now passed
using the exact staged September 30 binary. Both remote stage generations and
the recovered local copy were subsequently removed. The earlier pending
receipt records September 30 only; it is not the current execution status.
