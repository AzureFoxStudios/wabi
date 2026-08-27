# Lore Setup UX — TUI-first, channel-as-repo (2026-08-27)

Status: in flight (this document is the implementation log; updated as phases land).

## Problem

Lore setup was clunky and missed the product vision:

- **Device-linking was copy-paste CLI.** "Use a folder on this computer" on the
  web = mint a connect token, copy it, copy three `wabi-sync` commands, run them
  yourself, with no feedback loop into the UI.
- **The channel/repo split leaked.** With `WABI_LORE_AUTO_CREATE=true` every new
  lore channel gets a repo, but `import_from_git` refused with `RepoExists` on
  exactly those channels — "create project channel, then import my code" 409'd.
- **Auto-created repos were named `ch-<numeric-id>`** (`lore://host/ch-47`) —
  the URL actively contradicted "the channel IS the repo".
- **Every upload was its own commit**, so pushing a folder of N files minted N
  revisions. Importing a project produced a noise wall instead of "Initial
  import".
- **The web lied in small ways**: a lore-server URL field that was never sent
  (with a wrong default), "make sure loreserver is started" advice for embedded
  deployments where that's meaningless, and `/lore` chat commands that parsed
  `ch_{hex}` ids as `parseInt(x, 16)` (reading just the `c`), hit dead route
  shapes, "switched" branches by silently MERGING them, and "staged" files by
  PUT-ing an empty body over them.

## Destination (unchanged from the master kanban)

Channels are repo boundaries. A lore channel IS a repo from the moment it
exists. Setup is GitHub-simple:

- one command creates channel + repo (`:lore new wabi`);
- if you're on the device with the folder, one command links it
  (`:lore push <dir>`) — stage everything, seal with ONE commit;
- the repo is browsable without a browser (the TUI is the smoke-test vehicle).

## Changes

### Backend (`core/addons/lore/backend/src/lib.rs`)

1. **`stage_file(channel_id, local_path, repo_path)`** — stage without commit.
   Shared validation prologue extracted to `resolve_writable_target`
   (writability + P0 traversal hardening + `.wabiignore`), so the commit path
   and the stage path cannot drift. Deliberately bypasses
   `auto_branch_on_upload` review branches — a staged batch is sealed by an
   explicit snapshot on the current branch.
2. **`import_from_git` adopts EMPTY repos.** An existing registration only
   blocks the import when it's a mirror or its working tree has user content
   (new `working_tree_is_pristine` walker: only `.lore/`, sidecar, ignore
   seeds, `.mirror-cache` are furniture). The move-into-place step already
   replaces the tree and registration.
3. **`slugify_repo_name`** — `[a-z0-9-]` slug, separator runs collapsed.
   `channels.rs` auto-create now names repos after the channel
   (`lore://host/my-project`), falling back to `ch-{id}` when the name has no
   slugifiable characters.

### API (`core/crates/wabi-server/src/api/lore.rs`)

4. **`PUT /repos/{id}/files/{*path}?stageOnly=true`** — stage-only branch of
   `upload_file`. Response `{staged, file, etag}`; emits `lore:file-changed`
   with `action: "staged"`; per-file WDB commit recording is deferred to the
   closing snapshot (which owns the revision hash).

### TUI (`core/crates/wabi-tui`)

5. **New `Screen::Lore` (key `5`)** — left pane: lore channels with live repo
   state (`✓ repo · N files` / `⚠ no repo`); right pane: repo header
   (`lore://host/name`, imported-from) + windowed file list with sizes;
   `v` previews a selected text file (≤64 KiB, first 400 lines).
6. **`:lore` command family**:
   - `:lore new <name>` — create channel + repo in one step; confirms with the
     repo URL. If server auto-create is off, creates the repo explicitly so the
     flow always ends "repo ready".
   - `:lore push <dir>` — device-link: walk the folder client-side (skips
     `.git`, `target/`, `node_modules/`, `data/`, `logs/`, `lore-data/`,
     `.svelte-kit/`, `build/`, `dist/`, `.env*`, `.DS_Store`, symlinks), stage
     at concurrency 4 via `stageOnly=true`, then ONE snapshot
     (`Initial import from <dir> (N files)`).
   - `:lore import <git-url-or-path> [name]` — server-side git import into a
     fresh channel (uses adopt-empty).
   - `:lore health` — addon health.
