# Lore local workspace: automatic detection, manual decisions

Date: 2026-09-10
Status: implementation on PR #175; native build and full Svelte/runtime gates are still outstanding.
Base: 350c867df1419c2ade55e30a14bfb6b11cca2c49 on feat/lore-local-changes-2026-09-10.

This approved follow-up supersedes the manual-refresh and deferred-watching statements in
2026-09-10-lore-local-changes.md. It does not change that iteration's publishing or pull semantics.

## User behavior

After connecting a local folder, changes are detected automatically while the Local changes
view is connected and the Project workspace is mounted in a visible desktop window.
Switching between Repository and Local changes preserves the connection and shows change
counts/incoming notices in the Project navigation. Editor saves, additions, deletions and
renames update the comparison without clicking Refresh. Incoming server changes appear in
the Incoming list and a notice. Nothing is downloaded into the project, overwritten, deleted,
staged, restaged, committed, or published by the observer.

The user still selects files, supplies a summary, chooses Publish staged, and confirms Pull
incoming or a conflict resolution. Staged fingerprints remain exactly as selected. New edits
make the selection stale, visibly requiring review; they are never silently restaged. The
Publish button is disabled for stale selections, and existing fresh preflight checks remain.

Check now remains available. Pause detection stops automatic checks without stopping manual
actions. Resume, returning to the window, and a network-online hint request a fresh comparison.
Hidden/minimized windows do not scan or poll the server. Leaving the whole Project workspace, changing project/account/server, or closing it disposes
the observer. This is not an always-running tray service or a cross-project connection registry.
After a component is unmounted the original reconnect behavior still applies.

## Implementation

- `src-tauri/src/lore_local_detection.rs`: native notify 8.2 watcher on the already-granted
  canonical root. Commands reuse the existing window-bound handle checks. A small subscription
  ID/revision/quiet-time status is returned, not file contents or broadcast paths. Both existing
  native entry points register its state and commands. No tokens are stored or used by watching.
- The frontend polls that in-memory invalidation counter every second. It waits for 750 ms of
  quiet before scanning a burst of saves, with a 5-second maximum debounce. The initial scan
  follows watcher startup so edits made during scanning remain visible to the next check.
- Local hashing occurs on invalidation, explicit checks, focus/resume, or a five-minute safety
  audit for lost OS events. The existing full-content scan is reused; there is not yet a
  per-file hash cache or incremental scanner. Large projects still require runtime profiling.
- Remote manifest and review-policy GET checks run every 15 seconds, reusing the last local
  scan when the filesystem has not changed. These are metadata checks, not automatic pulls.
- Watcher startup/runtime failures display a warning and fall back to 30-second local checks.
  Comparison/network failures back off up to 60 seconds; existing lists/staging are retained,
  cached remote status is explicitly marked unavailable, and no file mutation is attempted.
- `LocalDetection` serializes automatic comparisons with manual operations. Save bursts,
  checks and focus hints coalesce; a slow scan never creates overlapping comparisons or
  interrupts a transfer. Disposal waits for a late native subscription and releases it.
- Native watchers have 45-second heartbeat leases, inspected every five seconds. Explicit
  cleanup stops them promptly; a lost frontend or failed cleanup still expires the watcher.
  A new subscription identity forces a rescan after expiry/reconnect.
- Access/read events and internal index/backup/build/secret paths do not invalidate the view;
  root `.wabiignore` edits do. Watcher recursion disables symlink following on backends that
  support that config. The existing scan still rejects symlinks/unsafe paths. OS rescan flags
  invalidate even if their event classification is otherwise ignored.
- `LocalWorkspace.detect` is deliberately distinct from manual `refresh`: it computes a
  snapshot without saving baselines, clearing staged selections, or using any write endpoint.
  Cached local and remote values are session-local. Manual publish/pull always re-scan and
  check the server before applying a user decision.

Existing limitations remain: per-file Lore revisions, manual confirmed pulls, no atomic batch
commit, no auto-pull, no offline commit graph, and no branch selection. Custom ignore rules
still filter after the native scan and do not prune watch registration or hashing. Native
filesystem behavior must be verified on real Linux and Windows desktops before release.

## Verification performed for this follow-up

```sh
node --experimental-strip-types --test frontend/scripts/lore-local-detection.test.mjs
# 32 passed, 0 failed: production scheduler, fake time and I/O boundaries.

node --experimental-vm-modules --test frontend/scripts/lore-local-observer.test.mjs
# 9 passed, 0 failed: production LocalWorkspace observer, transpiled using TypeScript;
# mocked native/network/planner boundaries. Requires frontend dev dependencies.

tsc --strict --noEmit --target es2022 --module esnext frontend/src/lib/loreLocalDetection.ts
# Passed for the standalone scheduler.
```

TypeScript syntax transpilation also passed for the updated workspace module and the Svelte
script block. This does NOT compile Svelte markup or validate the full application.
Four new Rust tests cover filtering, editor/rule changes, atomic renames and rescan flags;
they were NOT run. The original comparison/publishing model and its 38-test suite were not
changed or re-run in this follow-up. No claim of 79 end-to-end tests is made.

The environment has Node/TypeScript but no Rust, Bun, installed project dependencies, desktop
runtime, or live Lore fixture; direct package/source network retrieval is unavailable. Native
Cargo dependency/lockfile resolution, full frontend checks/build and physical watcher tests
remain required. No merge or deployment is performed.

## Required verification before merging

1. Resolve and review the native Cargo lockfile with notify 8.2 and prior PR dependency changes.
   Run formatting, all native tests, and compile both Tauri entry points on supported targets.
2. Run the full pinned frontend check/build and existing test suites; exercise the actual
   Svelte markup and the new stale-selection, warning, pause and incoming-notice states.
3. Test actual editor save/rename/delete bursts, .wabiignore edits, excluded-path writes,
   symlink insertion, network shares, watcher-limit/overflow failure, and very large projects.
4. Verify an incoming change never touches local bytes until confirmation, and editor saves
   never touch the server. Test saves during scan/publish/pull, existing preflight failures,
   account/server changes mid-await, paused and hidden windows, lease expiry, and disposal.
5. Run the original live Lore, backup/rollback, permission/review-policy and filesystem safety
   gates from 2026-09-10-lore-local-changes.md. This follow-up does not waive them.
