# Live fenced receiver across two site networks — 2026-09-27

**Scope:** A disposable main Wabi Authority on Iyoku sent later WabiDB commits and one newly published upload to a fenced development receiver on Ronin while the Authority remained running. iRonin orchestrated the run and hosted a second Anchor. iRonin and Iyoku shared one local network/public egress at the time, so this was two independent network sites and three computers, not the three-site Gate A pilot.

## Build and transport

The field run used `scripts/three-site-real-authority-smoke.mjs` with the snapshot and receiver binaries enabled. These were portable debug binaries built from working-tree HEAD `cf00e3cb` with `--features field-embed,addons`, stripped for transfer and hash-checked on the remote computers:

| Temporary binary | SHA-256 |
|---|---|
| `wabi-server` | `d2fdac2063e496974b889e9ecea418d99e7f8365059f2d3aaaf1484dd9c48bf2` |
| `wabi-instance-snapshot` | `40cdb18d67dbfd643b784fcaf991b001c2b235577c9b63ff06ce62a9cdace5e8` |
| `wabi-db-replica-dev` | `88c58b47bb7f20e54bd4d63c69c61ec2a9352b005750d40c5a48d5ba5542b1bd` |

The baseline was exported only after stopping Iyoku's Authority. Ronin generated its age recipient key locally, received the encrypted baseline over SSH/Tailscale, and restored it with `--passive-replica`. Ronin's receiver listened on its Tailscale private IPv4. Iyoku then restarted the original Authority with experimental replication enabled and an independent random sync token. The peer used private HTTP over the existing protected Tailscale path; no domain, public listener, or firewall change was involved. The token and recipient identity lived only in disposable test directories and were removed after the check.

## Recorded result

The final field run returned `PASS`. Before Iyoku resumed writes, Ronin reported `appliedCommitSeq = indexedCommitSeq = 19`. While the Authority ran, a new message and a 4,096-byte resumable upload were accepted. Ronin later reported `appliedCommitSeq = indexedCommitSeq = 21`. The uploaded file was present in its passive upload tree and matched SHA-256 `495b63b9b5c41b598d95c9b884215a755c800e1994630244c7b80498b719049c`; the same hash was observed again after the receiver stopped. The receiver reported `writerFenced: true` and `fullInstanceReady: false`; a full Authority process refused to start from that passive tree. `sidecarCopyEnabled: true` showed that the optional lane was configured, but this field run did not prove a post-baseline sidecar change or a cross-file checkpoint.

The same run passed the normal regional sign-in, roster, polling/WebSocket, live message, upload/cache, Anchor loss, and expected Authority-loss checks. After the receiver stopped, the harness also repeated the [planned stopped Authority move](REMOTE_CONTROLLED_MOVE_2026-09-27.md) from Iyoku to Ronin and the fenced passive reseed back to Iyoku. The recorded result concerns one short disposable session, not sustained throughput or recovery time.

An earlier attempt with the same portable build hung during Iyoku's graceful shutdown after its Socket.IO clients disconnected. The server now bounds the Socket.IO close wait to five seconds and logs when that bound is reached. The final field run exited cleanly at all observed Authority stops, with no timeout warning. That run checks clean exit; it does not establish that the timeout branch itself was exercised.

After the field run, the harness gained a cleanup fallback that checks the reported remote PID, executable and disposable data path before signaling a leftover test process. A later local loopback run passed with that harness change. The remote fallback itself has not been fault-injected or field-verified.

## Acceptance boundary

This is a physical **two-network** acceptance check for the narrow experimental WabiDB plus verified published-upload path. A receiver position and matching file hash do not prove a recoverable whole instance. There is no shared checkpoint for WabiDB, sidecars and files; no complete inventory of plugin/Lore/external state; no deletion-safe retention proof; no operator promotion when Iyoku is unreachable; no lease, quorum, automatic election, measured RTO/RPO, or three independent sites. The receiver remained fenced and could not serve members. Gates B, C and D remain open.

A later [local stopped-tree comparison](REPLICA_STATE_COMPARISON_2026-09-27.md) checked every file in the disposable fixture and the decoded projection snapshot after graceful receiver shutdown. That comparison was on one computer and does not extend this field run's network acceptance scope.
