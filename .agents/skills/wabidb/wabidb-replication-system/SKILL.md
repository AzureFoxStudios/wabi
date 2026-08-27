---
name: wabidb-replication-system
version: 0.1.0
author: Hermes
description: "Learn WabiDB replication system including SyncTransport and HTTP endpoints."
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Replication, WabiDB, SyncTransport, HTTP]
---

# WabiDB Replication System Learning Guide

This skill provides a structured approach to learning WabiDB's replication system, focusing on the SyncTransport trait and HTTP endpoints implementation.

## When to Use

- Implementing replication in WabiDB
- Understanding SyncTransport trait implementation
- Learning about WabiDB's replication protocol
- Studying HTTP endpoints for replication
- Implementing peer-to-peer synchronization
- Understanding replication worker patterns

## Prerequisites

- Access to WabiDB source code (specifically `src/replication/`)
- Understanding of Rust async programming
- Familiarity with HTTP protocols
- Basic knowledge of database replication concepts
- Understanding of WabiDB's commit index structure

## How to Run

Use these commands to explore the replication system:

```bash
# View SyncTransport implementation
read_file /var/home/Ronin/wabi/core/crates/wabidb/src/replication/sync_protocol.rs

# View SyncWorker implementation
read_file /var/home/Ronin/wabi/core/crates/wabidb/src/replication/sync_worker.rs

# Run replication tests
cargo test -p wabidb --test sync_protocol
cargo test -p wabidb --test sync_worker
```

## Quick Reference

| Component | Key Files | Key Functions | Purpose |
|-----------|-----------|--------------|---------|
| SyncTransport | `sync_protocol.rs` | `build_sync_request`, `apply_sync_response` | Define replication protocol |
| SyncWorker | `sync_worker.rs` | `new`, `run_once`, `run_forever` | Implement replication worker |
| HTTP Endpoints | `sync_endpoints.rs` | `handle_sync_request`, `handle_sync_response` | HTTP interface |

## Procedure

### 1. Understanding SyncTransport Trait

**Pattern**: The SyncTransport trait defines the replication protocol with request/response structures.

**Key Components**:
- `SyncRequest`: Contains `since_commit_seq` to specify sync starting point
- `SyncResponse`: Contains new entries, latest commit sequence, and sync base
- `build_sync_request`: Creates a sync request with given sequence number
- `apply_sync_response`: Merges remote entries into local state

**Example Implementation**:
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

### 2. Implementing SyncWorker

**Pattern**: The SyncWorker handles periodic synchronization with a remote peer.

**Key Components**:
- `new`: Creates a new worker with peer endpoint and interval
- `run_once`: Performs a single sync cycle
- `run_forever`: Runs continuous sync loop with interval
- `cycle_count`: Tracks sync cycles

**Example Implementation**:
```rust
pub struct SyncWorker {
    pub peer_endpoint: String,
    pub sync_interval_micros: u64,
    pub cycle_count: std::sync::atomic::AtomicU64,
}

impl SyncWorker {
    pub fn new(peer_endpoint: &str, sync_interval_micros: u64) -> Self {
        Self {
            peer_endpoint: peer_endpoint.to_string(),
            sync_interval_micros,
            cycle_count: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn run_once(&self) -> Result<()> {
        self.cycle_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    pub async fn run_forever(&self) -> Result<()> {
        loop {
            self.run_once()?;
            tokio::time::sleep(std::time::Duration::from_micros(self.sync_interval_micros)).await;
        }
    }
}
```

### 3. HTTP Endpoint Implementation

**Pattern**: HTTP endpoints provide the network interface for replication.

**Key Components**:
- `handle_sync_request`: Processes incoming sync requests
- `handle_sync_response`: Processes incoming sync responses
- `POST /api/v1/sync/pull`: Pulls changes from remote
- `POST /api/v1/sync/push`: Pushes changes to remote

**Example Endpoint**:
```rust
#[post("/api/v1/sync/pull")]
pub async fn handle_sync_request(
    State(state): State<Arc<WabiDbEngine>>,
    Json(request): Json<SyncRequest>
) -> Result<Json<SyncResponse>> {
    let entries = state.read_commit_index_entries(request.since_commit_seq).await?;
    let latest = state.latest_commit_seq().await?;
    Ok(Json(SyncResponse {
        since_commit_seq: request.since_commit_seq,
        entries,
        latest_commit_seq: latest,
    }))
}
```

### 4. Replication Protocol

**Pattern**: The replication protocol uses commit sequence numbers to track synchronization state.

**Key Components**:
- `since_commit_seq`: Specifies the starting point for synchronization
- `latest_commit_seq`: Tracks the most recent commit
- `CommitIndexEntry`: Contains the actual data to replicate

**Example Protocol Flow**:
1. Client requests changes since commit_seq=100
2. Server responds with entries 101-150 and latest_commit_seq=150
3. Client merges entries into local state
4. Client requests changes since commit_seq=150

### 5. Testing and Verification

**Pattern**: Comprehensive tests validate the replication system.

**Key Test Cases**:
- Sync request/response round-trip
- Idempotent application of sync responses
- Error handling for invalid sequences
- Cycle counting verification

**Example Test**:
```rust
#[tokio::test]
async fn apply_sync_response_adds_entries() {
    let mut state = vec![sample_entry(1), sample_entry(2)];
    let resp = SyncResponse {
        since_commit_seq: 2,
        entries: vec![sample_entry(3), sample_entry(4)],
        latest_commit_seq: 4,
    };
    apply_sync_response(&mut state, resp).unwrap();
    assert_eq!(state.len(), 4);
    assert_eq!(state[0].commit_seq, 1);
    assert_eq!(state[3].commit_seq, 4);
}
```

## Pitfalls

- **Sequence Number Validation**: Ensure sync responses contain only entries with commit_seq > since_commit_seq
- **Idempotency**: Handle duplicate entries gracefully
- **Error Handling**: Properly handle network errors and invalid responses
- **Cycle Counting**: Use atomic operations for thread-safe counting
- **State Merging**: Maintain commit sequence order during merging
- **HTTP Endpoint Design**: Ensure endpoints are idempotent and stateless

## Verification

Confirm your understanding by running these commands:

```bash
# Run SyncTransport tests
cargo test -p wabidb --test sync_protocol

# Run SyncWorker tests
cargo test -p wabidb --test sync_worker

# Run HTTP endpoint tests
cargo test -p wabidb --test sync_endpoints
```

These tests should all pass, demonstrating the key aspects of WabiDB's replication system.