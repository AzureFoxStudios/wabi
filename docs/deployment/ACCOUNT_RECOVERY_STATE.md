# Account recovery state and recovery copies

**Status:** Main Wabi working-tree candidate, not deployed. Ordered code state
and compound code-based ownership recovery are one component of complete
instance recovery. They do not authorize standby promotion.

## Durable contract

One-time recovery codes are now canonical in WabiDB. The additive versioned JSON
event `recovery_codes_updated_v1` uses `recovery-codes:v1`, stream kind 6,
and the `recovery_codes_v1` index. Only SHA-256 digests are recorded; plaintext
codes are returned after issuance is durable and applied. Existing postcard
record layouts are unchanged.

Code operations are isolated sequencer commands, with one event per command.
Admission validates the full delta before preparation. A normal issuance
requires an existing account that is still the canonical owner at that point;
a queued ownership change can invalidate an earlier request. A code can be
spent only by its bound account. Consumed digests remain in the projection and
cannot be reissued. Concurrent attempts cannot both spend one code.

Code-based recovery writes its consumed digest, restored owner and advancing
global session cutoff in **one event and commit**. It requires the bound
account to exist and the cutoff to exceed every stored account cutoff and the
previous global cutoff, so an old current-session exemption does not survive
recovery. Validation or writer fencing refuses the operation without publishing
any of those changes. A successful API response follows durable commit and
complete application. Recovery reasserts ownership and revokes sessions; it
does not change the account password.

Replay validates and applies the same compound transition. The commit watermark
advances only after all affected rows have applied; ordinary projection reads
still have no snapshot isolation. The Authority holds code, revocation and owner
guards across commit and in-memory publication in that order. Owned workers
finish publication when a request is cancelled. Issuance and standalone code
consumption use the same cancellation protection.

Ownership assignment/first-owner claiming also carry commit and publication
through a cancelled request. Administration transfers recheck the expected
owner under the shared guard. Operator reset and ordinary transfer still include
separate session-revocation writes; those full workflows are not one atomic
operation. Other already-admitted requests and broader permission races remain
part of the full consistency acceptance work.

## Migration and rollback

Before its canonical initialization marker exists, Authority startup imports
`recovery_codes.json`, the existing map of lowercase 64-character digests to
positive account IDs. The source must be a regular, non-symlink file no larger
than 64 MiB. Invalid JSON, wrong types, invalid or duplicate digest keys and
unsafe paths refuse startup instead of resetting recovery state.

Imports use deterministic batches of at most 512 operations under the 256 KiB
event bound. The final batch initializes this component. An interrupted import
can retry identical entries; the Authority does not serve a partial import.
Changing a digest's account binding during such an import refuses startup.
Preserve the legacy source through migration.

After initialization, matching binaries read only canonical state and leave the
legacy source untouched. A stale source cannot make a consumed code valid again.
Retain it with stopped whole-instance archives while old binaries remain in use.
**Older binaries can read stale code state or ignore the compound recovery
event.** Downgrading requires a matching stopped backup or explicit migration,
rather than running an old binary against the migrated live tree.

New issuance appends to existing unused codes, preserving the previous behavior.
It does not silently invalidate earlier recovery sets. The issuance API requires
owner access and step-up authentication. Consumed digests are retained
indefinitely for reuse prevention; startup loads only unused codes into the
Authority's code map. Large-set storage, import memory and latency costs remain
unmeasured.

## Recovery boundary

A matching fenced database receiver can apply issuance and compound recovery
events in order and preserve code, owner and session state after restart/replay.
The component's initialization marker is not `fullInstanceReady), a lease,
quorum membership, a complete checkpoint or proof of zero acknowledged loss.
Restoring an older database prefix can still omit a later consumption or
revocation. Current asynchronous catch-up has no zero-loss guarantee.

Required sidecars, uploads, configuration, optional/external stores and other
compound operations still need the
[instance consistency contract](../architecture/INSTANCE_RECOVERY_INVENTORY.md).
See [focused evidence](../testing/ACCOUNT_RECOVERY_STATE_2026-09-28.md),
[session revocation operations](SESSION_REVOCATION_RECOVERY.md) and the
[geographic community plan](../plans/2026-09-26-geographic-community-nodes.md).
