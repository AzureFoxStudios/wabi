# Lore Code Sync — fixes, sync server, editable Code view, file browser

**Date:** 2026-08-17
**Status:** Implemented (working tree) — awaiting real-browser + deploy verification
**Scope:** `core/addons/lore/backend`, `core/crates/wabi-server` (api/lore.rs, auth_extractor.rs, adapter), `core/crates/wabidb` (lore projections), new `crates/wabi-sync`, frontend lore components + FilesWorkspace.

This is the implementation record for the "code workflow" push: Wabi as a code
sync server for external editors, in-browser code editing/review, backend
correctness fixes, and the file browser touch-up. Decisions (user-confirmed):
folder-level **wabi-sync CLI** as the sync client, **editable CodeMirror** in
the UI, **optimistic concurrency (ETag/If-Match) + optional locks**, and
**fix all known backend defects**.

## Phase 0 — Backend correctness (lore addon + API)

| Fix | Where |
|---|---|
| `?revision=` downloads honored via a per-revision content cache (`<lore_data_dir>/<channel_id>.revcache/<rev>/<path>`, populated at wabi-mediated commit time; head reads still come from the working tree) | `lib.rs download_file`, `cache_revision_content` |
| ETags: `LoreFileInfo.etag` (SHA-256; `q-…` sampled for >4 MiB files), etag cache keyed (size, mtime); `GET file` returns `ETag` + `If-None-Match`→304; `PUT`/`DELETE` honor `If-Match` → **409 `StaleEtag`** with `{currentEtag}`; absent If-Match = last-write-wins (back-compat) | `lib.rs` etag helpers, `api/lore.rs` `check_if_match` |
| `merge_branch` actually merges: `lore branch merge <src>` into the current branch (refuses self-merge), then sync+push | `lib.rs merge_branch` |
| WDB event writes are honest: `warn!` on failure + `wdbRecorded` in responses (was `let _ =`) | `api/lore.rs record_lore_commit_and_change` |
| Upload ignore-check runs **before** copying bytes / creating review branches (rejected uploads no longer leave bytes on disk or strand the repo on a review branch) | `lib.rs upload_file` |
| `file_history` path filter: native repos filter the WDB commit log (which carries per-file paths); mirrors use `git log -- <path>` | `api/lore.rs file_level_history`, `lib.rs mirror_history` |
| Locks carry `locked_by`/`locked_at` (server-reported owner or the requesting user) | `lib.rs lock_file` |
| Read-only mirrors: `status` via git on the fetch cache, `get_diff` returns empty (read op, no longer 501s), `file_diff` via `git diff` on the cache | `lib.rs status/get_diff/file_diff` |
| Parser hardening (handshake-repair Task 7): `parse_status_line` validates path shape and rejects prose prefixes; history/commit parsers only treat **indented** lines as messages and skip unindented prose without minting phantom revisions | `lib.rs` parsers + tests |
| Config: default lore URL unified to `:10000`; `WABI_LORE_MAX_BLOB_MB` enforced (413 `BlobTooLarge`); `WABI_LORE_AUTO_CREATE=false` now actually opts out of repo auto-create | `LoreConfig::default`, `api/lore.rs upload_file`, `api/channels.rs` |
| **Honest stubs**: mirror does a real export+`git push -f` (scratch repo, `.wabiignore`-filtered, `latest` tag; S3 → explicit "not implemented"); editor bridge launches REAL docker code-server containers (port-per-session, container cleanup) and refuses with a pointer to wabi-sync when disabled; script runner fixes duration_ms, enforces `allowed_scripts` globs, keeps the child pid so cancel/timeout kill the process; `run_script` default working_dir is the actual working tree | `mirror.rs`, `editor_bridge.rs`, `script_runner.rs`, `api/lore.rs` |
| `health_check` TCP-connects the lore server in sidecar/remote modes (not just `lore --version`) | `lib.rs health_check` |

## Phase 1 — Sync protocol, tokens, live events (server)

- **`GET /repos/{id}/manifest`** — files+etags+headRevision+readOnly in one call.
- **`GET /repos/{id}/changes?since=<seq>`** — cursor-ordered per-file change feed.
  New WabiDB event `lore_file_change` + projection `lore_file_changes`
  (key = channel LE + seq BE; the projection takes the authoritative seq from
  the event envelope). Written by `WdbAdapter::lore_file_change` alongside
  `lore_commit` on every upload/delete/snapshot.
