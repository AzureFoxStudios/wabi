# NAS Storage: Plugin vs Core Decision

**Date:** May 2026  
**Status:** Decision Required  
**Author:** Wabi Architecture

---

## 1. The Problem

Wabi currently stores uploads on **local disk only**. This works for single-server deployments but breaks down in any real production scenario:

- **No centralized storage** — If Wabi runs on multiple servers (future mesh/clustering), uploads on server A are invisible to server B.
- **No shared access** — Users on different nodes see inconsistent file availability.
- **Single point of failure** — Disk failure means upload loss.
- **No HA/backup** — Local disk has no redundancy by default.
- **Hosting friction** — Server operators must manage disk space, permissions, and paths manually on each host.

The current local-disk implementation (`uploads-fixing.md`) is explicitly temporary: "Can add S3/gcs/Backblaze later if storage scales." NAS is the natural next step for self-hosted operators who already have centralized storage infrastructure.

---

## 2. Plugin vs Core Analysis

### Option A: Built Into Core

**Pros:**
- Every Wabi deployment gets NAS support automatically — no addon to install, no friction.
- Storage abstraction can be centralized once, avoiding duplicated effort across multiple storage addons.
- Configuration lives in `ServerConfig` alongside other core settings — operators have one place to look.

**Cons:**
- Core gains a hard dependency on network file systems (NFS, CIFS/SMB) or a NAS SDK.
- Testing complexity explodes — core tests must now account for network storage failures, timeouts, permission errors.
- "Core minimal" philosophy erodes — if NAS is core, why not S3? Why not Backblaze? Each storage back-end leaks into core.
- NAS configuration (mount paths, credentials, auto-discovery) is inherently site-specific. Shipping this in core means shipping configuration complexity into every deployment.
- A bug in core storage affects every Wabi installation. A bug in a storage addon affects only addon users.

### Option B: Storage Addon Plugin

**Pros:**
- Fits the **Blender addon philosophy** perfectly: core stores files somewhere, storage back-end is an implementation detail.
- A `storage-nas` addon can be written, tested, and iterated on without touching core.
- Operators who don't need NAS don't install it — zero overhead.
- Multiple storage back-ends can coexist: `storage-nas`, `storage-s3`, `storage-gcs` — all implement a common `StorageProvider` interface.
- Failure isolation: a broken NAS addon doesn't crash the chat/voice/messaging core.
-符合 Wabi 的addon 系统 (见 `ADDON_ARCHITECTURE.md`) — addon声明 `permissions`, 有 `AddonContext`, 注册 hooks。

**Cons:**
- Requires the addon system to support **storage provider hooks** — a new hook type that doesn't exist yet.
- Operator must discover, install, and configure the addon — slightly more friction than "it just works."

### Verdict

**Option B (Plugin) wins.** The "core minimal, addons optional" philosophy is not rhetorical — it's the architectural constraint that keeps Wabi maintainable as scope grows. NAS storage is an implementation detail of the storage layer. Binding it to core creates a dependency that will only grow as more storage back-ends are requested.

The right model is: **Core defines a `StorageProvider` interface. Addons implement it. The addon manifest declares `storage` permission. Core calls `provider.store()` and `provider.retrieve()` without knowing where files go.**

---

## 3. Recommendation

**Build a `storage-nas` addon.**

The implementation should:

1. Define a `StorageProvider` trait in core (noop default using local disk) that addon storage back-ends implement.
2. Add a `wabi-storage` addon category alongside the existing `media`, `content`, `payments` categories.
3. Implement `storage-nas` as the first official addon in that category.
4. The `storage-nas` addon handles:
   - Mount path configuration (configurable via addon settings UI)
   - SMB/NFS detection and reconnection on mount failure
   - UUID-based file naming (already implemented in core upload handler, just needs to route through the provider)
   - Optional: mount monitoring, health reporting

**This is not a departure from local-first.** Local-first means "data lives on user devices by default." Server-side storage — whether local disk, NAS, or S3 — is an optional server operator choice. The storage addon model respects both: operators who want local disk use the noop provider (or a `storage-local` addon); operators who want NAS install `storage-nas`.

---

## 4. Implementation Sketch

### Phase 1: Core Storage Interface (Minimal Core Change)

Add a `StorageProvider` trait in `wabi-core` or `wabi-server` that defines the minimum contract:

