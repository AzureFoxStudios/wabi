# Controlled Authority move between two site networks — 2026-09-27

**Scope:** Disposable main Wabi Authority data, moved while stopped from Iyoku to Ronin over Tailscale, then copied back to Iyoku as a fenced passive tree. iRonin orchestrated the run. At the time of this check, iRonin and Iyoku shared one public IPv4 and a local LAN path; Ronin had a different public egress. This is two network sites and three computers, not the three independent networks required by Gate A.

## Build and run

The field run used temporary copies of the current working-tree debug binaries. Their SHA-256 digests were checked after copying to both remote computers:

| Binary | SHA-256 |
|---|---|
| `wabi-server` | `70e0fea0fa027524bd176c4a70bb62f24ba788600b8a3c3e4bb20fdb2f9dffd0` |
| `wabi-instance-snapshot` | `4628aa9cb22ce2ef324f6c10ef72f6afe9888c31aa2b3350ab0a2ee0e2271e3d` |

The source checkout was at `cf00e3cb` with uncommitted changes. This receipt describes that working tree, not a released build. The local loopback run and the remote field run of `scripts/three-site-real-authority-smoke.mjs` both returned `PASS` with the snapshot binary enabled. All Authority and Anchor state was created in disposable test directories. No production community data or firewall rules were changed.

## Observed sequence

1. The normal three-computer flow used Iyoku as Authority, Ronin as one Anchor, and iRonin as the client/orchestrator. It covered authentication, a signed three-entry roster, shared durable and live messages, polling/WebSocket, upload bytes, and the expected outage after Authority loss. Regional byte measurements are in the [three-computer field receipt](THREE_SITE_FIELD_2026-09-27.md).
2. After the Iyoku Authority exited cleanly, the harness checked and removed only stale PID locks inside its disposable data tree. Ronin generated the age recipient key locally. Iyoku installed a durable writer fence, exported its stopped data/uploads into an age-encrypted archive, and transferred that archive over SSH on the protected Tailscale path. The private decryption key remained on Ronin.
3. Ronin restored the archive into a new tree with the controlled-move guard. A real Authority process refused to start while activation was pending. Iyoku produced a receipt for that exact archive while its original tree remained fenced. Ronin activated the restore with the receipt; the old Iyoku tree still refused Authority startup.
4. Ronin started the replacement Authority. The known member-facing Anchor URL was repointed to it. The same community ID, existing member token, signed roster, exact message IDs without duplicates, and uploaded bytes remained usable. Ronin accepted a later message and published signed roster version 2.
5. The Ronin Authority stopped cleanly. Iyoku generated a fresh age recipient key locally. Ronin exported its later stopped state to that recipient. Iyoku restored it into a separate passive tree; the full Authority refused startup from both the original fenced tree and this passive tree.
6. The harness compared SHA-256 hashes for every durable file in Ronin's stopped replacement data tree and Iyoku's passive data tree, excluding only `.lock` and the passive writer-fence marker. All 30 compared paths matched. Ronin then restarted its Authority, and the post-move message remained readable through the Anchor.

The encrypted reseed archive had the same SHA-256 digest at source and destination: `375a78467425dc8c69b885e6b2e1dffea1f8f08382d5e8f8e2bccad275a21120`. The run observed no remaining test `wabi-server` processes after completion. The temporary binaries, keys, archives, receipts, and test data were removed after the evidence was recorded.

## What remains open

This was an operator-controlled, **stopped planned move**. Its receipt is a workflow guard, not remote attestation. It cannot safely promote a copy while the old Authority is unreachable, or prove that another unfenced copy cannot run. The passive reseed is a new stopped copy, not continuous replication or a promotable live standby. No distributed lease, quorum, automatic election, measured recovery time/loss objective, third independent site, long-lived desktop session, media call, plugin-owned storage, Lore store, or externally supplied secrets were tested. Gate B and automatic one-node survival therefore remain open.
