# Physical encrypted recovery coordination

**Recorded:** 2026-10-01. **Result:** the disposable three-computer coordination
trial passed, terminal session `98763`, exit zero. This is main Wabi work before
ERP. It does not activate a Wabi Authority or recover application state.

## What ran

| Computer | Configured voter | Runtime |
|---|---:|---|
| dotRonin | 1 | Local Linux, Python 3.12.3 |
| Ronin (`bazzite`) | 2 | Remote Linux, Python 3.14.7 |
| Iyoku (`192.168.1.11`) | 3 | Remote Linux, Python 3.14.7 |

All three used the same frozen Rust fixture: 85,751,720 bytes, SHA-256
`52455067953e0d2d67f04dff308caca01cc2d4715a17f60828f6eee3a17dd3ec`.
The accepted Python supervisor/controller sources were unchanged. Eighteen
compiled consensus source hashes matched the local acceptance receipt. No
Cargo invocation, dependency change, server deployment or writer activation
was part of this trial.

Each computer created its own private disposable node key. Only public keys
were collected to construct the fixed approved roster. Noise KK authenticates
the roster, community, partition and node pair before RPC. All advertised
endpoints used private Tailscale addresses. The explicitly bounded fixture
timing was heartbeat 500 ms, election 2,500–5,000 ms and snapshot timeout
10,000 ms. These observations do not establish general WAN tuning.

The initial operation converged on all three. Then, for each voter separately:

1. Kill and reap only its known owned fixture worker.
2. Accept the next exact operation on both surviving voters.
3. Restart the missing worker against its existing private key and store.
4. Compare the exact original command fingerprint, accepted receipt, applied
   position and complete operation-state hash on all three.
5. Read back every preceding original receipt and check that the private key
   and persistent store-lock inodes are unchanged.

Four operations and three failure/return cases passed. Measured submission to
the required receipt set took 1.415, 0.673, 3.346 and 2.040 seconds. These are
four fixture observations, not throughput, capacity or a guaranteed recovery
time. The fault is worker-process death; the host, Tailscale and SSH remain up.

## Subsequent minority and snapshot trial

A second fixture passed in terminal session `39282`, exit zero. It used the
same frozen Rust artifact and stable helpers, with bounded heartbeat 1,000 ms,
election 4,000–7,000 ms and snapshot timeout 10,000 ms. Each approved private
endpoint had an owned opaque TCP proxy to its worker's explicit loopback
listener. The proxies forwarded bytes without decrypting application traffic;
Noise still authenticated the original roster and peer pair. Dropping selected
owned proxy connections isolated the former leader from the other two voters.
No host-wide interface, firewall or Tailscale rule changed.

The isolated former leader 1 returned an indeterminate proposal without an
accepted receipt. Voters 2 and 3 elected a leader and accepted the next exact
operation. After reconnection, all three converged on that accepted history;
the minority's uncommitted operation 99 was absent on every voter.

Next, follower 1 was killed and reaped at applied index 4. The other two
accepted 30 further operations with exact receipts. Their observed purged
prefix reached index 29, beyond the missing follower's history. The returning
worker installed snapshot index 29 and caught up to all 32 accepted operations.
Complete operation-state hashes, counts, epoch and final exact receipt matched
on all three. A second same-store restart retained that state. The initial and
post-partition original receipts were read back on all three; all 30 intervening
operations had exact receipts on their accepting majority. Original private-key
and store-lock inodes remained unchanged. This is a metadata snapshot, not a
WabiDB community snapshot or a file/blob recovery result.

The first edge attempt also passed its minority assertions and observed an
actual purged prefix, but reached the controller's 128-command limit before
snapshot-return checks. The failed receipt remains failed. Its final cleanup
frame on Iyoku was consumed by a caller expecting an ordinary reply; an
independent read-only inventory subsequently found zero matching private stages.
The retry removed redundant leader polls, kept the 128-command/helper/lifetime
limits unchanged and retained already-observed lifecycle frames. It did not
retry indeterminate mutations automatically.

All three real supervisors, proxies and local SSH/Python transports reported
stopped/reaped workers, closed listeners, stopped threads and removed private
roots/stages. Follower 1 restarted twice. The second owned runner and raw logs
were removed after matching their compressed archives: 26,226 bytes. All
eighteen compiled consensus source hashes still matched after execution.

## Network diagnosis preserved

The first bounded setup transfer expired before Ronin parsed its setup or
created a private stage. A smaller raw compressed stream replaced the base64
JSON binary transfer. The second attempt launched all three real workers but
timed out waiting for the initial exact receipt set.

A six-direction actual TCP challenge then passed four paths and returned
`errno 113` on both inbound paths to Iyoku. Read-only inspection found
`tailscale0` in its `FedoraWorkstation` zone, with SSH and ports 3000/8080 already
allowed. Both private ports were unused. The trial selected existing private
port 3000 instead of its rejected random port. All six directed challenge paths
then passed in 0.200–0.512 seconds. No firewall, router or service rule changed.
This demonstrates why Tailscale ping/SSH success alone does not qualify an
application port. It does not prove public-IP access or a Tailcat role policy.

The earlier operator site report and three distinct egress hashes are placement
evidence. This run did not independently certify circuits or repeat the public
address queries. Tailscale is still the transport underneath the application
encryption; ordinary-IP and Tailcat acceptance remain separate.

## Evidence and cleanup

- [Passing coordination receipt](geographic-2026-10-01/physical-encrypted-rpc-contracts.json)
- [Passing private TCP paths](geographic-2026-10-01/private-tcp-allowed-port-contracts.json)
- [Rejected random-port paths](geographic-2026-10-01/private-tcp-path-contracts.json)
- [First transfer refusal](geographic-2026-10-01/physical-encrypted-rpc-attempt1.json)
- [Second convergence refusal](geographic-2026-10-01/physical-encrypted-rpc-attempt2.json)
- [Passing minority and purged-snapshot trial](geographic-2026-10-01/physical-encrypted-rpc-edge-contracts.json)
- [Incomplete first edge attempt](geographic-2026-10-01/physical-encrypted-rpc-edge-attempt1.json)

Each real supervisor reports `synthetic: false`, its owned child stopped and
complete cleanup. All three private node roots and parent stages were removed;
all local SSH/Python child processes were reaped with exit zero. Each worker
restarted once. The exact passing runner and raw logs were removed only after
matching their compressed archives: 19,133 bytes removed locally. Both failed
attempts retain their receipts and verified compressed sources/logs. The shared
frozen executable remains owned build output; no new target tree was created.
Approximately 46 GiB was free after this run. The separate security compilation
also uses this disk; its owner was notified of the measured decrease.

## Still required

The physical results now cover a minority cut scoped to owned connections and
metadata snapshot installation after an actually purged prefix. Whole-host
power loss and suspended stale-Wabi-writer return remain untested. Dynamic
voter enrollment/revocation/rotation, complete Wabi
state/tail/blob recovery, publication and encryption fencing, client discovery,
automatic Wabi recovery, regional rooms and capacity/privacy acceptance remain
open. Every fixture reply keeps `canonicalWriterPermitted: false`. Gates B, C
and D do not close from this result.
