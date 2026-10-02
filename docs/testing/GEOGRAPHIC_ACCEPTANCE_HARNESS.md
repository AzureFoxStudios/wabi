# Geographic acceptance harness

**October 1 physical follow-up:** the frozen Rust worker and unchanged Python
helpers now pass a separate [three-computer encrypted coordination acceptance](PHYSICAL_ENCRYPTED_RECOVERY_RPC_2026-10-01.md).
This includes each owned worker's failure/return, an owned-connection minority
cut/heal and actual metadata snapshot catch-up after purge with second restart.
All private stages, proxies and children were disposed. These fixtures cover
control metadata; the application workload and full Wabi recovery/capacity
gates below remain separate.

**Updated:** 2026-09-30
**Status:** Reusable candidate extensions to the existing disposable Authority /
Anchor smoke harness. Automatic recovery and regional room owners remain blocked
by their implementation prerequisites.

## Run a bounded room workload

Use the current build of `wabi-server` with its matching static frontend:

```sh
WABI_THREE_SITE_LOAD_OPTIONS='{"clients":6,"messages":20,"payloadBytes":512,"messagesPerSecond":2,"deadlineSeconds":90}' \
  node scripts/three-site-real-authority-smoke.mjs /absolute/path/to/wabi-server
```

The existing harness creates its own disposable Authority, two Anchors, two
accounts and room. After authenticated bidirectional message checks, the
optional workload joins extra WebSocket sessions through all three endpoints,
alternates the two fixture credentials, sends bounded messages, waits for every
client's delivery and the sender's canonical acknowledgment, then compares
acknowledged IDs with the Authority-backed history through the third endpoint.
It disconnects its owned sockets; the parent harness stops its owned processes
and removes its own temporary state in its existing finalizer.

The source file is `scripts/geographic-acceptance/room-load.mjs`. It validates
all resource limits before opening a socket and returns `loadEvidence` in the
parent's JSON receipt. A failed workload fails the parent smoke run.

| Option | Default | Maximum |
|---|---|---|
| `clients` | 6 | 32 |
| `messages` | 20 | 95 |
| `payloadBytes` | 512 | 4096 |
| `messagesPerSecond` | 2 | 20 |
| `deadlineSeconds` | 90 | 180 |

At least two clients are required. Unknown/noninteger options and schedules
that cannot fit their deadline are refused. Only one message is outstanding:
acknowledgment plus delivery settles before the next send, and the configured
rate is a ceiling. The achieved rate is measured. Very large runs belong in a
separate capacity scenario with explicit pagination and backpressure, not in
this historical smoke script's fixed-size history checks.

Metrics include connected clients (distinct from attempted clients), scheduled
and acknowledged messages, expected/observed/missing deliveries, duplicate
events, mismatched accepted/delivered IDs, latency p50/p95/p99/max and achieved
write rate. Application envelope byte counts are **not network traffic**.
Network bytes and measured registered accounts are null. Credentials, message
contents and endpoint addresses are absent from this workload receipt. Media
participants are zero; recovery/reconnect and capacity certification are false.

## Field mode

The existing parent accepts `WABI_THREE_SITE_FIELD_CONFIG`. Its remote SSH
paths must be fresh disposable `/tmp/wabi-three-site-field-*` roots and its
binaries must be explicitly staged there. Remote-host debug binaries need the
existing `field-embed` feature. Record binary/frontend/source digests and current
uplink qualification separately. Three endpoint URLs on one machine do not
establish three physical sites. The new workload's sessions originate on the
runner; the parent's separate remote-client probes establish remote-origin
behavior for their recorded requests. Do not label all load traffic as local
client traffic on three sites.

On normal errors the parent finalizer performs owned-process/root cleanup.
Whole-process kill or host power loss can bypass a JavaScript finalizer: inspect
owned disposable PIDs/roots afterward. This parent is not yet a crash-proof
remote supervisor. Never use it to stop production services or disrupt whole
network interfaces.

## Focused harness checks

```sh
node scripts/geographic-acceptance/room-load.test.mjs
node --check scripts/three-site-real-authority-smoke.mjs
```

The tests cover resource/schedule refusal, absent/tail latency measurements and
an already-aborted run that opens no sockets and emits no credentials. Real
runtime evidence must additionally run the parent against a known build.

## Remaining scenarios

The master plan requires a configuration-driven runner with per-assertion
passed/failed/blocked/not-run results, independently supervised fault injection,
three-site client workload generation, restart/reconnect and duplicate checks,
permission changes, verified recovery, majority partitions and old-writer return.
The current parent produces one aggregate PASS only after all of its executed
assertions succeed. It does not mark unimplemented failover as passing.
Many-room/hot-room saturation, slow clients, upload pressure and media are
separate bounded scenarios. See the
[remaining execution plan](../plans/2026-09-26-geographic-community-nodes.md#remaining-execution-plan--resumed-2026-09-30).

## Stopped-core audit and replay

The geographic harness directory also contains a bounded stopped-tree comparison
and a disposable encrypted V1 restore/replay rehearsal. See the
[October 1 contract and evidence](STOPPED_CORE_AUDIT_2026-10-01.md) for commands,
limits, persistent-lock handling, inactive-guard behavior and remaining verifier
gaps. These run independently of the three-uplink transport workload.

The separate `inactive-live-rehearsal.mjs` exercises the running local operator
route, authenticated live V2 restore and independent offline replay, optionally
on one explicitly configured remote test computer. It never activates either
copy. See [October 1 inactive verification](INACTIVE_CORE_VERIFY_2026-10-01.md)
for limits, exact provenance, failure evidence and cleanup semantics. Its
private optional JSON configuration contains only `sshTarget` and
`expectedHost`; run it with absolute server/snapshot paths and that file as the
third argument. Public output excludes credentials and endpoint addresses.

## Durable coordination contracts

The independent `wabi-consensus` crate runs the upstream actual-storage suite,
owned cancellation and process-kill checks, and actual three-voter Raft tests
with an in-process controlled network. See
[October 1 evidence](DURABLE_CONSENSUS_2026-10-01.md) and the crate README for its
command and resource limits. Control outcomes grant no Wabi writer permission.
Keep these results separate from physical network, complete recovery and
regional-room acceptance.

The independent Linux [probe supervisor](GEOGRAPHIC_PROBE_SUPERVISOR_2026-10-01.md)
and [controller](GEOGRAPHIC_PROBE_CONTROLLER_2026-10-01.md) have 33 and 25 passing
synthetic process/Unix-control checks respectively. They provide bounded owned
restart/cleanup and original-proposal receipt validation. The actual Rust
worker/Noise transport have subsequent 39-check local executable acceptance;
actual Rust/Python control and supervised local restart/cleanup also pass. See
[expanded evidence](ENCRYPTED_RECOVERY_RPC_2026-10-01.md). Physical encrypted
paths and Wabi recovery remain required.
