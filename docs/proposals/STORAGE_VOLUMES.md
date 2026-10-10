# Storage volumes: NAS attachment and admin-controlled file placement

**Status:** Proposal, 2026-10-10. Nothing in this document is implemented. Today every upload is stored in one directory (`WABI_UPLOADS_DIR`, default `<data_dir>/uploads`) on the Authority. See [WABI_DESIGN_PHILOSOPHY.md](../architecture/WABI_DESIGN_PHILOSOPHY.md) for the principles this follows.

**Supersedes:** [nas-storage-proposal.md](nas-storage-proposal.md) (May 2026). That proposal swapped the whole upload store for one addon-provided backend. This one keeps placement in core, allows many volumes at once, and builds on the upload records added since (`upload_published_v1`, `upload_revoked_v1`). See [section 10](#10-differences-from-the-may-2026-proposal).

## 1. Goals

1. **Capacity grows by attaching storage.** An operator can add a NAS share, a second disk or (later) object storage, and usable space goes up without moving the database.
2. **Admins control where files go.** Clear, ordered placement rules decide which volume receives which files: by room, kind, size or age.
3. **Nothing breaks when a volume is absent.** One offline volume makes only its files unavailable. Chat, the database and other volumes keep working.
4. **One disk still works with zero configuration.** An existing install becomes a single implicit volume, with identical behavior.
5. **Ready for multiple nodes.** A volume can later belong to another trusted node, so the same model carries regional storage ([GEOGRAPHIC_COMMUNITY_WEB.md](../architecture/GEOGRAPHIC_COMMUNITY_WEB.md)).

### Non-goals

- Wabi does not mount network shares itself. The operating system mounts NFS/SMB/iSCSI. Wabi uses the mounted path and checks it is healthy. This avoids shipping SMB/NFS clients, credentials and reconnect logic in Wabi.
- The WabiDB data directory never moves to a volume. Its advisory lock and fsync behavior require a local filesystem (`AGENTS.md` rule 9).
- This is not replication or HA. A NAS with its own RAID protects against disk failure. Losing the NAS still loses its files unless the operator has a backup or a second copy (see [section 7](#7-copies-and-durability)).

## 2. Current behavior this must preserve

Facts from `main` (2026-10-10):

- Completed uploads are flat files at `{uploads_dir}/{uuid}.{ext}`. Resumable staging lives at `{uploads_dir}/.tmp/{upload_id}` and is renamed into place, so staging and final files share one filesystem (`core/crates/wabi-server/src/api/upload.rs`).
- `upload_published_v1` commits filename, original name, channel/uploader, kind, byte count, SHA-256 and creation time. It is committed while bytes are staged; success is returned only after the final file is published and synced.
- `upload_revoked_v1` records deletion. Owner/admin deletion commits it before removing the file.
- On startup the Authority hashes every canonical upload and **refuses to start** if a nonrevoked published file is missing or changed (`upload_registry.rs`).
- About 28 server source files reference `config.uploads_dir` directly: uploads, emoji, whiteboard, Lore, server center, boosters, the upload registry, replication transport, instance archive/checkpoint and the replica receiver.
- The experimental replica path copies published upload bytes by filename and verifies SHA-256. The Anchor cache and volunteer boosters fetch through `GET /uploads/{filename}`.

## 3. Concepts

### Volume

A **volume** is a place where file bytes can live.

| Field | Meaning |
|---|---|
| `id` | Stable short ID (`local`, `nas-main`, `archive-2`). Never reused. |
| `label` | Human name shown in Admin. |
| `kind` | `local_path` (any mounted filesystem, including NAS). Later: `s3_compatible`, `remote_node`. |
| `root` | Absolute path for `local_path`. |
| `node_id` | The node that can reach this volume. Today always the Authority. |
| `capacity_budget` | Optional cap Wabi will not exceed, even if the disk has more space. |
| `reserve` | Free space Wabi always leaves (default: 5% or 2 GiB, whichever is larger). |
| `state` | `active`, `read_only`, `draining`, `offline`, `retired`. |
| `trust` | Free-text operator note (for example "family NAS, unencrypted, readable by NAS admin"), shown wherever the volume is chosen. |

The existing upload directory becomes the implicit volume `local`. No configuration is needed to keep today's behavior.

### Location record

Each published upload gains a **location**: which volume(s) hold its verified bytes. The upload's identity and hash do not change when bytes move, so links, messages, review anchors and caches stay valid.

### Placement rule

A **placement rule** decides where a *new* upload is written, and optionally where it should move later.

## 4. Admin control: deciding where the NAS comes in

### 4.1 Rules

Admin → Infrastructure → Storage shows an ordered rule list. The first matching rule wins; the last rule is always the default.

| Match | Example |
|---|---|
| Room or category | `#renders`, `#archive`, all channels in the "Projects" category |
| File kind | video, image, audio, CAD/model, Lore asset, other |
| Size | larger than 50 MB |
| Age (tiering) | older than 30 days, *move* to another volume |
| Upload source | channel attachment, profile media, emoji, whiteboard |

Each rule chooses a **target volume** and a **fallback**: the next volume, or *refuse the upload with a clear message*.

Example configuration:

```text
1. Kind = video OR size > 50 MB        → nas-main      (fallback: refuse)
2. Room = #archive                     → nas-main      (fallback: local)
3. Source = profile media / emoji      → local         (fast, small, always online)
4. Age > 30 days (background move)     → nas-main
5. Default                             → local         (fallback: nas-main)
```

Small, frequently viewed files stay on the fast local disk. Big and old files go to the large NAS.

### 4.2 Guardrails the admin always sees

- **Dry run before saving.** "This rule would place about 12 GB of existing files on `nas-main` and would apply to about 3 GB of new uploads per week" (estimated from the last 30 days).
- **Trust note on every target.** Choosing a volume for a private room shows that volume's trust note. Moving a room's files is an authority decision, so it is always explicit (philosophy principle 5).
- **Capacity forecast.** Free space, the current growth rate and "full in about N days" per volume.
- **No silent spill.** If a rule's target is full or offline, the configured fallback applies and Admin shows a warning. Wabi never quietly writes to an unexpected volume.

### 4.3 Bootstrap configuration

Admin UI is the normal path. Headless or container operators can declare volumes at startup, for example:

```text
WABI_STORAGE_VOLUMES=nas-main:/mnt/nas/wabi-uploads
```

Environment-declared volumes appear in Admin and are marked as environment-managed. Rules are stored as WabiDB events (section 6) so they replicate and appear in recovery like other community state.

## 5. Runtime behavior

### 5.1 Writes

1. Evaluate rules and pick the target volume.
2. Stage on **the same volume** (`{root}/.tmp/`) so the final rename stays atomic. Today's single `.tmp` becomes one per volume.
3. Commit `upload_published_v1` as now. The location is committed together with it (or immediately after, in the same group commit; section 6).
4. Write, fsync, rename and fsync the directory on the target volume, then return success. This is unchanged from today, just on a chosen root.

Before accepting an upload, Wabi checks the target has `size + reserve` free. Resumable uploads reserve their declared size at init time.

### 5.2 Reads

`GET /uploads/{filename}` resolves the filename → location → volume → path. Response headers, digest validators, cache policy, revocation checks and range behavior stay exactly as today, so Anchors, boosters and browsers need no change.

### 5.3 Moves (tiering, draining, rebalancing)

A background mover, rate-limited and pausable in Admin:

1. Copy to the destination's staging area.
2. Verify SHA-256 against the record.
3. Rename into place and fsync.
4. Commit a location change (new copy present).
5. After a grace period with no in-flight reads, delete the old copy and commit its removal.

A crash at any step leaves at least one verified, recorded copy. Restart resumes from the recorded state. Staging leftovers are cleaned up like today's `.tmp`.

**Draining** a volume moves everything off it, then marks it `retired`. This is how an operator replaces a NAS.

### 5.4 Volume health

Each volume is probed periodically: path exists, is the expected filesystem (a marker file containing the volume ID, so an *unmounted* path pointing at an empty local directory is detected), is writable, free space, and write/read latency.

| Condition | Behavior |
|---|---|
| Unmounted (marker missing) | `offline`. Never write to the bare mount point; that would fill the root disk and hide files when the NAS returns. |
| Slow or erroring | Admin warning; new writes follow the rule's fallback. |
| Below reserve | Treated as full for new writes; moves onto it pause. |
| Returns online | Marker and spot-check hashes verified, then `active` again. |

Downloading a file whose only copy is offline returns `503` with a clear "storage volume offline" error, not `404`. The client shows it as temporarily unavailable.

### 5.5 Startup verification

Today the Authority hashes every upload and refuses to start on a missing file. With a NAS that becomes slow (every byte read over the network) and fragile (one offline share blocks the whole community). Proposed change:

- Do not refuse startup because a volume is **offline**. Mark it offline and serve everything else.
- **Keep** the refusal when a volume is online and a recorded file is missing or has a wrong hash. That still means corruption or a bad restore.
- Replace "hash everything at startup" with a size check at startup plus a background scrubber that re-hashes files at a bounded rate and records the last verification time. Admin shows scrub progress and any mismatches.

This is a behavior change to a safety check, so it needs its own tests and a note in [BACKUP_AND_RECOVERY.md](../deployment/BACKUP_AND_RECOVERY.md).

## 6. Data model (additive JSON events)

All new durable facts are additive JSON events with `schemaVersion`. No postcard records change (`AGENTS.md` rule 5).

| Event | Stream | Content |
|---|---|---|
| `storage_volume_registered_v1` | `storage-volumes:v1` | `{schemaVersion, id, label, kind, nodeId, capacityBudget, reserve, trust}`. The path itself is node-local configuration, not community state. |
| `storage_volume_state_changed_v1` | `storage-volumes:v1` | `{schemaVersion, id, state}` for operator-set states (`read_only`, `draining`, `retired`). Health-derived `offline` is runtime state, not an event. |
| `storage_placement_rules_replaced_v1` | `storage-placement:v1` | `{schemaVersion, version, rules[]}`, the whole ordered list, monotonic version. |
| `upload_location_changed_v1` | `upload-assets:v1` | `{schemaVersion, filename, sha256, volumeId, change: added \| removed}` |

Projections: `storage_volumes`, `storage_placement`, `upload_locations` (filename → volume IDs).

**Legacy and backfill:** an upload with no location event is on `local`. That rule needs no migration and matches every existing install. Old binaries ignore the new events, but after a rollback they would look for every file in the old single directory. Downgrading after files were moved therefore requires moving them back first or restoring a matching backup, as the other upload events already document.

Any new streams and projections must be added to the relevant engine/plan docs when implemented (`AGENTS.md`, documentation hierarchy).

## 7. Copies and durability

A rule can require **minimum copies** (default 1). With `min_copies = 2`, an upload succeeds only when two volumes hold verified bytes, for example local SSD and NAS. This is the same "copies cost space" trade-off described in the philosophy doc:

| Setup | Usable space | Survives |
|---|---|---|
| 1 TB local + 4 TB NAS, 1 copy | ~5 TB | Neither device's loss without backup |
| Same, important rooms at 2 copies | Less, depending on rule | Loss of either device for those rooms |

A NAS's internal RAID is a single copy from Wabi's point of view. Admin labels it that way.

## 8. Recovery, replication and other subsystems

Every path that currently assumes one upload directory has to learn about volumes:

- **Instance archive/checkpoint**: enumerate all volumes, or record that a volume is deliberately excluded (for example "archive NAS backed up separately"). A restore with an excluded volume should report which files it does not contain rather than refuse silently. Update [INSTANCE_RECOVERY_INVENTORY.md](../architecture/INSTANCE_RECOVERY_INVENTORY.md).
- **Experimental replica byte catch-up**: read source bytes through the volume resolver. Map receiver placement through receiver-side volume configuration.
- **Revocation**: `upload_revoked_v1` deletes the file from **every** recorded location, including offline volumes when they return (pending-deletion list).
- **Anchor cache, boosters, service worker**: no change; they use the HTTP route.
- **Lore, whiteboard, emoji, profile media**: go through the resolver. Their source category becomes a rule match.

## 9. Implementation phases

Each phase ships independently. Each must keep a fresh single-disk install unchanged.

| Phase | Scope | Acceptance |
|---|---|---|
| **0. Storage interface** | Add one `UploadStore` resolver (`resolve(filename)`, `stage(volume)`, `publish`, `remove`, streaming read/write). Replace direct `config.uploads_dir` joins in all ~28 files. Behavior identical. | Existing upload, registry, archive, replica and Anchor tests pass unchanged. Grep check: no new direct `uploads_dir` path joins outside the store. |
| **1. Local-path volumes + rules for new uploads** | Volume registry, marker files, health probe, placement rules for new uploads, location events, Admin Storage page (read-only health plus rule editor with dry run). | Upload lands on the rule's volume; unmounted NAS detected and never written; offline volume returns 503 only for its files; restart with a volume offline still serves the rest; rollback note documented. |
| **2. Moves, tiering, draining, scrubber** | Background mover, age rules, drain/retire, rate-limited scrubber, startup check change (5.5). | Kill at every mover step leaves one verified recorded copy; drain empties a volume; revocation reaches moved and offline copies; scrubber detects an altered byte. |
| **3. Minimum copies** | Multi-copy writes and repair when a copy goes missing. | Upload with `min_copies = 2` refused when only one volume is healthy (or follows fallback); repair restores a removed copy. |
| **4. Object storage (optional)** | `s3_compatible` kind behind a compile-time feature, so operators can use MinIO/Garage/SeaweedFS for pooled multi-machine storage. | Same acceptance suite as `local_path`, plus credential handling and a clear error when the endpoint is unreachable. |
| **5. Remote node volumes** | Volumes attached to other trusted nodes, writes from nearby entry points, small record crossing regions. Depends on room placement and the trust model in the geographic design. | Defined with [GEOGRAPHIC_COMMUNITY_WEB.md](../architecture/GEOGRAPHIC_COMMUNITY_WEB.md) gates; not started before phases 0–3 are field-tested. |

Phase 0 is the main engineering cost and has value even if nothing else lands: it removes the "one directory on one disk" assumption from the codebase.

## 10. Differences from the May 2026 proposal

| May 2026 (`nas-storage-proposal.md`) | This proposal | Why |
|---|---|---|
| One active provider, swapped in by an addon | Many volumes active at once, chosen by rules | Capacity should grow by *adding* storage, and admins need per-room/kind/size control |
| Addon mounts SMB/NFS and holds credentials | The OS mounts; Wabi uses paths and detects unmounted shares | Less code and fewer secrets in Wabi; mounting is a solved OS problem |
| Placement logic in an optional plugin | Volume/location records in core; only exotic backends (S3) are optional features | Upload records, revocation, recovery and replication are core correctness. Runtime plugins are trusted operator code without proven isolation |
| `retrieve()` returns whole files in memory | Streaming reads and writes | Large video/CAD files must not be buffered whole |
| Predates hash/revocation events | Built on `upload_published_v1` / `upload_revoked_v1` | Hashes make moves verifiable and copies interchangeable |

## 11. Open questions

1. **Per-room quotas.** Should rules also cap how much a room or user may store on a volume? (Likely yes, as a later rule field.)
2. **Encryption at rest on volumes.** Should Wabi optionally encrypt bytes on volumes the operator marks untrusted (for example a shared NAS)? That changes how scrubbing, Anchor caching and range requests work, and needs a key-management design.
3. **Network filesystem semantics.** Some SMB/NFS configurations do not honor rename or fsync the way local filesystems do. Phase 1 should include a volume self-test (atomic rename, fsync, directory fsync) and refuse or warn on volumes that fail it.
4. **Where staging lives for slow volumes.** Staging on the target keeps renames atomic, but a slow NAS slows uploads. An alternative is staging locally and then running the verified mover. That makes the upload two-step but faster for the user.
