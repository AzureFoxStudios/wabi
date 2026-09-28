# Session revocations and recovery copies

**Status:** Main Wabi working-tree candidate. Session denials now use WabiDB's
ordered log; this is one recovery component, not a complete standby checkpoint.

## Canonical state

Single-token denials, account issue-time floors, the current-session exemption,
the global issue-time floor and imported legacy permanent user denials live in
the `auth_revocations_v1` projection. `auth_revocations_updated_v1` is an additive
versioned JSON event on `auth-revocations:v1`, stream kind 6. Each command writes
one bounded delta to that stream, avoiding same-stream nonce reuse. Existing
postcard record layouts are unchanged.

The sequencer isolates these control commands and checks their complete delta
before encryption/preparation. A stale account/global floor, invalid payload,
wrong stream/kind or mixed command is refused without a commit or partial index
mutation. Later queued commands see the preceding applied floor. The projection
validates the entire delta before changing any index row, including replay.

Token entries are keyed separately, as are account floors; an ordinary mutation
does not serialize the entire denial set. Floors cannot decrease. A token's
known expiration cannot be shortened. Exemptions can change only with an
advancing account floor. Existing current-session password-change semantics
remain in force. Global revocation also advances beyond future account floors.

Individual token denials remain subject to the earlier expiration-plus-one-hour
retention rule. Later mutations prune at most 256 expired entries in one commit.
A stale prune cannot remove a token whose known expiration has changed, and
local admission rejects a prune before its retention window. Pruning can lag
that time window while the server is idle or a backlog exists. Account/global
floors remain effective afterward. Established sockets can outlive JWT expiry;
this is not an indefinite single-token denial guarantee.
Housekeeping still scans the in-memory token map, and startup loads the retained
denial set. Large-community memory and latency costs have not been measured.

The Authority holds its revocation write guard across the durable/applied
command and publication to its in-memory auth view. HTTP/authentication and live
socket checks cannot see a successful in-memory mutation before that boundary.
An owned task carries commit and publication through a dropped request; caller
cancellation cannot strand an accepted denial outside the running auth view.
Logout, password/session/admin/operator revocation and moderation callers now
handle persistence errors; they do not report successful session revocation
when the engine refuses the write. Compound password, ownership and moderation
workflows still contain other writes and are not one atomic transaction.

## Legacy import and rollback

When no canonical initialization marker exists, Authority startup reads the
existing `revocations.json`, supporting both the earlier token-ID array and the
later token-to-expiration map. Invalid JSON, unknown fields and unsafe file
paths refuse startup instead of resetting denial state. Imports use batches of
at most 512 operations with a byte bound below the 4 MiB event limit. Supported
token IDs are at most 4,096 bytes; imported exemption sets contain at most 64
distinct IDs. An unsupported legacy value refuses startup rather than dropping
it silently.

The final import commit publishes the component's initialization marker. An
interruption before it keeps the Authority unavailable; restarting retries the
remaining import from the legacy source with idempotent transitions. Preserve
that source until migration has finished. Do not change it during an interrupted
import to remove denials already copied into WabiDB.

After initialization, WabiDB is canonical. The Authority neither rereads nor
rewrites the old file. A stale or malformed legacy file cannot override applied
canonical denials. Preserve it with stopped whole-instance backups while older
binaries and archives may still depend on it. **An older binary can ignore the
new event and read stale revocations:** rollback requires a matching stopped
backup or an explicit migration. Do not downgrade against the migrated live
tree and assume sessions remain revoked.

## Recovery boundary

A fenced database receiver can apply these encrypted events in commit order and
retain their index state after restart or full event replay. This replaces the
eventually copied sidecar as the canonical source for session revocations on a
matching binary. The migration marker certifies this component only; it is not
`fullInstanceReady`, a node enrollment credential, a quorum decision or permission
to promote a receiver.

Recovery codes and code-based ownership recovery now have their own
[ordered compound contract](ACCOUNT_RECOVERY_STATE.md). Other account/policy
sidecars, uploads, configuration, external stores and remaining compound
operation boundaries still need the complete
[instance consistency contract](../architecture/INSTANCE_RECOVERY_INVENTORY.md).
Replica lag must be respected: restoring an older prefix can still lack a later
revocation. Current asynchronous catch-up does not prove zero acknowledged data
loss, complete live recovery or survival of an unavailable Authority.

See [focused evidence](../testing/SESSION_REVOCATION_RECOVERY_2026-09-28.md) and
the [geographic community plan](../plans/2026-09-26-geographic-community-nodes.md).
