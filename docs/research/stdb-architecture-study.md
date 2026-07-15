# SpacetimeDB Architecture Study

> An independent technical review conducted from the perspective of a self-hosted, privacy-first chat/social platform evaluating whether to keep using SpacetimeDB or build a purpose-built replacement.
>
> Source tree: `/var/home/Ronin/vendor/SpacetimeDB` (tag v2.6.0)
> Date: 2026-06-18

---

## 1. What SpacetimeDB Actually Is

SpacetimeDB is a combined database engine and application runtime that compiles user-supplied modules (Rust, C#, TypeScript/JavaScript via V8, or C++) into WASM or V8 bytecode, executes them as "reducers" within database transactions, and pushes live row-level deltas to subscribed WebSocket clients. The canonical deployment model is a single binary (`spacetimedb`) that acts as both the storage engine and the application server.

The "zen" of SpacetimeDB can be summarized as: **in-memory committed state + append-only commitlog for durability**. There is no page buffer pool cache in the traditional sense — the entire committed state of every table lives in memory as a collection of BTree-backed pages (`crates/table/src/table.rs`, the `Table` struct). The commitlog (`crates/commitlog/src/lib.rs`) serves as the write-ahead log: every committed transaction is serialized and appended before the outcome is reported to the caller. Snapshots (`crates/snapshot/src/lib.rs`) exist as a recovery optimization so that restarting a database does not require replaying the entire commitlog from offset 0.

The key architectural claim — "the database is the server" — is realized through this colocation: client connections arrive over WebSocket (or HTTP for ad-hoc queries), the connection handler deserializes the reducer call, the module host invokes the WASM/V8 function inside a transaction, the transaction commits to the in-memory state and the commitlog, and the subscription manager computes the delta between the pre- and post-transaction state and pushes it to every subscribed client. All of this happens in a single process.

The workspace at `/var/home/Ronin/vendor/SpacetimeDB/Cargo.toml:118` declares version `2.6.0`, edition `2024`, rust-version `1.93.0`.

The database side is built on a collection of carefully separated Rust crates — roughly 40+ workspace members — that the rest of this document will walk through in detail. From a product perspective, what a user or operator sees is: a single `spacetimedb start` command boots an HTTP+WebSocket server that accepts connections, module uploads, and SQL queries. The server compiles uploaded modules (Rust via `wasm-pack`, C# via the `spacetimedb-csharp-codegen` toolchain, TypeScript via rolldown + V8), runs them, and maintains the database state. There is no separate database process, no ORM, no API gateway to deploy. This colocation is the defining architectural decision.

---

## 2. License and Licensing Reality

The repository is licensed under the **Business Source License 1.1** (BSL 1.1), with the full text at `/var/home/Ronin/vendor/SpacetimeDB/LICENSE.txt`.

### Key license parameters (lines 7-27):

- **Licensor**: Clockwork Laboratories, Inc.
- **Licensed Work**: SpacetimeDB 2.6.0
- **Additional Use Grant** (lines 12-16):
  > You may make use of the Licensed Work provided your application or service uses the Licensed Work with no more than one SpacetimeDB instance in production and provided that you do not use the Licensed Work for a Database Service.
- **"Database Service" definition** (lines 18-22):
  > A "Database Service" is a commercial offering that allows third parties (other than your employees and contractors) to access the functionality of the Licensed Work by creating tables whose schemas are controlled by such third parties.
- **Change Date**: 2031-06-15 (line 24)
- **Change License**: GNU Affero General Public License v3.0 with a linking exception (lines 26-27)

### Practical implications for a self-hosted chat platform

The "one SpacetimeDB instance in production" restriction means that an app running its own single SpacetimeDB server for its own users is within the Additional Use Grant. However, any scenario that requires _multiple_ logical databases (e.g., per-community isolated databases for privacy compartmentalization) would need either an explicit commercial license or a creative interpretation of "one instance." The Database Service clause targets cloud providers reselling STDB as a service — it does not appear to restrict an app that controls its own tables. But the "one instance" constraint is a meaningful architectural limitation: you cannot shard across multiple STDB processes without a license negotiation.

The change license (AGPLv3 + linking exception) means that after June 2031, the code becomes AGPL with an additional permission that waives the network-interaction source distribution requirement for modified versions that link to STDB. Before that date, the BSL terms apply.

The local clone is definitively identified as **SpacetimeDB 2.6.0** at `Cargo.toml:118`.

---

## 3. Crate Layout and Responsibilities

The workspace members are declared at `Cargo.toml:3-79`. Below is a crate-by-crate breakdown.

The crate map is not a random decomposition — each line maps to a separable concern that a reimplementation would either adopt or deliberately replace. Below is the catalog.

### `crates/core` (spacetimedb-core)
The central orchestrator. Contains the `HostController` (`src/host/host_controller.rs`), module host actor (`src/host/module_host.rs` and `src/host/wasm_common/module_host_actor.rs`), subscription manager (`src/subscription/module_subscription_manager.rs`), client connection handling, identity/auth, the scheduler (`src/host/scheduler/`), and the `WasmInstanceEnv` host function bridge (`src/host/mod.rs`). Every running module is registered in `HostController.hosts` as a `HostCell` — an `Arc<AsyncRwLock<Option<Host>>>` in an `IntMap<u64, HostCell>` (lines 67-70). The `HostController` also owns the shared `PagePool` (line 114) and the `BsatnRowListBuilderPool` (line 120).

### `crates/engine` (spacetimedb-engine)
The `RelationalDB` struct (`src/relational_db.rs`) and persistence wiring (`src/persistence.rs`). `RelationalDB` wraps `Locking` (the MVCC datastore), the durability layer, and the snapshot worker. Provides `begin_mut_tx`, `commit_tx`, `rollback`, and `open` (which does snapshot restore + commitlog replay). The `SNAPSHOT_FREQUENCY` constant at line 126 is 1,000,000 transactions.

### `crates/datastore` (spacetimedb-datastore)
The transactional storage core. `Locking` (`src/locking_tx_datastore/datastore.rs`) holds a `CommittedState` behind an `Arc<RwLock<...>>` and a `SequencesState` behind `Arc<Mutex<...>>`. Lock ordering is documented at lines 54-61: `memory`, then `committed_state`, then `sequence_state`. Contains `TxId` (read-only transaction), `MutTxId` (mutable transaction), `TxState` (per-tx dirty state), `CommittedState` (the in-memory committed snapshot), and the replay logic (`src/locking_tx_datastore/replay.rs`). The `IsolationLevel` enum (`src/traits.rs`) defines `Serializable` and `Snapshot` variants.

### `crates/commitlog` (spacetimedb-commitlog)
The write-ahead log. `Commitlog<T, R>` (`src/lib.rs:164`) is parameterized by record type `T` (canonically `payload::Txdata`) and repository backend `R` (canonically `repo::Fs`). The `Options` struct (lines 42-101) controls segment size (default 1 GiB), offset index interval (default 4 KiB), fsync behavior, write buffer size (default 128 KiB). Records are committed via `Commitlog::commit()` which writes a batch of `Transaction<T>` as a single `Commit`. The payload `Txdata` is defined in `src/payload/txdata.rs` and encodes the full set of row inserts and deletes per table.

### `crates/durability` (spacetimedb-durability)
The abstract `Durability` trait (`src/lib.rs:127`): `append_tx`, `durable_tx_offset`, `close`. Also the `History` trait (line 185): `fold_transactions_from`, `transactions_from`, `tx_range_hint`. The local (commitlog-based) implementation is in `src/imp/`.

### `crates/snapshot` (spacetimedb-snapshot)
Snapshot create/restore. `SnapshotRepository` (`src/lib.rs:750`) holds a directory, database identity, and replica id. `create_snapshot` (line 781) captures pages and blobs at a given `TxOffset` into an `UnflushedSnapshot`, which is later made durable by `sync_all`. Snapshots are content-addressed: pages and blobs are stored as files named by their BLAKE3 hash, enabling hardlink-based deduplication across snapshots via `prev_snapshot`. `read_snapshot` (line 959) reconstructs a `ReconstructedSnapshot` containing a `HashMapBlobStore` and a `BTreeMap<TableId, Vec<Box<Page>>>`.

### `crates/table` (spacetimedb-table)
The `PagePool` (`src/page_pool.rs`), `BlobStore` trait and `HashMapBlobStore` (`src/blob_store.rs`), `Table` struct with indexes and BTree-backed pages, `RowPointer`, and the page layout (`src/page.rs`, `src/pages.rs`). The page pool is an object pool of `Box<Page>` that is shared across all databases on a host (see `HostController.page_pool` at `crates/core/src/host/host_controller.rs:114`). This is not per-database — it is a single pool that all `CommittedState`s on the same process draw from.

### `crates/subscription` (spacetimedb-subscription)
The subscription plan and evaluation compiler. `SubscriptionPlan` (`src/lib.rs`) holds compiled `Fragments` (insert and delete plan fragments built from `PipelinedIxScan`, `PipelinedIxJoin`, `PipelinedProject`). `compile_from_plan` produces these from a `PhysicalPlan`. The subscription SQL is compiled via `compile_subscription` from `crates/query/`.

### `crates/lib` (spacetimedb-lib)
Schema definitions, the SATS typespace, `AlgebraicType` / `AlgebraicValue`, `ProductType` / `ProductValue`, `Identity`, `ConnectionId`, the `RawModuleDefV9/V10` builders, and the `RawTableDefV10` with its `is_event` field (`src/db/raw_def/v10.rs:279-284`).

### `crates/sats` (spacetimedb-sats)
The Spacetime Algebraic Type System (SATS) and BSATN (binary SATS) encoding/decoding. All types used in tables, subscriptions, and the commitlog are expressed as `AlgebraicType`s and serialized as `AlgebraicValue`s through BSATN.

### `crates/bindings`, `crates/bindings-macro`, `crates/bindings-sys`
The Rust module author SDK. `spacetimedb::table`, `spacetimedb::reducer`, `spacetimedb::procedure`, etc. These macros generate the `__describe_module__`, `__call_reducer__`, etc. exports and (de)serialize the C ABI between the module and host.

### `crates/standalone` (spacetimedb-standalone)
The server binary. `main.rs` and `src/lib.rs` wire together: a `ControlDb` (sled-backed metadata store, `src/control_db.rs`), `DiskStorage` for module bytes, `HostController`, `ClientActorIndex`, Prometheus metrics, the JWT auth provider, WebSocket options. `StandaloneEnv::init` (line 63) orchestrates all of this.

### `crates/client-api` and `crates/client-api-messages`
HTTP and WebSocket route handlers. WebSocket upgrade, subscription messages, the v1 and v2 protocol message types (`ws_v1::*`, `ws_v2::*`). The v2 protocol is the typed-query-builder protocol; v1 is the legacy JSON/BSATN protocol.

### `crates/client` (in core)
Client connection actor loop, `ClientConnectionSender`, `ClientActorIndex`, message serialization.

### `crates/sql-parser` and `crates/query`
SQL parsing (via `sqlparser` crate) and query compilation into physical plans. `crates/query/src/lib.rs` has `compile_subscription` for subscription compilation and `compile_query` for ad-hoc query compilation.

### `crates/physical-plan`, `crates/execution`, `crates/expr`, `crates/query-builder`
The query plan layer. `PhysicalPlan` types (`IxScan`, `TableScan`, `ProjectPlan`, `JoinPlan`), `PipelinedExecutor` (`crates/execution/src/pipelined/`), `CollectViews`, `ParamResolver`. The `query-builder` crate provides the V2 typed-query-builder protocol used by newer SDKs.

### `crates/v8` (in core at `src/host/v8/`)
V8 module runtime. `JsMainInstance` for the main lane (reducers, subscriptions, one-off queries) and `JsProcedureInstance` for the procedure pool. Described in the module-level doc comment at `src/host/v8/mod.rs:1-55`. Worker threads hold their own V8 isolates.

### `crates/wasmtime` (in core at `src/host/wasmtime/`)
WASM module runtime via Wasmtime. `ModuleInstance`, `WasmtimeModule`, fuel-based energy budgeting.

### `crates/wasm_common` (in core at `src/host/wasm_common/`)
The `WasmModuleHostActor` at `src/host/wasm_common/module_host_actor.rs` and the `WasmInstance` trait (line 79): `call_reducer`, `call_procedure`, `call_view`, `call_view_anon`, `call_http_handler`. Shared by both WASM and V8 backends.

### `crates/fs-utils`, `crates/paths`, `crates/runtime`, `crates/data-structures`
Utility crates. `fs-utils` has `DirTrie` (content-addressed directory tree), `CompressReader/Writer`, `lockfile`. `paths` provides strongly-typed path wrappers (`ServerDataDir`, `ReplicaDir`, `CommitLogDir`, `SnapshotsPath`, etc.). `runtime` provides `Handle` for tokio runtime handles. `data-structures` provides custom `HashMap`, `HashSet`, `IntMap`, `Pool`, `SmallHashMap`, `ErrorStream`.

### `crates/schema` (spacetimedb-schema)
The canonical `TableSchema`, `ColumnSchema`, `IndexSchema`, `ViewDef`, `ModuleDef`, `ReducerDef`, `ProcedureDef`, migration planning (`auto_migrate`). This crate is where the type-level representation of "what a table is" lives. If Wabi defines its own schema system, this is the crate to study for the feature surface.

---

## 4. Storage Model: Pages, Tables, and Blobs

### Page Pool

The `PagePool` at `crates/table/src/page_pool.rs:26` wraps a generic `Pool<Box<Page>>` — an object pool of `Page` boxes. It is shared across all databases on a host. The `HostController` holds one `pub page_pool: PagePool` at `crates/core/src/host/host_controller.rs:114`. Every `Locking` datastore and its `CommittedState` hold a handle to this same pool.

`PagePool::new` (line 44) accepts an optional max size in bytes (default 128 × `size_of::<Page>()`). `take_with_fixed_row_size` retrieves or creates a page configured for a given fixed row size. `put` returns a page to the pool.

### Pages

Each `Page` (`crates/table/src/page.rs`) is a fixed-size block that can hold multiple rows of a single table. The page tracks which slots are occupied via a bitset (`present_rows`). Pages are BTree leaves: a `Table` is a collection of pages organized in a BTree keyed by row pointer.

### Tables

`Table` (`crates/table/src/table.rs`) wraps a `BTreeMap<RowPointer, Box<Page>>` plus indexes. When rows are inserted, they fill slots in existing pages or allocate new ones from the `PagePool`. The `BlobStore` is threaded through all table operations so that large variable-length columns are stored as content-addressed blobs rather than inline in the page BTree.

### Blob Store

`BlobStore` trait at `crates/table/src/blob_store.rs:67`:
- `clone_blob` (reference count increment)
- `insert_blob` (content-address + store)
- `retrieve_blob`
- `free_blob` (refcount decrement)
- `iter_blobs` (for snapshot creation)
- `insert_with_uses` (for snapshot restore)

`HashMapBlobStore` (line 164) is the default in-memory implementation — a `HashMap<BlobHash, BlobObject>` where `BlobObject` holds a `uses: usize` refcount and `blob: Box<[u8]>`. Blobs are content-addressed via BLAKE3 of their bytes (`BlobHash::hash_from_bytes`, line 36). This store is used directly in `CommittedState` (`crates/datastore/src/locking_tx_datastore/committed_state.rs:66`: `pub(crate) blob_store: HashMapBlobStore`).

### Page Pool Sharing

The page pool is explicitly shared across databases. From `CommittedState` at `crates/datastore/src/locking_tx_datastore/committed_state.rs:74-77`:
> "Between transactions, this is untouched. During transactions, the [`MutTxId`] can steal pages from the committed state. This is a handle on a shared structure. Pages are shared between all modules running on a particular host, not allocated per-module."

---

## 5. Commitlog and Durability

### Commitlog Structure

The `Commitlog` at `crates/commitlog/src/lib.rs:164` is the canonical WAL. The `Options` struct (lines 42-101):
- `max_segment_size`: default 1 GiB (line 110)
- `offset_index_interval_bytes`: default 4 KiB (line 111)
- `offset_index_require_segment_fsync`: default true (line 112)
- `write_buffer_size`: default 128 KiB (line 114)
- `preallocate_segments`: default false (line 113)

Records are appended via `Commitlog::commit()` (line 475), which takes an `IntoIterator<Item = Transaction<T>>`. The method acquires a write lock on `inner`, writes the commit, and returns a `Committed` struct containing the offset range and checksum. Data is buffered; callers must call `flush()` or `flush_and_sync()` to persist to storage.

The commitlog segment is the on-disk file. Each segment has a log format version, a header, and a sequence of commits. The `repo::Fs` backend creates files in the directory given by `CommitLogDir`. Segments are named by their starting transaction offset.

### Durability Trait

`crates/durability/src/lib.rs:127` defines the `Durability` trait: `append_tx` (non-blocking), `durable_tx_offset` (returns a `DurableOffset` handle), and `close` (async shutdown). The `History` trait (line 185) provides replay via `fold_transactions_from` and `transactions_from`.

The local implementation (in `crates/durability/src/imp/`) wraps a `Commitlog` and a background flush/sync worker. `append_tx` submits a `PreparedTx<Txdata>` to an internal channel; a worker drains the channel and writes to the commitlog, calling `flush_and_sync` periodically.

### RelationalDB Persistence Wiring

`crates/engine/src/persistence.rs` exposes `DurabilityConfig` and `CommitlogConfig` that map user-facing config to `spacetimedb_durability::local::Options` and `spacetimedb_commitlog::Options`. `LocalPersistenceProvider` creates per-replica commitlog directories and snapshot directories.

### Snapshots

`crates/snapshot/src/lib.rs:3-7`:
> "A snapshot is an on-disk view of the committed state of a database at a particular transaction offset. Snapshots exist as an optimization over replaying the commitlog; when restoring to the most recent transaction, rather than replaying the commitlog from 0, we can reload the most recent snapshot, then replay only the suffix of the commitlog."

`SnapshotRepository::create_snapshot` (line 781) captures all tables (pages) and blobs into a content-addressed object repository using `DirTrie`. Objects are stored as files named by their BLAKE3 hash. If a `prev_snapshot` is supplied, objects are hardlinked to avoid re-writing unchanged pages/blobs.

`read_snapshot` (line 959) reads a `ReconstructedSnapshot` containing a `HashMapBlobStore` and a `BTreeMap<TableId, Vec<Box<Page>>>`. The caller (typically `RelationalDB::open`) installs these into a new `Locking` / `CommittedState`.

### Replay

`crates/datastore/src/locking_tx_datastore/replay.rs:35` starts `apply_history`, which creates a `Replay` struct and calls `history.fold_transactions_from(start_tx_offset, &mut replay)`. The `Replay` struct implements `Decoder` — each `decode_record` call processes one transaction by iterating over its table entries and calling `replay_insert` or `replay_delete`.

### Full Durability Pipeline

1. A reducer runs inside a `MutTxId`. On commit (`RelationalDB::commit_tx`), the `TxState` is merged into `CommittedState` and the `TxData` is serialized.
2. The `TxData` is sent to the durability layer via `append_tx`.
3. The durability worker writes the `TxData` to the commitlog buffer and periodically calls `flush_and_sync`.
4. When the durable offset advances by `SNAPSHOT_FREQUENCY` (1,000,000), a snapshot is triggered.
5. On restart, `RelationalDB::open` calls `restore_from_snapshot_or_bootstrap` to load the latest snapshot, then `apply_history` to replay the commitlog suffix after the snapshot's offset.

---

## 6. Transaction Model: MVCC, Locking, and Isolation

### Locking Architecture

The top-level datastore is `Locking` at `crates/datastore/src/locking_tx_datastore/datastore.rs:64`:

```rust
pub struct Locking {
    pub committed_state: Arc<RwLock<CommittedState>>,
    pub(super) sequence_state: Arc<Mutex<SequencesState>>,
    pub(crate) database_identity: Identity,
}
```

The lock acquisition order is documented at lines 54-61: `memory` → `committed_state` → `sequence_state`. This ordering prevents deadlocks.

### Read Transactions (`TxId`)

`TxId` (`crates/datastore/src/locking_tx_datastore/tx.rs:26`) holds a `SharedReadGuard<CommittedState>` — a shared (read) lock on the committed state. Multiple readers can proceed concurrently. The `TxId` implements `StateView` for scans and index lookups.

### Write Transactions (`MutTxId`)

`MutTxId` (`crates/datastore/src/locking_tx_datastore/mut_tx.rs`) acquires an exclusive (write) lock on `CommittedState`. While held, it also holds a `TxState` that accumulates dirty data: `insert_tables`, `delete_tables`, `pending_schema_changes`. Writers **serialize** — only one mutable transaction can be in-flight at a time per database.

### TxState

`TxState` at `crates/datastore/src/locking_tx_datastore/tx_state.rs:21-47`:
- `insert_tables: BTreeMap<TableId, Table>` — rows inserted during this transaction.
- `delete_tables: BTreeMap<TableId, DeleteTable>` — rows deleted during this transaction.
- `blob_store: HashMapBlobStore` — blobs inserted in this transaction.
- `pending_schema_changes: Vec<PendingSchemaChange>` — schema mutations (create table, drop table, create index, drop index).

### Commit Path

When `RelationalDB::commit_tx` is called, the `MutTxId` is consumed:
1. The in-memory state in `CommittedState` is updated with the inserted/deleted rows from `TxState`.
2. The committed `TxData` (the delta) is serialized for the commitlog.
3. The write lock is released.
4. The `TxData` is sent to the durability layer.
5. The subscription manager receives the delta and evaluates subscription queries.

### Rollback

Rollback reverses schema changes in reverse order (`CommittedState::rollback`, line 679). Inserted pages are returned to the page pool. Deleted rows are unmarked.

### Isolation Level

`IsolationLevel` at `crates/datastore/src/traits.rs:23-100` defines `Serializable` and `Snapshot`. The documentation explains that the datastore must treat unsupported isolation levels as the strongest supported level. In practice, the serialized-writer model plus snapshot reads means the effective isolation is serializable for writers (only one writer at a time) and snapshot for readers (readers see a consistent committed-state snapshot taken at their start).

### View Read Sets

`CommittedState` also tracks `view_read_sets: IntMap<ViewId, ViewReadSets>` (at `committed_state.rs:81+`). These track which tables each view reads from. When a reducer writes to a table, the system checks whether any view reads that table; if so, the view is re-evaluated. This is the core of the incremental view maintenance system.

---

## 7. Module Host: WASM and V8

### HostController

`crates/core/src/host/host_controller.rs:98` is the central registry:
- `hosts: Hosts` (i.e., `Arc<Mutex<IntMap<u64, HostCell>>>`)
- `page_pool: PagePool` — shared across all databases
- `runtimes: Arc<HostRuntimes>` — holds `WasmtimeRuntime` and `V8Runtime`
- `energy_monitor: Arc<dyn EnergyMonitor>`
- `persistence: Arc<dyn PersistenceProvider>`

Each `HostCell` is an `Arc<AsyncRwLock<Option<Host>>>`. A `Host` wraps a `ModuleHost` (behind a watch channel for live-update subscribers) and a `DatabaseLogger`.

### WASM Runtime

The Wasmtime runtime at `crates/core/src/host/wasmtime/` uses fuel metering for energy budgeting. `WasmtimeModule` compiles the WASM bytecode. `ModuleInstance` (a `WasmtimeModule` plus an instantiated `Instance`) holds the store and linker. Fuel is set via `FunctionBudget::DEFAULT_BUDGET` when an instance is created; each WASM instruction consumes fuel, and when fuel runs out the reducer is terminated with `OutOfEnergy`.

The async variant is used for procedures; the sync variant is used for the main reducer/query lane.

### V8 Runtime

`crates/core/src/host/v8/mod.rs:1-55` describes the topology:
- A single `SharedJsMainInstanceManager` thread (one V8 isolate, mpsc-queued) handles reducers, subscriptions, and one-off queries.
- A separate bounded `ModuleInstanceManager<JsModule>` pool handles procedures. Each procedure instance is an independent thread with its own isolate.
- After a trap or heap retirement, the isolate is replaced inline.

### The WasmInstance Trait

`crates/core/src/host/wasm_common/module_host_actor.rs:79`:
```rust
pub trait WasmInstance {
    fn call_reducer(&mut self, op: ReducerOp<'_>, budget: FunctionBudget) -> ReducerExecuteResult;
    fn call_view(&mut self, op: ViewOp<'_>, budget: FunctionBudget) -> ViewExecuteResult;
    fn call_view_anon(&mut self, op: AnonymousViewOp<'_>, budget: FunctionBudget) -> ViewExecuteResult;
    fn call_procedure(&mut self, op: ProcedureOp, budget: FunctionBudget) -> impl Future<...>;
    fn call_http_handler(&mut self, ...);
    fn extract_descriptions(&mut self) -> Result<RawModuleDef, DescribeError>;
}
```

This trait is shared by both WASM and V8 backends, providing a uniform interface to the module host actor.

### Host Functions (Module ABI)

The host functions (tagged exports from the module to the host runtime) are declared and dispatched through `WasmInstanceEnv` at `crates/core/src/host/mod.rs`. The C ABI that modules use includes: `_console_log`, `_buffer_alloc`, `_schedule_reducer`, `_cancel_reducer`, `_insert`, `_delete`, `_iter`, `_datastore_table_row_count`, etc. Modules export: `__describe_module__`, `__call_reducer__`, `__call_procedure__`, `__call_view__`, `__call_view_anon__`, `__call_http_handler__`.

### Energy Budget

`FunctionBudget` from `spacetimedb_client_api_messages::energy::FunctionBudget` limits how many "instructions" a single reducer/procedure can execute. `ReducerOutcome::BudgetExceeded` (host_controller.rs:175) is returned when the budget is exhausted.

---

## 8. Reducers, Procedures, Views, HTTP Handlers

### Reducers

Reducers are transactional, atomic functions. The module host calls `__call_reducer__` on the WASM/V8 instance, passing the reducer name and arguments encoded as BSATN. The reducer runs inside a `MutTxId` (exclusive write lock). If it succeeds, the transaction is committed: `EventStatus::Committed(DatabaseUpdate)`. If it fails (panic, trap, budget exceeded), the transaction is rolled back and the error is reported: `EventStatus::FailedUser` or `EventStatus::OutOfEnergy`. The reducer result is serialized in `EventStatus` at `crates/core/src/host/module_host.rs`.

### Procedures

Procedures (`__call_procedure__`) can span multiple transactions. They hold an exclusive instance (for V8) or an async WASM instance. The procedure can explicitly commit intermediate state and continue. Unlike reducers, procedure results return values and sub-steps are not automatically emitted as Event entries.

### Views

Views (`__call_view__`) are read-only. They do not open a transaction; they operate on a `TxId` (shared lock). Views can be parameterized (with argument restrictions). Parameterized views are interpreted via `ViewDef` and have result size limits. Anonymous views (`__call_view_anon__`) return raw SQL results without a pre-defined schema.

### HTTP Handlers

`__call_http_handler__` receives `HttpRequest` and returns `HttpResponse`. Routes are registered by the module and dispatched by the host.

### Signatures (from module_host.rs)

The call signatures in `ModuleHost` (the higher-level struct, not the `WasmInstance` trait) include:
- `call_reducer` — name, args, auth context, caller connection, energy budget → `ReducerCallResult`
- `call_procedure` — procedure id, args → `ProcedureCallResult`
- `call_view` — view id, args → `ViewCallResult`
- `call_view_anon` — SQL string → `ViewCallResult`
- `call_http_handler` — request → `HttpHandlerCallResult`

---

## 9. Subscriptions: SQL → Plan → Evaluation → Broadcast

### Subscription Manager

The central actor is `SubscriptionManager` at `crates/core/src/subscription/module_subscription_manager.rs`. It tracks:
- `clients: HashMap<ClientId, ClientInfo>` — each with `v1_subscriptions`, `v2_subscriptions`, `legacy_subscriptions`, and a `dropped` flag.
- `queries: HashMap<QueryHash, QueryState>` — cached subscription plans.
- `search_args: SearchArguments` — `(TableId, ColId, AlgebraicValue) → HashSet<QueryHash>`: an index mapping "which queries are interested in a given column value being inserted/deleted."
- `join_edges: SearchArguments` — similar index for join conditions.
- `tables: IntMap<TableId, HashSet<QueryHash>>` — "which queries are interested in any change to this table."
- `indexes: QueriedTableIndexIds` — refcounted index usage tracking.

### Query Compilation

When a client subscribes (`crates/core/src/subscription/subscription.rs`), the SQL string is compiled via `SubscriptionPlan::compile_plans`. The subscription SQL subset is intentionally restricted: `SELECT * FROM table` (no arbitrary projections), optional `WHERE` clause with indexed columns, optional `JOIN` with one other table on indexed columns, no aggregates, no subqueries, no `ORDER BY`, no `GROUP BY`. The compiler produces one or more `SubscriptionPlan` objects (at `crates/subscription/src/lib.rs`), each containing `Fragments` with `insert_plans` and `delete_plans` as `PipelinedProject` vectors.

### Delta Evaluation

When a transaction commits, `eval_updates_sequential` (line 1346) processes the delta:

1. The `DeltaTx` wraps a `TxId` (for committed state reads) plus `DeltaTableIndexes` (small BTree indexes built from the changed rows for fast lookups).
2. For each changed row, `queries_for_row` (line 1321) looks up the `QueryHash` set from `search_args` and `join_edges`.
3. Only the queries whose hash appears in the lookup results are re-evaluated — not all subscriptions.
4. `eval_delta` at `crates/core/src/subscription/delta.rs:19` runs the `SubscriptionPlan` over the `DeltaTx`, collecting `inserts` and `deletes` as `UpdatesRelValue`. The function explicitly documents bag semantics (line 12-17): duplicate rows from joins are NOT removed.
5. The result (`ComputedQueries`) is sent over a channel to the `SendWorker`.

### SendWorker

The `SendWorker` (line 1714) is an off-main-thread async task. It receives `SendWorkerMessage::Broadcast` messages and aggregates per-client updates. Key optimization (from the comment at line 1385-1387):
> "We've now finished all of the work which needs to read from the datastore, so get this work off the main thread and over to the send_worker, then return ASAP in order to unlock the datastore and start running the next transaction."

The worker (at `send_one_computed_queries`, line 1881+):
1. Groups `ClientUpdate`s by `(ClientId, TableId)`.
2. For each client, stitches all table updates into a single `DatabaseUpdate`.
3. Sends the update to the client's `ClientConnectionSender`.

This design ensures per-client update cost scales with `O(updates touched)` rather than `O(subscriptions × transactions)`.

### WebSocket Framing

Two protocols exist:
- **v1** (`ws_v1`): JSON or BSATN. Each subscription is a SQL string sent via `Subscribe` message. Updates are sent as `DatabaseUpdate` messages with `table_updates` per table.
- **v2** (`ws_v2`): The typed-query-builder protocol. Subscriptions use `QuerySetId`-keyed query sets. Introduces `TableUpdateRows` with per-row data. Two-phase subscribe: apply the initial snapshot, then subscribe to incremental updates.

### RLS Integration

Row-Level Security filters are compiled into the subscription plan as additional WHERE clauses. The RLS expression is a `RowLevelExpr` from `crates/engine/src/sql/rls.rs`. Module owners bypass RLS; subscriber clients do not.

---

## 10. Event Tables: The Special "Ephemeral" Tier

Event tables are a SpacetimeDB feature for data that should be broadcast to subscribers in the transaction that inserts it, but **not** merged into the committed in-memory state for future transactions.

### Declaration

Tables are declared as event tables via the `#[table(..., event)]` attribute in Rust, or the equivalent in other languages. The `is_event: bool` field lives in `RawTableDefV10` at `crates/lib/src/db/raw_def/v10.rs:279-284`:
```rust
/// Whether this is an event table.
///
/// Event tables are write-only: their rows are persisted to the commitlog
/// but are NOT merged into committed state. They are only visible to V2
/// subscribers in the transaction that inserted them.
pub is_event: bool,
```

### Behavior in CommittedState

In `CommittedState::merge_apply_inserts` at `crates/datastore/src/locking_tx_datastore/committed_state.rs:619-622`:
```rust
if schema.is_event {
    // For event tables, we don't want to insert into the committed state,
    // we just want to include them in subscriptions and the commitlog.
    Self::collect_inserts(page_pool, truncates, tx_data, &tx_bs, table_id, tx_table, |_| {});
}
```

The rows are collected into `TxData` (for the commitlog and subscriptions) but the commit-table insert is skipped.

### Behavior in Replay

In `Replay::replay_insert` at `crates/datastore/src/locking_tx_datastore/replay.rs:754-758`:
```rust
// Event table rows in the commitlog are preserved for future replay features
// but don't rebuild state — event tables have no committed state.
if schema.is_event {
    return Ok(());
}
```

The comment explicitly states: event table rows **are** serialized into `TxData` and written to the commitlog. They are just not re-inserted into the committed state on replay.

### Behavior in Subscriptions

In `get_all` at `crates/core/src/subscription/subscription.rs:26`:
```rust
.filter(|t| t.table_type == StTableType::User && auth.has_read_access(t.table_access) && !t.is_event)
```

Event tables are excluded from the initial "subscribe all" query. They are only visible to queries that explicitly select from them, and only see rows inserted in the current transaction (since no committed rows exist).

### Subscription Behavior (Verified)

Event tables are excluded from the initial "subscribe all" query. They are only visible to queries that explicitly select from them, and only see rows inserted in the current transaction (since no committed rows exist).

A subscription that includes an event table evaluates rows as part of the current transaction's delta only. The `returns_event_table()` method on the subscription `Plan` (at `crates/core/src/subscription/module_subscription_manager.rs:146`) signals that the delta for this subscription should include event-table rows for the current transaction.

### **CORRECTION (Verified Against Source 2026-06-18)**

A previous version of this section claimed that event tables have a `private` flag and a `sender` column, and that rows are visible only to V2 (typed-query-builder) subscribers. **These claims are not supported by the actual STDB 2.6.0 source.** Verified against `crates/datastore/src/system_tables.rs:1783-1785`:

```rust
pub struct StEventTableRow {
    pub(crate) table_id: TableId,
}
```

`StEventTableRow` has exactly **one field**: `table_id`. The `StEventTableFields` enum at line 435 also has only one field: `table_id`. There is **no `private` column, no `sender` column, and no V2-only gating** in the current STDB source. Any per-recipient privacy model must be built at the application layer; STDB does not provide it via event tables.

WabiDB's ephemeral tier does not depend on these features. WabiDB simply does not write ephemeral rows to SQLite at all, which sidesteps the entire class of "how do we ensure per-recipient privacy on a public commitlog" concerns.

### Critical Privacy Implication

The fact that event table rows **are** written to the commitlog is a critical consideration for a privacy-first platform. Even though event tables appear ephemeral (rows vanish after the transaction), the commitlog on disk retains the serialized `TxData`. An attacker with disk access or an operator who retains commitlog files can reconstruct all event table rows. There is no built-in mechanism to purge event rows from the commitlog after a retention period. The comment at `replay.rs:754-758` says "Event table rows in the commitlog are preserved for future replay features" — this is intentional, not an oversight.

---

## 11. File / Binary Storage in Columns

SpacetimeDB supports `Vec<u8>` (Rust), `List<byte>` (C#), `std::vector<uint8_t>` (C++), and `t.array(t.u8())` (TypeScript) as column types. Binary data is stored inline in the row when it fits, and as a blob-store entry (content-addressed via BLAKE3) when it exceeds a threshold.

The 2.0 documentation (`docs/docs/00200-core-concepts/00300-tables/00210-file-storage.md`) describes binary column storage:
- Files up to ~100 MiB are supported inline.
- Rows (including binary columns) are held in memory during reducer execution.
- Binary columns participate in transactions and subscriptions just like any other column.
- If binary data exceeds available memory during reducer execution, the system will be under memory pressure.

For a chat platform, this means voice notes, image attachments, and audio frames can be stored directly in tables with transactional guarantees. The subscription system will push new binary rows to subscribed clients automatically. However, the in-memory requirement means large binary storage is expensive — every binary value in a row is present in the committed state's in-memory blob store.

---

## 12. SQL: Shape, Restrictions, and the "No Full SQL" Reality

### SQL Parser

The parser lives at `crates/sql-parser/` and wraps the `sqlparser` crate. Two subsets exist:

1. **Query SQL** (CLI/HTTP): A broader subset allowing multi-table joins, `WHERE`, indexing hints. Used via the HTTP API (`/sql` endpoint).
2. **Subscription SQL**: Stricter subset. Used in WebSocket subscription messages.

### Subscription SQL Restrictions

The subscription SQL at `crates/subscription/src/lib.rs` and `crates/core/src/subscription/subscription.rs` is intentionally restricted:
- `SELECT * FROM table` — no arbitrary column projections; always full rows.
- One or two tables joined on indexed columns.
- `WHERE` predicates on indexed columns.
- No `ORDER BY`, `GROUP BY`, `HAVING`, `LIMIT`, `OFFSET`.
- No aggregates (`COUNT`, `SUM`, etc.).
- No subqueries, no `UNION`, no `EXCEPT`, no `INTERSECT`.
- No `DISTINCT`.
- No `JOIN` types other than inner join on equality.
- No `UPDATE`, `DELETE`, or `INSERT` — state changes are exclusively through reducers.

### Query SQL

The query SQL (HTTP API) is a strict superset of the subscription SQL. More-than-two-table joins are allowed. It is still not a full SQL dialect (no `UPDATE`/`DELETE`/`INSERT`).

### View SQL

Views have their own SQL subset: the query is analyzed and incrementally maintained. View definitions compile into the `ViewDef` schema stored in system tables. When a table a view depends on changes, the view is re-evaluated.

### RLS

Row-Level Security can be enabled with a preprocessor directive (`@rls`). The module defines a filter function; the system compiles it into a `RowLevelExpr` that is injected into subscription plans. Module owners bypass RLS. This is documented in the v2 docs but the RLS doc still references v1.12 patterns in `docs/versioned_docs/version-1.12.0/`.

---

## 13. Security and Isolation

### WASM Isolation

WASM modules run in Wasmtime instances with fuel metering. This provides genuine defense in depth: even if the module's WASM bytecode is malicious, it cannot escape the Wasmtime sandbox. The host's memory is not directly accessible to the WASM instance — all communication is through the C ABI host function bridge.

### V8 Isolation

V8 modules run in separate isolates per main-lane/work-lane. Each isolate has its own heap, GC, and JIT. Communication with the host is through explicit syscall functions defined in `crates/core/src/host/v8/syscall.rs`.

### Energy Budget

`FunctionBudget` caps how much CPU work a single reducer/procedure can consume. This is enforced via Wasmtime fuel for WASM modules and approximate instruction counting for V8. The `ReducerOutcome::BudgetExceeded` variant signals that the budget was hit.

### Identity and Auth

Authentication is identity-based: 32-byte public keys, JWTs, `AuthCtx` carrying the caller's `Identity` and `ConnectionId`. `ConnectionAuthCtx` is threaded through every reducer call. The `client_connected` and `client_disconnected` lifecycle reducers can reject connections by throwing in `client_connected`.

### Database Isolation

Each database runs in its own `HostCell` (module host + `RelationalDB` + `Locking`). Modules cannot read other databases' tables. The `ControlDb` at `crates/standalone/src/control_db.rs` holds server-level metadata (databases, replicas, hosts, nodes) in a sled-backed store, separate from user data.

### Connection Lifecycle

Connections open via WebSocket upgrade. The server authenticates the client (JWT or identity key), creates a `ClientConnectionSender`, and optionally calls the `client_connected` reducer. On disconnect, `client_disconnected` is called. If `client_connected` throws, the connection is rejected.

---

## 14. Operational Reality: How Someone Actually Runs This

### Server Layout

The standalone binary (`crates/standalone/src/main.rs`) wires:
1. `ControlDb` — sled-backed metadata store at `data_dir/control_db/`.
2. `DiskStorage` — program bytes at `data_dir/program_bytes/`.
3. `LocalPersistenceProvider` — creates per-replica directories.
4. `HostController` — manages all databases/modules.
5. `ClientActorIndex` — WebSocket connection registry.
6. Prometheus metrics registry.
7. JWT auth provider.

### Data Directory Layout

```
data_dir/
  control_db/           # sled database of databases/replicas/nodes
  program_bytes/        # compiled WASM/V8 bytecode files
  <database_identity>/  # per-database
    <replica_id>/
      commitlog/        # segments: <offset>.segment
      snapshots/        # snapshot directories: <tx_offset>.snapshot_dir/
      lockfile          # advisory database lock
```

### Snapshots

Every `SNAPSHOT_FREQUENCY` (1,000,000) transactions, a snapshot is taken. The snapshot worker runs on `spawn_blocking` to avoid blocking the main async runtime. Snapshots are created as `UnflushedSnapshot` objects, then asynchronously synced via `sync_all`.

### Compression

Snapshots and commitlog segments can be compressed with zstd. `compress_snapshots` and `compress_segments` are explicit operations. The `CompressionStats` types track compression metrics.

### Monitoring

Prometheus metrics are exposed: `ENGINE_METRICS`, `DB_METRICS`, `WORKER_METRICS`. Jemalloc profiling is compiled in (line 44-60 of standalone/src/main.rs) but disabled by default.

### Encryption at Rest

There is no built-in encryption at rest. The commitlog segments and snapshot files are plaintext (or plaintext-compressed). OS-level encryption (dm-crypt, LUKS) would be required for disk-level protection.

### Resource Constraints

- Page pool shared across all databases on a host.
- In-memory committed state: the entire database lives in RAM.
- Single-writer lock per database: only one reducer at a time per database.
- Energy budgets bound reducer CPU usage.

---

## 15. What This Means for a Self-Hosted Privacy-First Chat Platform

### Lessons That Translate Directly

**Reducer model with transactional state mutations.** The idea of encapsulating state changes in named, typed functions that run atomically is elegant and directly applicable. A chat platform's operations (send message, join room, upload attachment) map naturally to reducers. The reducer model gives a clear mental model: the database never transitions between invalid states because each reducer is an atomic "patch." Notably, STDB's reducer model is not a stored procedure or a database trigger — it is application code that happens to run inside the storage engine's write lock. For Wabi, the same pattern works: define commands that read state, compute a result, and produce row mutations, all in one shot.

**Live subscriptions to row changes via push.** The subscription system — compile a query, evaluate it on each transaction delta, push only the changed rows — is the correct model for real-time UI updates. The architecture of deduplicating by query hash, indexing by (table, column, value), and offloading serialization to a background worker are all directly reusable patterns. The key insight from the STDB implementation is that the SendWorker (`crates/core/src/subscription/module_subscription_manager.rs:1714`) is the right place to aggregate and format per-client messages, because it moves CPU-intensive serialization off the critical transaction path. The `eval_updates_sequential` design (line 1346) — which removed rayon parallelization in favor of single-threaded evaluation for small deltas — is also instructive: small updates are the common case for chat, and thread-switching overhead dominates evaluation time.

**Colocated state and logic, single binary deploy.** Having the application logic and the database in the same process eliminates network round trips and simplifies deployment. For a single-tenant server, this is ideal. STDB achieves this through the module WASM sandbox, but the same benefit can be had without WASM by co-compiling the app logic with the database engine. The colocation eliminates the replication lag, connection pooling, and serialization overhead that traditional three-tier architectures impose.

**In-memory hot state + commitlog durability.** The performance profile (fast reads/writes because everything is in memory, safe persistence because the WAL is append-only) is well-suited to a chat workload where most data is hot. The recovery pipeline (snapshot → commitlog replay) is well-proven in STDB. For a smaller engine, a simpler approach is possible: open a SQLite database for the durable state and keep a small in-memory cache of hot topics. But the STDB pattern of "completely in-memory, backed by an append-only log" is viable if the dataset fits in RAM.

**Energy quotas to bound reducer work.** A necessary operational control for multi-tenant scenarios and DoS protection. The `FunctionBudget` mechanism (`spacetimedb_client_api_messages::energy::FunctionBudget`) limits how much CPU a single reducer can consume. In a chat platform, this bounds the harm from a buggy or malicious room event handler.

**Event tables as a tier for "transient" data.** The concept of write-commitlog-only, don't-merge-to-state is exactly right for short-lived signals (typing indicators, audio frames, ephemeral presence). The commitlog caveat (rows persist in the WAL) must be understood and addressed; a Wabi implementation could add a `memory_only` tier that does not write to the commitlog at all, accepting the risk of loss on restart for truly transient data.

**Pages + page pool as a shared resource model.** Object pooling for pages with content-addressed snapshot deduplication is a smart resource management pattern. The page pool (`crates/table/src/page_pool.rs`) reduces allocation pressure by recycling `Box<Page>` objects. The snapshot hardlinking (`crates/snapshot/src/lib.rs:335`: `hardlink_or_write`) avoids re-writing unchanged pages across consecutive snapshots. These are engineering patterns that a smaller engine can adopt directly.

**Query hash indexing for delta evaluation.** The `SearchArguments` data structure (a mapping from `(TableId, ColId, AlgebraicValue)` to `HashSet<QueryHash>`) at `module_subscription_manager.rs` is an elegant index for "given this changed row, which subscriptions need re-evaluation?" This avoids re-evaluating every subscription on every transaction. A chat topic system could use an analogous index: `(topic, channel_id) -> set of subscribers`.

### Lessons That Do NOT Translate

**BSL 1.1 license.** The "one SpacetimeDB instance in production" restriction is a meaningful constraint for any architecture that wants to run multiple isolated database processes. For a platform that envisions per-community databases, data sovereignty, or tenant-isolated storage, the BSL's "one instance" provision is a liability. A Wabi-native engine has no such restriction.

**The full subscription query planner and SQL subset.** STDB ships a SQL compiler, a physical plan optimizer (`crates/physical-plan/`), a pipelined executor (`crates/execution/src/pipelined/`), and a subscription plan compiler (`crates/subscription/src/lib.rs`) — approximately 15,000 lines of nontrivial query processing code. A chat platform does not need `SELECT * FROM table JOIN table2 ON ... WHERE col = ?`. A topic-based or channel-based subscription model (`subscribe("room/123/messages")`) is simpler, more intuitive, and easier to secure. The entire SQL layer is overhead that a purpose-built engine does not need.

**The full multi-language module runtime (WASM + V8).** STDB invests heavily in running untrusted user code: Wasmtime fuel metering, V8 isolate pools, the C ABI host function bridge, the `WasmInstanceEnv` binding layer, compile-time codegen (`crates/bindings-macro`). This is tens of thousands of lines of code across `crates/{bindings,bindings-macro,bindings-sys,core/src/host/{wasmtime,v8,wasm_common}}`. Wabi does not need to run arbitrary user code — it only needs to run its own logic. The module runtime is the single largest cost in the STDB codebase.

**BSL-imposed "one instance per app."** As noted above, this restriction complicates privacy-split architectures that need multiple logical databases for data compartmentalization. If the design goal is "each community gets its own encrypted database," running N STDB instances is not allowed under the default grant.

**Generic database engine scope.** The SQL interface, ad-hoc query support, schema migrations, system tables (`st_table`, `st_column`, `st_index`, `st_sequence`, `st_view`, `st_event_table`, `st_scheduled`, `st_var`, `st_client`, `st_connection_credentials`, `st_row_level_security`, `st_table_accessor`, `st_column_accessor`, `st_index_accessor` — at least 15 system tables), the `RawModuleDefV9/V10` builders, the migration planner (`crates/schema/src/auto_migrate/`), all exist to make STDB a general-purpose database. For a focused chat platform, these are liabilities: they add complexity, attack surface, and maintenance burden.

**Client authentication and energy accounting infrastructure.** STDB has a full JWT-based identity system, energy balance tracking, and a `NullEnergyMonitor` `trait` that is extensible for paid-tier energy metering. A self-hosted chat platform does not need micro-transaction-level energy accounting. Simple rate limiting per-connection is sufficient.

### Privacy / Retention Observations

**Event tables' commitlog persistence is a gotcha.** If a chat platform uses event tables for "transient" features (voice frames, ephemeral messages), the commitlog on disk retains a full history of those events. There is no built-in retention or garbage collection for the commitlog. An operator (or attacker with disk access) can replay the commitlog and reconstruct all event rows. The source at `replay.rs:754-758` is explicit: "Event table rows in the commitlog are preserved for future replay features." If Wabi adopts event tables, it must either (a) add a `memory_only` flag that skips commitlog writing for truly transient data, losing it on restart, or (b) encrypt event-table commitlog entries with per-session keys.

**WAL replay reconstructs everything.** Because the commitlog is the source of truth for recovery, anyone who can read the commitlog files can reconstruct the entire database state at any point in history (bounded by snapshot pruning). For a privacy-first platform, this means disk-level encryption is mandatory, and a secure-erase policy for old commitlog segments is necessary. The STDB codebase does not provide any of this — it is operator responsibility.

**No built-in TTL or retention.** There is no database primitive for per-table or per-row time-to-live. Retention must be implemented as application logic (scheduled reducers that delete old rows). The commitlog, however, will retain those deletions forever unless the operator prunes old segments. For a chat platform with legal retention requirements, a first-class retention policy engine (per-topic, per-user, durable-only vs. soft-delete) is essential.

**Snapshot compression does not imply privacy.** Snapshots can be zstd-compressed (`crates/snapshot/src/lib.rs:1229-1261`), but compression is not encryption. The same BLAKE3 content hashes are used for deduplication across snapshots, which means content-equivalent pages are linkable by hash value. A privacy-focused design might want to use per-snapshot encryption keys to prevent cross-snapshot linkage.

### What Wabi Could Keep

- **Reducer model + transactional state.** The core abstraction of named, typed, atomic state transitions is the single most important idea to retain. It provides an audit trail (every state change is a named event with caller identity), simplifies concurrency (single writer lock), and maps cleanly to the UX of a chat application.
- **Topic-based subscriptions with row-level deltas.** The concept of per-subscription deltas computed as the symmetric difference between a query's old and new results is the correct foundation for real-time UI. But the query language should be `subscribe("room/{id}/messages")` not `SELECT * FROM messages WHERE room_id = ?`. The delta computation can be simpler: insert new rows matching the topic, delete rows that were removed or no longer match (e.g., deleted messages).
- **Two-tier data lifecycle.** Borrow the durable vs. ephemeral (event table) distinction, but add a third tier for encrypted-at-rest blobs. STDB's event tables demonstrate that not all data needs committed-state persistence. A third "crypto" tier would hold messages that can only be decrypted by the intended recipient.
- **In-memory hot state + append-only log.** The performance and simplicity arguments are compelling for a single-tenant server with moderate data volume.
- **Energy budgeting for any future addon system.** If Wabi ever supports plugins, fuel metering via Wasmtime is the right approach. The ABI lesson from STDB (`_insert`, `_delete`, `_iter` as host functions) is a clean, testable contract between the runtime and user code.

### What Wabi Should Reinvent Cleanly

- **An embedded storage layer.** Use SQLite or `redb` for committed state, instead of the custom page pool + BTree index implementation. This eliminates the "all data must fit in RAM" requirement and provides battle-tested ACID compliance, concurrent readers, and on-disk durability out of the box. The in-memory cache can be a separate layer (e.g., a row cache for hot topics), not the primary storage. This also eliminates ~15,000 lines of custom storage engine code (`crates/table/`, `crates/datastore/src/locking_tx_datastore/`, and large parts of `crates/engine/`).
- **A purpose-built live-update broadcaster.** Not a SQL subscription planner. A channel-based pub/sub with topic routing (e.g., `"room/{room_id}"`, `"user/{user_id}/dm"`), per-subscriber filters (e.g., only messages from certain senders), and minimal overhead. The SendWorker pattern (off-main-thread aggregation + serialization) is worth keeping.
- **A bounded object-type system.** Instead of arbitrary `AlgebraicType` schemas reducible to SATS/BSATN, define a fixed set of message types (`TextMessage`, `VoiceFrame`, `Attachment`, `UserPresence`, `Reaction`, etc.) that map to database rows. This eliminates the entire dynamic type system, schema compilation, and the `RawModuleDef` pipeline, and simplifies the subscription compiler enormously because every subscription is just "rows of type X with filter Y."
- **A retention engine as a first-class component.** Per-topic retention policies (TTL for ephemeral messages, logical deletion markers, encrypted blob garbage collection), secure deletion (file-level shredding for commitlog segments), and encryption-at-rest integration. This is a non-negotiable requirement for a privacy-first platform, and STDB does not provide it.
- **Replica isolation.** STDB's `Locking` struct uses a single `RwLock<CommittedState>` per database, serializing all writers. A chat platform with many rooms can use per-room or per-shard write locks for concurrency, as long as cross-room transactions are not needed. This is a significant scalability win that STDB's architecture does not support.

---

## 16. Source Map Appendix

A recommended reading order for a future implementer who wants to study the codebase for design inspiration:

| # | File | Lesson |
|---|------|--------|
| 1 | `crates/engine/src/relational_db.rs:98-126` | The `RelationalDB` struct: how durability, snapshotting, and MVCC are composed. Read `open` (line 259) for the startup pipeline. |
| 2 | `crates/datastore/src/locking_tx_datastore/datastore.rs:54-100` | `Locking` struct, lock ordering, and the `new`/`commit` flow. |
| 3 | `crates/datastore/src/locking_tx_datastore/committed_state.rs:52-80` | `CommittedState` — the entire in-memory database state in one struct. |
| 4 | `crates/datastore/src/locking_tx_datastore/tx_state.rs:21-60` | `TxState` — how a transaction tracks dirty data. |
| 5 | `crates/commitlog/src/lib.rs:40-101,156-480` | `Options` and `Commitlog` — the WAL interface. |
| 6 | `crates/durability/src/lib.rs:118-174` | `Durability` trait — the abstract persistence layer. |
| 7 | `crates/snapshot/src/lib.rs:1-22,750-853` | Snapshot philosophy and `SnapshotRepository::create_snapshot`. |
| 8 | `crates/datastore/src/locking_tx_datastore/replay.rs:35-80,754-758` | Replay logic and event-table skip. |
| 9 | `crates/table/src/page_pool.rs:24-51` | `PagePool` — shared page object pool. |
| 10 | `crates/table/src/blob_store.rs:63-128` | `BlobStore` trait — content-addressed blob storage. |
| 11 | `crates/core/src/host/host_controller.rs:66-121` | `HostController` — the host registry and shared resources. |
| 12 | `crates/core/src/host/module_host.rs:80-120` | `DatabaseTableUpdate` and `EventStatus` — the transaction delta format. |
| 13 | `crates/core/src/host/wasm_common/module_host_actor.rs:79-100` | `WasmInstance` trait — the unified module call interface. |
| 14 | `crates/core/src/subscription/module_subscription_manager.rs:1300-1395` | `eval_updates_sequential` — the subscription evaluation entry point. |
| 15 | `crates/core/src/subscription/module_subscription_manager.rs:1710-1842` | `SendWorker` — off-main-thread broadcast aggregation. |
| 16 | `crates/core/src/subscription/delta.rs:1-50` | `eval_delta` — running a subscription plan over a delta. |
| 17 | `crates/core/src/subscription/tx.rs:1-60` | `DeltaTx` and `DeltaTableIndexes` — fast delta lookup structures. |
| 18 | `crates/core/src/subscription/subscription.rs:14-39` | Subscription SQL compilation and event-table filter. |
| 19 | `crates/subscription/src/lib.rs:1-100` | `Fragments` and `SubscriptionPlan` — compiled query plan for subs. |
| 20 | `crates/lib/src/db/raw_def/v10.rs:270-284` | `is_event` field definition. |
| 21 | `crates/datastore/src/locking_tx_datastore/committed_state.rs:600-633` | Event-table skip in `merge_apply_inserts`. |
| 22 | `crates/datastore/src/locking_tx_datastore/replay.rs:754-758` | Event-table skip in replay. |
| 23 | `crates/datastore/src/traits.rs:23-100` | `IsolationLevel` and the isolation model. |
| 24 | `crates/core/src/host/v8/mod.rs:1-55` | V8 module host topology diagram and description. |
| 25 | `crates/standalone/src/lib.rs:42-100` | `StandaloneOptions` and `StandaloneEnv::init` — how the server wires together. |
| 26 | `crates/standalone/src/control_db.rs` | The sled-backed ControlDb for server metadata. |
| 27 | `crates/commitlog/src/payload.rs` and `crates/commitlog/src/payload/txdata.rs` | The `Txdata` encoding format — what is actually written to the WAL per transaction. |
| 28 | `crates/core/src/host/mod.rs:34-77` | `FunctionArgs` — how reducer arguments are encoded/decoded (JSON or BSATN). |
| 29 | `crates/engine/src/persistence.rs:22-73` | `DurabilityConfig` and `CommitlogConfig` — how operator-facing config maps to commitlog `Options`. |
| 30 | `crates/core/src/host/host_controller.rs:619-650` | `acquire_read_lock` and `acquire_write_lock` — the lock acquisition for concurrent access to a host cell. |
| 31 | `crates/subscription/src/lib.rs:1-100` | `SubscriptionPlan` and `Fragments` — the compiled subscription plan structure. |
| 32 | `crates/physical-plan/src/plan.rs` | `PhysicalPlan` types (`IxScan`, `TableScan`, `JoinPlan`, `ProjectPlan`). |
| 33 | `crates/execution/src/pipelined/` | `PipelinedIxScan`, `PipelinedIxJoin`, `PipelinedProject` — the pipelined execution engine. |
| 34 | `crates/core/src/subscription/module_subscription_manager.rs:150-199` | `ClientInfo` — how the subscription manager tracks per-client state (v1, v2, legacy subs, ref counts). |
| 35 | `crates/datastore/src/locking_tx_datastore/tx.rs:1-80` | `TxId` — a read-only transaction with shared lock on committed state. |
| 36 | `crates/datastore/src/locking_tx_datastore/mut_tx.rs:1-60` | `MutTxId` — the writer transaction and its view of inserts/deletes. |
| 37 | `crates/core/src/host/wasmtime/mod.rs` | `WasmtimeModule` compilation, `ModuleInstance` creation, fuel setup. |
| 38 | `crates/core/src/host/v8/syscall.rs:62-65` | The V8 syscall bridge: `call_call_reducer`, `call_call_view`, etc. |
| 39 | `crates/bindings/src/lib.rs` | The `spacetimedb` crate API surface that module authors use (`#[table]`, `#[reducer]`, etc.). |
| 40 | `crates/bindings-macro/src/lib.rs` | The proc macros that generate `__describe_module__` and the C ABI exports. |

---

## 17. Open Questions and Unknowns

### Doc Drift

The file storage documentation exists only in the 2.0 docs (`docs/docs/00200-core-concepts/00300-tables/00210-file-storage.md`). The RLS documentation at `docs/versioned_docs/version-1.12.0/00300-resources/00100-how-to/00400-row-level-security.md` references patterns from the v1.12 era. The gap suggests that some features (file storage) were introduced or documented only in 2.0, while others (RLS) have documentation that has not been updated to reflect 2.0 changes.

### Contradictions Between Docs and Source

The source code's comment at `committed_state.rs:74-77` says the page pool handle is "shared between all modules running on a particular host." The `HostController::page_pool` field indeed holds a single `PagePool`. However, it is unclear if this means a malicious module could exhaust the shared page pool and affect other databases. Each database's `CommittedState` has the same `PagePool` handle, so a module that allocates many large pages could pressure the pool. The pool's `max_size` is the only guard.

### BSL Additional Use Grant Interpretation

The BSL Additional Use Grant language ("no more than one SpacetimeDB instance in production") has not been legally tested. Whether "instance" means one operating system process or one logical database is ambiguous. The "Database Service" carveout is also ambiguous for apps that provide multi-tenant chat rooms (where each room operator controls their own schema). This study does not constitute legal advice.

### Event Table Commitlog Retention

While the source and documentation are clear that event table rows are preserved in the commitlog (replay.rs:754-758), the long-term implications are not addressed: there is no documented mechanism to purge event rows from old commitlog segments, and no discussion of the ethical/privacy implications of ephemeral data persisting in the WAL indefinitely.

### Encryption at Rest

The commitlog, snapshots, and program bytes are all stored as plaintext files. The server documentation does not mention encryption at rest. An operator must rely on OS-level disk encryption, which is unsuitable for environments where the disk is not fully controlled (e.g., cloud block storage with snapshot features).

---

*This document was produced as an independent technical study of the SpacetimeDB source tree at `/var/home/Ronin/vendor/SpacetimeDB` (v2.6.0). It is not legal advice. It does not reproduce significant portions of the STDB source code. All claims are backed by file:line citations to specific source files read during the study.*
