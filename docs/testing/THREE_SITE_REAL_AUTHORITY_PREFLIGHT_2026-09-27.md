# Real Authority and two-Anchor access preflight

**Date:** 2026-09-27  
**Scope:** One disposable Authority and two separate Anchor processes on one loopback host. This is a three-process integration check, not the required three-network field pilot.

Command:

```bash
cd frontend && STATIC_BUILD=1 bun run build && cd ..
cargo build --locked -p wabi-server --bin wabi-server
node scripts/three-site-real-authority-smoke.mjs target/debug/wabi-server
```

The static frontend build, backend build and script passed. Latest tested binary SHA-256: `23f05d70b1923e69befb3ace5d2508b439626602633d636f7c91ece6466769c9`. The working tree was modified, so the checked-out commit `cf00e3cb` alone does not identify the tested source. The script creates temporary Authority data and two Anchor listeners, uses disposable accounts, and removes its temporary files and processes afterward. One first run after rebuilding timed out at the script's ten-second registration bound; two immediate full reruns passed in about seven seconds each. The timeout was not reproduced, but remains a reason to watch registration latency during the field run.

The first run found that `wabi-server` created an empty uploads `.tmp` directory before the missing-registry startup guard. The guard mistook it for lost upload history and refused a fresh Authority. Startup now creates that directory after `AppState` checks recovery state, and the guard tolerates only an empty, real `.tmp` directory left by an earlier attempt. A focused unit check passes for an empty `.tmp`, a populated `.tmp` refusal, and a real file refusal.

With the corrected build, the real-process preflight passed these steps:

1. The owner registered through the materials Anchor; a second disposable account registered through the equipment Anchor. Both received usable sessions.
2. The two accounts accessed one channel through different Anchors. Engine.IO polling and authenticated Socket.IO WebSocket connections succeeded through each Anchor. Live Socket.IO messages crossed in both directions with the accepted message IDs, and equipment read both from durable HTTP history.
3. A versioned JavaScript chunk referenced by the Authority's app shell was delivered byte-for-byte from each Anchor's embedded build, with `X-Wabi-Anchor-Static: local`. The sampled chunk was 28,424 bytes per site; local serving makes zero Authority requests for a present chunk. The Anchor regression suite passed 15 tests, including local HEAD delivery, upstream forwarding for a missing version and non-GET requests, and that the root app shell still comes from the Authority. A separate path guard test rejects traversal and non-asset paths.
4. Materials sent a resumable upload through its Anchor. Equipment downloaded the same bytes through its Anchor's optional RAM cache; the first response reported `miss` and the second `hit`, with matching SHA-256. A later loopback run added a disposable TCP meter on the equipment Anchor's Authority path. For a 262,144-byte file, it counted 263,175 Authority-to-Anchor bytes for the miss and 504 for the hit, including HTTP headers. This measures one local connection, not physical regional savings.
5. After the materials Anchor stopped, equipment still read and wrote the channel. After the Authority stopped, equipment returned HTTP 503 for both the API and a previously cached file rather than serving canonical work or stale cached bytes. The public embedded chunk remained locally available; this does not make community state available.

This proves a local static response for one sampled app chunk but does not measure independent uplinks, WAN latency or aggregate origin egress. It does not exercise Ronin/iRonin desktop clients, public-IP certificate setup, Tailcat reachability, long sessions, media calls, real site failures, or multi-site bandwidth. The [three-site field scenario](../plans/2026-09-26-geographic-community-nodes.md#three-site-acceptance-scenario) remains open.

## Planned stopped move through a known Anchor URL

The same disposable process script also passed twice with the optional snapshot binary:

```bash
cargo build --locked -p wabi-server --bin wabi-server --bin wabi-instance-snapshot
node scripts/three-site-real-authority-smoke.mjs target/debug/wabi-server target/debug/wabi-instance-snapshot
```

After the access checks, the script stopped the Authority, verified the surviving Anchor returned 503 for canonical work, fenced the stopped old data tree, exported an age-encrypted whole-instance archive, and restored it in controlled-move mode. A real server process refused the replacement before activation. The matching old-tree receipt activated it, while a real process still refused the fenced original. The equipment Anchor restarted on the same member-facing URL, pointed to the replacement. Through that URL, the same member token retrieved the same community ID, signed roster, message history and upload bytes. A new write succeeded, the owner published roster version 2, and the original still refused startup.

This run exposed a shutdown detail: the cleanly exited disposable Authority left `data/wabidb/.lock`. The snapshot tool correctly refused to fence or export until the lock was gone. The script removes a lock only from its own temporary tree, after confirming the child exited successfully, no longer belongs to the running set, and the regular lock file contains that child's exact PID. Operators must independently confirm a real data tree is idle before removing a stale lock; see [backup and recovery](../deployment/BACKUP_AND_RECOVERY.md#candidate-controlled-move-of-a-stopped-authority).

This is a planned, manually fenced move on one computer. It does not prove recovery from an unreachable former Authority, automatic promotion, a live standby, separate networks, regional room ownership, or uninterrupted realtime sessions. The test artifacts and generated Cargo build cache were removed after the run; the build must be repeated to rerun the command above.
