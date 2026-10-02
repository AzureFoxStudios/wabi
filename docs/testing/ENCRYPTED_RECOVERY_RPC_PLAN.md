# Encrypted recovery RPC: acceptance plan

**Recorded:** 2026-10-01. **Status:** local executable acceptance passed;
scoped physical encrypted coordination also passed; further faults and Wabi
recovery remain open.

The isolated durable store has [recorded local acceptance](DURABLE_CONSENSUS_2026-10-01.md).
The new `wabi-consensus/src/transport` sources and direct encrypted TCP/process
test now have [39-check local executable acceptance](ENCRYPTED_RECOVERY_RPC_2026-10-01.md).
They are wired only to the isolated crate; the Authority is not wired to it.
The security owner released and then received back a serialized dependency/build
slot. The older nested `tests/pending` source receipts below describe history;
they are superseded by the new executable receipt. Physical/whole-instance
acceptance is still required, and current compiled paths stay stable for the
other chat's final workspace run.

The [subsequent physical result](PHYSICAL_ENCRYPTED_RECOVERY_RPC_2026-10-01.md)
passes four exact durable operations and each owned worker's
kill/restart/majority-write/catch-up on dotRonin, Ronin and Iyoku. All private
stages and processes were removed. A further owned-proxy physical trial passes
minority no-ACK/heal and actual metadata snapshot installation after prefix
purge, 32 accepted operations, second restart and complete cleanup. A real
six-direction TCP check diagnosed
Iyoku's rejected random port; its existing allowed unused private port 3000
passed every path, with no firewall change. Whole-host power loss, complete
Wabi state and writer-fencing acceptance are separate remaining tests.

This document specifies the next acceptance slice of package 4 in the
[master plan](../plans/2026-09-26-geographic-community-nodes.md). It does not
close the whole-instance recovery, canonical writer or regional-room gates.

A fresh [read-only SSH preflight](geographic-2026-10-01/encrypted-rpc-ssh-preflight.json)
on October 1 passed for Ronin (`bazzite`) and Iyoku (`192.168.1.11`), with
approximately 13.5 GiB and 7.1 GiB temporary space. Both reported zero remaining
directories from the previous inactive-checkpoint rehearsal. No remote file or
process was created. This checks access and headroom only; it does not qualify
independent uplinks or execute the new encrypted RPC protocol.

One explicitly user-approved HTTPS address check per computer on October 1
reported three distinct internet exits, with expected host identities on all
three. The [redacted observation](geographic-2026-10-01/three-exit-observation.json)
publishes hashes rather than the reported addresses. An exit proxy or overlay
could affect this observation; it does not certify physical circuit independence,
ordinary-IP ingress or encrypted recovery RPC. No remote files or services were
created by the check.

Six directed Tailscale discovery-path checks also passed, with three samples
per path and observed round trips of 107–226 milliseconds. Most samples used
relays; some used direct paths. The [redacted route receipt](geographic-2026-10-01/overlay-path-preflight.json)
records no route addresses. Tailscale discovery pings do not traverse either
host's application OS/firewall and cannot replace the encrypted application
test. Physical Raft timing must account for these measured paths; the short
loopback election settings in the staged tests are not a WAN recommendation.

## Address and identity contract

Each of three explicitly approved recovery voters has an independent private
key, node ID, site label, protocol, community binding and literal IP endpoint.
Both ends must know the same complete initial roster. Helpers, ordinary member
accounts and volunteer tokens cannot join this transport.

The proposed Noise KK handshake binds both peer IDs, community, partition,
protocol and the complete roster fingerprint. RPC bytes follow only after
mutual authentication. A changed discovered endpoint is refused before dialing.
There is no opportunistic enrollment, credential-forwarding redirect or
plaintext fallback. Initial membership and received snapshot membership must
equal the approved roster. Dynamic membership, revocation and key rotation
still need a separately reviewed majority-authorized implementation.

The endpoint is a transport address, not the cryptographic identity. A literal
IPv4 or IPv6 endpoint does not require a domain or Tailscale. Reachability still
requires a usable route: local/private routing, a private overlay, or an
operator-arranged reachable endpoint. A NAT or ingress relay may have a separate
explicit local listener; the approved published endpoint and peer key remain
bound to the handshake. The protocol does not create a public address, perform
NAT traversal, configure a firewall or open a router port.

