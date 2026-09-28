# Guarded stopped move check — 2026-09-27

**Scope:** A disposable, stopped Authority archive, guarded restore, old-host fence receipt, replacement activation, and later passive reseed of the retired site on one test computer. This is not a live standby, quorum election, or three-network field run.

## Evidence

```sh
cargo test --locked -p wabi-server --bin wabi-instance-snapshot
cargo test --locked -p wabi-server --test first_boot_onboarding
cargo test --locked -p wabi-server --test first_boot_onboarding encrypted_stopped_move_preserves_community_id_and_retires_original
cargo test --locked -p wabidb --lib controlled_move_pending_marker_rejects_direct_engine_writes
```

The snapshot binary suite passed 11/11 and the full first-boot integration suite passed 12/12 after the fence-first change. The direct WabiDB pending-marker check passed earlier. The controlled-move unit case now rejects an archive exported before the old writer fence existed, fences the old stopped tree, exports two archives, and verifies that a missing receipt, a receipt for a different archive, and an altered proof leave `activation-pending-v1` in place. A matching receipt from the stopped, durably fenced source removes the pending marker while the source remains fenced. The restore removes the archived fence only inside the inactive replacement tree. The extended controlled-move integration case passed in a focused run on 2026-09-27, and the full first-boot suite then passed 20/20.

The server integration case fences the old stopped tree before exporting a disposable community with its root key and signed entry-point roster. Before activation, both `AppState::new` and the real `wabi-server` process refuse the guarded replacement; the process does so before recreating JWT or uploads paths. After the matching receipt is verified, the replacement starts with the same community ID, updates its signed roster, and accepts a new WabiDB write. The original remains refused. The extension then stops the new Authority, exports its later state, and restores a fresh passive tree for the retired site. Both its original tree and the reseeded copy refuse full Authority startup; the passive WabiDB has the new user's record and remains durably writer-fenced. This is a disposable same-machine reseed check, not a remote rejoin or promotion test.

A separate [real Authority plus two Anchors process run](THREE_SITE_REAL_AUTHORITY_PREFLIGHT_2026-09-27.md#planned-stopped-move-through-a-known-anchor-url) passed the planned move through a stable member-facing Anchor URL. It preserved the community ID, existing token, signed roster, durable history and uploaded bytes, then accepted a new write and roster update after activation. The old process refused restart. The run also found a stale WabiDB lock after clean process exit; the disposable script releases only its own verified child-PID lock before invoking the snapshot tool. This process check is still one-host loopback evidence.

## Limits

The receipt binds the encrypted archive hash to the source tree's persisted root key and requires the stopped-tree fence to remain present. This is a workflow guard, not independent remote attestation: a person with the decrypted archive also has that root key and could fabricate a receipt. It assumes the operator actually controls the old tree, fences it before export and does not remove that fence. It cannot fence an unreachable machine, prevent another unfenced copy from being started, or detect an operator removing the fence and running the old process between steps. External secrets and stores still need separate handling. A plain restore does not create the activation guard. The reseed copies the new Authority's stopped state and would need the separate experimental receiver for further narrow catch-up. No live incremental catch-up in this controlled-move case, physical second host, automatic failover, or per-room regional write path was tested.