- **Server-minted connect tokens** — `POST/GET /repos/{id}/connect-tokens`,
  `DELETE …/connect-tokens/{hash}`. Opaque `wblore_…` tokens, SHA-256-hashed at
  rest in the new `lore_tokens` projection (mint/revoke events), scoped
  `read`/`read,write`, bound to user+channel. `auth_extractor` accepts them as
  Bearer creds (JWT decode first, `wblore_` fallback); a router middleware
  (`lore_scope_guard`) rejects mutating requests from read-only tokens.
  Replaces the old browser-minted W6b token, which validated nothing.
- **Live events** — every wabi-mediated write emits `lore:file-changed` to the
  channel's socket room (`ch_<hex>`) with `{action, path, etag, revision,
  authorUserId, pendingReview, cursor}` (retention-reaper pattern via
  `state.sio`). The inert engine subscription bridge was left untouched.

## Phase 2 — `wabi-sync` CLI (new workspace member `crates/wabi-sync`)

Editor-agnostic folder sync: `login <server>` → `link <ch_e1|225> <folder>`
(writes `.wabi-sync.json`) → `watch` (FS events + change-feed polling,
debounced) or one-shot `push`/`pull`/`sync`/`status`/`lock`/`unlock`.
Three-way merge via etag baselines in `.wabi-sync/state.json`; conflicts never
clobber — the losing side is preserved as `<path>.wabi-conflict-<etag8>`.
Client etag algorithm is byte-identical to the server's (wire contract).

## Phase 3 — Code view (frontend)

- `LoreFileViewer` → CodeMirror 6 (one-dark, line numbers, language
  auto-detect; packages were already deps, previously unused). **Editing**
  (role-gated `canEdit` = can_asset_write): re-fetches content+etag on edit
  entry, Ctrl/Cmd+S → PUT with If-Match; 409 → conflict bar
  (overwrite server / load server version / keep editing).
- `LoreDiffViewer`: line numbers, unified+side-by-side, Prism-highlighted code
  inside hunks (grammar by file extension, escaped + cached).
- Live updates: `loreStore.subscribeLoreLive()` on `lore:file-changed`;
  `LoreChannelShell` debounced-refreshes tree+history (W6e).
- Connect panel (`LoreConnectPanel`): server-minted tokens with scope picker,
  active-token list with revoke, and the exact `wabi-sync login/link/watch`
  commands for this channel (replaces the fake browser token + C/C++/Rust
  snippets).

## Phase 4 — Files workspace

`FilesWorkspace` now reuses `LoreFileTree` (real recursive tree + its own
search) instead of the flat breadcrumb/list; loads the full listing once per
space. Uploads run through a 3-wide concurrency pool with a per-file progress
list and land in the selected node's folder. Text previews render through
`LoreFileViewer` (dedupes the preview path); images keep blob previews.

## Verification

- `cargo test -p wabi-lore` — 28 pass (parsers, etags, revcache, allowlist,
  globs, mirror-real-push-to-local-bare-repo, editor-bridge honesty).
- `cargo test -p wabidb` lore — 13 pass (new feed/token projection tests).
- `cargo test -p wabi-server --features addons --lib api::lore` — 9 pass
  (If-Match matrix + end-to-end upload/download-at-revision/conflict/ignore
  flow against a bash **stub lore CLI** fixture).
- `cargo test -p wabi-sync` — 8 pass.
- `bun run check` — 0 errors.
- NOTE: `projections::messages::tests::insert_and_lookup` and
  `engine::locks::tests::projection_messages_routes_to_handler` fail at clean
  HEAD **without any of these changes** (verified via git worktree) — they
  belong to the parallel wabidb restart-recovery workstream, not this one.
- Outstanding: real-browser verification of the Code view (golden rule 7),
  deploy with `--features addons`, end-to-end wabi-sync run against a live
  server with a real lore CLI.

## New WabiDB surfaces (per DB-change policy)

- Event `lore_file_change` → `LoreFileChangeProjection` → index
  `lore_file_changes`, record `LoreFileChangeRecord` (new type; no postcard
  compat risk). Registered in `build_type_registry`.
- Events `lore_token_minted`/`lore_token_revoked` → `LoreTokenProjection` →
  index `lore_tokens`, record `LoreTokenRecord`.
- `WabiStore` additions with default no-op impls: `list_lore_commits`,
  `lore_file_change`, `list_lore_file_changes`, `lore_mint_token`,
  `lore_revoke_token`, `lore_get_token`, `list_lore_tokens`.
- No existing postcard record was modified (no RecordV0/V1 fallback needed);
  `ChannelType` untouched (no ts-rs regen required).