The fixed hello is visible before encryption: protocol, peer IDs, community
identifier, partition hash and roster hash. A transport observer can also see
IP addresses, packet sizes and timing. This control-plane design is not anonymous
and does not hide community linkage on an ordinary IP path. No member content or
private key is included in that hello. Review this metadata exposure before
public deployment; a private overlay changes who can observe it, not the
application protocol's own disclosure. Approved recovery voters are trusted
operators; Raft does not tolerate malicious voters as a Byzantine protocol.

Application authentication must be tested over both private-overlay and ordinary
IP paths. Success over Tailscale alone cannot certify the ordinary public-IP
path. The advertised endpoint is immutable in this first fixed-roster slice;
changing it requires a new agreed test configuration, not a discovered redirect.

## Dependency review before wiring

Pin Snow 0.10.0 and select only the required standard runtime, default resolver,
Curve25519, ChaCha20-Poly1305, SHA-256 and OS randomness features. In particular,
the resolver needs `use-getrandom`; an optional dependency being present does
not by itself select that resolver implementation. The first proposed feature
list omitted this flag and must be corrected before the first build.

Use the already selected x25519-dalek 2.0.1 with `static_secrets` and zeroize
1.9.0. Review the fetched crate manifest and source against the exact APIs;
preserve the shared lock's security patches. Record every new package identity
and rerun the dependency audit. No lock rollback over another chat's changes.
Primary references: [Snow package manifest](https://docs.rs/crate/snow/0.10.0/source/Cargo.toml),
[Snow builder](https://docs.rs/snow/0.10.0/snow/struct.Builder.html),
[X25519 contributory check](https://docs.rs/x25519-dalek/2.0.1/x25519_dalek/struct.SharedSecret.html).

## Layered assertions

Every assertion has its own result: `passed`, `failed`, `blocked` or `not_run`.
A refusal is successful only when the intended unsafe operation was rejected;
connection failure cannot substitute for an authenticated negative case.

| Layer | Required assertions | Current evidence |
|---|---|---|
| Configuration | Wrong private key, invalid/low-order public key, malformed or inconsistent roster, incompatible protocol/community, invalid resource budget and incompatible Raft chunk sizing refuse | Local executable checks passed |
| Private key persistence | Explicit creation is private and durable; reopen retains identity; absent, truncated, public, hard-linked or symlink-substituted keys refuse without regeneration or overwrite | Local key/bootstrap/configuration and actual child-startup checks passed |
| Handshake | Both peer identities and all context bindings checked; wrong key/community/partition/roster/target fails before an RPC reaches Raft | Local executable checks passed |
| Wire protection | A fragmented synthetic payload round-trips; plaintext marker absent from captured wire; tampered ciphertext and replayed frame refuse | Local checks passed; marker absence is a fixture check, not an independent cryptographic audit |
| RPC admission | Authenticated source matches claimed Raft sender; changed discovered address never dialed; altered membership, invalid command and oversized snapshot refuse | Local actual-handler checks passed |
| Resource ownership | Length bounds before allocation, connection cap, handshake/RPC deadlines, shutdown closes listener and drains owned tasks; unavailable peers cannot create unbounded outgoing work | Local stalled-handler and shared outgoing-budget/cancellation/deadline checks passed |
| Encrypted TCP voters | Each voter stops/returns; majority continues; all stores restart; original operation retries once; a 1-versus-2 partition cannot acknowledge on the minority; heal converges; missing follower installs snapshot after actual purge and retains it after restart | All three local TCP scenarios passed |
| Separate processes | Repeat loss/return and partition assertions with three independently supervised executable processes; kill and reap owned children; restart from exact original stores | Local SIGKILL/restart/minority-heal/snapshot and unsafe-startup contracts passed; real Python supervisor/controller integration also passed; physical paths remain required |
| Physical paths | Exact executable on dotRonin, Ronin and Iyoku; recheck host, temporary space, route, egress/site placement; demonstrate encrypted authenticated RPC in both directions | Scoped PASS: exact frozen worker, direct private-overlay coordination and six TCP paths; site/circuit certification and ordinary public IP remain open |
| Physical failure | Each node killed separately, returning node catches up, majority/minority cut scoped to disposable listeners, delayed/failed requests cannot produce duplicate applied outcomes | Scoped PASS: every worker loss/return, owned-proxy minority no-ACK/heal and actual purged metadata snapshot/second restart with cleanup; whole-host and Wabi recovery remain open |

The local proxy fixture cuts owned TCP paths only. It changes no global network
interface or production firewall. A graceful actor shutdown is distinct from
process death. Three computers on one uplink are distinct processes, not three
independent networks. Site labels in configuration do not prove independence.

## Disposable process probe contract

The separate [Linux supervisor prerequisite](GEOGRAPHIC_PROBE_SUPERVISOR_2026-10-01.md)
now has 33 passing synthetic process tests: actual controller/supervisor death,
identity-checked pidfd adoption, inherited-lock registration, controller bounds,
suspend-aware timing, bounded same-store worker restart and exact owned-root cleanup.
Restart mode preserves the original supervisor lock and fixture across owned
worker loss/replacement without renewing its lifetime or controller lease.
It launches no Wabi service. A later actual Rust/Python local run also passed
guarded follower restart and complete owned cleanup. Neither local result
replaces the physical gates below.

The separate [local controller prerequisite](GEOGRAPHIC_PROBE_CONTROLLER_2026-10-01.md)
passed 25 synthetic checks. It pins the active supervisor and actual Unix peer,
bounds requests and requires the persisted original-command fingerprint before
accepting receipt convergence. A lost reply stays indeterminate. The compiled
Rust fixture supplies this fingerprint and passes a matching codec golden;
actual Rust replies through the Python controller also pass locally. Epoch/log/outcome alone
cannot identify the exact proposal after a timeout.

The same four Python sources subsequently passed all 33 supervisor and 25
controller checks separately on Ronin and Iyoku (Python 3.14.7, x86_64).
The [remote runtime receipt](geographic-2026-10-01/remote-python-helper-contracts.json)
records terminal exits, zero skips, matching source hashes and verified logs.
All private stages/test roots were removed; no owned live process group or
bytecode cache remained. These are actual synthetic host-runtime checks,
including Unix peer credentials and process restart/cleanup. They create no
node key, TCP listener or Wabi service and do not exercise encrypted interhost
RPC, Rust/Python codec compatibility or Wabi recovery.

The direct TCP test now contains a locally verified child worker using the same test executable, a
private Unix control socket, private fixed configuration and its own store/key.
Its passing parent test exercises actual
SIGKILL/reap/reopen for each voter, full restart/idempotent retry and a
majority/minority cut followed by receipt convergence. An independent watchdog
is written to terminate only that worker after 100 seconds, including if its
controller disappears or async runtime stalls; this behavior still needs an
actual process test. It does not remove private roots after a killed controller,
so physical crash cleanup needs the external ownership supervisor below.

### Independent physical node-key bootstrap — locally verified

The frozen worker needs a create-only entry point before its fixed public
roster can be assembled. The direct test adds the ignored
`processes::separate_process_identity_bootstrap` entry point. It accepts a
private bounded `fixture.json` containing `schemaVersion: 1`, `nodeId: 1..3`
and the existing fixture owner. The trusted operator must exclusively own the
private absolute stage, with no symlink ancestor. Only that configuration and
an optional frozen `probe.bin` may exist. Any existing key, even damaged,
or unexpected file refuses generation. There is no regeneration/overwrite.

It creates an independent OS-random private key through the same pinned Rust
identity implementation, syncs it, and emits only one tagged public record
(`schemaVersion`, `nodeId`, `publicKey`). It creates no store, lock, socket or
listener. The passing bounded parent contracts create three independent child keys,
public-key reload, second-create refusal with unchanged key inode and timestamp,
and ten unsafe input variants. These now have executable local acceptance;
keys were generated only in disposable local fixtures, not on physical peers.

After verified bootstrap, the operator replaces the temporary configuration
with the complete approved worker roster, records its exact digest and then
claims the supervisor. The two configuration shapes are deliberately distinct;
bootstrap cannot accept ordinary worker configuration as a regeneration request.
No production key, account token or community-root secret is a bootstrap input.

Worker configuration also adds optional bounded `raftTiming`
(`heartbeatMs`, `electionMinMs`, `electionMaxMs`, `snapshotTimeoutMs`). Validation
precedes store/listener creation; omission preserves the existing short local
fixture timings. The 500/2500/5000/10000 ms value set passed local bounds and
actual control-interface tests, **not WAN validation**. Its pure contract
checks valid/invalid bounds and unchanged local defaults. Physical timing must
still be selected from observed application latency and failure behavior.
These changes are now in the compiled direct test; current provenance is in
[the executable receipt](geographic-2026-10-01/encrypted-rpc-contracts.json).
Historical source-only/fingerprint receipts are preserved separately.

The staged worker also refuses public, linked, substituted or oversized private
configuration before initialization. Replies identify the actual node and
report current term and observed snapshot/purge positions separately from the
durable applied position. The parent compares exact durable operation-receipt
fingerprints on all healed nodes and reads the original receipt back, rather
than treating equal counts as convergence. These assertions passed locally.

Outgoing RPCs share a semaphore across cloned network factories: default four,
maximum sixteen, with immediate budget refusal before serialization or dialing
when full. There is no semaphore waiter queue. The permit lives through the
whole RPC and caller cancellation releases it. The passing mock-peer test checks
overload refusal and reuse after cancellation and deadline expiry.

The passing separate-process scenario exercises a follower outage across thirty
majority writes, requires an observed purge beyond the missing prefix, then
requires a returned follower's snapshot position and a second SIGKILL/reopen to
retain all thirty-five exact receipts. Its own recorded executable result is
distinct from the earlier in-process snapshot acceptance.

A separate passing parent test invokes the real child worker with an absent,
truncated, mismatched, public or hard-linked node key. Each child must exit with
failure and be reaped without creating a durable database, lock or control
socket. This is actual executable-startup refusal, recorded separately from
the pure configuration/key tests.

The probe must not link the Wabi Authority or access live WabiDB, member content,
root keys or recovery guards.

- Explicit existing private root, durable node binding and key loaded without
  fallback generation. Generate new independent fixture keys only during the
  separate explicit setup step; transfer each private key to its own node only.
- Fixed approved roster; bounded private configuration file; no command-line or
  log secret output. Public receipts use logical site labels and key/roster
  fingerprints, not private keys, access tokens or public endpoint inventories.
- Local stdin or an existing-root private Unix socket for status, one bounded
  ownership intent and shutdown.
  No remote admin, proposal, key export or generic port-forwarding endpoint.
- Fresh initialization only when the store is demonstrably uninitialized;
  reopen must not bootstrap a replacement community or reset an old vote.
- Hard process lifetime, command size/count and store/network ceilings. At most
  three fixture nodes plus their owned supervisor tasks; no parallel Cargo.
- Each request carries a unique operation ID and exact expected epoch. A timed
  out client result is indeterminate, not proof of rejection: later compare the
  durable receipt on the recovered majority. Never retry changed contents under
  the same ID or infer canonical writer permission from a control acknowledgment.
- Stop the listener, abort/drain connection tasks, shut down Raft and await owned
  storage I/O. A hard supervisor deadline then terminates and reaps only that
  fixture process. Preserve the lock inode and use OS contention to detect a
  still-owned store; never delete its lock file to restart.

## Run and cleanup receipt

Freeze one executable, record its SHA-256/size/compiler and source/manifest/lock
digests, then transfer only an owned stripped copy. Verify the copy on each host
before starting it. Earlier checkpoint binary provenance cannot cover this new
protocol. Do not execute a rebuilt path in place of the frozen artifact.

Each run needs a random owner marker and exact roots/executable/PIDs, including
process start identity where the OS provides it. Its independent supervisor
must stop on controller disappearance or hard runtime expiry. Reconnection
cleanup checks these bindings before killing or deleting anything. A PID number
or directory prefix alone cannot authorize cleanup after a crash.

For every fault, save attempted/committed operation IDs, durable applied positions,
terms, epochs, snapshot/purge position, logical topology and elapsed time. Also
record refusal counters, traffic sample boundaries, memory/disk peak and
cleanup outcome. Do not label election time as Wabi member recovery time.

All temporary roots, fixture secrets, partial transfers and owned process logs
must be removed after saving compressed, redacted evidence. Keep only the frozen
public receipts/logs and needed shared build artifacts. Failed cleanup stays an
explicit failure and must be completed before starting another physical run.

## Follow-on work remains mandatory

Even an entirely passing encrypted control-plane run grants no canonical writer
permission: `canonical_writer_permitted` remains false. It does not replicate
Wabi messages, upload bytes, keys, permission state or complete instance state.
Safe every-path write/publication/nonce ordering, complete verified recovery,
surviving client discovery, dynamic trusted membership and regional room data
ownership retain their own acceptance gates. No automatic Wabi HA, geographic
conversation locality or large-community capacity claim follows from this slice.
