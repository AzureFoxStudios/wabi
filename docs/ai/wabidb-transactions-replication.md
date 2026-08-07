# WabiDB Transactions and Replication

## Transaction system

### ACID properties

**Atomicity**: all events in a transaction are written together or none at all. Burned sequence numbers ensure partial transactions don't consume IDs.

**Consistency**: schema validation at write time through projection handlers. Cryptographic validation (hashes, signatures) on all data.

**Isolation**: single sequencer (`Semaphore(1)`) ensures serializable isolation. Lock-free reads via SkipMap projections. Linearizability barrier ensures read-after-write consistency.

**Durability**: fsync before returning success. Batcher groups commits for efficient fsync while maintaining durability guarantees.

### Crash recovery

1. Lock file validation — ensure only one instance runs
2. Manifest loading — read storage configuration
3. Replay from commit index — rebuild state from durable log
4. Orphan handling — ignore writes not referenced in commit index (Option B)
5. Projection rebuild — use snapshots + post-snapshot journal entries
6. Subscription recovery — re-establish streams and resume from checkpoints

### Crash injection points (for testing)

| Point | Tests |
|-------|-------|
| `crash_before_any_write` | Burned-seq invariant |
| `crash_mid_stream_write` | Orphan skip in multi-stream transactions |
| `crash_before_index_fsync` | Option B recovery (ignore uncommitted writes) |
| `crash_after_index_fsync` | Durability-await correctness |
| `crash_after_projection_update` | Idempotency and replay safety |

### Key tuning parameters

- **Batch size**: commits per fsync (throughput vs latency tradeoff)
- **Batch age**: max time to wait for batch to fill
- **Sync timeout**: how long to wait for fsync completion
- **Sequencer channel size**: buffer for incoming commands
- **Dispatcher channel size**: buffer for projection updates

## Replication

### Architecture

Segment-shipping model: encrypted `.wseg` bytes transferred as base64, written to same path structure on replica.

### SyncTransport trait

```rust
pub struct SyncRequest {
    pub since_commit_seq: u64,
}

pub struct SyncResponse {
    pub since_commit_seq: u64,
    pub entries: Vec<CommitIndexEntry>,
    pub latest_commit_seq: u64,
}
```

### SyncWorker

Periodic synchronization with a remote peer:
- `new(peer_endpoint, sync_interval_micros)` — create worker
- `run_once()` — single sync cycle
- `run_forever()` — continuous sync loop

### HTTP endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/sync/pull` | POST | Pull changes from remote |
| `/api/v1/sync/push` | POST | Push changes to remote |
| `/api/v1/sync/status` | GET | Sync status |

### Protocol flow

1. Client requests changes since `commit_seq=100`
2. Server responds with entries 101-150 and `latest_commit_seq=150`
3. Client merges entries into local state
4. Client requests changes since `commit_seq=150`

### Standby

`/standby` REST group receives snapshots for warm-standby nodes.

### Mesh

`/mesh` multi-node coordination via `core/addons/mesh/backend` (workspace addon). Helper nodes via `/nodes`.

### Key pitfalls

- **Sequence number validation**: ensure sync responses contain only entries with `commit_seq > since_commit_seq`
- **Idempotency**: handle duplicate entries gracefully
- **Error handling**: properly handle network errors and invalid responses