```rust
// core/crates/wabi-server/src/storage/provider.rs

pub trait StorageProvider: Send + Sync {
    async fn store(&self, path: &str, data: Bytes) -> Result<StoredFile>;
    async fn retrieve(&self, path: &str) -> Result<Bytes>;
    async fn delete(&self, path: &str) -> Result<()>;
    async fn exists(&self, path: &str) -> Result<bool>;
}

#[derive(Debug, Clone)]
pub struct StoredFile {
    pub path: String,
    pub size_bytes: u64,
    pub mime_type: String,
}
```

Core registers a default provider (local disk, today's implementation). Addons can **replace** the provider at startup via a new hook.

### Phase 2: Addon Hook for Storage Provider Registration

In `ADDON_ARCHITECTURE.md` hooks, add:

```rust
// In AddonHooks trait:
fn register_storage_provider(&self, ctx: &mut AddonContext) -> Option<Box<dyn StorageProvider>>;
```

When an addon returns `Some(provider)`, core swaps the active provider. Only one storage provider can be active — if multiple addons register, the last one wins (or error at enable time).

### Phase 3: `storage-nas` Addon

```
addons/
└── storage/
    └── storage-nas/
        ├── backend/
        │   ├── src/
        │   │   ├── lib.rs         # SMB/NFS mounting, provider impl
        │   │   ├── smb.rs         # SMB client wrapper (smbclient crate)
        │   │   └── nfs.rs         # NFS client wrapper (nfs-rs)
        │   └── Cargo.toml
        ├── frontend/
        │   └── NasSettings.svelte  # Mount path, credentials UI
        └── plugin.json
```

`plugin.json` key fields:

```json
{
  "id": "storage-nas",
  "name": "NAS Storage",
  "category": "storage",
  "permissions": ["storage:provider"],
  "storage": {
    "provider": true,
    "mountProtocols": ["smb", "nfs"],
    "configFields": [
      { "name": "mountPath", "type": "string", "required": true },
      { "name": "host", "type": "string" },
      { "name": "shareName", "type": "string" }
    ]
  }
}
```

### Phase 4: Upload Handler Integration

The existing upload handler (`api/upload.rs`) currently writes to local disk:

```rust
// current (upload.rs):
std::fs::write(&path, data)?;
```

Replace with:

```rust
// updated:
self.storage_provider.store(&relative_path, bytes).await?;
```

The `storage_provider` is a `Arc<dyn StorageProvider>` set at server startup. Core ships with `LocalDiskStorageProvider` as the default.

### Phase 5: Settings UI

`NasSettings.svelte` provides:
- Mount path input (e.g. `/mnt/nas/uploads`)
- Host/Share fields (for SMB auto-mount hint)
- Test connection button
- Health indicator (mounted/unmounted)

---

## 5. Open Questions

1. **Storage provider priority** — If two storage addons are installed (e.g. `storage-nas` + `storage-s3`), which wins? Error at enable time, or last-loaded wins? Recommendation: error at enable time with a clear message.

2. **Migration path for existing uploads** — Operators switching from local disk to NAS must move existing files. Should `storage-nas` include a migration tool, or is that out of scope?

3. **Local disk as an addon** — Should the default local-disk provider be lifted into a `storage-local` addon so operators can swap all storage with one mechanism? Or is the current in-core default acceptable as a permanent baseline?

4. **Credentials / secrets** — SMB mounts may need credentials. Where does `storage-nas` store these? Env vars? Addon config file? Wabi's existing secrets handling (JWT, STDB tokens) suggests env vars — confirm this is acceptable for NAS credentials too.

5. **Health monitoring** — If the NAS goes down mid-upload, what happens? Retry with backoff? Fail fast and return error? The `StorageProvider` interface should define this behavior, not be left to individual addons.

6. **Addon dependency on core hook** — Phase 2 requires a new core hook (`register_storage_provider`). This is a minimal core change but it must land before `storage-nas` can be implemented. Is this acceptable, or should we ship `storage-nas` with a temporary shim that references a not-yet-extracted interface?

---

## Summary

| | Core | Plugin |
|---|---|---|
| Philosophy fit | Erodes "core minimal" | ✅ Fits exactly |
| Failure isolation | ❌ Storage bug = core bug | ✅ Addon crash isolated |
| Operator friction | None (always present) | Slight (install addon) |
| Extensibility | S3/GCS require core changes | ✅ New addon, no core touch |
| Testing scope | Grows with each back-end | ✅ Per-addon test suite |

**Decision: Build `storage-nas` as an official addon. Land the `StorageProvider` interface in core as the minimal plumbing required. Leave the current local-disk implementation as the default provider, effectively making it a built-in noop addon.**