# The Lore Addon — A Complete Guide

> **Audience:** You are new to this codebase and have been pointed at the Lore
> addon. This document explains what Lore is, how it fits into Wabi, where every
> piece of code lives, how to turn it on, how the call-recording feature uses
> it, and how to operate and extend it. It is intentionally verbose — read it
> top to bottom once and you should be able to navigate the code with
> confidence.
>
> **Scope of this document:** the server-side Rust addon (`wabi-lore`), its
> REST API, its integration with WabiDB, and the optional frontend call-recording
> → Lore upload feature. It does **not** cover the underlying
> [Lore](https://github.com/EpicGames/lore) CLI/server internals — for those,
> see the upstream Lore project.

---

## Table of Contents

1. [What Lore Is (in plain English)](#1-what-lore-is-in-plain-english)
2. [The Single Most Important Concept: It's Optional and Compile-Time Gated](#2-the-single-most-important-concept-its-optional-and-compile-time-gated)
3. [High-Level Architecture](#3-high-level-architecture)
4. [Where the Code Lives](#4-where-the-code-lives)
5. [Enabling Lore (Build + Config)](#5-enabling-lore-build--config)
6. [Configuration Reference](#6-configuration-reference)
7. [Data Model](#7-data-model)
8. [REST API Reference](#8-rest-api-reference)
9. [The Call-Recording → Lore Integration](#9-the-call-recording--lore-integration)
10. [Restart Rehydration (Why Lore Survives a Server Restart)](#10-restart-rehydration-why-lore-survives-a-server-restart)
11. [Security Model](#11-security-model)
12. [Operations & Runbook](#12-operations--runbook)
13. [Developer Onboarding](#13-developer-onboarding)
14. [Repo Classes, Artist Review Flow, External Mirrors & Git Import](#14-repo-classes-artist-review-flow-external-mirrors--git-import)
15. [Known Limitations & Future Work](#15-known-limitations--future-work)
16. [Glossary](#16-glossary)

---

## 1. What Lore Is (in plain English)

Lore is a **version-control system for large binary files** — think "Git, but
for CAD models, 3D assets, textures, audio, and video" rather than source code.
It is a separate project (by Epic Games, MIT-licensed) that Wabi *wraps* rather
than reinvents. In Wabi, the **Lore addon** is the bridge between Wabi's
channel/message model and a running Lore server.

Concretely, Lore gives a Wabi **channel** (specifically an "Asset Storage"
channel) the ability to host a **Lore repository** where files get:

- **Full revision history** — every upload creates an immutable revision; you
  can list history, diff two revisions, and roll back.
- **Branching & merging** — parallel lines of work on the same assets.
- **Chunk-level deduplication** — if two files share chunks, they are stored
  once.
- **File locking** — reserve an unmergeable asset (e.g. a `.step` CAD file) so
  two people don't edit it at once.
- **Range-aware downloads** — clients can request byte ranges (important for
  seeking inside large video files).

WabiDB itself only ever stores **metadata** about Lore (which channel owns
which repo, what the latest revision hash is, who committed what). The actual
bytes live in the Lore server. This separation is the whole point: WabiDB stays
a small, fast event log, while heavy binaries live in a system built for them.

---

## 2. The Single Most Important Concept: It's Optional and Compile-Time Gated

If you remember nothing else, remember this:

> **Lore is an optional Rust *server feature* (`--features wabi-lore`).**
> The website stays minimal by default; the desktop app gets the "improved"
> experience only when its server is built with the feature. The shared web
> client just quietly does nothing when the feature isn't there.

What this means in practice:

- **Backend:** The entire Lore API module (`core/crates/wabi-server/src/api/lore.rs`)
  is wrapped in `#[cfg(feature = "wabi-lore")]`. If you build `wabi-server`
  *without* the feature, that module is not compiled at all — the routes don't
  exist, the `AppState.lore_service` field is absent, and there is zero
  runtime cost. We call this "poofing at compile time": the code literally
  vanishes from the binary.
- **Frontend:** The Svelte client is a *single shared bundle* for both the
  website and the desktop (Tauri) app. It cannot be carved up by a compile flag
  the way Rust can. So instead of a feature flag, the client **runtime-guards**
  its Lore behavior: before doing anything Lore-related, it calls the
  `checkLoreHealth` endpoint. If the server doesn't have Lore (404 on `/health`),
  the client silently no-ops. So the "website is minimal / desktop is improved"
  split is really a **server-build split**, not a client split — both clients
  are identical and gracefully adapt to whichever server they talk to.

So when someone says "Lore is enabled on the desktop but not the website," what
they mean is: the desktop is pointed at a `wabi-server` that was compiled with
`--features wabi-lore`; the website is pointed at one that wasn't.

---

## 3. High-Level Architecture

```
                         ┌─────────────────────────────────────────────┐
                         │                wabi-server                  │
                         │                                              │
                         │   WabiDB event store (channels, messages,    │
                         │   members, AND LoreRepoRecord/LoreCommitRecord)│
                         │         │                          │         │
                         │         │                          │         │
                         │   ┌─────┴──────────────┐   ┌───────┴────────┐ │
                         │   │  AppState          │   │  wabi-server   │ │
                         │   │  .lore_service:    │   │  REST API       │ │
                         │   │  RwLock<Option<    │   │  /api/addons/  │ │
                         │   │   Arc<LoreService>>│   │   lore/...      │ │
                         │   └─────┬──────────────┘   └───────▲────────┘ │
                         │         │                              │       │
                         │         │ owns                        │ HTTP   │
                         │   ┌─────┴──────────────┐              │       │
                         │   │  LoreService       │              │       │
                         │   │  (crate: wabi-lore)│              │       │
                         │   │  - in-memory repo  │              │       │
                         │   │    index (HashMap) │              │       │
                         │   │  - wraps `lore` CLI│              │       │
                         │   └─────┬──────────────┘              │       │
                         └─────────┼──────────────────────────────┼───────┘
                                   │ subprocess (Phase 1)         │
                                   │ `lore repo create/write/...` │
                                   ▼                              │
                         ┌──────────────────────┐                 │
                         │  loreserver          │◄────────────────┘
                         │  (immutable CAS +    │   (file bytes, octet-stream)
                         │   mutable branch     │
                         │   store)             │
                         └──────────────────────┘
```

Key takeaways for a newcomer:

1. **`LoreService` is a thin Rust wrapper around the `lore` command-line tool.**
   In *Phase 1* (the current implementation), every Lore operation — create a
   repo, write a file, commit, list, diff, lock — is performed by spawning the
   `lore` CLI binary as a subprocess via `tokio::process::Command`. There is no
   direct Rust-crate dependency on Lore yet. *Phase 2* may replace the CLI
   wrapper with the `lore` Rust crate once its API is stable. This is why the
   `lore_binary_path` config exists: it tells `LoreService` where to find the
   binary.
2. **`LoreService` keeps an in-memory index of repos** (`repos: HashMap<i64,
   LoreRepo>`). This is just a cache for speed; the durable truth lives in WabiDB
   (see §7 and §10).
3. **WabiDB stores Lore *metadata* as events.** When a repo is created, a
   `lore_repo_registered` event is appended; when a file is committed, a
   `lore_commit` event is appended. These feed a projection (`lore_repos`,
   `lore_commits`) that the server can query.
4. **The Lore server holds the bytes.** `LoreService` talks to it over the
   `lore_server_url` (e.g. `lore://localhost:10000`). Whether that server is a
   child process (*embedded*), a sibling container (*sidecar*), or a remote
   instance (*remote*) is a deployment choice — the addon code is the same.

---

## 4. Where the Code Lives

| Component | Path | What it is |
|---|---|---|
| **Lore service (addon crate)** | `core/addons/lore/backend/src/lib.rs` | The `wabi-lore` crate. Defines `LoreService`, `LoreConfig`, `LoreRepo`, `LoreRevision`, `LoreFileInfo`, `LoreRepoSeed`, and all the CLI-wrapping methods. |
| **Server API handlers** | `core/crates/wabi-server/src/api/lore.rs` | Axum routes + handlers (`upload_file`, `download_file`, `snapshot`, branches, **`upload_recording`**, etc.). `#[cfg(feature = "wabi-lore")]`. |
| **Route mounting** | `core/crates/wabi-server/src/api/routes.rs` (line ~56) | `router.nest("/addons/lore", lore::routes(...))` inside `#[cfg(feature = "wabi-lore")]`. This whole router is then nested under `/api` in `main.rs`. |
| **Config types** | `core/crates/wabi-server/src/config.rs` | `LoreAddonConfig` (the `[addons.lore]` TOML block) and the env-var override path in `main.rs`. |
| **AppState field** | `core/crates/wabi-server/src/state.rs` (line ~61) | `lore_service: RwLock<Option<Arc<wabi_lore::LoreService>>>` — also `#[cfg(feature = "wabi-lore")]`. |
| **Service bootstrap** | `core/crates/wabi-server/src/main.rs` (the `if config.lore.enabled` block, ~line 429) | Constructs `LoreConfig`, runs a health check, **rehydrates** repos, and calls `state.set_lore_service(...)`. |
| **WabiDB trait** | `core/crates/wabidb/src/engine/wabi_store.rs` | `WabiStore` trait — the abstract DB interface. Lore methods (`lore_create_repo`, `lore_get_repo`, `lore_commit`, **`list_lore_repos`**) live here. |
| **WabiDB adapter** | `core/crates/wabi-server/src/adapter/mod.rs` | `WdbAdapter` implements `WabiStore`; its Lore methods persist/query the `lore_repos` / `lore_commits` projections. |
| **Lore projection** | `core/crates/wabidb/src/projections/lore.rs` | `LoreRepoProjection` / `LoreCommitProjection` — decode the Lore events into queryable indexes. |
| **Frontend types** | `frontend/src/lib/callRecordingTypes.ts` | `CallRecordingState` (incl. `loreUploadStatus*`), `RecordingArtifactExport.blob`, `RecordingExportResult.mainBlob`. |
| **Frontend core** | `frontend/src/lib/callRecording.ts` | The recording state machine. `stopCallRecording()` triggers the Lore upload. |
| **Frontend Lore helper (NEW)** | `frontend/src/lib/loreRecording.ts` | `uploadRecordingToLoreServer()` — the *only* file in the recording core that touches Lore. Runtime-guarded. |
| **Frontend Lore API** | `frontend/src/lib/api/lore.ts` | `uploadLoreFile()`, `checkLoreHealth()`, `loreUrl()` (exported). |
| **Frontend UI** | `frontend/src/lib/components/CallRecordingPanel.svelte` | Renders the `loreUploadStatus` line. |

A mental model: **the addon crate owns the "what Lore can do" logic; the server's
`api/lore.rs` owns the "how HTTP maps to that logic"; WabiDB owns "what we
remember about Lore"; and the frontend's `loreRecording.ts` owns "when a
recording should be pushed to Lore."**

---

## 5. Enabling Lore (Build + Config)

### 5.1 Build with the feature

```bash
# From the repo root
cargo check   -p wabi-server --features wabi-lore
cargo build   -p wabi-server --features wabi-lore
cargo test    -p wabi-server --features wabi-lore
```

Without `--features wabi-lore`, the Lore module is absent from the binary. This
is the recommended default for a "minimal" deployment.

### 5.2 Configure it

Lore only initializes if **both** of these are true:

1. The binary was built with `--features wabi-lore`, **and**
2. `[addons.lore] enabled = true` in `config.toml` (or `WABI_LORE_ENABLED=1`).

At startup (`main.rs`), the server builds a `LoreConfig`, runs
`LoreService::health_check()` (which shells out to `lore --version` to confirm
the CLI exists), and — only if that passes — stores the service in
`AppState.lore_service`. If the CLI is missing or health fails, you'll see:

```
[lore] Health check failed: ... — Lore addon disabled
```

and the server continues without Lore.

### 5.3 The `lore` CLI / server must be available

In *sidecar* or *embedded* mode, the `lore` binary (and a `loreserver`) must be
installed and reachable at `lore_binary_path` / `lore_server_url`. In *remote*
mode, just point `lore_server_url` at your shared server.

---

## 6. Configuration Reference

### 6.1 `config.toml`

```toml
[addons.lore]
enabled                  = false   # Master switch. Off by default.
mode                     = "sidecar"  # "embedded" | "sidecar" | "remote"
lore_server_url          = "lore://localhost:10000"
lore_binary_path         = "lore"   # Resolved via PATH if just "lore"
lore_data_dir            = "/var/wabi/lore"   # Used in embedded mode
default_blob_max_size_mb = 1024
auto_create_repos        = true    # Auto-create a Lore repo when an
                                    # Asset Storage channel is created
recordings_channel_name  = "Recordings"  # Name of the channel that finished
                                         # call recordings are uploaded to
```

All of these are **optional** in the TOML thanks to the struct-level
`#[serde(default)]`; if a key is omitted it falls back to the value shown above
(or `None` for `recordings_channel_name`, which then defaults to `"Recordings"`
in `main.rs`).

### 6.2 Environment-variable overrides

`wabi-server` also reads these env vars (useful for containers / 12-factor
setups). They take precedence over `config.toml`:

| Env var | Maps to |
|---|---|
| `WABI_LORE_ENABLED` | `enabled` (parse as bool) |
| `WABI_LORE_MODE` | `mode` |
| `WABI_LORE_SERVER_URL` | `lore_server_url` |
| `WABI_LORE_BINARY_PATH` | `lore_binary_path` |
| `WABI_LORE_DATA_DIR` | `lore_data_dir` |
| `WABI_LORE_MAX_BLOB_MB` | `default_blob_max_size_mb` |
| `WABI_LORE_AUTO_CREATE` | `auto_create_repos` |
| `WABI_LORE_RECORDINGS_CHANNEL` | `recordings_channel_name` (empty string is treated as "not set") |

---

## 7. Data Model

### 7.1 Channel IDs

Wabi channel IDs are **strings** of the form `ch_{hex}`, e.g. `ch_1a2b3c`. Lore,
however, indexes repos by an **`i64`** channel ID. The conversion is: strip the
`ch_` prefix and parse the remainder as a **base-16 (hex)** integer. You'll see
this in both `channels.rs` (when auto-creating a repo) and `upload_recording`
(when resolving the Recordings channel):

```rust
let lore_channel_id = channel_id_str
    .strip_prefix("ch_")
    .and_then(|hex| i64::from_str_radix(hex, 16).ok())
    ...
```

> **Known quirk:** the *frontend* parses channel IDs with a **decimal**
> `/^ch_(\d+)/` regex in two places (`loreStore.getChannelId()` and
> `LoreChannel.parseChannelId()`). That regex will *not* match a real
> `ch_{hex}` ID. It currently works only because those code paths use the
> numeric ID in other ways or aren't exercised on the hex form. If you touch
> channel-ID parsing, unify it — prefer a single shared helper.

### 7.2 `LoreRepoRecord` (persisted in WabiDB)

Stored under the `lore_repos` projection, keyed by `channel_id` (LE bytes).
Written by `lore_create_repo` on a `lore_repo_registered` event; removed on
`lore_repo_deleted`.

| Field | Type | Meaning |
|---|---|---|
| `channel_id` | `i64` | The Lore-side channel ID (hex of `ch_{hex}`). |
| `repo_name` | `String` | The Lore repo name (e.g. `ch-ch_1a2b3c`). |
| `lore_server_url` | `String` | Where the repo lives. |
| `created_by` | `i64` | User who created it. |
| `created_at_micros` | `i64` | Creation timestamp (microseconds). |

### 7.3 `LoreCommitRecord` (persisted in WabiDB)

Stored under the `lore_commits` projection on each `lore_commit` event.

| Field | Type | Meaning |
|---|---|---|
| `commit_hash` | `String` | The revision hash from Lore. |
| `channel_id` | `i64` | Owning channel. |
| `repo_name` | `String` | Repo the commit landed in. |
| `file_path` | `String` | File affected (e.g. `recordings/foo.webm`). |
| `message` | `String` | Commit message. |
| `author_user_id` | `i64` | Who committed. |
| `timestamp_micros` | `i64` | When. |

### 7.4 In-memory `LoreRepo` (runtime only)

`LoreService.repos` is a `HashMap<i64, LoreRepo>` holding `LoreRepo` structs
(`id`, `channel_id`, `lore_server_url`, `repo_name`, `created_by`,
`created_at`). **This map is not persisted** — it is rebuilt at startup (see
§10). All the API handlers call `lore.get_repo(channel_id)` to find the
`repo_name` they need before shelling out to the CLI.

Since the repo-classes feature (see §14), `LoreRepo` carries three extra
runtime fields that **do not exist on the WabiDB `LoreRepoRecord`**:

| Field | Type | Meaning |
|---|---|---|
| `class` | `RepoClass` | `Native` (default) or `Mirror { upstream_url }` (read-only pointer to an external git repo). |
| `auto_branch_on_upload` | `bool` | When true, every `upload_file` lands on a fresh `uploads/<user>-<ts>` branch instead of the current branch (artist-friendly review flow). |
| `imported_from` | `Option<String>` | The upstream git URL a repo was files-imported from (`import_from_git`). |

These are persisted in a **sidecar state file**, `.wabi-repo.json`, written
into the repo's working tree (not in WabiDB — the postcard-encoded
`LoreRepoRecord` cannot gain fields without a dual-decode migration). On
startup, `load_existing_repos` rehydrates the index from WabiDB *and* overlays
each repo's sidecar file, so class/auto-branch/import provenance survive a
restart. Deleting a repo removes the sidecar (and, for mirrors, the fetch
cache).

---

## 8. REST API Reference

**Base path:** `/api/addons/lore` (the server mounts the API router at `/api`,
and the Lore router at `/addons/lore` within it).

**Auth:** Every endpoint requires a valid `Authorization: Bearer <token>`
(`AuthUser` extractor). Authorization is derived from channel membership/role.

### 8.1 Repo management

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/addons/lore/repos` | Create a Lore repo for a channel (body: `{ channelId, repoName, autoBranchOnUpload? }`). |
| `GET` | `/api/addons/lore/repos/{channel_id}` | Get repo info (incl. `class`, `autoBranchOnUpload`, `importedFrom`). |
| `PATCH` | `/api/addons/lore/repos/{channel_id}` | Update repo settings (body: `{ autoBranchOnUpload }`). |
| `DELETE` | `/api/addons/lore/repos/{channel_id}` | Delete the repo. |
| `POST` | `/api/addons/lore/repos/import` | Files-only git import (body: `{ channelId, name, upstreamUrl }`). Returns repo or `409` (repo exists) / `502` (clone failed). |
| `POST` | `/api/addons/lore/repos/{channel_id}/external` | Register a read-only external mirror pointer (body: `{ name, upstreamUrl }`). |
| `POST` | `/api/addons/lore/repos/{channel_id}/mirror/refresh` | Invalidate the mirror fetch cache (next read re-fetches upstream). Webhook receiver target. |
| `POST` | `/api/addons/lore/repos/{channel_id}/snapshot` | Commit current staged state + record a revision. |

> **Mirror repos are read-only pointers.** Every write endpoint on a `Mirror`
> repo (upload, delete, lock/unlock, branch create/merge, snapshot,
> approve/reject) returns **501** `{ "error": "mirror repos are read-only via
> Wabi; browse upstream", "type": "MirrorReadOnly" }`. Reads (list, download,
> history) are served from a lazily-fetched git cache — see §14.3.

### 8.2 File operations

| Method | Path | Description |
|---|---|---|
| `PUT` | `/api/addons/lore/repos/{channel_id}/files/{*path}` | Upload/stage a file. **Body is raw bytes** (`application/octet-stream`), with optional `?message=` and `?repo_path=` query params. Response: `{ revision, file, pendingReview, reviewBranch }`. When the repo has `autoBranchOnUpload`, the file is committed to a fresh `review/{user}/{ts}` branch and `pendingReview: true` with the branch name; otherwise `pendingReview: false` and no branch. |
| `GET` | `/api/addons/lore/repos/{channel_id}/files/{*path}` | Download. Supports HTTP `Range` requests for seeking in large media. |
| `DELETE` | `/api/addons/lore/repos/{channel_id}/files/{*path}` | Delete a file. |
| `POST` | `/api/addons/lore/repos/{channel_id}/files/{*path}/lock` | Acquire a file lock (body optionally names the owner). |
| `DELETE` | `/api/addons/lore/repos/{channel_id}/files/{*path}/lock` | Release a lock. |

> **Note on `GET .../files/{*path}`:** this handler implements HTTP **Range**
> support (206 Partial Content) with a stable on-disk cache under
> `$TMPDIR/wabi-lore-cache/`, plus a background cleanup task. This is what makes
> large video files seekable without re-downloading.

### 8.3 History & diff

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/addons/lore/repos/{channel_id}/history` | Repo revision history. |
| `GET` | `/api/addons/lore/repos/{channel_id}/files/{*path}/history` | File-level history. |
| `GET` | `/api/addons/lore/repos/{channel_id}/files/{*path}/diff` | Diff two revisions (`?from=`/`?to=`). |

### 8.4 Branch operations

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/addons/lore/repos/{channel_id}/branches` | List branches. |
| `POST` | `/api/addons/lore/repos/{channel_id}/branches` | Create a branch. |
| `POST` | `/api/addons/lore/repos/{channel_id}/branches/{name}/merge` | Merge a branch. |
| `POST` | `/api/addons/lore/repos/{channel_id}/review/{name}/approve` | Approve a review branch: merge it into mainline, then archive it (retire). See §14.2. |
| `POST` | `/api/addons/lore/repos/{channel_id}/review/{name}/reject` | Reject a review branch: archive it without merging. See §14.2. |

### 8.5 Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/addons/lore/health` | Returns `{ "status": "ok" }` when the Lore CLI is reachable. **The frontend calls this to decide whether Lore features should light up.** A 404 here means "Lore not built into this server." |

### 8.6 Call-recording upload (the special one)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/addons/lore/recordings` | Upload a finished call recording to the configured **Recordings** Asset Storage channel. |

This is the **only** Lore endpoint that does **not** take a `channel_id` in the
path. Instead:

- **Body:** the raw file bytes (`Content-Type: application/octet-stream`).
- **Query params:** `?filename=...` (destination file name) and
  `?message=...` (commit message). Both optional.
- **Server behavior:**
  1. Reads `recordings_channel_name` from config (default `"Recordings"`).
  2. Scans all channels (via `get_channels_raw`) for one whose `name` matches.
     - If none → **404** `"Recordings channel '<name>' not found"`.
  3. Derives the `i64` Lore channel ID from the `ch_{hex}` string.
  4. Confirms a Lore repo actually exists for that channel
     (`lore.get_repo(...)`). If not → **404** `"... is not an Asset Storage
     channel with a Lore repo"`. (This is the hardening that prevents a
     non-asset-storage channel with the same name from causing an opaque 500.)
  5. Writes the body to a temp file, calls `lore.upload_file(...)` (which runs
     `lore file write` + `lore commit`), then records a `lore_commit` in WabiDB.
  6. Returns `{ revision, file, path }` where `path` is
     `recordings/{filename}`.
- **Why no `channel_id`?** The target is fixed by server configuration, so the
  client doesn't need to know or choose it. This keeps the client simple and the
  operator in control.

---

## 9. The Call-Recording → Lore Integration

This is the headline user-facing feature: when a call ends, the recording is
saved locally *and*, if Lore is available, automatically pushed to the
"Recordings" channel. Below is the full journey, front to back.

### 9.1 Client-side recording (no Lore involved yet)

1. A user starts a recording via `startCallRecording()`
   (`callRecording.ts`). MediaRecorder captures audio/video into `Blob` chunks.
2. On stop, `CallRecordingSession.stop()` resolves each artifact's
   `stopPromise`. The **main** ("mixed") artifact is `exports[0]`.
3. `exportRecordingArtifact(blob, fileName)` saves the file locally (Tauri
   desktop save, or a browser download) **and now also retains the `blob`** on
   the `RecordingArtifactExport` it returns.
4. `stop()` returns a `RecordingExportResult` that includes `mainBlob` — the
   main recording's `Blob`.

> Why carry the blob? Previously the blob was created and immediately discarded
> after the local save. To forward it to Lore, we had to keep a reference. The
> `blob` field on `RecordingArtifactExport` (and `mainBlob` on
> `RecordingExportResult`) is that reference.

### 9.2 The upload trigger

In `stopCallRecording()` (`callRecording.ts`):

```ts
const exported = await session.stop();
const fileName = get(callRecordingState).fileName;
callRecordingState.update(/* ... set status: 'idle', saved paths ... */);

// Optional: auto-upload the main recording to the Lore "Recordings" channel.
if (exported.mainBlob && fileName) {
    void uploadRecordingToLore(exported.mainBlob, fileName);
}
```

`uploadRecordingToLore()` (a private helper in `callRecording.ts`) flips the
state to `loreUploadStatus: 'uploading'`, then awaits
`uploadRecordingToLoreServer(...)` and maps the result to state:

| Outcome | `loreUploadStatus` | Notes |
|---|---|---|
| success | `done` | `loreUploadedPath` set to `recordings/{filename}` |
| channel missing / not asset-storage | `no-channel` | server returned 404 |
| other error | `error` | `loreUploadError` set |
| Lore not present at all | `none` | `checkLoreHealth` failed → silent no-op |

The upload is **fire-and-forget** (`void ...`) so it never blocks the UI.

### 9.3 The isolated helper (`loreRecording.ts`) — the only Lore-aware file

```ts
export async function uploadRecordingToLoreServer(blob, fileName) {
    if (!(await isLoreAvailable())) return { status: 'unavailable' };
    const file = new File([blob], fileName, { type: blob.type });
    const url  = `${loreUrl('/recordings')}?filename=...&message=...`;
    const res  = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        body: await file.arrayBuffer()
    });
    if (res.status === 404) return { status: 'no-channel' };
    if (!res.ok)            return { status: 'error', message: ... };
    return { status: 'done', path: data.path || fileName };
}
```

Key design points:

- **`isLoreAvailable()` is cached.** The first call hits `checkLoreHealth`;
  thereafter it returns the cached boolean. So a minimal server is probed **once
  per session**, not on every recording.
- **The core recording module stays Lore-agnostic.** `callRecording.ts` imports
  only the `uploadRecordingToLoreServer` function from `loreRecording.ts`. All
  Lore specifics (URL, health check, headers) are sealed inside the helper. If
  you removed `loreRecording.ts`, the recording core would compile and run
  unchanged — it would just never upload.
- **`resetLoreRecordingCache()`** (also exported) clears the cached health
  result — intended to be called on logout / server switch so a stale
  "unavailable" doesn't persist.

### 9.4 The 6-second reset and why it matters

`stopCallRecording()` schedules a `setTimeout(..., 6_000)` that resets most of
the recording state back to `INITIAL_STATE` (clearing the "saved" banner). We
**explicitly preserve** the three `loreUpload*` fields across that reset, so an
upload that's still in flight (or finishes a moment later) stays visible to the
user instead of being wiped by the timer.

### 9.5 UI

`CallRecordingPanel.svelte` renders the status line whenever
`loreUploadStatus !== 'none'` and the call isn't actively recording:

- `uploading` → "Saving recording to Lore…"
- `done` → "Saved to Lore Recordings"
- `no-channel` → "Lore Recordings channel not found"
- `error` → "Lore upload failed: <message>"

### 9.6 Server side

See §8.6. In short: resolve the "Recordings" channel by name, prove it's a real
Lore repo, write the bytes, commit, record the `lore_commit` event, return the
path.

### 9.7 Setup checklist (operator)

1. Build `wabi-server` with `--features wabi-lore` and set
   `[addons.lore] enabled = true`.
2. Create an **Asset Storage** channel named exactly `Recordings` (or whatever
   `recordings_channel_name` is set to). Give it `asset_storage: true` when
   creating it via the API — this auto-creates its Lore repo.
3. Make a call, stop the recording, and watch `CallRecordingPanel` show
   "Saving recording to Lore…" then "Saved to Lore Recordings."
4. Browse the `Recordings` channel's Lore repo (via the Lore UI / API) to see
   `recordings/<timestamp>.webm`.

If step 2 is skipped, the client shows "Lore Recordings channel not found" and
the local save still succeeds — Lore upload is purely additive.

---

## 10. Restart Rehydration (Why Lore Survives a Server Restart)

### 10.1 The problem

`LoreService.repos` is an **in-memory** `HashMap`. It is only populated when
`create_repo` runs — i.e. when an Asset Storage channel is created (at runtime)
or via the `POST /repos` API. **On a process restart, that map starts empty.**
Because every API handler does `lore.get_repo(channel_id)`, an empty map means
`get_repo` returns `None`, and uploads/downloads/etc. would **404 until someone
re-touched the channel**. In other words, Lore "forgot" all its repos after a
restart even though the underlying Lore data on disk was fine.

### 10.2 Why it's safe to fix

The repo registry is **already durably persisted** in WabiDB: `lore_create_repo`
writes a `LoreRepoRecord` into the `lore_repos` projection, and
`LoreRepoProjection::list_repos()` can enumerate them. So we just need to reload
the in-memory map from WabiDB at startup.

### 10.3 The fix (what was implemented)

Four small, surgical changes:

1. **`wabi-store` trait (`core/crates/wabidb/src/engine/wabi_store.rs`):**
   added `async fn list_lore_repos() -> Result<Vec<LoreRepoRecord>>` with a
   default no-op body (`Ok(Vec::new())`). The default means other implementors
   of `WabiStore` (e.g. the in-memory `LocalWabiStore` used in tests) need no
   changes.
2. **`WdbAdapter` (`adapter/mod.rs`):** implemented `list_lore_repos` by
   wrapping the existing `LoreRepoProjection::list_repos(...)`.
3. **`LoreService` (`core/addons/lore/backend/src/lib.rs`):** added a
   dependency-free `LoreRepoSeed` struct (channel_id, repo_name,
   lore_server_url, created_by, created_at_micros) and
   `load_existing_repos(seeds: Vec<LoreRepoSeed>)` which repopulates the
   `repos` map. Using a `Seed` (rather than the wabidb `LoreRepoRecord`
   directly) keeps the addon crate free of any `wabidb` dependency.
4. **`main.rs` (lore init block):** after the health check passes, it calls
   `state.wdb.list_lore_repos()`, maps each record into a `LoreRepoSeed`, and
   calls `service.load_existing_repos(...)` *before* `state.set_lore_service(...)`.

### 10.4 Why not a "lazy fallback"?

An alternative considered was to make `get_repo` fall back to a WDB lookup on a
miss. That adds a projection read on every repo access and still can't recover
lost Lore *bytes* (only the index). Eager rehydration at startup is a one-time
cost, fully covers the restart case, and matches the "WabiDB is the source of
truth" design — so it was chosen over the lazy approach.

### 10.5 Edge cases

- **Lore bytes wiped but WDB record remains:** rehydration restores the *index*,
  but the actual `lore file write` would fail because the repo data is gone.
  This is a data-loss scenario outside the addon's scope; rehydration only
  restores the pointer, not lost content.
- **`LoreRepoId` is regenerated on rehydration.** It was never persisted; it's
  only echoed back in returned `LoreRevision` metadata, so a fresh UUID is
  cosmetically fine.
- **Repos created after startup** still go through `create_repo` and populate
  the map normally — rehydration handles only what existed before the restart.

---

## 11. Security Model

### 11.1 Authentication

Every Lore endpoint uses the same `AuthUser` extractor as the rest of the API:
a valid Wabi session/JWT bearer token. There is no separate Lore credential —
the Wabi token is the credential, and the server acts on the user's behalf when
shelling out to the `lore` CLI.

### 11.2 Authorization

Authorization is **channel-scoped**:

- Channel **read** → Lore read access to that channel's repo.
- Channel **write** → Lore write access (upload, commit, lock).
- Channel **admin** → repo delete and other admin operations.

The `upload_recording` endpoint additionally restricts its target to the single
configured Recordings channel and refuses (404) anything that isn't a real Lore
repo, so a user cannot redirect recordings into an arbitrary channel.

### 11.3 Encryption & transport

- The addon talks to `loreserver` over whatever transport Lore configures
  (typically TLS). This is orthogonal to Wabi and handled by the Lore side.
- At rest, Lore's content-addressed store is independent of WabiDB encryption.
- Client-side encryption of recordings before upload is *not* currently
  implemented; uploads go as plaintext bytes over an authenticated channel.
  (Future work — see §15.)

### 11.4 File locks

Unmergeable binary assets can be locked via the lock endpoints. The Lore server
owns lock state; the addon enforces channel-level authorization on acquire /
release.

---

## 12. Operations & Runbook

### 12.1 Health check

```bash
curl -H "Authorization: Bearer $TOKEN" https://your-server/api/addons/lore/health
# -> { "status": "ok" }   (Lore built + CLI reachable)
# -> 404                   (Lore not compiled into this server)
# -> { "status": "error" } (CLI missing / unreachable)
```

The **frontend relies on this endpoint** to decide whether to show/attempt Lore
features. If health fails, the client silently disables Lore UI — no errors
surface to the user.

### 12.2 "Recordings aren't uploading"

1. Is the server built with `--features wabi-lore`? (Check `/health`.)
2. Is `[addons.lore] enabled = true` and did the service pass its startup
   health check? (Look for `[lore] Health check failed` in logs.)
3. Does an **Asset Storage** channel named exactly `Recordings` exist? (The
   client shows "Lore Recordings channel not found" if not.)
4. Was that channel created with `asset_storage: true`? (Otherwise no Lore repo
   exists and you'll see the same 404 / "not an Asset Storage channel" message.)
5. After a restart, did rehydration log `Rehydrated N Lore repo(s) from WDB`?
   (If `N = 0` and you expected repos, the `lore_repos` projection may be
   empty — check WabiDB.)

### 12.3 Logs to know

- `[lore] Health check failed: ... — Lore addon disabled` — Lore CLI missing or
  misconfigured; server runs without Lore.
- `[lore] Rehydrated N Lore repo(s) from WDB` — startup rehydration succeeded.
- `[lore] Lore addon initialized` — fully up.

---

## 13. Developer Onboarding

### 13.1 Build & test commands

```bash
# Backend, with the addon
cargo check -p wabi-server --features wabi-lore
cargo test  -p wabi-server --features wabi-lore

# The addon crate's own unit tests (config/repo serialization, etc.)
cargo test -p wabi-lore

# WabiDB lore projection + integration tests
cargo test -p wabidb lore

# Frontend type-check (Svelte + TS)
cd frontend && npm run check
```

### 13.2 Adding a new Lore REST endpoint (cookbook)

1. In `core/crates/wabi-server/src/api/lore.rs`, add a handler function. Use
   `lore_service(&state).await?` to get the `Arc<LoreService>` (it 404s/errors
   cleanly if Lore is off). Resolve any `channel_id` from the path/query, look up
   or create the repo via `lore`, and persist metadata with
   `state.wdb.lore_commit(...)` / `lore_create_repo(...)`.
2. Register the route in the `routes()` function (the `Router::new()` chain),
   gated automatically because the whole module is `#[cfg(feature="wabi-lore")]`.
3. If your handler needs new durable state, add a `WabiStore` trait method
   (with a default body) + a `WdbAdapter` impl + a projection, following the
   `lore_commits` / `lore_repos` pattern in `core/crates/wabidb`.
4. Add/update the frontend call in `frontend/src/lib/api/lore.ts` if the client
   needs it.

### 13.3 Key invariants to respect

- **Never store Lore bytes in WabiDB.** Only metadata (repo records, commit
  records) belong in the event log.
- **The `repos` map is a cache.** Always be able to rebuild it (rehydration).
- **Frontend Lore code belongs in `loreRecording.ts`** (for recordings) or
  `api/lore.ts` (generic). Keep `callRecording.ts` Lore-agnostic.
- **Channel IDs are `ch_{hex}` strings** server-side; convert to `i64` via hex
  parse. (And fix the frontend's decimal regex if you work near it — see §7.1.)

---

## 14. Repo Classes, Artist Review Flow, External Mirrors & Git Import

This section documents the repo-classes feature: every Lore repo is either a
**native** repo or a **read-only external mirror**, and native repos can run an
artist-friendly **review flow** where uploads land on review branches, plus a
**files-only git import** path.

### 14.1 Repo classes

A `LoreRepo` has a `class` (`RepoClass`):

- **`Native`** (default) — a full Lore repo owned by Wabi: create/upload/commit/
  lock/branch/merge all work as documented in §8.
- **`Mirror { upstream_url }`** — a read-only pointer to an external git
  repository. Wabi never owns the bytes; it lazily fetches from upstream and
  serves reads. All write endpoints return **501** (`MirrorReadOnly`).

Repos default to `Native`; nothing changes for existing channels. A repo becomes
a mirror only via `POST /repos/{channel_id}/external`. The `class`,
`auto_branch_on_upload`, and `imported_from` fields live in the `.wabi-repo.json`
sidecar in the working tree (see §7.4) because the postcard `LoreRepoRecord`
cannot gain fields without a dual-decode migration.

### 14.2 Artist-friendly review flow

Lore's model of "upload straight to the current branch" is hostile to artists —
an accidental upload pollutes the trunk. The review flow fixes this:

1. An Owner/Admin/Developer turns it on per repo:
   `PATCH /repos/{channel_id}` with `{ "autoBranchOnUpload": true }`.
2. An Artist uploads as usual (`PUT .../files/{*path}`). The service
   **creates + switches to a fresh `uploads/{sanitized_username}-{timestamp}`
   branch**, commits the file there, then switches back. The response includes
   `"pendingReview": true` and `"reviewBranch": "uploads/.../..."`. The upload
   never touches mainline.
3. A reviewer (Owner/Admin/Developer) either:
   - **Approves**: `POST /repos/{channel_id}/review/{name}/approve` → merge the
     branch into mainline, then archive (retire) it via `lore branch archive`.
   - **Rejects**: `POST /repos/{channel_id}/review/{name}/reject` → archive the
     branch without merging.

Archiving (rather than deleting) is deliberate: the Lore CLI has no destructive
branch delete; `lore branch archive` hides the branch from normal `list`
output while keeping it recoverable. The branch name embeds the uploader so
reviewers know who to talk to. Branch management and commit/review actions are
gated to Owner/Admin/Developer; uploads accept Artist (see §11.2).

### 14.3 External mirrors (read-only pointers)

Registering an external mirror records a pointer and creates the WabiDB
`LoreRepoRecord`; **no bytes are cloned at registration**. Reads are served
from a fetch cache:

- The first read (`list_files`, `get_file_content`, `download_file`,
  `file_history`) triggers a lazy `git clone --depth 1` of `upstream_url` into
  `<data_dir>/<channel_id>/.mirror-cache`.
- Subsequent reads within `MIRROR_CACHE_TTL_SECS` (600 s) reuse the cache.
- `POST /repos/{channel_id}/mirror/refresh` invalidates the cache so the next
  read re-fetches — point your upstream's push webhook here.
- `delete_repo` removes the cache directory.

Caveats: the shallow clone carries only the tip commit, so mirror history shows
a single revision, and diffs are not supported on mirrors (the service refuses
diff on read-only repos). Mirrors are best used as a "browse upstream" window,
or alongside `import_from_git` (below) to get working history.

### 14.4 Git import (files-only)

`POST /repos/import` (`{ channelId, name, upstreamUrl }`) imports an existing
git repository into a new native Lore repo:

1. Validates the channel has no repo yet (else **409**).
2. `git clone` the upstream into a temp dir; on failure, returns **502** with
   the git stderr.
3. Strips `.git`, seeds a `.gitignore`, stages everything, and makes one initial
   commit, then moves the tree into place as the repo's working tree.

This imports **files only** — git history, tags, and branches are not carried
over. For a channel that wants the old history browsable, register the same
upstream as an external mirror (`POST .../external`) so the reads come from
upstream while Wabi keeps its own native repo for writes. The upstream URL is
recorded in `LoreRepo.imported_from`.

### 14.5 Embedded mode

The default `mode = "embedded"` runs Lore fully offline against a local
working tree. For mirrors this means `git` (not the Lore CLI) does the fetching;
`sync_repo`/`push_repo` are no-ops that log `offline repo: sync skipped`, and
file locks degrade to `locked_by: null` (no Lore server to consult). The `git`
binary must be on the server's `PATH` for mirror/import features.

---

## 15. Known Limitations & Future Work

- **Phase 1 = CLI wrapper.** All Lore ops shell out to the `lore` binary.
  Phase 2 may call the `lore` Rust crate directly for lower latency and better
  error handling.
- **`LoreRepoId` is not persisted** (regenerated on rehydration). Cosmetic only.
- **No client-side encryption** of recordings before upload yet.
- **Frontend channel-ID parsing uses a decimal regex** (`/^ch_(\d+)/`) that
  doesn't match real `ch_{hex}` IDs — unify this before relying on it.
- **The Recordings channel must be created manually** by an operator (the
  server 404s if it's missing rather than auto-creating it). Auto-provisioning
  could be added if desired.
- **`get_channels_raw` scans all channels** per recording upload to find the
  Recordings channel by name. Fine at current scale; could be cached or resolved
  once at startup if recording volume grows.
- **Lost Lore bytes + intact WDB record** still 404s at the CLI level
  (rehydration restores only the index). Operational backups of the Lore data
  dir are the mitigation.

---

## 16. Glossary

- **Lore** — the upstream version-control system for large binaries (Epic
  Games). Wabi wraps it.
- **loreserver** — the Lore server process that stores the actual bytes.
- **`LoreService`** — the `wabi-lore` crate's Rust wrapper around the `lore`
  CLI. Lives in `AppState.lore_service`.
- **`lore_repo`** — a Lore repository attached to one Wabi channel.
- **Asset Storage channel** — a Wabi channel of type `lore` ("Asset Storage")
  that can host a Lore repo (typically auto-created when `asset_storage: true`).
- **Recordings channel** — the specific Asset Storage channel (named
  `Recordings` by default) that finished call recordings are uploaded to.
- **`lore_repos` / `lore_commits` projections** — WabiDB indexes that store
  Lore metadata as queryable state.
- **Rehydration** — reloading `LoreService.repos` from WabiDB at startup so Lore
  survives a restart.
- **Feature gate (`--features wabi-lore`)** — the Rust compile-time switch that
  includes/excludes the entire Lore module from the server binary.
- **Runtime guard (`checkLoreHealth`)** — the frontend's check that decides
  whether to attempt Lore features against the current server.
- **`RepoClass`** — a Lore repo's class: `Native` or `Mirror { upstream_url }`
  (read-only external pointer).
- **Review flow / `autoBranchOnUpload`** — repo setting that sends every upload
  to a fresh `uploads/<user>-<ts>` branch for later approve/reject.
- **`lore branch archive`** — the Lore CLI's non-destructive "retire a branch"
  command used to retire review branches after approve/reject.
- **`import_from_git`** — the files-only git import path (`POST /repos/import`).
- **`.wabi-repo.json`** — the sidecar state file in a repo's working tree that
  persists `class`, `auto_branch_on_upload`, and `imported_from` across
  restarts.

---

*This document describes the implementation as it exists today (Lore addon +
call-recording integration + restart rehydration). If you find a mismatch
between this guide and the code, trust the code and update this file.*