7. **API client**: `create_channel`, `lore_health`, `lore_get_repo` (404→None),
   `lore_create_repo`, `lore_import`, `lore_list_files`, `lore_stage`,
   `lore_snapshot`, `lore_download`; `parse_channel_id` (`ch_{hex}`→i64,
   same contract as the web's `parseLoreChannelId`); `slugify` client mirror.

### Web honesty fixes

8. `LoreConnectModal.svelte`: removed the never-sent lore-server URL field
   (+ its wrong `lore://127.0.0.1:41337` default); health chip now distinguishes
   `disabled` (`WABI_LORE_ENABLED=false`) from `error`, and the error advice no
   longer tells embedded deployments to start a separate server.
9. `CommandRegistry.ts` `/lore`: channel id via `parseLoreChannelId`;
   diff/lock use the action-first routes (`/diff/{*path}`, `/lock/{*path}`);
   `branch switch` and `stage` answer honestly instead of merge-lying /
   empty-body-PUT-destroying content.

## Tests

- `api::lore::tests::staged_batch_push_seals_into_single_snapshot_commit` —
  2 staged files → visible in tree → ONE snapshot revision → head content
  intact.
- `api::lore::tests::git_import_adopts_empty_auto_created_repo` — real local
  `git init` upstream; import into a channel with an empty auto-created repo
  succeeds; re-import into the now-populated repo still `RepoExists`.
- `wabi_lore::tests::test_slugify_repo_name`,
  `test_working_tree_is_pristine`, `test_walk_working_tree_files` — unit
  coverage for the new helpers.
- Pre-existing lore suites stay green (12 api::lore, 34 wabi-lore).

## Evidence / delivery

- Base: `origin/main` `1105c37` (PR #155 squash) + cherry-picked bazzite fix
  `367af1d4` (`wabidb-pong emit needs &data`) — origin/main did not compile
  without it. The user-reported `166d21a` / rebased arena branch does not exist
  on origin, bazzite, or this machine; its unique content (calling fixes) is
  already in main via the squash.
- Local gates: `bun run check` 0 errors; `cargo test -p wabi-lore -p
  wabi-server --features addons` green; release builds of `wabi-server
  --features addons` + `wabi-tui`.
- **Tim deployment** (two swaps, runbook procedure — stop, clear BOTH locks,
  replace, recreate): final binary SHA `ab3aaf92ce104561…` matches local;
  `:3001/health`, Caddy `:8088/health`, and public `https://wabi.chat/health`
  all 200. `docker logs` is empty on this host (logs not captured) —
  rehydration verified functionally instead: after restart, WDB-registered
  repos (e.g. channel 97) respond, and channel 1120's re-registered repo
  survives a `docker compose restart` with all 2,534 files intact.
- **Wabi-on-wabi fixture (the point of the exercise)**: lore channel `wabi`
  (`ch_460` = 1120) on Tim now hosts a full copy of the wabi worktree:
  `:lore push` staged 2,534 files and sealed them with ONE snapshot —
  `Initial import from /home/ironin/wabi-lore (2534 files)`, head revision
  `c6c9de511b45a739…`. Browsable via the API (`GET /repos/1120/files`,
  `/manifest`) and in the TUI Lore screen (`✓ wabi · 2534 files`, repo
  `lore://host.docker.internal:41337/wabi`).

## Found-and-fixed along the way (all in this pass)

1. **`list_files` listed only uncommitted changes.** Native repos listed via
   `lore status --scan`, so every COMMITTED repo browsed as "3 files" (the
   seeded furniture) — including channel 97, populated days ago. Fixed: the
   working tree is walked (`walk_working_tree_files`, furniture + symlinks +
   `.wabiignore` respected) and `status --scan` labels overlay as A/M/D,
   defaulting to `clean`. Mirrors already worked this way (`git ls-files`).
2. **TUI fake-auth header.** A remembered username without a token rendered
   `● user (member)` while every authenticated call failed. `App::new` now
   only builds the remembered user when a token exists.
3. **TUI repo-class normalization.** The wire's tagged-object form
   `{"type":"native"}` was misread as "mirror", labeling native repos
   read-only in the Lore screen. Fixed at the client boundary.

## Known follow-ups

- The wabi repo's history holds TWO "Initial import" revisions (a stray
  duplicate push during driver debugging) plus the test artifacts' delete
  entries. Harmless; a future `:lore` history view will make pruning obvious.
- One observed rehydration gap: a repo created and then immediately
  delete/re-created across a driver kill lost its WDB registration once
  (root cause not fully pinned — likely a raced `lore_delete_repo`); the
  create-adopts-tree self-heal path repaired it in one call. Worth a
  deterministic repro before touching the event flow.
- wabi-sync's initial sync could reuse `stageOnly` + one snapshot.
- `BRANCH_SWITCH_ENABLED` remains false in the shell; a real switch endpoint +
  UI is still open kanban work.

## Follow-ups (not this round)

- wabi-sync could use `stageOnly` + one snapshot for its initial sync too.
- Web "link a folder" flow can reuse the same stage/snapshot batch endpoint
  shape when a browser folder-picker import lands.
- `BRANCH_SWITCH_ENABLED` remains false in the shell; a real switch endpoint +
  UI is still open kanban work.
